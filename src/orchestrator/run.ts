import { join } from "node:path";
import { ulid } from "ulid";
import { applyAuthMode } from "../auth/mode.js";
import { discoverRepos, type DiscoveredRepo } from "../phases/discover.js";
import { analyze } from "../phases/analyze.js";
import { plan } from "../phases/plan.js";
import { execute } from "../phases/execute.js";
import { getStackProfile } from "../stack/detect.js";
import { BudgetTracker } from "./budget.js";
import { runWithConcurrency } from "./concurrency.js";
import { createRunDir, saveManifest } from "../state/runIndex.js";
import { ensureAgentDir, ensureGitignore, saveRepoState } from "../state/repoState.js";
import { appendLogEvent } from "../state/runLog.js";
import { writeAtomic } from "../state/atomicWrite.js";
import {
  BudgetCapped,
  SCHEMA_VERSION,
  type AuthMode,
  type LogEvent,
  type RepoEntry,
  type RunConfig,
  type RunManifest,
  type TaskState,
} from "../types.js";
import { readFile } from "node:fs/promises";

export interface OrchestrationParams {
  runId?: string;
  authMode: AuthMode;
  config: RunConfig;
  stateRoot: string;
  selectRepos: (repos: DiscoveredRepo[]) => Promise<string[]>;
  proposalGate: (proposalPath: string) => Promise<"accept" | "reject" | "reanalyze">;
  planGate: (planPath: string) => Promise<"accept" | "reject" | "replan">;
  checkpoint: (
    taskOutcome: TaskState & { filesChanged: string[]; diff: string },
  ) => Promise<"continue" | "skip" | "edit" | "quit">;
  runConfirmation: (manifest: RunManifest) => Promise<boolean>;
  authConfirmation: (warnings: string[]) => Promise<boolean>;
  analyzeFn?: typeof analyze;
  planFn?: typeof plan;
  executeFn?: typeof execute;
}

