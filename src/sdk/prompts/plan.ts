import type { StackProfile } from "../../stack/profiles/types.js";
import { renderPlanModeBlock, type Thoroughness } from "./iteration.js";

export interface PlanPromptInput {
  repoPath: string;
  repoName: string;
  stackProfile: StackProfile;
  proposalMarkdown: string;
  userNotes?: string;
  previousPlan?: string;
  iteration?: number;
  thoroughness?: Thoroughness;
}

export function renderPlanPrompt(input: PlanPromptInput): string {
  const iterationBlock = input.previousPlan
    ? `\n## Your previous plan\n\nA previous planning run produced the markdown below. Treat it as the baseline you are refining — preserve the task UUIDs for tasks that survive substantively unchanged, and only mint fresh UUIDs for tasks that are genuinely new or have shifted enough in scope that they should be re-executed from scratch. Tasks the user is removing must not reappear.\n\n---\n\n${input.previousPlan.trim()}\n\n---\n`
    : "";

  const notesBlock = input.userNotes
    ? `\n## User notes for this iteration\n\n${input.userNotes.trim()}\n`
    : "";

  const iteration = input.iteration ?? 1;
  const thoroughness: Thoroughness = input.thoroughness ?? "balanced";
  const modeBlock = renderPlanModeBlock(iteration, thoroughness);

  return `# Task: Convert an approved completion proposal into an executable plan

You are an expert engineer planning the work needed to complete a project. The completion proposal below has been approved by the user. Your job is to break it into concrete, atomic tasks that will be executed one at a time by a coding agent on its own branch.

## Approved completion proposal

${input.proposalMarkdown}

## Stack context

This repo is **${input.stackProfile.displayName}** (\`${input.stackProfile.id}\`). Default test command: \`${input.stackProfile.defaultTestCommand}\`.

## How to investigate

You have read-only \`Read\` access to the repository at \`${input.repoPath}\`. Use it sparingly — confirm file paths and module boundaries that the proposal references, but do not re-do the analyzer's work.

**Ignore the \`.agent/\` directory entirely.** It contains this orchestrator's state files (proposal, plan, run logs). Do not Read anything inside \`.agent/\`. If a \`plan.md\` is already present there, it's your previous output — do not Read it from disk; the previous plan (if any) is injected below.

**Do not edit, create, or commit anything.** This phase produces a plan; another agent will execute. Return the plan markdown as your final response and the orchestrator will persist it.

## Output format — STRICT

Output a markdown document with the following structure:

\`\`\`
# Plan — ${input.repoName}

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
${iterationBlock}${notesBlock}${modeBlock}

## Output

Return only the plan markdown. No preamble.`;
}
