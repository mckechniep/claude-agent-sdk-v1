import type { StackProfile } from "../../stack/profiles/types.js";

export interface AnalyzePromptInput {
  repoPath: string;
  repoName: string;
  stackProfile: StackProfile;
  hasReadme: boolean;
  hasTests: boolean;
  lastCommitDate: string | null;
  userNotes?: string;
  previousProposal?: string;
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

  return `# Task: Analyze a code repository and propose what "completion" means

You are an expert software engineer. Inspect the repository at \`${input.repoPath}\` (named "${input.repoName}") and produce a concise markdown document titled \`completion-proposal.md\` that captures:

1. **Current state** — what this project appears to be, the major modules/files, what's implemented, what's stubbed.
2. **Apparent intent** — what the README and code suggest the project is trying to become.
3. **Proposed completion criteria** — concrete, testable bullet points describing what "v1 complete" would mean. Each bullet must be verifiable, not aspirational.
4. **Out of scope** — what you are deliberately NOT including in completion (so the user can correct you).
5. **Open questions** — anything ambiguous you would want the user to clarify.

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
${iterationBlock}${notesBlock}

## Output format

Return only the completion-proposal markdown. No preamble, no postscript. Begin with \`# Completion Proposal — ${input.repoName}\` as the H1.`;
}
