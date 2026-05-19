import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { discoverRepos } from "../../../src/phases/discover.js";

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
});