export async function runOrchestration(p: OrchestrationParams): Promise<RunManifest> {
  applyAuthMode(p.authMode);

  const runId = p.runId ?? ulid();
  const runDir = await createRunDir(p.stateRoot, runId);
  const tracker = new BudgetTracker({
    maxTokens: p.config.maxTokens,
    maxDurationMs: p.config.maxDurationMs,
  });
  const logPath = join(runDir, "run-log.jsonl");
  const log = (e: LogEvent) => appendLogEvent(logPath, e);
  const now = () => new Date().toISOString();

  const manifest: RunManifest = {
    runId,
    createdAt: now(),
    authMode: p.authMode,
    config: p.config,
    repos: [],
    budget: { tokensUsed: 0, startedAt: now() },
    status: "discovering",
    schemaVersion: SCHEMA_VERSION,
  };

  const persist = async () => {
    manifest.budget.tokensUsed = tracker.tokensUsed;
    await saveManifest(runDir, manifest);
  };
  await log({ ts: now(), type: "run_started", runId });
  await persist();

  // Discover
  const discovered = await discoverRepos({
    targetDir: p.config.targetDir,
    exclude: p.config.exclude,
    include: p.config.include,
  });

  manifest.status = "selecting";
  await persist();
  const selectedPaths = await p.selectRepos(discovered);
  const selected = discovered.filter((r) => selectedPaths.includes(r.path));

  manifest.repos = selected.map<RepoEntry>((r) => ({
    path: r.path,
    name: r.name,
    stack: r.stack,
    status: "pending",
    testGate: p.config.testGate !== "skip",
  }));
  manifest.status = "preflight";
  await persist();

  for (const repo of selected) {
    await ensureAgentDir(repo.path);
    await ensureGitignore(repo.path);
  }

  const analyzeFn = p.analyzeFn ?? analyze;
  const planFn = p.planFn ?? plan;
  const executeFn = p.executeFn ?? execute;

  try {
    // Pre-flight: analyze + plan all repos before execution starts
    for (let i = 0; i < manifest.repos.length; i++) {
      const repo = manifest.repos[i]!;
      const profile = getStackProfile(repo.stack);
      repo.status = "analyzing";
      await persist();
      await log({ ts: now(), type: "phase_started", repoPath: repo.path, phase: "analyze" });

      const analyzeResult = await analyzeFn({
        repoPath: repo.path,
        repoName: repo.name,
        stackProfile: profile,
        hasReadme: discovered[i]?.hasReadme ?? false,
        hasTests: discovered[i]?.hasTests ?? false,
        lastCommitDate: discovered[i]?.lastCommitDate ?? null,
        tracker,
        model: p.config.model.analyze ?? p.config.model.default,
      });
      repo.proposalPath = analyzeResult.proposalPath;
      repo.status = "awaiting-proposal-approval";
      await persist();
      await log({
        ts: now(),
        type: "phase_completed",
        repoPath: repo.path,
        phase: "analyze",
        tokensUsed: analyzeResult.tokensUsed,
        durationMs: analyzeResult.durationMs,
      });

      const action = await p.proposalGate(analyzeResult.proposalPath);
      if (action === "reject") {
        repo.status = "skipped";
        await persist();
        continue;
      }
      // (re-analyze loop omitted for brevity; could be added later via orchestrator wrapper)

      repo.status = "planning";
      await persist();
      const proposalMd = await readFile(analyzeResult.proposalPath, "utf8");
      await log({ ts: now(), type: "phase_started", repoPath: repo.path, phase: "plan" });
      const planResult = await planFn({
        repoPath: repo.path,
        repoName: repo.name,
        stackProfile: profile,
        proposalMarkdown: proposalMd,
        tracker,
        model: p.config.model.plan ?? p.config.model.default,
      });
      repo.planPath = planResult.planPath;
      repo.taskState = planResult.tasks;
      repo.status = "awaiting-plan-approval";
      await persist();
      await log({
        ts: now(),
        type: "phase_completed",
        repoPath: repo.path,
        phase: "plan",
        tokensUsed: planResult.tokensUsed,
        durationMs: planResult.durationMs,
      });

      const planAction = await p.planGate(planResult.planPath);
      if (planAction === "reject") {
        repo.status = "skipped";
        await persist();
        continue;
      }
    }

    // Confirm aggregate
    manifest.status = "running";
    await persist();
    if (!(await p.runConfirmation(manifest))) {
      manifest.status = "paused";
      await persist();
      return manifest;
    }

    // Execute repos honoring concurrency
    const runnable = manifest.repos.filter(
      (r) => r.status !== "skipped" && r.taskState && r.taskState.length > 0,
    );

    await runWithConcurrency(runnable, p.config.concurrency, async (repo) => {
      const profile = getStackProfile(repo.stack);
      repo.status = "executing";
      await persist();
      const tasks = repo.taskState ?? [];
      let taskIdx = 0;
      for (const task of tasks) {
        await log({ ts: now(), type: "task_started", repoPath: repo.path, taskId: task.taskId });
        const outcome = await executeFn({
          repoPath: repo.path,
          repoName: repo.name,
          stackProfile: profile,
          task,
          tracker,
          maxRetries: p.config.maxRetries,
          testGateEnabled: repo.testGate,
          testCommand: profile.defaultTestCommand,
          testTimeoutMs: p.config.testTimeoutMs,
          model: p.config.model.execute ?? p.config.model.default,
        });
        Object.assign(task, outcome);
        await saveRepoState(repo.path, repo);
        await persist();
        if (outcome.status === "completed") {
          await log({
            ts: now(),
            type: "task_completed",
            repoPath: repo.path,
            taskId: task.taskId,
            commitSha: outcome.commitSha ?? "",
            tokensUsed: outcome.tokensUsed,
          });
        } else {
          await log({
            ts: now(),
            type: "task_failed",
            repoPath: repo.path,
            taskId: task.taskId,
            reason: outcome.failureReason ?? "unknown",
            willRetry: false,
          });
          if (p.config.onFailure === "skip-repo") {
            repo.status = "failed";
            await persist();
            return;
          }
          if (p.config.onFailure === "stop") {
            throw new Error(`fail-stop on task ${task.taskId}`);
          }
        }
        taskIdx += 1;
        if ((taskIdx + 1) % p.config.checkpointEvery === 0 && taskIdx + 1 < tasks.length) {
          await log({
            ts: now(),
            type: "checkpoint_paused",
            repoPath: repo.path,
            afterTaskId: task.taskId,
          });
          const action = await p.checkpoint(outcome);
          await log({
            ts: now(),
            type: "checkpoint_resumed",
            repoPath: repo.path,
            action,
          });
          if (action === "skip" || action === "quit") {
            if (action === "skip") repo.status = "skipped";
            return;
          }
        }
      }
      repo.status = "completed";
      await persist();
    });

    manifest.status = manifest.repos.every(
      (r) => r.status === "completed" || r.status === "skipped",
    )
      ? "completed"
      : "failed";
    await persist();
    await log({
      ts: now(),
      type: "run_finalized",
      status: manifest.status === "completed" ? "completed" : "failed",
      durationMs: Date.now() - new Date(manifest.createdAt).getTime(),
    });

    // Write summary.md
    const summary = renderSummary(manifest);
    await writeAtomic(join(runDir, "summary.md"), summary);
    return manifest;
  } catch (err) {
    if (err instanceof BudgetCapped) {
      manifest.status = "paused";
      await persist();
      await log({ ts: now(), type: "budget_capped", reason: err.message });
      return manifest;
    }
    manifest.status = "failed";
    await persist();
    throw err;
  }
}

function renderSummary(m: RunManifest): string {
  const lines = [`# Run ${m.runId}`, ``, `Status: ${m.status}`, ``];
  for (const repo of m.repos) {
    lines.push(`- ${repo.name}: ${repo.status}`);
  }
  lines.push(``, `Tokens used: ${m.budget.tokensUsed}`);
  return lines.join("\n");
}
