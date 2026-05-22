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
});
