import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AUTH_MODES, type AuthMode } from "../types.js";
import { writeAtomic, isErrnoCode } from "../state/atomicWrite.js";

const UiConfigSchema = z.object({
  preferredAuthMode: z.enum(AUTH_MODES).nullable(),
});
export type UiConfig = z.infer<typeof UiConfigSchema>;

const DEFAULT: UiConfig = { preferredAuthMode: null };

export function configPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return join(home, ".local", "share", "agent-orchestrator", "ui-config.json");
}

export async function loadUiConfig(): Promise<UiConfig> {
  const path = configPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return { ...DEFAULT };
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = UiConfigSchema.safeParse(parsed);
    if (!result.success) return { ...DEFAULT };
    return result.data;
  } catch {
    return { ...DEFAULT };
  }
}

export async function saveUiConfig(next: UiConfig): Promise<void> {
  const validated = UiConfigSchema.parse(next);
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeAtomic(path, JSON.stringify(validated, null, 2));
}

export async function setPreferredAuthMode(mode: AuthMode | null): Promise<UiConfig> {
  const next: UiConfig = { preferredAuthMode: mode };
  await saveUiConfig(next);
  return next;
}
