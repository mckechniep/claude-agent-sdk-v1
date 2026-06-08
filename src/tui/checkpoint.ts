import { select } from "@inquirer/prompts";
import type { TaskState } from "../types.js";

export type CheckpointAction = "continue" | "skip" | "edit" | "quit" | "view";

export interface CheckpointInput {
  task: TaskState;
  filesChanged: string[];
  diffText: string;
}

export async function checkpoint(input: CheckpointInput): Promise<CheckpointAction> {
  process.stdout.write(formatCheckpointSummary(input));
  while (true) {
    const action = await select<CheckpointAction>({
      message: "What's next?",
      choices: [
        { name: "Continue to next task", value: "continue" },
        { name: "Skip remaining tasks for this repo", value: "skip" },
        { name: "View full diff", value: "view" },
        { name: "Edit plan in $EDITOR", value: "edit" },
        { name: "Quit (run will be paused)", value: "quit" },
      ],
    });
    if (action === "view") {
      process.stdout.write("\n----- diff -----\n" + input.diffText + "\n----------------\n");
      continue;
    }
    return action;
  }
}

export function formatCheckpointSummary(input: CheckpointInput): string {
  const head = `\n[checkpoint] task ${input.task.taskId.slice(0, 8)} — ${input.task.title}`;
  const stats = `   files changed: ${input.filesChanged.length}, tokens: ${input.task.tokensUsed}, duration: ${Math.round(input.task.durationMs / 1000)}s`;
  const sha = input.task.commitSha ? `   commit: ${input.task.commitSha.slice(0, 8)}` : "";
  return [head, stats, sha].filter(Boolean).join("\n") + "\n";
}
