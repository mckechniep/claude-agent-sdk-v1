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
      - The full plan should have between 3 and 30 tasks. Prefer fewer, larger tasks for self-contained code changes — but never let a single task require reading large swaths of the repo at once (see the next constraint).
      - **Budget each task's _reading_ cost, not only its writing cost.** Every task is executed by a *fresh* agent with an empty context window: it must re-read everything it needs from scratch, and the repo keeps growing as earlier tasks land. A task that has to survey many files or the whole API surface in one go will exhaust its context window (autocompact thrashing) and fail without writing anything. Split read-heavy or cross-cutting work by surface area so each task is completable from a bounded slice of the repo:
        - Documentation: one task per document or area (e.g. separate tasks for the README, the data-model docs, and the admin/API docs) — never a single "write all the docs" task.
        - Broad test suites: split by module or feature area, not one task that exercises everything at once.
        - Sweeping refactors or renames: split by package or directory.
      - Tools available to you: \`Read\` only. **You may not edit, create, or commit anything.**

      ## Iteration 1 guidance (balanced, mode: normal)

      This is an early iteration. Produce the plan; if the user's notes ask for changes, apply them. If the proposal has genuine ambiguity about HOW to slice tasks, you may include a brief "## Open questions" section at the end of the plan to surface them.


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
