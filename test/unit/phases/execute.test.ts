import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { execute } from "../../../src/phases/execute.js";
import { jstsProfile } from "../../../src/stack/profiles/jsts.js";
import { BudgetTracker } from "../../../src/orchestrator/budget.js";
import { getCurrentBranch } from "../../../src/lib/git.js";
import type { TaskState } from "../../../src/types.js";

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "exec-"));
  const g = simpleGit(dir);
  await g.init();
  await g.addConfig("user.email", "test@example.com");
  await g.addConfig("user.name", "test");
  await writeFile(join(dir, "a.txt"), "hello");
  await g.add(".").commit("init");
  return dir;
}

const baseTask: TaskState = {
  taskId: "11111111-1111-1111-1111-111111111111",
  title: "T",
  acceptanceCriteria: [],
  status: "pending",
  attempts: 0,
  tokensUsed: 0,
  durationMs: 0,
};

describe("execute", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeRepo();
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("commits successfully when agent makes edits (test gate disabled)", async () => {
    const fakeQuery = vi.fn(async function* () {
      await writeFile(join(repo, "b.txt"), "edit");
      yield {
        type: "result",
        result: "done",
        usage: { input_tokens: 100, output_tokens: 50 },
      };
    });
    const tracker = new BudgetTracker({});
    const result = await execute({
      repoPath: repo,
      repoName: "x",
      stackProfile: jstsProfile,
      task: baseTask,
      tracker,
      maxRetries: 0,
      testGateEnabled: false,
      testCommand: "",
      testTimeoutMs: 5000,
      queryFn: fakeQuery as never,
    });
    expect(result.status).toBe("completed");
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.attempts).toBe(1);
    expect(result.tokensUsed).toBe(150);
    expect(result.filesChanged).toContain("b.txt");
    expect(await getCurrentBranch(repo)).toBe("agent/11111111");
  });

  it("fails task when agent makes no edits and no retries are left", async () => {
    const fakeQuery = vi.fn(async function* () {
      yield {
        type: "result",
        result: "claimed done",
        usage: { input_tokens: 50, output_tokens: 25 },
      };
    });
    const tracker = new BudgetTracker({});
    const result = await execute({
      repoPath: repo,
      repoName: "x",
      stackProfile: jstsProfile,
      task: baseTask,
      tracker,
      maxRetries: 0,
      testGateEnabled: false,
      testCommand: "",
      testTimeoutMs: 5000,
      queryFn: fakeQuery as never,
    });
    expect(result.status).toBe("failed");
    expect(result.failureReason).toMatch(/no file changes/i);
    expect(result.attempts).toBe(1);
  });

  it("retries when attempt 1 produces no changes and succeeds on attempt 2", async () => {
    let call = 0;
    const fakeQuery = vi.fn(async function* () {
      call += 1;
      if (call === 2) {
        await writeFile(join(repo, "late.txt"), "fixed");
      }
      yield {
        type: "result",
        result: call === 1 ? "I had no idea" : "fixed it",
        usage: { input_tokens: 100, output_tokens: 50 },
      };
    });
    const tracker = new BudgetTracker({});
    const result = await execute({
      repoPath: repo,
      repoName: "x",
      stackProfile: jstsProfile,
      task: baseTask,
      tracker,
      maxRetries: 1,
      testGateEnabled: false,
      testCommand: "",
      testTimeoutMs: 5000,
      queryFn: fakeQuery as never,
    });
    expect(result.status).toBe("completed");
    expect(result.attempts).toBe(2);
    expect(fakeQuery).toHaveBeenCalledTimes(2);
    expect(result.filesChanged).toContain("late.txt");
  });

  it("uses Read, Write, Edit, Bash allowlist", async () => {
    const fakeQuery = vi.fn(async function* () {
      await writeFile(join(repo, "x.txt"), "x");
      yield {
        type: "result",
        result: "ok",
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    });
    await execute({
      repoPath: repo,
      repoName: "x",
      stackProfile: jstsProfile,
      task: baseTask,
      tracker: new BudgetTracker({}),
      maxRetries: 0,
      testGateEnabled: false,
      testCommand: "",
      testTimeoutMs: 5000,
      queryFn: fakeQuery as never,
    });
    const firstCall = fakeQuery.mock.calls[0] as unknown as
      | [{ options: { allowedTools: string[] } }]
      | undefined;
    if (!firstCall) throw new Error("expected fakeQuery to be called");
    expect(firstCall[0].options.allowedTools).toEqual(["Read", "Write", "Edit", "Bash"]);
  });

  it("test gate failure with no retries marks task failed", async () => {
    const fakeQuery = vi.fn(async function* () {
      await writeFile(join(repo, "b.txt"), "edit");
      yield {
        type: "result",
        result: "done",
        usage: { input_tokens: 100, output_tokens: 50 },
      };
    });
    const result = await execute({
      repoPath: repo,
      repoName: "x",
      stackProfile: jstsProfile,
      task: baseTask,
      tracker: new BudgetTracker({}),
      maxRetries: 0,
      testGateEnabled: true,
      testCommand: "exit 1",
      testTimeoutMs: 5000,
      queryFn: fakeQuery as never,
    });
    expect(result.status).toBe("failed");
    expect(result.failureReason).toMatch(/tests failed/i);
  });
});
