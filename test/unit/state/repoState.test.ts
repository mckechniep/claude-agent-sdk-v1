import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureAgentDir,
  saveRepoState,
  loadRepoState,
  writeProposal,
  writePlan,
  readPlan,
  writePlanApproval,
  readPlanApproval,
  ensureGitignore,
} from "../../../src/state/repoState.js";
import type { RepoEntry } from "../../../src/types.js";

const baseRepo = (): RepoEntry => ({
  path: "/tmp/x",
  name: "x",
  stack: "jsts",
  status: "pending",
  testGate: true,
});

describe("repoState", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "reposrc-"));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("creates .agent and notes/ subdirs", async () => {
    await ensureAgentDir(repo);
    const { stat } = await import("node:fs/promises");
    expect((await stat(join(repo, ".agent"))).isDirectory()).toBe(true);
    expect((await stat(join(repo, ".agent", "notes"))).isDirectory()).toBe(true);
  });

  it("round-trips repo state", async () => {
    await ensureAgentDir(repo);
    const r = baseRepo();
    await saveRepoState(repo, r);
    const loaded = await loadRepoState(repo);
    expect(loaded).toEqual(r);
  });

  it("writes proposal markdown to the expected path", async () => {
    await ensureAgentDir(repo);
    const path = await writeProposal(repo, "# Proposal\n\nbody");
    expect(path).toBe(join(repo, ".agent", "completion-proposal.md"));
    expect(await readFile(path, "utf8")).toContain("# Proposal");
  });

  it("writes plan markdown to the expected path", async () => {
    await ensureAgentDir(repo);
    const path = await writePlan(repo, "# Plan");
    expect(path).toBe(join(repo, ".agent", "plan.md"));
    expect(await readFile(path, "utf8")).toBe("# Plan");
  });

  it("readPlan returns null when plan.md is absent", async () => {
    await ensureAgentDir(repo);
    expect(await readPlan(repo)).toBeNull();
  });

  it("readPlan round-trips the markdown written by writePlan", async () => {
    await ensureAgentDir(repo);
    await writePlan(repo, "# Plan — x\n\nbody");
    expect(await readPlan(repo)).toBe("# Plan — x\n\nbody");
  });

  it("plan approval marker is a pointer-only payload", async () => {
    await ensureAgentDir(repo);
    const planPath = await writePlan(repo, "# Plan");
    const markerPath = await writePlanApproval(repo, planPath, 7);
    expect(markerPath).toBe(join(repo, ".agent", "plan-approved.json"));
    const approval = await readPlanApproval(repo);
    expect(approval).not.toBeNull();
    expect(approval?.planPath).toBe(planPath);
    expect(approval?.taskCount).toBe(7);
    expect(typeof approval?.approvedAt).toBe("string");
  });

  it("readPlanApproval returns null when no marker exists", async () => {
    await ensureAgentDir(repo);
    expect(await readPlanApproval(repo)).toBeNull();
  });

  it("appends .agent/ to .gitignore if not present", async () => {
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, ".gitignore"), "node_modules\n");
    await ensureGitignore(repo);
    const content = await readFile(join(repo, ".gitignore"), "utf8");
    expect(content).toContain(".agent/");
  });

  it("does not duplicate .agent/ entry in .gitignore", async () => {
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, ".gitignore"), "node_modules\n.agent/\n");
    await ensureGitignore(repo);
    const content = await readFile(join(repo, ".gitignore"), "utf8");
    const occurrences = content.match(/\.agent\//g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it("creates .gitignore with .agent/ entry when the file does not exist", async () => {
    await mkdir(repo, { recursive: true });
    await ensureGitignore(repo);
    const content = await readFile(join(repo, ".gitignore"), "utf8");
    expect(content).toBe(".agent/\n");
  });

  it("treats `.agent` (no trailing slash) as already present", async () => {
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, ".gitignore"), "node_modules\n.agent\n");
    await ensureGitignore(repo);
    const content = await readFile(join(repo, ".gitignore"), "utf8");
    // Must not have appended `.agent/` since `.agent` already covers it
    expect(content).toBe("node_modules\n.agent\n");
  });

  it("throws StateCorruption when state.json fails schema", async () => {
    await ensureAgentDir(repo);
    await writeFile(join(repo, ".agent", "state.json"), '{"path":"x"}');
    await expect(loadRepoState(repo)).rejects.toThrow(/State corruption/);
  });

  it("throws StateCorruption with 'JSON parse failed' on malformed JSON", async () => {
    await ensureAgentDir(repo);
    await writeFile(join(repo, ".agent", "state.json"), "{not valid json");
    await expect(loadRepoState(repo)).rejects.toThrow(/JSON parse failed/);
  });

  it("invalidates the plan + plan-approval when a new proposal is written", async () => {
    // First full cycle: proposal → plan → plan approved.
    await writeProposal(repo, "# proposal v1");
    const planPath = await writePlan(repo, "# plan v1");
    await writePlanApproval(repo, planPath, 3);
    expect(await readPlan(repo)).toBe("# plan v1");
    expect(await readPlanApproval(repo)).not.toBeNull();

    // Re-analyze writes a new proposal — the stale plan + approval must go, so a
    // later resume can't execute a plan built against the superseded proposal.
    await writeProposal(repo, "# proposal v2");
    expect(await readPlan(repo)).toBeNull();
    expect(await readPlanApproval(repo)).toBeNull();
  });

  it("first proposal write is a no-op for plan invalidation (no plan yet)", async () => {
    await expect(writeProposal(repo, "# proposal")).resolves.toContain("completion-proposal.md");
    expect(await readPlan(repo)).toBeNull();
  });
});
