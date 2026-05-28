import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ulid } from "ulid";
import { applyAuthMode } from "../auth/mode.js";
import { analyze } from "../phases/analyze.js";
import { discoverRepos, type DiscoveredRepo } from "../phases/discover.js";
import { execute } from "../phases/execute.js";
import { plan } from "../phases/plan.js";
import { getStackProfile } from "../stack/detect.js";
import { writeAtomic } from "../state/atomicWrite.js";
import {
  ensureAgentDir,
  ensureGitignore,
  readPlanApproval,
  readProposalApproval,
  saveRepoState,
  writePlanApproval,
  writeProposalApproval,
} from "../state/repoState.js";
import { createRunDir, loadManifest, saveManifest } from "../state/runIndex.js";
import { appendLogEvent } from "../state/runLog.js";
import {
  BudgetCapped,
  SCHEMA_VERSION,
  type AuthMode,
  type LogEvent,
  type RepoEntry,
  type RunConfig,
  type RunManifest,
} from "../types.js";
import { BudgetTracker } from "./budget.js";
import { runWithConcurrency } from "./concurrency.js";

const RUN_CONFIRMED_MARKER = "run-confirmed.json";

const nowIso = (): string => new Date().toISOString();

export interface StepDecisions {
  proposals?: Record<string, "accept" | "reject" | "reanalyze">;
  plans?: Record<string, "accept" | "reject" | "replan">;
  runConfirmed?: boolean;
}

export interface StepParams {
  runId: string;
  stateRoot: string;
  authMode?: AuthMode;
  config?: RunConfig;
  selectedRepos?: DiscoveredRepo[];
  decisions?: StepDecisions;
  analyzeFn?: typeof analyze;
  planFn?: typeof plan;
  executeFn?: typeof execute;
  // Optional force-stop signal: passed to phase functions so an in-flight
  // SDK query can be cancelled mid-stream. The background loop wires this
  // up; CLI callers can leave it undefined.
  abortSignal?: AbortSignal;
}

async function tryLoadManifest(runDir: string): Promise<RunManifest | null> {
  try {
    return await loadManifest(runDir);
  } catch {
    return null;
  }
}

async function initManifest(
  runDir: string,
  runId: string,
  authMode: AuthMode,
  config: RunConfig,
  selectedRepos: DiscoveredRepo[],
): Promise<RunManifest> {
  const manifest: RunManifest = {
    runId,
    createdAt: nowIso(),
    authMode,
    config,
    repos: selectedRepos.map<RepoEntry>((r) => ({
      path: r.path,
      name: r.name,
      stack: r.stack,
      hasReadme: r.hasReadme,
      hasTests: r.hasTests,
      lastCommitDate: r.lastCommitDate ?? undefined,
      status: "pending",
      testGate: config.testGate !== "skip",
    })),
    budget: { tokensUsed: 0, startedAt: nowIso() },
    status: "preflight",
    schemaVersion: SCHEMA_VERSION,
  };
  await saveManifest(runDir, manifest);
  for (const r of selectedRepos) {
    await ensureAgentDir(r.path);
    await ensureGitignore(r.path);
  }
  return manifest;
}

async function applyDecisionsToState(
  manifest: RunManifest,
  runDir: string,
  decisions: StepDecisions,
): Promise<void> {
  for (const [repoPath, action] of Object.entries(decisions.proposals ?? {})) {
    const repo = manifest.repos.find((r) => r.path === repoPath);
    if (!repo) continue;
    if (action === "accept" && repo.proposalPath) {
      await writeProposalApproval(repo.path, repo.proposalPath);
    } else if (action === "reject") {
      repo.status = "skipped";
    } else if (action === "reanalyze") {
      repo.status = "pending";
      repo.proposalPath = undefined;
    }
  }
  for (const [repoPath, action] of Object.entries(decisions.plans ?? {})) {
    const repo = manifest.repos.find((r) => r.path === repoPath);
    if (!repo) continue;
    if (action === "accept" && repo.planPath) {
      await writePlanApproval(repo.path, repo.planPath, (repo.taskState ?? []).length);
    } else if (action === "reject") {
      repo.status = "skipped";
    } else if (action === "replan") {
      repo.status = "awaiting-proposal-approval";
      repo.planPath = undefined;
      repo.taskState = undefined;
    }
  }
  if (decisions.runConfirmed) {
    await writeAtomic(
      join(runDir, RUN_CONFIRMED_MARKER),
      JSON.stringify({ confirmedAt: nowIso() }),
    );
  }
}

