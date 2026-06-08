import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@anthropic-ai/claude-agent-sdk";
import { renderExecutePromptParts } from "../../src/sdk/prompts/execute.js";
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

describe("renderExecutePromptParts", () => {
  it("splits a stable systemPrompt prefix from a variable userPrompt", () => {
    const parts = renderExecutePromptParts({
      repoPath: "/x/foo",
      repoName: "foo",
      stackProfile: jstsProfile,
      task: baseTask,
    });

    // systemPrompt is an array ending with the boundary marker so the SDK
    // treats everything before it as the cacheable prefix.
    expect(parts.systemPrompt).toHaveLength(3);
    expect(parts.systemPrompt[2]).toBe(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    expect(parts.systemPrompt[0]).toContain("You are an expert engineer");
    expect(parts.systemPrompt[0]).toContain("Tools and permissions");
    expect(parts.systemPrompt[1]).toContain("Repository context");
    expect(parts.systemPrompt[1]).toContain('"foo"');
    expect(parts.systemPrompt[1]).toContain("JavaScript/TypeScript");
    // Per-task content lives in userPrompt only — never in systemPrompt.
    expect(parts.systemPrompt.join("\n")).not.toContain("Add foo");
    expect(parts.userPrompt).toContain("Add foo");
    expect(parts.userPrompt).toContain("foo() exists");
  });

  it("renders an identical systemPrompt prefix across tasks in the same repo (cache hit eligible)", () => {
    const a = renderExecutePromptParts({
      repoPath: "/x/foo",
      repoName: "foo",
      stackProfile: jstsProfile,
      task: baseTask,
    });
    const b = renderExecutePromptParts({
      repoPath: "/x/foo",
      repoName: "foo",
      stackProfile: jstsProfile,
      task: { ...baseTask, title: "Add bar", acceptanceCriteria: ["bar() exists"] },
    });
    expect(a.systemPrompt).toEqual(b.systemPrompt);
    expect(a.userPrompt).not.toEqual(b.userPrompt);
  });

  it("includes retry feedback in the userPrompt without polluting systemPrompt", () => {
    const parts = renderExecutePromptParts({
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
    expect(parts.userPrompt).toContain("PREVIOUS ATTEMPT FAILED");
    expect(parts.userPrompt).toContain("FAIL: foo not exported");
    expect(parts.userPrompt).toContain("src/foo.ts");
    expect(parts.systemPrompt.join("\n")).not.toContain("PREVIOUS ATTEMPT FAILED");
  });

  it("handles tasks with no acceptance criteria gracefully", () => {
    const parts = renderExecutePromptParts({
      repoPath: "/x/foo",
      repoName: "foo",
      stackProfile: jstsProfile,
      task: { ...baseTask, acceptanceCriteria: [] },
    });
    expect(parts.userPrompt).toContain("no explicit criteria");
  });
});
