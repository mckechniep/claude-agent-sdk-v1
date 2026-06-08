import type { TaskState } from "../types.js";

const TASK_BLOCK_RE = /###\s+task:\s+([0-9a-fA-F-]+)\s*\n([\s\S]*?)(?=\n###\s+task:|\n##\s|\n*$)/g;
const TITLE_RE = /\*\*Title:\*\*\s+(.+)/;
const CRITERIA_RE = /\*\*Acceptance criteria:\*\*\s*\n((?:\s*-\s+.+\n?)+)/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function parsePlan(markdown: string): TaskState[] {
  const tasks: TaskState[] = [];
  for (const match of markdown.matchAll(TASK_BLOCK_RE)) {
    const taskId = match[1];
    const body = match[2];
    if (!taskId || body === undefined) continue;
    if (!UUID_RE.test(taskId)) continue;
    const titleMatch = body.match(TITLE_RE);
    const criteriaMatch = body.match(CRITERIA_RE);
    const title = titleMatch?.[1]?.trim() ?? "Untitled task";
    const criteriaBlock = criteriaMatch?.[1] ?? "";
    const acceptanceCriteria = criteriaBlock
      .split("\n")
      .map((l) => l.replace(/^\s*-\s+/, "").trim())
      .filter(Boolean);
    tasks.push({
      taskId,
      title,
      acceptanceCriteria,
      status: "pending",
      attempts: 0,
      tokensUsed: 0,
      durationMs: 0,
    });
  }
  return tasks;
}
