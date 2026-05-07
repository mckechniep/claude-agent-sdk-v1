import { appendFile, readFile } from "node:fs/promises";
import { LogEventSchema, type LogEvent } from "../types.js";

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
