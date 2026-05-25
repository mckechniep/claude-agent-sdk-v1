import { join } from "node:path";
import { step } from "../orchestrator/run.js";
import type { StepParams } from "../orchestrator/run.js";
import { appendLogEvent } from "../state/runLog.js";
import type { LogEvent, RunManifest } from "../types.js";

const activeLoops = new Map<string, AbortController>();

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

export function abortLoop(runId: string): boolean {
  const controller = activeLoops.get(runId);
  if (!controller) return false;
  controller.abort();
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
  activeLoops.set(opts.runId, controller);
  void runLoopBody(opts, controller);
  return controller;
}

async function runLoopBody(
  opts: BackgroundLoopOptions,
  controller: AbortController,
): Promise<void> {
  const stepFn = opts.stepFn ?? step;
  const logPath = join(opts.stateRoot, opts.runId, "run-log.jsonl");
  const log = async (event: LogEvent): Promise<void> => {
    try {
      await appendLogEvent(logPath, event);
    } catch {
      // Best-effort logging. If the file can't be written we still need the
      // loop to clean up activeLoops; swallowing here prevents masking the
      // underlying step() error in the catch below.
    }
  };

  try {
    await log({ ts: nowIso(), type: "run_loop_started", runId: opts.runId });

    while (!controller.signal.aborted) {
      const manifest = await stepFn(opts.stepParams());

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

    if (controller.signal.aborted) {
      await log({ ts: nowIso(), type: "run_loop_aborted", runId: opts.runId });
    }
  } catch (err) {
    // startBackgroundLoop is fire-and-forget, so rethrowing here would surface
    // as an unhandled rejection. The error is durably written to the JSONL log
    // — that's the public observation surface for failure.
    await log({
      ts: nowIso(),
      type: "run_loop_error",
      runId: opts.runId,
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    activeLoops.delete(opts.runId);
  }
}

function hasRepoAwaitingDecision(manifest: RunManifest): boolean {
  return manifest.repos.some(
    (r) => r.status === "awaiting-proposal-approval" || r.status === "awaiting-plan-approval",
  );
}

function nowIso(): string {
  return new Date().toISOString();
}
