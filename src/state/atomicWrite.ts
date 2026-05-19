import { rename, writeFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pid } from "node:process";

export function isErrnoCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

export async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const tmpPath = `${path}.tmp.${pid}.${Date.now()}`;
  await writeFile(tmpPath, data);
  await rename(tmpPath, path);
}

const TMP_PATTERN = /\.tmp\.\d+\.\d+$/;

export async function cleanStaleTmpFiles(dir: string): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return 0;
    throw error;
  }
  for (const entry of entries) {
    if (!TMP_PATTERN.test(entry)) continue;
    try {
      await unlink(join(dir, entry));
      removed += 1;
    } catch (error) {
      if (!isErrnoCode(error, "ENOENT")) throw error;
    }
  }
  return removed;
}
