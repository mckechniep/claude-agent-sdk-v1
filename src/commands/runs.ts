import { listRuns, defaultStateRoot } from "../state/runIndex.js";
import { renderRunSummary } from "../tui/render.js";

export async function runsListCommand(): Promise<void> {
  const runs = await listRuns(defaultStateRoot());
  if (runs.length === 0) {
    console.warn("No runs found.");
    return;
  }
  for (const { manifest } of runs) {
    console.warn(
      `${manifest.runId}  ${manifest.status.padEnd(10)}  ${manifest.repos.length} repos  ${manifest.createdAt}`,
    );
  }
}

export async function runsShowCommand(runId: string): Promise<void> {
  const runs = await listRuns(defaultStateRoot());
  const target = runs.find((r) => r.runId === runId);
  if (!target) {
    console.error(`Run ${runId} not found`);
    process.exit(1);
  }
  console.warn(renderRunSummary(target.manifest));
}
