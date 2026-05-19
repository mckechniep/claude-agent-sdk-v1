import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RepoEntrySchema, StateCorruption, type RepoEntry } from "../types.js";
import { writeAtomic, cleanStaleTmpFiles, isErrnoCode } from "./atomicWrite.js";

export const AGENT_DIR = ".agent";

export async function ensureAgentDir(repoPath: string): Promise<string> {
  const dir = join(repoPath, AGENT_DIR);
  await mkdir(join(dir, "notes"), { recursive: true });
  return dir;
}

export async function saveRepoState(repoPath: string, entry: RepoEntry): Promise<void> {
  const dir = await ensureAgentDir(repoPath);
  const validated = RepoEntrySchema.parse(entry);
  await writeAtomic(join(dir, "state.json"), JSON.stringify(validated, null, 2));
}

export async function loadRepoState(repoPath: string): Promise<RepoEntry> {
  const dir = join(repoPath, AGENT_DIR);
  // Recover from crashes between writeAtomic's tmp-write and rename steps.
  await cleanStaleTmpFiles(dir);
  const path = join(dir, "state.json");
  const raw = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StateCorruption(path, `JSON parse failed: ${(err as Error).message}`);
  }
  const result = RepoEntrySchema.safeParse(parsed);
  if (!result.success) {
    throw new StateCorruption(path, `schema mismatch: ${result.error.message}`);
  }
  return result.data;
}

export async function writeProposal(repoPath: string, markdown: string): Promise<string> {
  const dir = await ensureAgentDir(repoPath);
  const path = join(dir, "completion-proposal.md");
  await writeAtomic(path, markdown);
  return path;
}

export async function readProposal(repoPath: string): Promise<string | null> {
  const path = join(repoPath, AGENT_DIR, "completion-proposal.md");
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return null;
    throw err;
  }
}

export async function writePlan(repoPath: string, markdown: string): Promise<string> {
  const dir = await ensureAgentDir(repoPath);
  const path = join(dir, "plan.md");
  await writeAtomic(path, markdown);
  return path;
}

export interface ProposalApproval {
  approvedAt: string;
  proposalPath: string;
}

export async function writeProposalApproval(
  repoPath: string,
  proposalPath: string,
): Promise<string> {
  const dir = await ensureAgentDir(repoPath);
  const path = join(dir, "proposal-approved.json");
  const payload: ProposalApproval = {
    approvedAt: new Date().toISOString(),
    proposalPath,
  };
  await writeAtomic(path, JSON.stringify(payload, null, 2));
  return path;
}

export async function readProposalApproval(repoPath: string): Promise<ProposalApproval | null> {
  const path = join(repoPath, AGENT_DIR, "proposal-approved.json");
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as ProposalApproval;
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return null;
    throw err;
  }
}

export async function ensureGitignore(repoPath: string): Promise<void> {
  const path = join(repoPath, ".gitignore");
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch (err) {
    if (!isErrnoCode(err, "ENOENT")) throw err;
  }
  if (current.split("\n").some((l) => l.trim() === ".agent/" || l.trim() === ".agent")) return;
  const next =
    current.endsWith("\n") || current === "" ? current + ".agent/\n" : current + "\n.agent/\n";
  await writeFile(path, next);
}