async function runConfirmedExists(runDir: string): Promise<boolean> {
  try {
    await access(join(runDir, RUN_CONFIRMED_MARKER));
    return true;
  } catch {
    return false;
  }
}

async function advancePreflightOnce(
  manifest: RunManifest,
  runDir: string,
  tracker: BudgetTracker,
  log: (e: LogEvent) => Promise<void>,
  p: StepParams,
): Promise<boolean> {
  const analyzeFn = p.analyzeFn ?? analyze;
  const planFn = p.planFn ?? plan;
  const persist = async (): Promise<void> => {
    manifest.budget.tokensUsed = tracker.tokensUsed;
    await saveManifest(runDir, manifest);
  };

  const autonomy = manifest.config.autonomy;
  const isYolo = autonomy === "yolo";
  const allowParallel = isYolo || autonomy === "supervised";

  // Advance any approved proposals into planning
  for (const repo of manifest.repos.filter((r) => r.status === "awaiting-proposal-approval")) {
    if (!repo.proposalPath) continue;
    const approval = await readProposalApproval(repo.path);
    if (!approval) continue;
    repo.status = "planning";
    await persist();
    await log({ ts: nowIso(), type: "phase_started", repoPath: repo.path, phase: "plan" });
    const proposalMd = await readFile(repo.proposalPath, "utf8");
    const planResult = await planFn({
      repoPath: repo.path,
      repoName: repo.name,
      stackProfile: getStackProfile(repo.stack),
      proposalMarkdown: proposalMd,
      tracker,
      model: manifest.config.model.plan ?? manifest.config.model.default,
      abortSignal: p.abortSignal,
    });
    repo.planPath = planResult.planPath;
    repo.taskState = planResult.tasks;
    repo.status = "awaiting-plan-approval";
    await persist();
    await log({
      ts: nowIso(),
      type: "phase_completed",
      repoPath: repo.path,
      phase: "plan",
      tokensUsed: planResult.tokensUsed,
      durationMs: planResult.durationMs,
    });
    if (isYolo) {
      await writePlanApproval(repo.path, planResult.planPath, planResult.tasks.length);
    }
    return true;
  }

  // Dispatch any pending analyses
  const pending = manifest.repos.filter((r) => r.status === "pending");
  if (pending.length > 0) {
    const batch = allowParallel ? pending : [pending[0]!];
    for (const r of batch) r.status = "analyzing";
    await persist();
    for (const r of batch) {
      await log({ ts: nowIso(), type: "phase_started", repoPath: r.path, phase: "analyze" });
    }
    await Promise.all(
      batch.map(async (repo) => {
        const result = await analyzeFn({
          repoPath: repo.path,
          repoName: repo.name,
          stackProfile: getStackProfile(repo.stack),
          hasReadme: repo.hasReadme ?? false,
          hasTests: repo.hasTests ?? false,
          lastCommitDate: repo.lastCommitDate ?? null,
          tracker,
          model: manifest.config.model.analyze ?? manifest.config.model.default,
          abortSignal: p.abortSignal,
        });
        repo.proposalPath = result.proposalPath;
        repo.status = "awaiting-proposal-approval";
        await log({
          ts: nowIso(),
          type: "phase_completed",
          repoPath: repo.path,
          phase: "analyze",
          tokensUsed: result.tokensUsed,
          durationMs: result.durationMs,
        });
        if (isYolo) {
          await writeProposalApproval(repo.path, result.proposalPath);
        }
      }),
    );
    await persist();
    return true;
  }

  // No more pending; check if preflight is complete
  const reposNeedingApproval = manifest.repos.filter((r) => r.status === "awaiting-plan-approval");
  if (reposNeedingApproval.length === 0) {
    // All repos finished preflight via approval, skip, or fail
    manifest.status = "awaiting-run-confirmation";
    await persist();
    return true;
  }
  // Check if all remaining awaiting repos have approval markers
  for (const repo of reposNeedingApproval) {
    if (!(await readPlanApproval(repo.path))) {
      return false; // still waiting for at least one
    }
  }
  manifest.status = "awaiting-run-confirmation";
  await persist();
  return true;
}

