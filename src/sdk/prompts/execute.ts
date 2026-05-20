import type { StackProfile } from "../../stack/profiles/types.js";
import type { TaskState } from "../../types.js";

export interface ExecuteRetryFeedback {
  previousFiles: string[];
  testCommand: string;
  testOutput: string;
  attemptNumber: number;
}

export interface ExecutePromptInput {
  repoPath: string;
  repoName: string;
  stackProfile: StackProfile;
  task: TaskState;
  retryFeedback?: ExecuteRetryFeedback;
}

export function renderExecutePrompt(input: ExecutePromptInput): string {
  const criteria =
    input.task.acceptanceCriteria.length === 0
      ? "  - (no explicit criteria — make the change described by the title)"
      : input.task.acceptanceCriteria.map((c) => `  - ${c}`).join("\n");

  const retryBlock = input.retryFeedback
    ? `\n## PREVIOUS ATTEMPT FAILED\n\nAttempt #${input.retryFeedback.attemptNumber} did not pass. Here's what we have:\n\n- Files modified: ${input.retryFeedback.previousFiles.join(", ") || "none"}\n- Test command: \`${input.retryFeedback.testCommand}\`\n- Test output (truncated to 4KB):\n\n\`\`\`\n${input.retryFeedback.testOutput.slice(0, 4096)}\n\`\`\`\n\nThings to consider:\n- The previous diff is preserved on the current branch as a WIP commit — review it before re-editing.\n- The test failure usually means the logic is wrong, not the structure.\n- If you believe the test itself is wrong, say so explicitly and stop without further edits.\n\nTry again. If you cannot fix it in this attempt, return a clear explanation of what's blocking and don't make further edits.\n`
    : "";

  return `# Task: Execute one plan task in repository "${input.repoName}"

You are an expert engineer. Make the minimal code edits required to satisfy the acceptance criteria below.

## Task

**Title:** ${input.task.title}

**Acceptance criteria:**
${criteria}

## Stack context

This repo is **${input.stackProfile.displayName}** (\`${input.stackProfile.id}\`). Default test command: \`${input.stackProfile.defaultTestCommand}\`.

## Tools and permissions

You have: \`Read\`, \`Write\`, \`Edit\`, \`Bash\`.

**You may NOT run \`git commit\`, \`git push\`, \`git reset --hard\`, \`git checkout <branch>\`, or any other branch-mutating git command.** The orchestrator owns branching and committing. You may use read-only git operations (\`git log\`, \`git diff\`, \`git status\`) and you may use \`git add\` to stage if you want, but the actual commit is performed by the orchestrator after your work passes the test gate.

**Ignore the \`.agent/\` directory entirely** — it is orchestrator state, not source. Do not Read, Edit, or Write anything inside it.

## How to work

1. Read enough of the codebase to understand the change in context.
2. Make the smallest edits that satisfy the acceptance criteria. Prefer \`Edit\` for existing files; use \`Write\` only when creating a new file.
3. If the project has a test runner, run it via Bash and iterate until it passes (or you've made the targeted change and the tests are unrelated). The orchestrator will re-run tests after you return.
4. When you believe the work is complete, return a short summary of what you changed and which files you touched.

If a task seems wrong (e.g., asks for something the codebase already does, or contradicts itself), say so and stop instead of making bad edits.
${retryBlock}`;
}
