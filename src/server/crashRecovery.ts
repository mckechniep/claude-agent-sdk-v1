import { join } from "node:path";
import { listRuns, loadManifest, saveManifest } from "../state/runIndex.js";
import { appendLogEvent } from "../state/runLog.js";
import { readHeartbeat, isHeartbeatStale, type Heartbeat } from "../state/heartbeat.js";
import { runLogPath } from "../state/runLog.js";
import type { RunManifest, RunStatus } from "../types.js";

// Runs whose status implies the loop was alive but the server died before
// it could settle to "paused". A heartbeat older than this threshold is
// considered proof of a crash rather than a slow step. We pick a generous
// window — 60 s — because a single SDK turn in executor mode can legitimately
// take 30-45 s during a long task.
export const CRASH_THRESHOLD_MS = 60_000;

// Statuses that mean "the loop should be alive right now." Anything else
// (paused, completed, failed, awaiting-*) is a legitimate resting state
// and must not be touched by the sweep.
const ACTIVE_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "discovering",
  "selecting",
  "preflight",
  "running",
  "stopping",
]);

export type RecoverOutcome =
  | { kind: "recovered"; previousStatus: RunStatus; lastHeartbeatAt: string | null }
  | {
      kind: "skipped";
      reason: "terminal-status" | "fresh-heartbeat" | "not-found" | "write-failed";
      detail?: string;
    };

/**
 * Recovers a single run by ID. Same semantics as sweepCrashedRuns but
 * targeted — used by the on-demand /recover route, which the dashboard
 * hits when the user clicks "Recover this run" on an offline loop.
 *
 * Caller is responsible for emitting any user-facing error response — this
 * returns a structured outcome rather than throwing so the route layer can
 * pick the right HTTP code (409 for terminal/fresh, 200 for recovered).
 */
export async function recoverRun(
  stateRoot: string,
  runId: string,
  nowMs: number = Date.now(),
): Promise<RecoverOutcome> {
  const runDir = join(stateRoot, runId);
  let manifest: RunManifest;
  try {
    manifest = await loadManifest(runDir);
  } catch {
    return { kind: "skipped", reason: "not-found" };
  }
  if (!ACTIVE_STATUSES.has(manifest.status)) {
    return { kind: "skipped", reason: "terminal-status", detail: manifest.status };
  }
  const heartbeat = await readHeartbeat(runDir);
  if (!isHeartbeatStale(heartbeat, CRASH_THRESHOLD_MS, nowMs)) {
    return { kind: "skipped", reason: "fresh-heartbeat" };
  }
  return await settleRun(stateRoot, runId, manifest, heartbeat, nowMs);
}

export interface RecoveryReport {
  recovered: Array<{ runId: string; previousStatus: RunStatus; lastHeartbeatAt: string | null }>;
  // Runs that looked suspicious but were skipped (e.g. fresh heartbeat
  // suggests another process is genuinely driving the loop).
  skipped: Array<{ runId: string; reason: string }>;
}

/**
 * Scans `stateRoot` for runs that crashed mid-execution and settles them
 * to "paused" so the dashboard's Resume affordance becomes available.
 *
 * Idempotent — calling it twice is safe; the second call sees the same
 * runs already in "paused" status and skips them. Intended to run once
 * during server startup, before the HTTP listener accepts requests.
 */
export async function sweepCrashedRuns(
  stateRoot: string,
  nowMs: number = Date.now(),
): Promise<RecoveryReport> {
  const report: RecoveryReport = { recovered: [], skipped: [] };
  const runs = await listRuns(stateRoot);

  for (const { runId, manifest } of runs) {
    if (!ACTIVE_STATUSES.has(manifest.status)) continue;

    const runDir = join(stateRoot, runId);
    const heartbeat = await readHeartbeat(runDir);

    if (!isHeartbeatStale(heartbeat, CRASH_THRESHOLD_MS, nowMs)) {
      // Heartbeat is fresh — likely another server instance is driving
      // this run. Don't steal it.
      report.skipped.push({ runId, reason: "fresh heartbeat" });
      continue;
    }

    const outcome = await settleRun(stateRoot, runId, manifest, heartbeat, nowMs);
    if (outcome.kind === "recovered") {
      report.recovered.push({
        runId,
        previousStatus: outcome.previousStatus,
        lastHeartbeatAt: outcome.lastHeartbeatAt,
      });
    } else if (outcome.kind === "skipped") {
      report.skipped.push({
        runId,
        reason: outcome.detail ?? outcome.reason,
      });
    }
  }

  return report;
}

/**
 * Writes the manifest as paused and emits the recovery log event. Shared
 * by sweepCrashedRuns and recoverRun so the side-effect surface stays in
 * one place — every recovery, whether boot-time or on-demand, produces an
 * identical event for the audit log.
 */
async function settleRun(
  stateRoot: string,
  runId: string,
  manifest: RunManifest,
  heartbeat: Heartbeat | null,
  nowMs: number,
): Promise<RecoverOutcome> {
  const runDir = join(stateRoot, runId);
  const previousStatus = manifest.status;
  const recoveredManifest: RunManifest = { ...manifest, status: "paused" };
  try {
    await saveManifest(runDir, recoveredManifest);
    await appendLogEvent(runLogPath(stateRoot, runId), {
      ts: new Date(nowMs).toISOString(),
      type: "run_recovered_from_crash",
      runId,
      previousStatus,
      lastHeartbeatAt: heartbeat?.ts ?? null,
    });
    return {
      kind: "recovered",
      previousStatus,
      lastHeartbeatAt: heartbeat?.ts ?? null,
    };
  } catch (err) {
    return {
      kind: "skipped",
      reason: "write-failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