async function advanceRunning(
  manifest: RunManifest,
  runDir: string,
  tracker: BudgetTracker,
  log: (e: LogEvent) => Promise<void>,
  p: StepParams,
): Promise<void> {
  const executeFn = p.executeFn ?? execute;
  const persist = async (): Promise<void> => {
    manifest.budget.tokensUsed = tracker.tokensUsed;
    await saveManifest(runDir, manifest);
  };

  const runnable = manifest.repos.filter(
    (r) =>
      r.status !== "skipped" &&
      r.status !== "failed" &&
      r.taskState !== undefined &&
      r.taskState.length > 0,
  );

  await runWithConcurrency(runnable, manifest.config.concurrency, async (repo) => {
    const profile = getStackProfile(repo.stack);
    repo.status = "executing";
    await persist();
    const tasks = repo.taskState ?? [];
    for (const task of tasks) {
      if (task.status === "completed" || task.status === "skipped") continue;
      await log({ ts: nowIso(), type: "task_started", repoPath: repo.path, taskId: task.taskId });
      const outcome = await executeFn({
        repoPath: repo.path,
        repoName: repo.name,
        stackProfile: profile,
        task,
        tracker,
        maxRetries: manifest.config.maxRetries,
        testGateEnabled: repo.testGate,
        testCommand: profile.defaultTestCommand,
        testTimeoutMs: manifest.config.testTimeoutMs,
        model: manifest.config.model.execute ?? manifest.config.model.default,
        abortSignal: p.abortSignal,
      });
      Object.assign(task, outcome);
      await saveRepoState(repo.path, repo);
      await persist();
      if (outcome.status === "completed") {
        await log({
          ts: nowIso(),
          type: "task_completed",
          repoPath: repo.path,
          taskId: task.taskId,
          commitSha: outcome.commitSha ?? "",
          tokensUsed: outcome.tokensUsed,
        });
      } else {
        await log({
          ts: nowIso(),
          type: "task_failed",
          repoPath: repo.path,
          taskId: task.taskId,
          reason: outcome.failureReason ?? "unknown",
          willRetry: false,
        });
        if (manifest.config.onFailure === "skip-repo") {
          repo.status = "failed";
          await persist();
          return;
        }
        if (manifest.config.onFailure === "stop") {
          throw new Error(`fail-stop on task ${task.taskId}`);
        }
      }
    }
    repo.status = "completed";
    await persist();
  });

  manifest.status = manifest.repos.every((r) => r.status === "completed" || r.status === "skipped")
    ? "completed"
    : "failed";
  await persist();
  await log({
    ts: nowIso(),
    type: "run_finalized",
    status: manifest.status === "completed" ? "completed" : "failed",
    durationMs: Date.now() - new Date(manifest.createdAt).getTime(),
  });
  await writeAtomic(join(runDir, "summary.md"), renderSummary(manifest));
}

