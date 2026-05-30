import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

// Per-task SDK transcript: the full message stream for one execute task, as
// JSONL, under runs/<runId>/transcripts/<taskId>.jsonl. This is the deep-debug
// artifact the run-log deliberately omits — when an execute task fails (e.g.
// "no file changes"), this is where you see exactly what the agent read, ran,
// and said across every attempt. One line per entry (~PIPE_BUF-safe like the
// run-log), so concurrent task transcripts never interleave a single line.

export function transcriptPath(runDir: string, taskId: string): string {
  return join(runDir, "transcripts", `${taskId}.jsonl`);
}

export async function ensureTranscriptDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

export async function appendTranscript(filePath: string, entry: unknown): Promise<void> {
  await appendFile(filePath, JSON.stringify(entry) + "\n");
}
