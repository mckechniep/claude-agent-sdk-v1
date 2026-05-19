import type { StackProfile } from "./types.js";

export const jstsProfile: StackProfile = {
  id: "jsts",
  displayName: "JavaScript/TypeScript",
  manifestFiles: ["package.json"],
  defaultTestCommand: "pnpm test --run",
  defaultBuildCommand: "pnpm build",
  conventions: [
    "Source typically lives in `src/` or `app/`.",
    "Tests typically use Jest, Vitest, Playwright, or node:test in `test/`, `__tests__/`, or co-located `*.test.ts`.",
    "Package manifest is `package.json`; lockfile choice indicates package manager (pnpm-lock.yaml/yarn.lock/package-lock.json).",
    "TypeScript projects have `tsconfig.json`; check `compilerOptions.strict`.",
    "Common build outputs: `dist/`, `build/`, `.next/`.",
  ],
};
