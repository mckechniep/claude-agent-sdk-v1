import type { StackProfile } from "../../stack/profiles/types.js";
import { renderAnalyzeModeBlock, type Thoroughness } from "./iteration.js";

export interface AnalyzePromptInput {
  repoPath: string;
  repoName: string;
  stackProfile: StackProfile;
  hasReadme: boolean;
  hasTests: boolean;
  lastCommitDate: string | null;
  userNotes?: string;
  previousProposal?: string;
  iteration?: number;
  thoroughness?: Thoroughness;
  // When true, force the convergence ("defaults") mode regardless of
  // iteration: incorporate the user's notes, stop asking questions.
  finalize?: boolean;
}

export function renderAnalyzePrompt(input: AnalyzePromptInput): string {
  const conventionsBlock = input.stackProfile.conventions
    .map((c, i) => `  ${i + 1}. ${c}`)
    .join("\n");

  const iterationBlock = input.previousProposal
    ? `\n## Your previous proposal\n\nA previous analysis run produced the markdown below. Treat this as the baseline you are refining — do not re-derive everything from scratch. Incorporate the user's notes (next section), keep what's still correct, and update what they're pushing back on. The orchestrator will overwrite the existing \`completion-proposal.md\` with your new output; you are not editing the file on disk.\n\n---\n\n${input.previousProposal.trim()}\n\n---\n`
    : "";

  const notesBlock = input.userNotes
    ? `\n## User notes for this iteration\n\n${input.userNotes.trim()}\n`
    : "";

  const iteration = input.iteration ?? 1;
  const thoroughness: Thoroughness = input.thoroughness ?? "balanced";
  const modeBlock = renderAnalyzeModeBlock(iteration, thoroughness, input.finalize);

  return `# Task: Analyze a code repository and propose what "completion" means

You are an expert software engineer. Inspect the repository at \`${input.repoPath}\` (named "${input.repoName}") and produce a concise markdown document titled \`completion-proposal.md\` that captures:

1. **Current state** — what this project appears to be, the major modules/files, what's implemented, what's stubbed.
2. **Apparent intent** — what the README and code suggest the project is trying to become.
3. **Target milestone** — the next semver milestone this proposal aims at (see "Versioning context" below for how to pick it). State the version explicitly, e.g., \`Target: 0.4.0\` or \`Target: 1.0.0-beta.1\`.
4. **Proposed completion criteria** — concrete, testable bullet points describing what shipping the target milestone in (3) would mean. Frame criteria relative to that milestone, not "v1" or other generic version labels. Each bullet must be verifiable, not aspirational.
5. **Out of scope** — what you are deliberately NOT including in this milestone (so the user can correct you). Items here are candidates for a later version, not this one.
6. **Open questions** — anything ambiguous you would want the user to clarify.

## Versioning context

Detect the project's current version before proposing a milestone:

- Read \`package.json\` / \`Cargo.toml\` / \`pyproject.toml\` / \`Gemfile\` / etc. for a declared \`version\` field.
- If unset or absent, run \`git tag --list --sort=-v:refname\` to find the most recent release tag (strip a leading \`v\` if present).
- If neither exists, treat the project as pre-versioned and target \`0.1.0\` as the first meaningful milestone.

Pick the **next milestone** using this phase ladder (the user follows strict semver — pre-1.0 stays at major 0, then alpha → beta → rc → 1.0.0, then standard MAJOR.MINOR.PATCH):

| Currently at | Next milestone candidates | Pick when |
|---|---|---|
| pre-versioned / no tags | \`0.1.0\` | first meaningful scaffold ships |
| \`0.x.y\` | \`0.{x+1}.0\` | a feature batch lands (default) |
| \`0.x.y\` | \`1.0.0-alpha.1\` | project feels feature-complete-ish, ready for internal testing |
| \`1.0.0-alpha.N\` | \`1.0.0-alpha.{N+1}\` | another alpha round (default during alpha) |
| \`1.0.0-alpha.N\` | \`1.0.0-beta.1\` | API has stabilized, opening to external beta users |
| \`1.0.0-beta.N\` | \`1.0.0-beta.{N+1}\` | another beta round (default during beta) |
| \`1.0.0-beta.N\` | \`1.0.0-rc.1\` | feature-frozen, final QA |
| \`1.0.0-rc.N\` | \`1.0.0\` | would ship if nothing critical breaks |
| \`MAJOR.MINOR.PATCH\` (≥ 1.0.0) | \`MAJOR.{MINOR+1}.0\` | new backwards-compatible feature batch (default) |
| \`MAJOR.MINOR.PATCH\` (≥ 1.0.0) | \`MAJOR.MINOR.{PATCH+1}\` | only bug fixes / internal refactor |
| \`MAJOR.MINOR.PATCH\` (≥ 1.0.0) | \`{MAJOR+1}.0.0\` | the proposal requires breaking changes to public API |

**Default to the more conservative bump** unless the project's state clearly justifies a phase transition. Skipping ahead (e.g., 0.x → 1.0.0 directly without alpha/beta/rc) requires explicit user signal and should be flagged in Open questions.

## Stack context

This repo was detected as: **${input.stackProfile.displayName}** (\`${input.stackProfile.id}\`).

Conventions for this stack:
${conventionsBlock}

## Repository signals

- README present: ${input.hasReadme ? "yes" : "no"}
- Tests present: ${input.hasTests ? "yes" : "no"}
- Last commit: ${input.lastCommitDate ?? "unknown"}

## How to investigate

You have read-only tools available: \`Read\` for files, \`Bash\` for read-only commands like \`git log\`, \`git diff\`, \`grep\`, \`find\`.

**Ignore the \`.agent/\` directory entirely.** It contains this orchestrator's state files (previous proposals, plans, run logs) and is not part of the repository's source. Do not Read anything inside \`.agent/\` and do not consider it part of the codebase.

**Do not edit any files in the source tree.** Do not write the proposal to disk yourself — return it as your final response and the orchestrator will persist it to \`.agent/completion-proposal.md\`, overwriting any prior version. If a \`completion-proposal.md\` is already present there, that's expected: it's your previous output, and you should produce a fresh version (informed by the previous proposal and user notes below if provided).

When in doubt about scope, prefer narrower completion criteria. The user will correct you. Don't pad with speculative features.
${iterationBlock}${notesBlock}${modeBlock}

## Output format

Return only the completion-proposal markdown. No preamble, no postscript. Begin with \`# Completion Proposal — ${input.repoName}\` as the H1.`;
}
