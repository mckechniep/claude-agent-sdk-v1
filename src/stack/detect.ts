import { access } from "node:fs/promises";
import { join } from "node:path";
import type { StackId } from "../types.js";
import { jstsProfile } from "./profiles/jsts.js";
import { pythonProfile } from "./profiles/python.js";
import { genericProfile } from "./profiles/generic.js";
import type { StackProfile } from "./profiles/types.js";

const PROFILES_BY_ID: Record<StackId, StackProfile> = {
  jsts: jstsProfile,
  python: pythonProfile,
  generic: genericProfile,
};

const DETECTION_ORDER: StackId[] = ["jsts", "python"];

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function detectStack(repoPath: string): Promise<StackId> {
  for (const id of DETECTION_ORDER) {
    const profile = PROFILES_BY_ID[id];
    for (const manifest of profile.manifestFiles) {
      if (await fileExists(join(repoPath, manifest))) return id;
    }
  }
  return "generic";
}

export function getStackProfile(id: StackId): StackProfile {
  return PROFILES_BY_ID[id];
}
