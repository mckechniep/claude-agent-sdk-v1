import type { StackId } from "../../types.js";

export interface StackProfile {
  id: StackId;
  displayName: string;
  manifestFiles: string[];
  defaultTestCommand: string;
  defaultBuildCommand: string;
  conventions: string[];
}
