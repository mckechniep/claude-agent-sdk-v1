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
import {
  writeProposal,
  writeProposalApproval,
  writePlan,
  writePlanApproval,
  ensureAgentDir,
  AGENT_DIR,
} from "../../../src/state/repoState.js";

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

  it("bootstrapOnly initializes the run without advancing any phase", async () => {
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
    const executeFn = vi.fn(async () => ({
      taskId: "44444444-4444-4444-4444-444444444444",
      title: "T",
      acceptanceCriteria: [],
      status: "completed" as const,
      attempts: 1,
      tokensUsed: 0,
      durationMs: 0,
      commitSha: "c".repeat(40),
      filesChanged: [],
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
      bootstrapOnly: true,
    });

    // Run was initialized but no phase work happened
    expect(manifest.status).toBe("preflight");
    expect(manifest.repos).toHaveLength(1);
    expect(manifest.repos[0]?.status).toBe("pending");
    expect(analyzeFn).not.toHaveBeenCalled();
    expect(planFn).not.toHaveBeenCalled();
    expect(executeFn).not.toHaveBeenCalled();

    // Manifest was persisted: a follow-up step() without bootstrapOnly loads it
    const { loadManifest } = await import("../../../src/state/runIndex.js");
    const { join: pathJoin } = await import("node:path");
    const persisted = await loadManifest(pathJoin(stateRoot, runId));
    expect(persisted.status).toBe("preflight");
    expect(persisted.repos[0]?.status).toBe("pending");
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

// ---------------------------------------------------------------------------
// Two-task plan.md fixture used across the prior-approval tests
// ---------------------------------------------------------------------------
const TASK_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TASK_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const PLAN_MD = `# Plan — fixture-repo

## Summary
Implement v1.

## Tasks

### task: ${TASK_A}
**Title:** Task A
**Acceptance criteria:**
- Criterion A1
- Criterion A2

**Dependencies:** none
**Estimated effort:** small

---

### task: ${TASK_B}
**Title:** Task B
**Acceptance criteria:**
- Criterion B1

**Dependencies:** ${TASK_A}
**Estimated effort:** small
`;

// Helper: build a DiscoveredRepo object pointing at an existing directory.
function makeDiscoveredRepo(repoPath: string, name: string): DiscoveredRepo {
  return {
    path: repoPath,
    name,
    stack: "jsts",
    hasReadme: false,
    hasTests: false,
    lastCommitDate: null,
    isDirty: false,
    hasApprovedProposal: false,
    hasApprovedPlan: false,
  };
}

// Helper: stub fns that should never be called for skipped phases.
function makeNeverFns() {
  return {
    analyzeFn: vi.fn(async () => {
      throw new Error("analyzeFn should not be called");
    }),
    planFn: vi.fn(async () => {
      throw new Error("planFn should not be called");
    }),
  };
}

// Helper: executor that marks each task completed.
function makeExecuteFn() {
  return vi.fn(async (args: { task: { taskId: string; title: string } }) => ({
    taskId: args.task.taskId,
    title: args.task.title,
    acceptanceCriteria: [] as string[],
    status: "completed" as const,
    attempts: 1,
    tokensUsed: 10,
    durationMs: 5,
    commitSha: "c".repeat(40),
    filesChanged: [] as string[],
    diff: "",
  }));
}

describe("prior approval restoration", () => {
  let target: string;
  let stateRoot: string;

  beforeEach(async () => {
    target = await mkdtemp(join(tmpdir(), "priorapproval-tgt-"));
    stateRoot = await mkdtemp(join(tmpdir(), "priorapproval-state-"));
    vi.spyOn(authMode, "applyAuthMode").mockImplementation(() => {});
  });

  afterEach(async () => {
    await rm(target, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ------------------------------------------------------------------
  // Test 1: full plan approval → starts at awaiting-plan-approval
  // ------------------------------------------------------------------
  it("starts a repo with a valid approved plan at awaiting-plan-approval with taskState loaded", async () => {
    const repoPath = await makeFixtureRepo(target, "repo-plan-approved");

    // Write proposal + approval + plan + plan-approval (taskCount 2).
    const proposalPath = await writeProposal(repoPath, "# Proposal\nDo something.");
    await writeProposalApproval(repoPath, proposalPath);
    const planPath = await writePlan(repoPath, PLAN_MD);
    await writePlanApproval(repoPath, planPath, 2);

    const runId = ulid();
    const manifest = await step({
      runId,
      stateRoot,
      authMode: "api",
      config: yoloConfig(target),
      selectedRepos: [makeDiscoveredRepo(repoPath, "repo-plan-approved")],
      bootstrapOnly: true,
    });

    expect(manifest.status).toBe("preflight");
    const repo = manifest.repos[0];
    expect(repo?.status).toBe("awaiting-plan-approval");
    expect(repo?.proposalPath).toBeTruthy();
    expect(repo?.planPath).toBeTruthy();
    expect(repo?.taskState).toHaveLength(2);
    expect(repo?.taskState?.[0]?.status).toBe("pending");
    expect(repo?.taskState?.[1]?.status).toBe("pending");
  });

  // ------------------------------------------------------------------
  // Test 2: fully-approved repo skips analyze+plan when run advances
  // ------------------------------------------------------------------
  it("skips analyze AND plan for a fully-approved repo when the run advances", async () => {
    const repoPath = await makeFixtureRepo(target, "repo-skip-both");

    const proposalPath = await writeProposal(repoPath, "# Proposal\nDo something.");
    await writeProposalApproval(repoPath, proposalPath);
    const planPath = await writePlan(repoPath, PLAN_MD);
    await writePlanApproval(repoPath, planPath, 2);

    const { analyzeFn, planFn } = makeNeverFns();
    const executeFn = makeExecuteFn();

    const runId = ulid();
    const manifest = await step({
      runId,
      stateRoot,
      authMode: "api",
      config: yoloConfig(target),
      selectedRepos: [makeDiscoveredRepo(repoPath, "repo-skip-both")],
      analyzeFn,
      planFn,
      executeFn,
    });

    expect(manifest.status).toBe("completed");
    expect(analyzeFn).not.toHaveBeenCalled();
    expect(planFn).not.toHaveBeenCalled();
    expect(executeFn).toHaveBeenCalledTimes(2); // one call per task
  });

  // ------------------------------------------------------------------
  // Test 3: only proposal approved → skips analyze, runs plan
  // ------------------------------------------------------------------
  it("starts a repo with only an approved proposal at awaiting-proposal-approval (skips analyze only)", async () => {
    const repoPath = await makeFixtureRepo(target, "repo-proposal-only");

    const proposalPath = await writeProposal(repoPath, "# Proposal\nDo something.");
    await writeProposalApproval(repoPath, proposalPath);
    // No plan written, no plan-approved.json.

    let analyzeCallCount = 0;
    const analyzeFn = vi.fn(async () => {
      analyzeCallCount++;
      throw new Error("analyzeFn should not be called");
    });

    let planCallCount = 0;
    const planFn = vi.fn(async () => {
      planCallCount++;
      return {
        planPath: join(repoPath, AGENT_DIR, "plan.md"),
        planMarkdown: PLAN_MD,
        taskCount: 2,
        tasks: [
          {
            taskId: TASK_A,
            title: "Task A",
            acceptanceCriteria: ["Criterion A1"],
            status: "pending" as const,
            attempts: 0,
            tokensUsed: 0,
            durationMs: 0,
          },
          {
            taskId: TASK_B,
            title: "Task B",
            acceptanceCriteria: ["Criterion B1"],
            status: "pending" as const,
            attempts: 0,
            tokensUsed: 0,
            durationMs: 0,
          },
        ],
        estimatedTokens: 1000,
        estimatedDurationMs: 60_000,
        tokensUsed: 50,
        durationMs: 10,
      };
    });
    const executeFn = makeExecuteFn();

    const runId = ulid();
    const manifest = await step({
      runId,
      stateRoot,
      authMode: "api",
      config: yoloConfig(target),
      selectedRepos: [makeDiscoveredRepo(repoPath, "repo-proposal-only")],
      analyzeFn,
      planFn,
      executeFn,
    });

    expect(manifest.status).toBe("completed");
    expect(analyzeCallCount).toBe(0);
    expect(planCallCount).toBe(1);
    expect(executeFn).toHaveBeenCalledTimes(2);
  });

  // ------------------------------------------------------------------
  // Test 4: stale plan approval (task count mismatch) → starts at pending
  // ------------------------------------------------------------------
  it("starts repos with stale plan approvals (taskCount mismatch) at pending (full re-analysis)", async () => {
    const repoPath = await makeFixtureRepo(target, "repo-stale-plan");

    // plan.md has 2 tasks but the approval claims 3 → mismatch → stale.
    // Also: no valid proposal artifact (don't call writeProposal at all),
    // so the repo has nothing valid → starts at "pending".
    await ensureAgentDir(repoPath);
    const planPath = join(repoPath, AGENT_DIR, "plan.md");
    await writeFile(planPath, PLAN_MD);
    // Write plan-approved.json manually with the wrong task count.
    const planApprovedPath = join(repoPath, AGENT_DIR, "plan-approved.json");
    await writeFile(
      planApprovedPath,
      JSON.stringify({ approvedAt: new Date().toISOString(), planPath, taskCount: 3 }),
    );

    const runId = ulid();
    const manifest = await step({
      runId,
      stateRoot,
      authMode: "api",
      config: yoloConfig(target),
      selectedRepos: [makeDiscoveredRepo(repoPath, "repo-stale-plan")],
      bootstrapOnly: true,
    });

    const repo = manifest.repos[0];
    expect(repo?.status).toBe("pending");
  });

  // ------------------------------------------------------------------
  // Test 5: client lies about approval flags → server re-checks disk
  // ------------------------------------------------------------------
  it("ignores client-provided approval flags (server re-checks disk)", async () => {
    const repoPath = await makeFixtureRepo(target, "repo-no-agent-state");
    // No .agent/ directory created — no approvals on disk.

    // Lying client: flags say both are approved, but disk has nothing.
    const lyingRepo: DiscoveredRepo = {
      ...makeDiscoveredRepo(repoPath, "repo-no-agent-state"),
      hasApprovedProposal: true,
      hasApprovedPlan: true,
    };

    const runId = ulid();
    const manifest = await step({
      runId,
      stateRoot,
      authMode: "api",
      config: yoloConfig(target),
      selectedRepos: [lyingRepo],
      bootstrapOnly: true,
    });

    const repo = manifest.repos[0];
    expect(repo?.status).toBe("pending");
  });
});