export async function step(p: StepParams): Promise<RunManifest> {
  const runDir = join(p.stateRoot, p.runId);

  let manifest = await tryLoadManifest(runDir);
  if (!manifest) {
    if (!p.authMode || !p.config || !p.selectedRepos) {
      throw new Error(
        "step() first call requires authMode, config, and selectedRepos to initialize the run",
      );
    }
    await createRunDir(p.stateRoot, p.runId);
    manifest = await initManifest(runDir, p.runId, p.authMode, p.config, p.selectedRepos);
    await appendLogEvent(join(runDir, "run-log.jsonl"), {
      ts: nowIso(),
      type: "run_started",
      runId: p.runId,
    });
  }

  if (p.decisions) {
    await applyDecisionsToState(manifest, runDir, p.decisions);
    await saveManifest(runDir, manifest);
  }

  applyAuthMode(manifest.authMode);

  const tracker = new BudgetTracker({
    maxTokens: manifest.config.maxTokens,
    maxDurationMs: manifest.config.maxDurationMs,
  });
  tracker.tokensUsed = manifest.budget.tokensUsed;

  const logPath = join(runDir, "run-log.jsonl");
  const log = (e: LogEvent): Promise<void> => appendLogEvent(logPath, e);
  const persist = async (): Promise<void> => {
    manifest!.budget.tokensUsed = tracker.tokensUsed;
    await saveManifest(runDir, manifest!);
  };

  const isYolo = manifest.config.autonomy === "yolo";

  try {
    while (true) {
      if (manifest.status === "preflight") {
        const didWork = await advancePreflightOnce(manifest, runDir, tracker, log, p);
        if (!didWork) return manifest;
        if (!isYolo) return manifest;
        continue;
      }
      if (manifest.status === "awaiting-run-confirmation") {
        if (isYolo || (await runConfirmedExists(runDir))) {
          manifest.status = "running";
          await persist();
          continue;
        }
        return manifest;
      }
      if (manifest.status === "running") {
        await advanceRunning(manifest, runDir, tracker, log, p);
        return manifest;
      }
      return manifest;
    }
  } catch (err) {
    if (err instanceof BudgetCapped) {
      manifest.status = "paused";
      await persist();
      await log({ ts: nowIso(), type: "budget_capped", reason: err.message });
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

// ---------------------------------------------------------------------------
// runOrchestration: callback-driven wrapper around step() — preserves Style 1 API
// ---------------------------------------------------------------------------

export interface OrchestrationParams {
  runId?: string;
  authMode: AuthMode;
  config: RunConfig;
  stateRoot: string;
  selectRepos: (repos: DiscoveredRepo[]) => Promise<string[]>;
  proposalGate: (proposalPath: string) => Promise<"accept" | "reject" | "reanalyze">;
  planGate: (planPath: string) => Promise<"accept" | "reject" | "replan">;
  runConfirmation: (manifest: RunManifest) => Promise<boolean>;
  authConfirmation: (warnings: string[]) => Promise<boolean>;
  analyzeFn?: typeof analyze;
  planFn?: typeof plan;
  executeFn?: typeof execute;
}

export async function runOrchestration(p: OrchestrationParams): Promise<RunManifest> {
  const runId = p.runId ?? ulid();
  const discovered = await discoverRepos({
    targetDir: p.config.targetDir,
    exclude: p.config.exclude,
    include: p.config.include,
  });
  const selectedPaths = await p.selectRepos(discovered);
  const selectedRepos = discovered.filter((r) => selectedPaths.includes(r.path));

  let manifest = await step({
    runId,
    stateRoot: p.stateRoot,
    authMode: p.authMode,
    config: p.config,
    selectedRepos,
    analyzeFn: p.analyzeFn,
    planFn: p.planFn,
    executeFn: p.executeFn,
  });

  while (
    manifest.status !== "completed" &&
    manifest.status !== "failed" &&
    manifest.status !== "paused"
  ) {
    const decisions: StepDecisions = {};
    let needsAnotherStep = false;

    for (const repo of manifest.repos) {
      if (repo.status === "awaiting-proposal-approval" && repo.proposalPath) {
        if (!(await readProposalApproval(repo.path))) {
          decisions.proposals = decisions.proposals ?? {};
          decisions.proposals[repo.path] = await p.proposalGate(repo.proposalPath);
          needsAnotherStep = true;
        }
      }
      if (repo.status === "awaiting-plan-approval" && repo.planPath) {
        if (!(await readPlanApproval(repo.path))) {
          decisions.plans = decisions.plans ?? {};
          decisions.plans[repo.path] = await p.planGate(repo.planPath);
          needsAnotherStep = true;
        }
      }
    }

    if (manifest.status === "awaiting-run-confirmation") {
      const confirmed = await p.runConfirmation(manifest);
      if (!confirmed) {
        manifest.status = "paused";
        await saveManifest(join(p.stateRoot, runId), manifest);
        return manifest;
      }
      decisions.runConfirmed = true;
      needsAnotherStep = true;
    }

    if (!needsAnotherStep) {
      // Avoid infinite loop if step() returns with no gates pending
      break;
    }

    manifest = await step({
      runId,
      stateRoot: p.stateRoot,
      decisions,
      analyzeFn: p.analyzeFn,
      planFn: p.planFn,
      executeFn: p.executeFn,
    });
  }

  return manifest;
}
