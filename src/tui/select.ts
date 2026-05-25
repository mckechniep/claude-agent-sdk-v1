import { checkbox } from "@inquirer/prompts";
import type { DiscoveredRepo } from "../phases/discover.js";

export interface SelectReposParams {
  repos: DiscoveredRepo[];
  pageSize?: number;
}

export async function selectRepos(params: SelectReposParams): Promise<string[]> {
  if (params.repos.length === 0) return [];
  const selected = await checkbox<string>({
    message: "Select repos to include in this run",
    pageSize: params.pageSize ?? 15,
    choices: params.repos.map((r) => ({
      name: formatRepoLabel(r),
      value: r.path,
    })),
  });
  return selected;
}

export function formatRepoLabel(r: DiscoveredRepo): string {
  const stack = `[${r.stack}]`.padEnd(10);
  const dirty = r.isDirty ? " (dirty)" : "";
  const last = r.lastCommitDate ? ` last:${r.lastCommitDate.slice(0, 10)}` : "";
  const tests = r.hasTests ? " ✓tests" : "";
  return `${r.name.padEnd(28)} ${stack}${last}${tests}${dirty}`;
}
