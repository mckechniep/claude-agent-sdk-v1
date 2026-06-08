import { appendFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { LogEventSchema, type LogEvent } from "../types.js";

export function runLogPath(stateRoot: string, runId: string): string {
  return join(stateRoot, runId, "run-log.jsonl");
}

// Single-event JSON lines (~200 bytes typical) are well under PIPE_BUF (4096),
// so concurrent appendFile calls are atomic at the line level on POSIX. The
// orchestrator runs single-process anyway, but this invariant is what makes
// the JSONL audit-trail safe even under future fan-out.
export async function appendLogEvent(path: string, event: LogEvent): Promise<void> {
  const line = JSON.stringify(event) + "\n";
  await appendFile(path, line);
}

// TODO(observability): track and surface schema-rejected event count separately
// from JSON-parse failures. JSON parse fail = corrupt/partial line (last-line
// crash tolerance, expected). Schema fail = forward-compat or stale event shape
// (worth surfacing once lib/log.ts exists).
export async function readLogEvents(path: string): Promise<LogEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: LogEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      const validated = LogEventSchema.safeParse(parsed);
      if (validated.success) out.push(validated.data);
    } catch {
      // skip malformed lines (last-line-corruption tolerance)
    }
  }
  return out;
}

export interface LogTail {
  events: LogEvent[];
  nextByte: number;
  fileExists: boolean;
}

// Byte-cursored replay for HTTP callers. Returns only events whose terminating
// newline falls within [fromByte, EOF); nextByte is the offset of the byte
// *after* the last consumed newline (or fromByte if no newline was seen yet).
// This makes the cursor resync-safe across partial appends and torn writes.
export async function readLogTailFromByte(path: string, fromByte: number): Promise<LogTail> {
  let size: number;
  try {
    const s = await stat(path);
    size = s.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { events: [], nextByte: fromByte, fileExists: false };
    }
    throw err;
  }

  if (fromByte >= size) {
    return { events: [], nextByte: fromByte, fileExists: true };
  }

  const start = Math.max(0, fromByte);
  const buf = await readFile(path);
  const tail = buf.subarray(start, size);
  const lastNewline = tail.lastIndexOf(0x0a /* \n */);
  if (lastNewline < 0) {
    // No complete line yet beyond fromByte — caller should poll again.
    return { events: [], nextByte: fromByte, fileExists: true };
  }

  const complete = tail.subarray(0, lastNewline).toString("utf8");
  const events: LogEvent[] = [];
  for (const line of complete.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      const validated = LogEventSchema.safeParse(parsed);
      if (validated.success) events.push(validated.data);
    } catch {
      // skip malformed lines (last-line-corruption tolerance)
    }
  }
  return { events, nextByte: start + lastNewline + 1, fileExists: true };
}
