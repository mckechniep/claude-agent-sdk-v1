import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { discoverRepos } from "../../../src/phases/discover.js";
import {
  writeProposal,
  writeProposalApproval,
  writePlan,
  writePlanApproval,
} from "../../../src/state/repoState.js";

async function makeGitRepo(parent: string, name: string, files: Record<string, string> = {}) {
  const dir = join(parent, name);
  await mkdir(dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  await simpleGit(dir).init().add(".").commit("init", { "--allow-empty": null });
  return dir;
}

describe("discoverRepos", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "discover-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("finds direct child git repos", async () => {
    await makeGitRepo(root, "alpha", { "package.json": "{}", "README.md": "# alpha" });
    await makeGitRepo(root, "beta", { "pyproject.toml": "" });
    const repos = await discoverRepos({ targetDir: root, depth: 2 });
    const names = repos.map((r) => r.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
  });

  it("detects stack per repo", async () => {
    await makeGitRepo(root, "alpha", { "package.json": "{}" });
    await makeGitRepo(root, "beta", { "pyproject.toml": "" });
    const repos = await discoverRepos({ targetDir: root, depth: 2 });
    const map = Object.fromEntries(repos.map((r) => [r.name, r.stack]));
    expect(map.alpha).toBe("jsts");
    expect(map.beta).toBe("python");
  });

  it("ignores node_modules and .git directories", async () => {
    await mkdir(join(root, "node_modules", "fake"), { recursive: true });
    await makeGitRepo(root, "alpha", {});
    const repos = await discoverRepos({ targetDir: root, depth: 4 });
    expect(repos.map((r) => r.name)).toEqual(["alpha"]);
  });

  it("respects exclude patterns", async () => {
    await makeGitRepo(root, "alpha", {});
    await makeGitRepo(root, "alpha-legacy", {});
    const repos = await discoverRepos({
      targetDir: root,
      depth: 2,
      exclude: ["alpha-legacy"],
    });
    expect(repos.map((r) => r.name)).toEqual(["alpha"]);
  });

  it("reports hasReadme and hasTests flags", async () => {
    await makeGitRepo(root, "alpha", { "README.md": "# x", "package.json": "{}" });
    await mkdir(join(root, "alpha", "test"), { recursive: true });
    await writeFile(join(root, "alpha", "test", "x.test.ts"), "export {};");
    const repos = await discoverRepos({ targetDir: root, depth: 2 });
    expect(repos[0]?.hasReadme).toBe(true);
    expect(repos[0]?.hasTests).toBe(true);
  });

  it("reports false approval flags for repos without .agent state", async () => {
    await makeGitRepo(root, "alpha", { "package.json": "{}" });
    const repos = await discoverRepos({ targetDir: root, depth: 2 });
    expect(repos[0]?.hasApprovedProposal).toBe(false);
    expect(repos[0]?.hasApprovedPlan).toBe(false);
  });

  it("surfaces prior approval state for repos with .agent artifacts", async () => {
    const alphaDir = await makeGitRepo(root, "alpha", { "package.json": "{}" });

    // Set up a valid proposal approval.
    const proposalPath = await writeProposal(alphaDir, "# Proposal");
    await writeProposalApproval(alphaDir, proposalPath);

    // Set up a valid plan approval with two tasks.
    const planMd = `# Plan — alpha

## Tasks

### task: aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
**Title:** Task one

**Acceptance criteria:**
- criterion a

**Dependencies:** none
**Estimated effort:** small

---

### task: bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb
**Title:** Task two

**Acceptance criteria:**
- criterion b

**Dependencies:** aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
**Estimated effort:** small
`;
    const planPath = await writePlan(alphaDir, planMd);
    await writePlanApproval(alphaDir, planPath, 2);

    const repos = await discoverRepos({ targetDir: root, depth: 2 });
    expect(repos[0]?.hasApprovedProposal).toBe(true);
    expect(repos[0]?.hasApprovedPlan).toBe(true);
  });
});
