import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import * as authMode from "../../../src/auth/mode.js";
import { runOrchestration } from "../../../src/orchestrator/run.js";
import { ulid } from "ulid";
import type { RunConfig } from "../../../src/types.js";

async function makeFixtureRepo(parent: string, name: string): Promise<string> {
  const dir = join(parent, name);
  await mkdir(dir, { recursive: true });
  const g = simpleGit(dir);
  await g.init();
  await g.addConfig("user.email", "test@example.com");
  await g.addConfig("user.name", "test");
  await writeFile(join(dir, "package.json"), "{}");
  await g.add(".").commit("init");
  return dir;
}

const baseConfig = (target: string): RunConfig => ({
  targetDir: target,
  autonomy: "yolo",
  tier: "balanced",
  concurrency: 1,
  checkpointEvery: Number.MAX_SAFE_INTEGER,
  onFailure: "skip-repo",
  maxRetries: 0,
  testGate: "skip",
  testTimeoutMs: 30_000,
  model: { default: "claude-sonnet-4-6" },
});

describe("runOrchestration", () => {
  let target: string;
  let stateRoot: string;
  beforeEach(async () => {
    target = await mkdtemp(join(tmpdir(), "orchtgt-"));
    stateRoot = await mkdtemp(join(tmpdir(), "orchstate-"));
    vi.spyOn(authMode, "applyAuthMode").mockImplementation(() => {});
  });
  afterEach(async () => {
    await rm(target, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("runs discovery → analyze → plan → execute for each selected repo and finalizes", async () => {
    await makeFixtureRepo(target, "alpha");

    const fakeAnalyze = vi.fn(async () => ({
      proposalPath: "/dev/null",
      proposalMarkdown: "",
      tokensUsed: 100,
      durationMs: 10,
    }));
    const fakePlan = vi.fn(async () => ({
      planPath: "/dev/null",
      planMarkdown: "",
      taskCount: 1,
      tasks: [
        {
          taskId: "11111111-1111-1111-1111-111111111111",
          title: "T",
          acceptanceCriteria: [],
          status: "pending" as const,
          attempts: 0,
          tokensUsed: 0,
          durationMs: 0,
        },
      ],
      estimatedTokens: 1000,
      estimatedDurationMs: 60_000,
      tokensUsed: 200,
      durationMs: 10,
    }));
    const fakeExecute = vi.fn(async () => ({
      taskId: "11111111-1111-1111-1111-111111111111",
      title: "T",
      acceptanceCriteria: [],
      status: "completed" as const,
      attempts: 1,
      tokensUsed: 500,
      durationMs: 10,
      commitSha: "a".repeat(40),
      filesChanged: ["x.txt"],
      diff: "",
    }));

    const result = await runOrchestration({
      runId: ulid(),
      authMode: "api",
      config: baseConfig(target),
      stateRoot,
      selectRepos: async (repos) => repos.map((r) => r.path),
      proposalGate: async () => "accept",
      planGate: async () => "accept",
      runConfirmation: async () => true,
      authConfirmation: async () => true,
      analyzeFn: fakeAnalyze,
      planFn: fakePlan,
      executeFn: fakeExecute,
    });

    expect(result.status).toBe("completed");
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0].status).toBe("completed");
    expect(fakeAnalyze).toHaveBeenCalledTimes(1);
    expect(fakePlan).toHaveBeenCalledTimes(1);
    expect(fakeExecute).toHaveBeenCalledTimes(1);
  });

  // Phase E: resuming an existing (paused) run must NOT re-discover repos,
  // re-analyze, re-plan, or re-execute already-completed tasks. This is the
  // safety guarantee behind "resume this run" — confirming execution on a
  // half-done run continues from where it stopped, it does not restart.
  it("resumes a paused run without re-discovering, re-planning, or re-running completed tasks", async () => {
    await makeFixtureRepo(target, "alpha");
    const TASK1 = "11111111-1111-1111-1111-111111111111";
    const TASK2 = "22222222-2222-2222-2222-222222222222";
    const twoTasks = [
      { taskId: TASK1, title: "T1", acceptanceCriteria: [], status: "pending" as const, attempts: 0, tokensUsed: 0, durationMs: 0 },
      { taskId: TASK2, title: "T2", acceptanceCriteria: [], status: "pending" as const, attempts: 0, tokensUsed: 0, durationMs: 0 },
    ];

    const fakeAnalyze = vi.fn(async () => ({
      proposalPath: "/dev/null",
      proposalMarkdown: "",
      tokensUsed: 100,
      durationMs: 10,
    }));
    const fakePlan = vi.fn(async () => ({
      planPath: "/dev/null",
      planMarkdown: "",
      taskCount: 2,
      tasks: twoTasks,
      estimatedTokens: 1000,
      estimatedDurationMs: 60_000,
      tokensUsed: 200,
      durationMs: 10,
    }));
    const fakeExecute = vi.fn(async (args: { task: { taskId: string; title: string } }) => ({
      taskId: args.task.taskId,
      title: args.task.title,
      acceptanceCriteria: [],
      status: "completed" as const,
      attempts: 1,
      tokensUsed: 500,
      durationMs: 10,
      commitSha: "a".repeat(40),
      filesChanged: [],
      diff: "",
    }));

    const runId = ulid();
    // Initial run: both tasks complete.
    const first = await runOrchestration({
      runId,
      authMode: "api",
      config: baseConfig(target),
      stateRoot,
      selectRepos: async (repos) => repos.map((r) => r.path),
      proposalGate: async () => "accept",
      planGate: async () => "accept",
      runConfirmation: async () => true,
      authConfirmation: async () => true,
      analyzeFn: fakeAnalyze,
      planFn: fakePlan,
      executeFn: fakeExecute,
    });
    expect(first.status).toBe("completed");
    expect(fakeExecute).toHaveBeenCalledTimes(2);

    // Rewind on disk to a half-done paused state: task 1 done, task 2 pending.
    const runDir = join(stateRoot, runId);
    const { loadManifest, saveManifest } = await import("../../../src/state/runIndex.js");
    const m = await loadManifest(runDir);
    m.status = "paused";
    m.repos[0]!.status = "executing";
    m.repos[0]!.taskState = [
      { ...twoTasks[0]!, status: "completed" },
      { ...twoTasks[1]!, status: "pending" },
    ];
    await saveManifest(runDir, m);

    fakeAnalyze.mockClear();
    fakePlan.mockClear();
    fakeExecute.mockClear();
    const selectSpy = vi.fn(async (repos: { path: string }[]) => repos.map((r) => r.path));

    const resumed = await runOrchestration({
      runId,
      authMode: m.authMode,
      config: m.config,
      stateRoot,
      selectRepos: selectSpy,
      proposalGate: async () => "accept",
      planGate: async () => "accept",
      runConfirmation: async () => true,
      authConfirmation: async () => true,
      analyzeFn: fakeAnalyze,
      planFn: fakePlan,
      executeFn: fakeExecute,
    });

    expect(resumed.status).toBe("completed");
    // Resume must not re-discover / re-select repos.
    expect(selectSpy).not.toHaveBeenCalled();
    // Resume must not re-analyze or re-plan an already-planned repo.
    expect(fakeAnalyze).not.toHaveBeenCalled();
    expect(fakePlan).not.toHaveBeenCalled();
    // Only the single remaining (pending) task re-executes; task 1 is skipped.
    expect(fakeExecute).toHaveBeenCalledTimes(1);
    expect(fakeExecute.mock.calls[0]![0].task.taskId).toBe(TASK2);
  });
});
