import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { RepoEntrySchema, StateCorruption, type RepoEntry } from "../types.js";
import { writeAtomic, cleanStaleTmpFiles, isErrnoCode } from "./atomicWrite.js";
import { parsePlan } from "../lib/planParser.js";

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
  // Writing a (possibly new) proposal invalidates anything downstream that was
  // built from a prior proposal: the plan and its approval. Without this, a
  // re-analyze leaves plan.md + plan-approved.json on disk built against the
  // superseded proposal, and a later resume could execute that stale plan. rm
  // is idempotent (force), so the first-ever proposal write is a no-op here.
  await rm(join(dir, "plan.md"), { force: true });
  await rm(join(dir, "plan-approved.json"), { force: true });
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

export async function readPlan(repoPath: string): Promise<string | null> {
  const path = join(repoPath, AGENT_DIR, "plan.md");
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return null;
    throw err;
  }
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

export interface PlanApproval {
  approvedAt: string;
  planPath: string;
  taskCount: number;
}

export async function writePlanApproval(
  repoPath: string,
  planPath: string,
  taskCount: number,
): Promise<string> {
  const dir = await ensureAgentDir(repoPath);
  const path = join(dir, "plan-approved.json");
  const payload: PlanApproval = {
    approvedAt: new Date().toISOString(),
    planPath,
    taskCount,
  };
  await writeAtomic(path, JSON.stringify(payload, null, 2));
  return path;
}

export async function readPlanApproval(repoPath: string): Promise<PlanApproval | null> {
  const path = join(repoPath, AGENT_DIR, "plan-approved.json");
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as PlanApproval;
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return null;
    throw err;
  }
}

export interface PriorApprovalState {
  proposalApproved: boolean;
  planApproved: boolean;
  /** Number of tasks in the approved plan; only set when planApproved is true. */
  planTaskCount?: number;
}

/**
 * Inspect a repo's .agent/ directory for valid prior approvals.
 *
 * "Valid" means the approval marker parses AND the artifact it points to
 * still exists (and for plans, still parses to the same number of tasks the
 * approval recorded). Stale or dangling approvals report as false — callers
 * must treat them as "needs re-analysis", never as approved.
 *
 * This is the single source of truth for prior-approval validity: discover
 * uses it to badge repos in the UI, and the orchestrator (run bootstrap)
 * uses it to decide whether a repo can skip analyze/plan.
 */
export async function readPriorApprovalState(repoPath: string): Promise<PriorApprovalState> {
  try {
    // Check proposal approval: marker must parse AND completion-proposal.md must exist.
    const proposalApproval = await readProposalApproval(repoPath);
    const proposalMarkdown = proposalApproval ? await readProposal(repoPath) : null;
    const proposalApproved = proposalApproval !== null && proposalMarkdown !== null;

    // Check plan approval: marker must parse AND plan.md must exist AND
    // parsePlan(plan.md).length must equal approval.taskCount.
    const planApproval = await readPlanApproval(repoPath);
    let planApproved = false;
    let planTaskCount: number | undefined;

    if (planApproval !== null) {
      const planMarkdown = await readPlan(repoPath);
      if (planMarkdown !== null) {
        const tasks = parsePlan(planMarkdown);
        if (tasks.length === planApproval.taskCount) {
          planApproved = true;
          planTaskCount = planApproval.taskCount;
        }
      }
    }

    return { proposalApproved, planApproved, ...(planTaskCount !== undefined && { planTaskCount }) };
  } catch {
    // Corruption or unexpected I/O → report all-false rather than crashing
    // discovery. A corrupt .agent dir must never prevent the user from seeing
    // the repo in the UI.
    return { proposalApproved: false, planApproved: false };
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
