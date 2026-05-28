import { join } from "node:path";
import { step } from "../orchestrator/run.js";
import type { StepParams } from "../orchestrator/run.js";
import { loadManifest, saveManifest } from "../state/runIndex.js";
import { appendLogEvent } from "../state/runLog.js";
import { writeHeartbeat } from "../state/heartbeat.js";
import { QueryAbortedError } from "../sdk/query.js";
import type { LogEvent, RunManifest, RunStatus } from "../types.js";

// 5 s is fast enough that a refreshed dashboard sees "live" within a tick
// and slow enough to be negligible disk I/O (a 60-byte atomic write). The
// stale threshold on the read side is set to 3× this — see heartbeat.ts
// consumers — so a single missed beat doesn't flip the indicator amber.
export const HEARTBEAT_INTERVAL_MS = 5_000;

interface ActiveLoop {
  // Aborts between step() iterations — soft stop, current step finishes first.
  controller: AbortController;
  // Aborts mid-step via the SDK's abortController option — force stop, cancels
  // in-flight SDK query immediately. Soft stop never fires this.
  forceController: AbortController;
}

const activeLoops = new Map<string, ActiveLoop>();

export type StopMode = "soft" | "force";

export interface BackgroundLoopOptions {
  runId: string;
  stateRoot: string;
  // Factory so each iteration re-reads decisions from disk rather than
  // capturing a stale snapshot at loop start. The HTTP route layer writes
  // decisions to disk; the loop picks them up on the next pass.
  stepParams: () => StepParams;
  // Injectable for tests; defaults to the real step() implementation.
  stepFn?: typeof step;
}

export class LoopAlreadyActiveError extends Error {
  constructor(public readonly runId: string) {
    super(`A background loop is already active for runId ${runId}`);
    this.name = "LoopAlreadyActiveError";
  }
}

export function isLoopActive(runId: string): boolean {
  return activeLoops.has(runId);
}

/**
 * Legacy soft-only abort. Retained for back-compat with existing callers and
 * tests; new code should prefer requestStop() which exposes the soft/force
 * distinction.
 */
export function abortLoop(runId: string): boolean {
  return requestStop(runId, "soft");
}

/**
 * Signal the background loop to stop.
 *
 * - "soft": the current step() call is allowed to finish, then the loop exits
 *   between iterations. Safe — no in-flight work is interrupted.
 * - "force": additionally aborts the in-flight SDK query via its
 *   abortController. The current step() will throw QueryAbortedError, the
 *   in-progress task row stays at its last-written status (likely "in_progress"),
 *   and the loop exits.
 *
 * Returns false if no loop is active for this runId.
 */
export function requestStop(runId: string, mode: StopMode): boolean {
  const entry = activeLoops.get(runId);
  if (!entry) return false;
  entry.controller.abort();
  if (mode === "force") entry.forceController.abort();
  return true;
}

export function activeLoopCount(): number {
  return activeLoops.size;
}

export function startBackgroundLoop(opts: BackgroundLoopOptions): AbortController {
  if (activeLoops.has(opts.runId)) {
    throw new LoopAlreadyActiveError(opts.runId);
  }
  const controller = new AbortController();
  const forceController = new AbortController();
  activeLoops.set(opts.runId, { controller, forceController });
  void runLoopBody(opts, controller, forceController);
  return controller;
}

/**
 * Drives the heartbeat file at HEARTBEAT_INTERVAL_MS while the loop runs.
 * Returns a stop function the loop body calls in its finally.
 *
 * Implementation detail: we write an immediate beat before the interval
 * fires so dashboards see "live" the moment a loop starts, rather than
 * waiting up to 5 s for the first tick.
 */
function startHeartbeat(runDir: string, runId: string): () => void {
  const beat = (): void => {
    void writeHeartbeat(runDir, runId).catch(() => {
      // Best-effort: a failed heartbeat just means the dashboard sees
      // "stale" one tick later. Not worth crashing the loop over.
    });
  };
  beat();
  const handle = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  return () => clearInterval(handle);
}

