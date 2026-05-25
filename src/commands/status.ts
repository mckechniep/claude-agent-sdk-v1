import { access } from "node:fs/promises";
import { join } from "node:path";
import { listRuns, defaultStateRoot } from "../state/runIndex.js";
import { loadRepoState } from "../state/repoState.js";

export async function statusCommand(): Promise<void> {
  const cwd = process.cwd();
  const inRepo = await isInRepo(cwd);
  if (inRepo) {
    const state = await loadRepoState(cwd);
    console.warn(`Repo: ${state.name}`);
    console.warn(`Status: ${state.status}`);
    if (state.taskState) {
      const completed = state.taskState.filter((t) => t.status === "completed").length;
      console.warn(`Tasks: ${completed}/${state.taskState.length} completed`);
    }
    return;
  }
  const runs = await listRuns(defaultStateRoot());
  const active = runs.filter((r) => ["running", "paused"].includes(r.manifest.status));
  if (active.length === 0) {
    console.warn("No active runs.");
  } else {
    console.warn("Active runs:");
    for (const { manifest } of active) {
      console.warn(`  ${manifest.runId}  ${manifest.status}  ${manifest.repos.length} repos`);
    }
  }
}

async function isInRepo(cwd: string): Promise<boolean> {
  try {
    await access(join(cwd, ".agent", "state.json"));
    return true;
  } catch {
    return false;
  }
}
