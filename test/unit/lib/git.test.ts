import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import {
  ensureBranch,
  stageAll,
  commitWithMessage,
  isWorkingTreeClean,
  hasChanges,
  getDiff,
  getCurrentBranch,
  getHeadSha,
  listChangedFiles,
} from "../../../src/lib/git.js";

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "git-"));
  const g = simpleGit(dir);
  await g.init();
  await g.addConfig("user.email", "test@example.com");
  await g.addConfig("user.name", "test");
  await writeFile(join(dir, "a.txt"), "hello");
  await g.add(".").commit("init");
  return dir;
}

describe("git helpers", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeRepo();
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("ensureBranch creates and switches to branch when missing", async () => {
    await ensureBranch(repo, "agent/t1");
    expect(await getCurrentBranch(repo)).toBe("agent/t1");
  });

  it("ensureBranch is idempotent if branch already exists and is current", async () => {
    await ensureBranch(repo, "agent/t1");
    await ensureBranch(repo, "agent/t1");
    expect(await getCurrentBranch(repo)).toBe("agent/t1");
  });

  it("ensureBranch checks out an existing branch from another branch", async () => {
    await ensureBranch(repo, "agent/t1");
    const g = simpleGit(repo);
    await g.checkoutLocalBranch("agent/t2");
    await ensureBranch(repo, "agent/t1");
    expect(await getCurrentBranch(repo)).toBe("agent/t1");
  });

  it("stageAll + commitWithMessage produces a new commit", async () => {
    await ensureBranch(repo, "agent/t1");
    await writeFile(join(repo, "b.txt"), "new");
    expect(await hasChanges(repo)).toBe(true);
    await stageAll(repo);
    const sha = await commitWithMessage(repo, "feat: add b");
    expect(sha).toMatch(/^[0-9a-f]{7,40}$/);
    expect(await isWorkingTreeClean(repo)).toBe(true);
    expect((await getHeadSha(repo)).length).toBe(40);
  });

  it("getDiff returns unified diff for changed tracked files", async () => {
    await writeFile(join(repo, "a.txt"), "hello world");
    const diff = await getDiff(repo);
    expect(diff).toContain("+hello world");
  });

  it("listChangedFiles reports modified + untracked", async () => {
    await writeFile(join(repo, "a.txt"), "modified");
    await writeFile(join(repo, "c.txt"), "new");
    const files = await listChangedFiles(repo);
    expect(files).toContain("a.txt");
    expect(files).toContain("c.txt");
  });
});
