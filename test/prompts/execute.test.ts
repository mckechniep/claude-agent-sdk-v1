import { describe, expect, it } from "vitest";
import { renderExecutePrompt } from "../../src/sdk/prompts/execute.js";
import { jstsProfile } from "../../src/stack/profiles/jsts.js";
import type { TaskState } from "../../src/types.js";

const baseTask: TaskState = {
  taskId: "11111111-1111-1111-1111-111111111111",
  title: "Add foo",
  acceptanceCriteria: ["foo() exists", "foo() is exported"],
  status: "pending",
  attempts: 0,
  tokensUsed: 0,
  durationMs: 0,
};

describe("renderExecutePrompt", () => {
  it("renders without retry feedback", () => {
    const out = renderExecutePrompt({
      repoPath: "/x/foo",
      repoName: "foo",
      stackProfile: jstsProfile,
      task: baseTask,
    });
    expect(out).toMatchInlineSnapshot(`
      "# Task: Execute one plan task in repository "foo"

      You are an expert engineer. Make the minimal code edits required to satisfy the acceptance criteria below.

      ## Task

      **Title:** Add foo

      **Acceptance criteria:**
        - foo() exists
        - foo() is exported

      ## Stack context

      This repo is **JavaScript/TypeScript** (\`jsts\`). Default test command: \`pnpm test --run\`.

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
      "
    `);
  });

  it("includes retry feedback when provided", () => {
    const out = renderExecutePrompt({
      repoPath: "/x/foo",
      repoName: "foo",
      stackProfile: jstsProfile,
      task: baseTask,
      retryFeedback: {
        previousFiles: ["src/foo.ts"],
        testCommand: "pnpm test",
        testOutput: "FAIL: foo not exported",
        attemptNumber: 1,
      },
    });
    expect(out).toContain("PREVIOUS ATTEMPT FAILED");
    expect(out).toContain("FAIL: foo not exported");
    expect(out).toContain("src/foo.ts");
  });

  it("handles tasks with no acceptance criteria gracefully", () => {
    const out = renderExecutePrompt({
      repoPath: "/x/foo",
      repoName: "foo",
      stackProfile: jstsProfile,
      task: { ...baseTask, acceptanceCriteria: [] },
    });
    expect(out).toContain("no explicit criteria");
  });
});
