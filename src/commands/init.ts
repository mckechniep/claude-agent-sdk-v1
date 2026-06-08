import { writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";

const STARTER_RC = `{
  "$schema": "https://example.com/agentrc.schema.json",
  "auth": "api",
  "concurrency": 1,
  "checkpointEvery": 1,
  "onFailure": "skip-repo",
  "maxRetries": 1,
  "testGate": "per-repo",
  "testTimeout": "5m",
  "include": [],
  "exclude": ["projects/legacy-*"],
  "model": { "default": "claude-sonnet-4-6" }
}
`;

const STARTER_IGNORE = `node_modules
.git
dist
build
__pycache__
.venv
venv
target
vendor
`;

export interface InitOpts {
  dir?: string;
}

export async function initCommand(opts: InitOpts = {}): Promise<void> {
  const dir = resolve(opts.dir ?? process.cwd());
  await writeIfMissing(join(dir, ".agentrc.json"), STARTER_RC);
  await writeIfMissing(join(dir, ".agentignore"), STARTER_IGNORE);
  console.warn(`Initialized agent config in ${dir}`);
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  try {
    await access(path);
    console.warn(`exists, leaving alone: ${path}`);
    return;
  } catch {
    /* not present */
  }
  await writeFile(path, content);
  console.warn(`wrote: ${path}`);
}
