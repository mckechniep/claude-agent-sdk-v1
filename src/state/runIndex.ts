import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { RunManifestSchema, StateCorruption, type RunManifest } from "../types.js";
import { writeAtomic, cleanStaleTmpFiles, isErrnoCode } from "./atomicWrite.js";

export function defaultStateRoot(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return join(home, ".local", "share", "agent-orchestrator", "runs");
}

export async function createRunDir(stateRoot: string, runId: string): Promise<string> {
  const dir = join(stateRoot, runId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function saveManifest(runDir: string, manifest: RunManifest): Promise<void> {
  const validated = RunManifestSchema.parse(manifest);
  await writeAtomic(join(runDir, "manifest.json"), JSON.stringify(validated, null, 2));
}

export async function loadManifest(runDir: string): Promise<RunManifest> {
  // Recover from crashes between writeAtomic's tmp-write and rename steps.
  // Cheap (one readdir) and idempotent — safe to call on every load.
  await cleanStaleTmpFiles(runDir);
  const path = join(runDir, "manifest.json");
  const raw = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StateCorruption(path, `JSON parse failed: ${(err as Error).message}`);
  }
  const result = RunManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new StateCorruption(path, `schema mismatch: ${result.error.message}`);
  }
  return result.data;
}

export async function listRuns(
  stateRoot: string,
): Promise<Array<{ runId: string; manifest: RunManifest }>> {
  let entries: string[];
  try {
    entries = await readdir(stateRoot);
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return [];
    throw err;
  }
  const out: Array<{ runId: string; manifest: RunManifest }> = [];
  for (const entry of entries.sort().reverse()) {
    try {
      const manifest = await loadManifest(join(stateRoot, entry));
      out.push({ runId: entry, manifest });
    } catch {
      // skip unreadable runs (doctor will pick them up)
    }
  }
  return out;
}