async function runLoopBody(
  opts: BackgroundLoopOptions,
  controller: AbortController,
  forceController: AbortController,
): Promise<void> {
  const stepFn = opts.stepFn ?? step;
  const runDir = join(opts.stateRoot, opts.runId);
  const logPath = join(runDir, "run-log.jsonl");
  const log = async (event: LogEvent): Promise<void> => {
    try {
      await appendLogEvent(logPath, event);
    } catch {
      // Best-effort logging. If the file can't be written we still need the
      // loop to clean up activeLoops; swallowing here prevents masking the
      // underlying step() error in the catch below.
    }
  };

  // Tracks how the loop exited so the finally block can write the right
  // terminal manifest status and log the right event.
  let exitReason: "soft" | "force" | "error" | "natural" = "natural";
  let forceDuringStep = false;
  let lastError: unknown = null;

  const stopHeartbeat = startHeartbeat(runDir, opts.runId);

  try {
    await log({ ts: nowIso(), type: "run_loop_started", runId: opts.runId });

    while (!controller.signal.aborted) {
      // Inject the force signal at call time so every iteration sees the
      // current state. Cheap — just an object spread.
      const params: StepParams = {
        ...opts.stepParams(),
        abortSignal: forceController.signal,
      };
      const manifest = await stepFn(params);

      if (manifest.status === "completed") {
        await log({ ts: nowIso(), type: "run_loop_completed", runId: opts.runId });
        return;
      }
      if (manifest.status === "failed") {
        await log({ ts: nowIso(), type: "run_loop_failed", runId: opts.runId });
        return;
      }
      if (manifest.status === "paused") {
        await log({ ts: nowIso(), type: "run_loop_paused", runId: opts.runId });
        return;
      }
      if (manifest.status === "awaiting-run-confirmation" || hasRepoAwaitingDecision(manifest)) {
        await log({
          ts: nowIso(),
          type: "run_loop_awaiting_decision",
          runId: opts.runId,
          status: manifest.status,
        });
        return;
      }
      // Otherwise: discovering, selecting, preflight, running — loop again.
    }

    // Fell out of while because the soft controller fired.
    exitReason = "soft";
  } catch (err) {
    // A force abort fires the SDK's controller, which causes the in-flight
    // query to throw — our SDK wrapper translates that to QueryAbortedError.
    // Treat that as a deliberate stop, not a system error.
    const isAbortError =
      err instanceof QueryAbortedError ||
      forceController.signal.aborted ||
      (err instanceof Error && err.name === "AbortError");
    if (isAbortError) {
      exitReason = "force";
      forceDuringStep = true;
    } else {
      exitReason = "error";
      lastError = err;
    }
  } finally {
    try {
      if (exitReason === "soft") {
        await log({ ts: nowIso(), type: "run_loop_aborted", runId: opts.runId });
        await settleManifestToPaused(runDir);
      } else if (exitReason === "force") {
        await log({
          ts: nowIso(),
          type: "run_loop_force_aborted",
          runId: opts.runId,
          duringStep: forceDuringStep,
        });
        await settleManifestToPaused(runDir);
      } else if (exitReason === "error") {
        await log({
          ts: nowIso(),
          type: "run_loop_error",
          runId: opts.runId,
          message: lastError instanceof Error ? lastError.message : String(lastError),
        });
      }
    } finally {
      stopHeartbeat();
      activeLoops.delete(opts.runId);
    }
  }
}

/**
 * After a stop, mark the run as paused on disk so the UI shows a clean
 * resumable state. We don't overwrite terminal statuses (completed / failed)
 * because those represent legitimate end-states that happened to race with
 * the stop request.
 */
async function settleManifestToPaused(runDir: string): Promise<void> {
  let manifest: RunManifest;
  try {
    manifest = await loadManifest(runDir);
  } catch {
    return; // run was never bootstrapped; nothing to settle
  }
  if (isTerminalStatus(manifest.status)) return;
  manifest.status = "paused";
  try {
    await saveManifest(runDir, manifest);
  } catch {
    // Best-effort; UI will re-fetch manifest on next event tick anyway.
  }
}

function isTerminalStatus(status: RunStatus): boolean {
  return status === "completed" || status === "failed";
}

function hasRepoAwaitingDecision(manifest: RunManifest): boolean {
  return manifest.repos.some(
    (r) => r.status === "awaiting-proposal-approval" || r.status === "awaiting-plan-approval",
  );
}

function nowIso(): string {
  return new Date().toISOString();
}
