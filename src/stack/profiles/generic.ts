import type { StackProfile } from "./types.js";

export const genericProfile: StackProfile = {
  id: "generic",
  displayName: "Generic (experimental)",
  manifestFiles: [],
  defaultTestCommand: "",
  defaultBuildCommand: "",
  conventions: [
    "Stack could not be auto-detected. Treat conventions cautiously.",
    "Look for README and any *.md in the repo root for hints.",
    "Detect tooling from common files: Makefile, Dockerfile, .editorconfig, .github/workflows/.",
  ],
};
