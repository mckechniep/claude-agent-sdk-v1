import { listRuns, defaultStateRoot } from "../state/runIndex.js";

export interface ResumeOpts {
  runId?: string;
}

export async function resumeCommand(opts: ResumeOpts): Promise<void> {
  const runs = await listRuns(defaultStateRoot());
  const paused = runs.filter((r) => r.manifest.status === "paused");
  let runId = opts.runId;
  if (!runId) {
    if (paused.length === 0) {
      console.error("No paused runs found.");
      process.exit(1);
    }
    if (paused.length > 1) {
      console.error("Multiple paused runs. Specify --run-id <id>:");
      for (const { manifest } of paused) {
        console.error(`  ${manifest.runId}  ${manifest.repos.length} repos  ${manifest.createdAt}`);
      }
      process.exit(1);
    }
    runId = paused[0]!.runId;
  }
  console.warn(
    `Resume support is incremental — for now, the orchestrator must be re-invoked manually.`,
  );
  console.warn(`Target run: ${runId}`);
  console.warn(
    `Implementation note: full resume requires walking next-non-terminal logic; tracked for the resume task.`,
  );
  process.exit(0);
}
