import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { ulid } from "ulid";
import * as authMode from "../../../src/auth/mode.js";
import { step } from "../../../src/orchestrator/run.js";
import type { RunConfig } from "../../../src/types.js";
import type { DiscoveredRepo } from "../../../src/phases/discover.js";

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

const yoloConfig = (target: string): RunConfig => ({
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

const manualConfig = (target: string): RunConfig => ({
  ...yoloConfig(target),
  autonomy: "manual",
});

describe("step", () => {
  let target: string;
  let stateRoot: string;
  beforeEach(async () => {
    target = await mkdtemp(join(tmpdir(), "steptgt-"));
    stateRoot = await mkdtemp(join(tmpdir(), "stepstate-"));
    vi.spyOn(authMode, "applyAuthMode").mockImplementation(() => {});
  });
  afterEach(async () => {
    await rm(target, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("runs an entire yolo-mode run to completion in a single step() call", async () => {
    const repoPath = await makeFixtureRepo(target, "alpha");
    const selectedRepos: DiscoveredRepo[] = [
      {
        path: repoPath,
        name: "alpha",
        stack: "jsts",
        hasReadme: false,
        hasTests: false,
        lastCommitDate: null,
        isDirty: false,
      },
    ];

    const analyzeFn = vi.fn(async () => ({
      proposalPath: "/dev/null",
      proposalMarkdown: "",
      tokensUsed: 100,
      durationMs: 5,
    }));
    const planFn = vi.fn(async () => ({
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
    const executeFn = vi.fn(async () => ({
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

    const runId = ulid();
    const manifest = await step({
      runId,
      stateRoot,
      authMode: "api",
      config: yoloConfig(target),
      selectedRepos,
      analyzeFn,
      planFn,
      executeFn,
    });

    expect(manifest.status).toBe("completed");
    expect(manifest.repos).toHaveLength(1);
    expect(manifest.repos[0]?.status).toBe("completed");
    expect(analyzeFn).toHaveBeenCalledTimes(1);
    expect(planFn).toHaveBeenCalledTimes(1);
    expect(executeFn).toHaveBeenCalledTimes(1);
  });

  it("manual-mode step() returns at first awaiting-proposal-approval and resumes after decision", async () => {
    const repoPath = await makeFixtureRepo(target, "alpha");
    const selectedRepos: DiscoveredRepo[] = [
      {
        path: repoPath,
        name: "alpha",
        stack: "jsts",
        hasReadme: false,
        hasTests: false,
        lastCommitDate: null,
        isDirty: false,
      },
    ];

    const analyzeFn = vi.fn(async () => ({
      proposalPath: "/dev/null",
      proposalMarkdown: "",
      tokensUsed: 100,
      durationMs: 5,
    }));
    const planFn = vi.fn(async () => ({
      planPath: "/dev/null",
      planMarkdown: "",
      taskCount: 1,
      tasks: [
        {
          taskId: "22222222-2222-2222-2222-222222222222",
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

    const runId = ulid();
    const first = await step({
      runId,
      stateRoot,
      authMode: "api",
      config: manualConfig(target),
      selectedRepos,
      analyzeFn,
      planFn,
    });

    expect(first.status).toBe("preflight");
    expect(first.repos[0]?.status).toBe("awaiting-proposal-approval");
    expect(analyzeFn).toHaveBeenCalledTimes(1);
    expect(planFn).toHaveBeenCalledTimes(0);

    const second = await step({
      runId,
      stateRoot,
      decisions: {
        proposals: { [repoPath]: "accept" },
      },
      analyzeFn,
      planFn,
    });

    expect(second.repos[0]?.status).toBe("awaiting-plan-approval");
    expect(planFn).toHaveBeenCalledTimes(1);
  });

  it("manual-mode skips a repo when proposal decision is reject", async () => {
    const repoPath = await makeFixtureRepo(target, "alpha");
    const selectedRepos: DiscoveredRepo[] = [
      {
        path: repoPath,
        name: "alpha",
        stack: "jsts",
        hasReadme: false,
        hasTests: false,
        lastCommitDate: null,
        isDirty: false,
      },
    ];

    const analyzeFn = vi.fn(async () => ({
      proposalPath: "/dev/null",
      proposalMarkdown: "",
      tokensUsed: 100,
      durationMs: 5,
    }));
    const planFn = vi.fn(async () => ({
      planPath: "/dev/null",
      planMarkdown: "",
      taskCount: 0,
      tasks: [],
      estimatedTokens: 0,
      estimatedDurationMs: 0,
      tokensUsed: 0,
      durationMs: 0,
    }));

    const runId = ulid();
    await step({
      runId,
      stateRoot,
      authMode: "api",
      config: manualConfig(target),
      selectedRepos,
      analyzeFn,
      planFn,
    });
    const next = await step({
      runId,
      stateRoot,
      decisions: { proposals: { [repoPath]: "reject" } },
      analyzeFn,
      planFn,
    });

    expect(next.repos[0]?.status).toBe("skipped");
    expect(planFn).toHaveBeenCalledTimes(0);
  });

  it("throws when first step() call omits config or selectedRepos", async () => {
    await expect(step({ runId: ulid(), stateRoot, authMode: "api" })).rejects.toThrow(
      /first call requires/,
    );
  });
});
