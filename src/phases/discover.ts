import { readdir, stat, access } from "node:fs/promises";
import { basename, join } from "node:path";
import { simpleGit } from "simple-git";
import { detectStack } from "../stack/detect.js";
import { readPriorApprovalState } from "../state/repoState.js";
import type { StackId } from "../types.js";

export interface DiscoveredRepo {
  path: string;
  name: string;
  stack: StackId;
  hasReadme: boolean;
  hasTests: boolean;
  lastCommitDate: string | null;
  isDirty: boolean;
  // Local git branches + the currently checked-out one. The run surface uses
  // these to offer a per-repo base-branch picker (default = currentBranch).
  currentBranch: string;
  localBranches: string[];
  // The user-chosen base branch agent/* work forks off. Set by the run surface
  // in the start-run payload; absent during discovery itself.
  baseBranch?: string;
  // Prior orchestrator state (from the repo's .agent/ directory). Lets the
  // UI badge repos that already have approved work, and lets run bootstrap
  // skip re-analysis. Flags are validity-checked — a dangling/stale approval
  // reports false.
  hasApprovedProposal: boolean;
  hasApprovedPlan: boolean;
}

export interface DiscoverParams {
  targetDir: string;
  depth?: number;
  exclude?: string[];
  include?: string[];
}

const ALWAYS_IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  "vendor",
  ".next",
  "coverage",
]);

async function isGitRepo(path: string): Promise<boolean> {
  try {
    await access(join(path, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function hasTestsInRepo(repo: string): Promise<boolean> {
  const candidates = ["test", "tests", "__tests__"];
  for (const c of candidates) {
    if (await fileExists(join(repo, c))) return true;
  }
  let entries: string[];
  try {
    entries = await readdir(repo);
  } catch {
    return false;
  }
  return entries.some((e) => /\.test\.[tj]sx?$/.test(e) || /^test_.*\.py$/.test(e));
}

function matchesAny(name: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((p) => {
    if (p.includes("*")) {
      const re = new RegExp("^" + p.replace(/\*/g, ".*") + "$");
      return re.test(name);
    }
    return p === name;
  });
}

async function walkForRepos(
  current: string,
  depth: number,
  acc: string[],
  exclude: string[] | undefined,
): Promise<void> {
  if (depth < 0) return;
  let entries: string[];
  try {
    entries = await readdir(current);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (ALWAYS_IGNORE.has(entry)) continue;
    if (matchesAny(entry, exclude)) continue;
    const full = join(current, entry);
    let s;
    try {
      s = await stat(full);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    if (await isGitRepo(full)) {
      acc.push(full);
      continue;
    }
    await walkForRepos(full, depth - 1, acc, exclude);
  }
}

export async function describeRepo(path: string): Promise<DiscoveredRepo> {
  const name = basename(path);
  const stack = await detectStack(path);
  const hasReadme = await fileExists(join(path, "README.md"));
  const hasTests = await hasTestsInRepo(path);
  let lastCommitDate: string | null = null;
  let isDirty = false;
  let currentBranch = "";
  let localBranches: string[] = [];
  try {
    const g = simpleGit(path);
    const log = await g.log({ maxCount: 1 });
    lastCommitDate = log.latest?.date ?? null;
    const status = await g.status();
    isDirty = !status.isClean();
    const branches = await g.branchLocal();
    currentBranch = branches.current ?? "";
    localBranches = branches.all;
  } catch {
    // ignore — repo metadata best-effort
  }
  const priorState = await readPriorApprovalState(path);
  return {
    path,
    name,
    stack,
    hasReadme,
    hasTests,
    lastCommitDate,
    isDirty,
    currentBranch,
    localBranches,
    hasApprovedProposal: priorState.proposalApproved,
    hasApprovedPlan: priorState.planApproved,
  };
}

export async function* discoverReposStream(
  params: DiscoverParams,
): AsyncGenerator<DiscoveredRepo, { count: number }> {
  const depth = params.depth ?? 2;
  const found: string[] = [];
  await walkForRepos(params.targetDir, depth, found, params.exclude);

  const filtered = found.filter((p) => {
    const name = basename(p);
    if (params.include && !matchesAny(name, params.include)) return false;
    return true;
  });

  let count = 0;
  for (const path of filtered) {
    const repo = await describeRepo(path);
    yield repo;
    count++;
  }
  return { count };
}

export async function discoverRepos(params: DiscoverParams): Promise<DiscoveredRepo[]> {
  const out: DiscoveredRepo[] = [];
  const gen = discoverReposStream(params);
  for (;;) {
    const next = await gen.next();
    if (next.done) break;
    out.push(next.value);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
