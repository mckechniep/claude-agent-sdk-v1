import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic, isErrnoCode } from "./atomicWrite.js";

// Filename chosen to sort to the top of `ls` and to clearly read as
// metadata rather than user data. Lives inside the per-run state dir
// alongside manifest.json and run-log.jsonl.
const HEARTBEAT_FILENAME = ".heartbeat";

export interface Heartbeat {
  ts: string;
  runId: string;
}

export function heartbeatPath(runDir: string): string {
  return join(runDir, HEARTBEAT_FILENAME);
}

export async function writeHeartbeat(runDir: string, runId: string): Promise<void> {
  const payload: Heartbeat = { ts: new Date().toISOString(), runId };
  await writeAtomic(heartbeatPath(runDir), JSON.stringify(payload));
}

/**
 * Returns the last-written heartbeat for a run, or null if no heartbeat
 * has ever been written (e.g. a manual-autonomy run that never started a
 * background loop, or a pre-heartbeat run from before this feature).
 *
 * Treats a malformed file as "no heartbeat" rather than throwing — the
 * file is metadata, not user-visible data, and the caller's downstream
 * logic (liveness pill, recovery sweep) can handle null cleanly.
 */
export async function readHeartbeat(runDir: string): Promise<Heartbeat | null> {
  try {
    const raw = await readFile(heartbeatPath(runDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<Heartbeat>;
    if (typeof parsed.ts !== "string" || typeof parsed.runId !== "string") return null;
    return { ts: parsed.ts, runId: parsed.runId };
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return null;
    return null;
  }
}

/**
 * Returns true when the most recent heartbeat is older than `maxAgeMs`.
 * A null heartbeat (run never had one) is treated as stale.
 */
export function isHeartbeatStale(
  heartbeat: Heartbeat | null,
  maxAgeMs: number,
  nowMs: number = Date.now(),
): boolean {
  if (!heartbeat) return true;
  const heartbeatMs = Date.parse(heartbeat.ts);
  if (!Number.isFinite(heartbeatMs)) return true;
  return nowMs - heartbeatMs > maxAgeMs;
}
