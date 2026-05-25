import { join } from "node:path";
import { listRuns, defaultStateRoot } from "../state/runIndex.js";
import { cleanStaleTmpFiles } from "../state/atomicWrite.js";

export interface DoctorOpts {
  runId?: string;
  repair?: boolean;
}

export async function doctorCommand(opts: DoctorOpts): Promise<void> {
  const root = defaultStateRoot();
  if (!opts.runId) {
    const runs = await listRuns(root);
    if (runs.length === 0) {
      console.warn("No runs to inspect.");
      return;
    }
    let issues = 0;
    for (const { runId } of runs) {
      const cleaned = await cleanStaleTmpFiles(join(root, runId));
      if (cleaned > 0) {
        issues += cleaned;
        console.warn(`run ${runId}: removed ${cleaned} stale tmp file(s)`);
      }
    }
    console.warn(`Scan complete. Issues addressed: ${issues}`);
    return;
  }
  const cleaned = await cleanStaleTmpFiles(join(root, opts.runId));
  console.warn(`run ${opts.runId}: removed ${cleaned} stale tmp file(s)`);
}
