import { applyAuthMode } from "../auth/mode.js";
import { runOrchestration } from "../orchestrator/run.js";
import { listRuns, defaultStateRoot } from "../state/runIndex.js";
import { confirmPrompt, proposalGate, planGate } from "../tui/confirm.js";
import type { RunManifest } from "../types.js";

export interface ResumeOpts {
  runId?: string;
}

/** Count tasks already done vs. still to run across all repos in a manifest. */
function countTasks(manifest: RunManifest): { done: number; todo: number } {
  let done = 0;
  let todo = 0;
  for (const repo of manifest.repos) {
    for (const task of repo.taskState ?? []) {
      if (task.status === "completed" || task.status === "skipped") done += 1;
      else todo += 1;
    }
  }
  return { done, todo };
}

export async function resumeCommand(opts: ResumeOpts): Promise<void> {
  const stateRoot = defaultStateRoot();
  const runs = await listRuns(stateRoot);
  const paused = runs.filter((r) => r.manifest.status === "paused");

  let runId = opts.runId;
  if (!runId) {
    if (paused.length === 0) {
      console.error("No paused runs found.");
      process.exit(1);
    }
    if (paused.length > 1) {
      console.error("Multiple paused runs. Pass one as an argument: agent resume <runId>");
      for (const { manifest } of paused) {
        console.error(`  ${manifest.runId}  ${manifest.repos.length} repos  ${manifest.createdAt}`);
      }
      process.exit(1);
    }
    runId = paused[0]!.runId;
  }

  const entry = runs.find((r) => r.runId === runId);
  if (!entry) {
    console.error(`Run ${runId} not found.`);
    process.exit(1);
  }
  const manifest = entry.manifest;

  // Re-apply the auth mode the run was created with. `api` needs
  // ANTHROPIC_API_KEY in env; `subscription` uses the OAuth creds. Surface a
  // missing key as a config error (exit 4) rather than a stack trace.
  try {
    applyAuthMode(manifest.authMode);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(4);
  }

  const interactive = process.stdout.isTTY === true;
  const { done, todo } = countTasks(manifest);

  // Be explicit about what resume does: it continues from where the run
  // stopped. Completed tasks are skipped by the executor — resume never
  // re-runs or overwrites them.
  console.warn(
    `Resuming run ${runId} (was ${manifest.status}). ` +
      `${done} task(s) already done, ${todo} remaining. Completed tasks are skipped.`,
  );
  if (todo === 0) {
    console.warn("Nothing left to do — all tasks are already complete or skipped.");
  }

  const result = await runOrchestration({
    runId,
    authMode: manifest.authMode,
    config: manifest.config,
    stateRoot,
    // Unused on resume (the manifest already pins the repo set), but the
    // OrchestrationParams contract requires them.
    selectRepos: async (repos) => repos.map((r) => r.path),
    proposalGate: async () => (interactive ? proposalGate() : "accept"),
    planGate: async () => (interactive ? planGate() : "accept"),
    runConfirmation: async () =>
      interactive ? confirmPrompt(`Resume execution of ${todo} remaining task(s)?`, true) : true,
    authConfirmation: async (warns) =>
      interactive ? confirmPrompt(warns.join("\n") + "\nContinue?", true) : true,
  });

  if (result.status === "completed") process.exit(0);
  if (result.status === "paused") process.exit(2);
  if (result.status === "failed") process.exit(5);
  process.exit(1);
}
