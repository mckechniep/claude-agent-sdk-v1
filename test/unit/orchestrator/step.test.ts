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

  // Regression: a "paused" manifest used to fall through step()'s status
  // switch unchanged, so /resume and /retry-from-failure started the
  // background loop only to have it immediately exit with run_loop_paused.
  // step() must now treat paused as a soft-stop marker and re-enter the
  // state machine rather than returning the manifest verbatim.
  it("advances a paused manifest by re-entering the state machine", async () => {
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
          taskId: "33333333-3333-3333-3333-333333333333",
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
      taskId: "33333333-3333-3333-3333-333333333333",
      title: "T",
      acceptanceCriteria: [],
      status: "completed" as const,
      attempts: 1,
      tokensUsed: 500,
      durationMs: 10,
      commitSha: "b".repeat(40),
      filesChanged: ["y.txt"],
      diff: "",
    }));

    // First call bootstraps the manifest in preflight; a yolo run drives
    // straight through to completed in one shot.
    const runId = ulid();
    const initial = await step({
      runId,
      stateRoot,
      authMode: "api",
      config: yoloConfig(target),
      selectedRepos,
      analyzeFn,
      planFn,
      executeFn,
    });
    expect(initial.status).toBe("completed");

    // Simulate the on-disk shape after a stop: rewind one repo back to a
    // retryable state and flip the manifest status to paused.
    const runDir = join(stateRoot, runId);
    const { loadManifest, saveManifest } = await import("../../../src/state/runIndex.js");
    const paused = await loadManifest(runDir);
    paused.status = "paused";
    paused.repos[0]!.status = "executing";
    paused.repos[0]!.taskState = [
      {
        taskId: "33333333-3333-3333-3333-333333333333",
        title: "T",
        acceptanceCriteria: [],
        status: "pending",
        attempts: 0,
        tokensUsed: 0,
        durationMs: 0,
      },
    ];
    await saveManifest(runDir, paused);

    analyzeFn.mockClear();
    planFn.mockClear();
    executeFn.mockClear();

    const resumed = await step({
      runId,
      stateRoot,
      analyzeFn,
      planFn,
      executeFn,
    });

    // The whole point: status is no longer paused. The state machine
    // routed via preflight → awaiting-run-confirmation (marker already on
    // disk from the yolo run) → running → completed, re-executing the one
    // pending task.
    expect(resumed.status).not.toBe("paused");
    expect(resumed.status).toBe("completed");
    expect(executeFn).toHaveBeenCalledTimes(1);
    // Analyze and plan should NOT re-run — the repo was already past
    // those phases when we paused it.
    expect(analyzeFn).toHaveBeenCalledTimes(0);
    expect(planFn).toHaveBeenCalledTimes(0);
  });
});
