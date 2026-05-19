import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plan } from "../../../src/phases/plan.js";
import { jstsProfile } from "../../../src/stack/profiles/jsts.js";
import { BudgetTracker } from "../../../src/orchestrator/budget.js";

const SAMPLE_PLAN = `# Plan — foo

## Summary

Two tasks.

## Tasks

### task: 11111111-1111-1111-1111-111111111111
**Title:** First task

**Acceptance criteria:**
- works

**Dependencies:** none
**Estimated effort:** small

---

### task: 22222222-2222-2222-2222-222222222222
**Title:** Second task

**Acceptance criteria:**
- also works

**Dependencies:** none
**Estimated effort:** small
`;

describe("plan", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "plan-"));
    await mkdir(join(repo, ".git"), { recursive: true });
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("calls SDK with Read-only allowlist and parses returned plan", async () => {
    const fakeQuery = vi.fn(async function* () {
      yield {
        type: "result",
        result: SAMPLE_PLAN,
        usage: { input_tokens: 800, output_tokens: 400 },
      };
    });
    const tracker = new BudgetTracker({});
    const result = await plan({
      repoPath: repo,
      repoName: "foo",
      stackProfile: jstsProfile,
      proposalMarkdown: "# Completion Proposal — foo\n\nbody",
      tracker,
      queryFn: fakeQuery as never,
    });
    const firstCall = fakeQuery.mock.calls[0] as unknown as
      | [{ options: { allowedTools: string[] } }]
      | undefined;
    if (!firstCall) throw new Error("expected fakeQuery to be called");
    expect(firstCall[0].options.allowedTools).toEqual(["Read"]);

    expect(result.taskCount).toBe(2);
    expect(result.tasks[0].title).toBe("First task");
    expect(result.tasks[1].title).toBe("Second task");
    expect(result.estimatedTokens).toBe(2 * 30_000);
    expect(result.estimatedDurationMs).toBe(2 * 60_000);
    expect(result.tokensUsed).toBe(1200);
    expect(result.planPath).toBe(join(repo, ".agent", "plan.md"));
    const onDisk = await readFile(result.planPath, "utf8");
    expect(onDisk).toContain("First task");
  });

  it("threads the previous plan into the prompt on iteration", async () => {
    // Seed an existing plan.md so planStream picks it up.
    await mkdir(join(repo, ".agent"), { recursive: true });
    await writeFile(
      join(repo, ".agent", "plan.md"),
      "# Plan — foo\n\n## Tasks\n\n### task: aaaa\n**Title:** prior\n",
    );

    let capturedPrompt = "";
    const fakeQuery = vi.fn(async function* (args: unknown) {
      capturedPrompt = String((args as { prompt: string }).prompt);
      yield {
        type: "result",
        result: SAMPLE_PLAN,
        usage: { input_tokens: 800, output_tokens: 400 },
      };
    });

    await plan({
      repoPath: repo,
      repoName: "foo",
      stackProfile: jstsProfile,
      proposalMarkdown: "# Completion Proposal — foo\n\nbody",
      tracker: new BudgetTracker({}),
      userNotes: "Split task 2",
      queryFn: fakeQuery as never,
    });

    expect(capturedPrompt).toContain("Your previous plan");
    expect(capturedPrompt).toContain("### task: aaaa");
    expect(capturedPrompt).toContain("Split task 2");
  });
});
