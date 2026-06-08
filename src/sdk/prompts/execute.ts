import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@anthropic-ai/claude-agent-sdk";
import type { StackProfile } from "../../stack/profiles/types.js";
import type { TaskState } from "../../types.js";

export interface ExecuteRetryFeedback {
  // Why the previous attempt failed. "no-changes" needs a different nudge than
  // "test-failure": the agent didn't write anything, so framing it as a logic
  // bug (the test-failure prose) misleads it. See renderRetryBlock.
  kind: "no-changes" | "test-failure";
  previousFiles: string[];
  testCommand: string;
  testOutput: string;
  // The agent's final message from the previous attempt — surfaced back so a
  // hallucinated completion ("I've documented X…" with no Write call) is visible.
  previousFinalText: string;
  attemptNumber: number;
}

export interface ExecutePromptInput {
  repoPath: string;
  repoName: string;
  stackProfile: StackProfile;
  task: TaskState;
  retryFeedback?: ExecuteRetryFeedback;
}

export interface ExecutePromptParts {
  systemPrompt: string[];
  userPrompt: string;
}

const UNIVERSAL_INSTRUCTIONS = `You are an expert engineer working on one plan task at a time inside a git repository.

## Behavior

- Make the minimal code edits required to satisfy each task's acceptance criteria.
- Read enough of the codebase to understand the change in context.
- Make the smallest edits that satisfy the criteria. Prefer \`Edit\` for existing files; use \`Write\` only when creating a new file.
- If the project has a test runner, run it via Bash and iterate until it passes (or you've made the targeted change and the tests are unrelated). The orchestrator will re-run tests after you return.
- When you believe the work is complete, return a short summary of what you changed and which files you touched.
- If a task seems wrong (e.g., asks for something the codebase already does, or contradicts itself), say so and stop instead of making bad edits.

## Tools and permissions

You have: \`Read\`, \`Write\`, \`Edit\`, \`Bash\`.

**You may NOT run \`git commit\`, \`git push\`, \`git reset --hard\`, \`git checkout <branch>\`, or any other branch-mutating git command.** The orchestrator owns branching and committing. You may use read-only git operations (\`git log\`, \`git diff\`, \`git status\`) and you may use \`git add\` to stage if you want, but the actual commit is performed by the orchestrator after your work passes the test gate.

**Ignore the \`.agent/\` directory entirely** — it is orchestrator state, not source. Do not Read, Edit, or Write anything inside it.`;

function renderRepoContext(repoName: string, stackProfile: StackProfile): string {
  return `## Repository context

You are working in repository **"${repoName}"**.
Stack: **${stackProfile.displayName}** (\`${stackProfile.id}\`). Default test command: \`${stackProfile.defaultTestCommand}\`.`;
}

function renderRetryBlock(feedback: ExecuteRetryFeedback): string {
  if (feedback.kind === "no-changes") {
    const said = feedback.previousFinalText.trim();
    const saidBlock = said
      ? `\nYour previous final message was:\n\n\`\`\`\n${said.slice(0, 2048)}\n\`\`\`\n`
      : "";
    return `\n## PREVIOUS ATTEMPT MADE NO FILE CHANGES\n\nAttempt #${feedback.attemptNumber} reported completion but the working tree was left unchanged — you described the work but never actually created or edited any files on disk.\n${saidBlock}\nThis time you MUST use the \`Write\`/\`Edit\` tools to make the changes. Do not just summarize what should be done — do it, file by file. If a required file is large, read it in focused chunks rather than all at once so you don't exhaust your context before writing. If something genuinely prevents you from writing, state exactly what and stop — do not claim completion without edits.\n`;
  }
  return `\n## PREVIOUS ATTEMPT FAILED\n\nAttempt #${feedback.attemptNumber} did not pass. Here's what we have:\n\n- Files modified: ${feedback.previousFiles.join(", ") || "none"}\n- Test command: \`${feedback.testCommand}\`\n- Test output (truncated to 4KB):\n\n\`\`\`\n${feedback.testOutput.slice(0, 4096)}\n\`\`\`\n\nThings to consider:\n- The previous diff is preserved on the current branch as a WIP commit — review it before re-editing.\n- The test failure usually means the logic is wrong, not the structure.\n- If you believe the test itself is wrong, say so explicitly and stop without further edits.\n\nTry again. If you cannot fix it in this attempt, return a clear explanation of what's blocking and don't make further edits.\n`;
}

function renderUserPrompt(input: ExecutePromptInput): string {
  const criteria =
    input.task.acceptanceCriteria.length === 0
      ? "  - (no explicit criteria — make the change described by the title)"
      : input.task.acceptanceCriteria.map((c) => `  - ${c}`).join("\n");

  const retryBlock = input.retryFeedback ? renderRetryBlock(input.retryFeedback) : "";

  return `# Task

**Title:** ${input.task.title}

**Acceptance criteria:**
${criteria}
${retryBlock}`;
}

export function renderExecutePromptParts(input: ExecutePromptInput): ExecutePromptParts {
  return {
    systemPrompt: [
      UNIVERSAL_INSTRUCTIONS,
      renderRepoContext(input.repoName, input.stackProfile),
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    ],
    userPrompt: renderUserPrompt(input),
  };
}
