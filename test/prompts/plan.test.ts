import { describe, expect, it } from "vitest";
import { renderPlanPrompt } from "../../src/sdk/prompts/plan.js";
import { jstsProfile } from "../../src/stack/profiles/jsts.js";

describe("renderPlanPrompt", () => {
  it("renders the JS/TS variant correctly", () => {
    const out = renderPlanPrompt({
      repoPath: "/x/foo",
      repoName: "foo",
      stackProfile: jstsProfile,
      proposalMarkdown: "# Completion Proposal — foo\n\nbody",
    });
    expect(out).toMatchInlineSnapshot(`
      "# Task: Convert an approved completion proposal into an executable plan

      You are an expert engineer planning the work needed to complete a project. The completion proposal below has been approved by the user. Your job is to break it into concrete, atomic tasks that will be executed one at a time by a coding agent on its own branch.

      ## Approved completion proposal

      # Completion Proposal — foo

      body

      ## Stack context

      This repo is **JavaScript/TypeScript** (\`jsts\`). Default test command: \`pnpm test --run\`.

      ## How to investigate

      You have read-only \`Read\` access to the repository at \`/x/foo\`. Use it sparingly — confirm file paths and module boundaries that the proposal references, but do not re-do the analyzer's work.

      **Ignore the \`.agent/\` directory entirely.** It contains this orchestrator's state files (proposal, plan, run logs). Do not Read anything inside \`.agent/\`. If a \`plan.md\` is already present there, it's your previous output — do not Read it from disk; the previous plan (if any) is injected below.

      **Do not edit, create, or commit anything.** This phase produces a plan; another agent will execute. Return the plan markdown as your final response and the orchestrator will persist it.

      ## Output format — STRICT

      Output a markdown document with the following structure:

      \`\`\`
      # Plan — foo

      ## Summary

      <one paragraph summarizing the plan>

      ## Tasks

      ### task: <UUIDv4>
      **Title:** <imperative one-line title>

      **Acceptance criteria:**
      - <criterion 1, testable>
      - <criterion 2, testable>

      **Dependencies:** none | <list other task UUIDs>

      **Estimated effort:** small | medium | large

      ---

      ### task: <UUIDv4>
      ...
      \`\`\`

      ## Constraints

      - Each task must be independently committable. Do not create tasks that span multiple commits.
      - Acceptance criteria must be verifiable by reading code or running tests, not subjective judgment.
      - Each task should target less than 1 hour of equivalent dev work.
      - Generate fresh UUIDv4 strings for each new task — do NOT reuse IDs across unrelated tasks. When refining a previous plan, preserve the UUID of any task whose intent is unchanged.
      - The full plan should have between 3 and 30 tasks. Bias toward fewer, larger tasks over many tiny ones.
      - Tools available to you: \`Read\` only. **You may not edit, create, or commit anything.**


      ## Output

      Return only the plan markdown. No preamble."
    `);
  });

  it("appends user notes when provided", () => {
    const out = renderPlanPrompt({
      repoPath: "/x/foo",
      repoName: "foo",
      stackProfile: jstsProfile,
      proposalMarkdown: "# Completion Proposal — foo\n\nbody",
      userNotes: "Split task 3 into two smaller commits.",
    });
    expect(out).toContain("Split task 3 into two smaller commits.");
  });

  it("includes the previous plan when iterating", () => {
    const previous = "# Plan — foo\n\n## Tasks\n\n### task: abc\n**Title:** old\n";
    const out = renderPlanPrompt({
      repoPath: "/x/foo",
      repoName: "foo",
      stackProfile: jstsProfile,
      proposalMarkdown: "# Completion Proposal — foo\n\nbody",
      previousPlan: previous,
    });
    expect(out).toContain("Your previous plan");
    expect(out).toContain("### task: abc");
  });
});
