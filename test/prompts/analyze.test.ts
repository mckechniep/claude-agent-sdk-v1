import { describe, expect, it } from "vitest";
import { renderAnalyzePrompt } from "../../src/sdk/prompts/analyze.js";
import { jstsProfile } from "../../src/stack/profiles/jsts.js";

describe("renderAnalyzePrompt", () => {
  it("renders the JS/TS variant correctly", () => {
    const out = renderAnalyzePrompt({
      repoPath: "/x/foo",
      repoName: "foo",
      stackProfile: jstsProfile,
      hasReadme: true,
      hasTests: true,
      lastCommitDate: "2026-04-01T00:00:00Z",
    });
    expect(out).toMatchInlineSnapshot(`
      "# Task: Analyze a code repository and propose what "completion" means

      You are an expert software engineer. Inspect the repository at \`/x/foo\` (named "foo") and produce a concise markdown document titled \`completion-proposal.md\` that captures:

      1. **Current state** — what this project appears to be, the major modules/files, what's implemented, what's stubbed.
      2. **Apparent intent** — what the README and code suggest the project is trying to become.
      3. **Proposed completion criteria** — concrete, testable bullet points describing what "v1 complete" would mean. Each bullet must be verifiable, not aspirational.
      4. **Out of scope** — what you are deliberately NOT including in completion (so the user can correct you).
      5. **Open questions** — anything ambiguous you would want the user to clarify.

      ## Stack context

      This repo was detected as: **JavaScript/TypeScript** (\`jsts\`).

      Conventions for this stack:
        1. Source typically lives in \`src/\` or \`app/\`.
        2. Tests typically use Jest, Vitest, Playwright, or node:test in \`test/\`, \`__tests__/\`, or co-located \`*.test.ts\`.
        3. Package manifest is \`package.json\`; lockfile choice indicates package manager (pnpm-lock.yaml/yarn.lock/package-lock.json).
        4. TypeScript projects have \`tsconfig.json\`; check \`compilerOptions.strict\`.
        5. Common build outputs: \`dist/\`, \`build/\`, \`.next/\`.

      ## Repository signals

      - README present: yes
      - Tests present: yes
      - Last commit: 2026-04-01T00:00:00Z

      ## How to investigate

      You have read-only tools available: \`Read\` for files, \`Bash\` for read-only commands like \`git log\`, \`git diff\`, \`grep\`, \`find\`.

      **Ignore the \`.agent/\` directory entirely.** It contains this orchestrator's state files (previous proposals, plans, run logs) and is not part of the repository's source. Do not Read anything inside \`.agent/\` and do not consider it part of the codebase.

      **Do not edit any files in the source tree.** Do not write the proposal to disk yourself — return it as your final response and the orchestrator will persist it to \`.agent/completion-proposal.md\`, overwriting any prior version. If a \`completion-proposal.md\` is already present there, that's expected: it's your previous output, and you should produce a fresh version (informed by the previous proposal and user notes below if provided).

      When in doubt about scope, prefer narrower completion criteria. The user will correct you. Don't pad with speculative features.

      ## Iteration 1 guidance (balanced, mode: normal)

      This is an early iteration. Produce the full proposal as usual; in section 5 list any genuine ambiguities you would want the user to clarify. If you have no remaining questions, write "None." — do not invent questions to fill the section.


      ## Output format

      Return only the completion-proposal markdown. No preamble, no postscript. Begin with \`# Completion Proposal — foo\` as the H1."
    `);
  });

  it("appends user notes when provided", () => {
    const out = renderAnalyzePrompt({
      repoPath: "/x/foo",
      repoName: "foo",
      stackProfile: jstsProfile,
      hasReadme: false,
      hasTests: false,
      lastCommitDate: null,
      userNotes: "Focus on the public CLI surface only.",
    });
    expect(out).toContain("Focus on the public CLI surface only.");
  });
});
