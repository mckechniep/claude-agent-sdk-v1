import { simpleGit, type SimpleGit } from "simple-git";

export async function ensureBranch(repoPath: string, branch: string): Promise<void> {
  const g: SimpleGit = simpleGit(repoPath);
  const branches = await g.branchLocal();
  if (branches.all.includes(branch)) {
    if (branches.current !== branch) await g.checkout(branch);
    return;
  }
  await g.checkoutLocalBranch(branch);
}

export async function stageAll(repoPath: string): Promise<void> {
  await simpleGit(repoPath).add(".");
}

export async function commitWithMessage(repoPath: string, message: string): Promise<string> {
  const g = simpleGit(repoPath);
  const result = await g.commit(message);
  return result.commit;
}

export async function isWorkingTreeClean(repoPath: string): Promise<boolean> {
  const status = await simpleGit(repoPath).status();
  return status.isClean();
}

export async function hasChanges(repoPath: string): Promise<boolean> {
  return !(await isWorkingTreeClean(repoPath));
}

export async function getDiff(repoPath: string): Promise<string> {
  return simpleGit(repoPath).diff();
}

export async function getStagedDiff(repoPath: string): Promise<string> {
  return simpleGit(repoPath).diff(["--staged"]);
}

export async function getCurrentBranch(repoPath: string): Promise<string> {
  const status = await simpleGit(repoPath).status();
  return status.current ?? "";
}

export async function getHeadSha(repoPath: string): Promise<string> {
  return (await simpleGit(repoPath).revparse(["HEAD"])).trim();
}

export async function listChangedFiles(repoPath: string): Promise<string[]> {
  const status = await simpleGit(repoPath).status();
  return [
    ...status.modified,
    ...status.created,
    ...status.not_added,
    ...status.deleted,
    ...status.renamed.map((r) => r.to),
  ];
}
