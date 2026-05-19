import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze } from "../../../src/phases/analyze.js";
import { jstsProfile } from "../../../src/stack/profiles/jsts.js";
import { BudgetTracker } from "../../../src/orchestrator/budget.js";

describe("analyze", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "analyze-"));
    await mkdir(join(repo, ".git"), { recursive: true });
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("calls the SDK with correct allowlist and writes the proposal", async () => {
    const fakeQuery = vi.fn(async function* () {
      yield {
        type: "result",
        result: "# Completion Proposal — foo\n\nstuff",
        usage: { input_tokens: 1000, output_tokens: 500 },
      };
    });
    const tracker = new BudgetTracker({});
    const result = await analyze({
      repoPath: repo,
      repoName: "foo",
      stackProfile: jstsProfile,
      hasReadme: true,
      hasTests: true,
      lastCommitDate: null,
      tracker,
      queryFn: fakeQuery as never,
    });

    expect(fakeQuery).toHaveBeenCalledTimes(1);
    const firstCall = fakeQuery.mock.calls[0] as unknown as
      | [{ options: { allowedTools: string[] } }]
      | undefined;
    if (!firstCall) throw new Error("expected fakeQuery to be called");
    expect(firstCall[0].options.allowedTools).toEqual(["Read", "Bash"]);

    expect(result.proposalPath).toBe(join(repo, ".agent", "completion-proposal.md"));
    expect(result.tokensUsed).toBe(1500);
    const content = await readFile(result.proposalPath, "utf8");
    expect(content).toContain("# Completion Proposal");
  });
});
