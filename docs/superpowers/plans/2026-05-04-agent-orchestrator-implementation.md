# Agent Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-machine CLI tool that walks a user through discovering local git repos, analyzing them with an LLM agent to propose completion criteria, drafting plans for user approval, and executing those plans task-by-task with commits, retries, and resumability.

**Architecture:** Approach 2 — orchestrator is plain TypeScript code that drives a state machine; the Claude Agent SDK's `query()` is a leaf primitive called per-phase with focused prompts and scoped tool allowlists. State persisted via atomic writes (full-document state files) plus an append-only JSONL event log, with a central run index and per-repo `.agent/` directories.

**Tech Stack:** Node 22+, TypeScript 5.6+, `@anthropic-ai/claude-agent-sdk` 0.2.118+, pnpm, Vitest, Zod, simple-git, commander, ulid, memfs (test). Config files: ESLint flat config, Prettier, tsconfig strict.

**Reference:** Spec at `docs/superpowers/specs/2026-05-04-agent-orchestrator-design.md` — read before starting.

---

## Phase 0 — Project bootstrap

Goal: working pnpm + TypeScript + Vitest project, lints, formats, types. No runtime code yet.

### Task 1 — Initialize package, dependencies, and tsconfig

**Files:**
- Modify: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Delete: `agent.ts` (replaced by `src/cli.ts` later)

- [ ] **Step 1: Replace `package.json`**

```json
{
  "name": "agent-orchestrator",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.0.0" },
  "bin": { "agent": "./dist/cli.js" },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/cli.ts",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "format": "prettier --write .",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:unit": "vitest run --dir test/unit",
    "test:integration": "vitest run --dir test/integration",
    "test:prompts": "vitest run --dir test/prompts",
    "test:e2e": "RUN_E2E=1 vitest run --dir test/e2e",
    "coverage": "vitest run --coverage"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.2.118",
    "commander": "^12.1.0",
    "simple-git": "^3.27.0",
    "ulid": "^2.3.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.9.0",
    "@vitest/coverage-v8": "^2.1.4",
    "eslint": "^9.14.0",
    "memfs": "^4.14.0",
    "prettier": "^3.3.3",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3",
    "typescript-eslint": "^8.13.0",
    "vitest": "^2.1.4"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules
dist
coverage
*.log
.env
.env.local
.DS_Store
*.tmp
.vitest-cache
```

- [ ] **Step 4: Delete the placeholder `agent.ts`**

```bash
rm agent.ts
```

- [ ] **Step 5: Install dependencies**

Run: `pnpm install`
Expected: lockfile generated, no errors. `node_modules/typescript/bin/tsc` exists.

- [ ] **Step 6: Verify typecheck passes (no source yet)**

Run: `pnpm typecheck`
Expected: passes (no `.ts` files yet to check).

- [ ] **Step 7: Commit**

```bash
git init
git add package.json tsconfig.json .gitignore
git rm -f agent.ts || true
git commit -m "chore: bootstrap pnpm + typescript project"
```

### Task 2 — Configure linter, formatter, and test runner

**Files:**
- Create: `eslint.config.js`
- Create: `.prettierrc.json`
- Create: `.prettierignore`
- Create: `vitest.config.ts`

- [ ] **Step 1: Create `eslint.config.js`**

```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "test/fixtures/**"],
  },
);
```

- [ ] **Step 2: Create `.prettierrc.json`**

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "useTabs": false,
  "arrowParens": "always",
  "endOfLine": "lf"
}
```

- [ ] **Step 3: Create `.prettierignore`**

```
node_modules
dist
coverage
test/fixtures
*.md
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/types.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
    include: ["test/**/*.test.ts"],
  },
});
```

- [ ] **Step 5: Verify lint and format work on existing files**

Run: `pnpm lint`
Expected: passes (no source files yet).

Run: `pnpm format`
Expected: formats config files in place. No errors.

- [ ] **Step 6: Commit**

```bash
git add eslint.config.js .prettierrc.json .prettierignore vitest.config.ts
git commit -m "chore: add eslint, prettier, vitest configs"
```

### Task 3 — Scaffold source tree and create types.ts

**Files:**
- Create: `src/cli.ts` (placeholder)
- Create: `src/types.ts`

- [ ] **Step 1: Create the source directory structure**

```bash
mkdir -p src/commands src/orchestrator src/phases src/tui src/state/migrations \
         src/auth src/sdk/prompts src/stack/profiles src/lib \
         test/unit test/integration test/prompts test/e2e test/fixtures/repos
```

- [ ] **Step 2: Create `src/cli.ts` placeholder**

```ts
#!/usr/bin/env node
console.error("agent-orchestrator: not yet implemented");
process.exit(1);
```

- [ ] **Step 3: Create `src/types.ts` with all shared types**

```ts
import { z } from "zod";

export const SCHEMA_VERSION = 1;

export type AuthMode = "api" | "subscription";

export type PhaseName = "discover" | "analyze" | "plan" | "execute";

export type RunStatus =
  | "discovering"
  | "selecting"
  | "preflight"
  | "running"
  | "paused"
  | "completed"
  | "failed";

export type RepoStatus =
  | "pending"
  | "analyzing"
  | "awaiting-proposal-approval"
  | "planning"
  | "awaiting-plan-approval"
  | "executing"
  | "completed"
  | "failed"
  | "skipped";

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";

export type StackId = "jsts" | "python" | "generic";

export type OnFailure = "stop" | "skip-task" | "skip-repo" | "retry";

export type TestGate = "required" | "skip" | "per-repo";

export const RunConfigSchema = z.object({
  targetDir: z.string(),
  concurrency: z.number().int().positive(),
  checkpointEvery: z.number(), // Infinity for --yolo, encoded as Number.MAX_SAFE_INTEGER on disk
  onFailure: z.enum(["stop", "skip-task", "skip-repo", "retry"]),
  maxRetries: z.number().int().nonnegative(),
  maxTokens: z.number().int().positive().optional(),
  maxDurationMs: z.number().int().positive().optional(),
  testGate: z.enum(["required", "skip", "per-repo"]),
  testTimeoutMs: z.number().int().positive(),
  model: z.object({
    default: z.string(),
    analyze: z.string().optional(),
    plan: z.string().optional(),
    execute: z.string().optional(),
  }),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
});
export type RunConfig = z.infer<typeof RunConfigSchema>;

export const TaskStateSchema = z.object({
  taskId: z.string().uuid(),
  title: z.string(),
  acceptanceCriteria: z.array(z.string()),
  status: z.enum(["pending", "in_progress", "completed", "failed", "skipped"]),
  attempts: z.number().int().nonnegative(),
  commitSha: z.string().optional(),
  tokensUsed: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  testOutput: z.string().optional(),
  failureReason: z.string().optional(),
});
export type TaskState = z.infer<typeof TaskStateSchema>;

export const RepoEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  stack: z.enum(["jsts", "python", "generic"]),
  status: z.enum([
    "pending",
    "analyzing",
    "awaiting-proposal-approval",
    "planning",
    "awaiting-plan-approval",
    "executing",
    "completed",
    "failed",
    "skipped",
  ]),
  proposalPath: z.string().optional(),
  planPath: z.string().optional(),
  taskState: z.array(TaskStateSchema).optional(),
  testGate: z.boolean(),
});
export type RepoEntry = z.infer<typeof RepoEntrySchema>;

export const BudgetStateSchema = z.object({
  tokensUsed: z.number().int().nonnegative(),
  startedAt: z.string(),
  estimatedTotalTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});
export type BudgetState = z.infer<typeof BudgetStateSchema>;

export const RunManifestSchema = z.object({
  runId: z.string(),
  createdAt: z.string(),
  authMode: z.enum(["api", "subscription"]),
  config: RunConfigSchema,
  repos: z.array(RepoEntrySchema),
  budget: BudgetStateSchema,
  status: z.enum([
    "discovering",
    "selecting",
    "preflight",
    "running",
    "paused",
    "completed",
    "failed",
  ]),
  schemaVersion: z.number().int().positive(),
});
export type RunManifest = z.infer<typeof RunManifestSchema>;

export const LogEventSchema = z.discriminatedUnion("type", [
  z.object({ ts: z.string(), type: z.literal("run_started"), runId: z.string() }),
  z.object({
    ts: z.string(),
    type: z.literal("phase_started"),
    repoPath: z.string(),
    phase: z.enum(["discover", "analyze", "plan", "execute"]),
  }),
  z.object({
    ts: z.string(),
    type: z.literal("phase_completed"),
    repoPath: z.string(),
    phase: z.enum(["discover", "analyze", "plan", "execute"]),
    tokensUsed: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
  }),
  z.object({
    ts: z.string(),
    type: z.literal("task_started"),
    repoPath: z.string(),
    taskId: z.string(),
  }),
  z.object({
    ts: z.string(),
    type: z.literal("task_completed"),
    repoPath: z.string(),
    taskId: z.string(),
    commitSha: z.string(),
    tokensUsed: z.number().int().nonnegative(),
  }),
  z.object({
    ts: z.string(),
    type: z.literal("task_failed"),
    repoPath: z.string(),
    taskId: z.string(),
    reason: z.string(),
    willRetry: z.boolean(),
  }),
  z.object({
    ts: z.string(),
    type: z.literal("checkpoint_paused"),
    repoPath: z.string(),
    afterTaskId: z.string(),
  }),
  z.object({
    ts: z.string(),
    type: z.literal("checkpoint_resumed"),
    repoPath: z.string(),
    action: z.enum(["continue", "skip", "edit", "quit"]),
  }),
  z.object({
    ts: z.string(),
    type: z.literal("budget_warning"),
    reason: z.string(),
    tokensUsed: z.number().int().nonnegative(),
  }),
  z.object({ ts: z.string(), type: z.literal("budget_capped"), reason: z.string() }),
  z.object({
    ts: z.string(),
    type: z.literal("run_finalized"),
    status: z.enum(["completed", "failed"]),
    durationMs: z.number().int().nonnegative(),
  }),
]);
export type LogEvent = z.infer<typeof LogEventSchema>;

export class StateCorruption extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`State corruption at ${path}: ${message}`);
    this.name = "StateCorruption";
  }
}

export class BudgetCapped extends Error {
  constructor(public readonly reason: string) {
    super(`Budget cap hit: ${reason}`);
    this.name = "BudgetCapped";
  }
}

export class TaskAbandoned extends Error {
  constructor(
    public readonly taskId: string,
    public readonly reason: string,
  ) {
    super(`Task ${taskId} abandoned: ${reason}`);
    this.name = "TaskAbandoned";
  }
}
```

- [ ] **Step 4: Verify typecheck**

Run: `pnpm typecheck`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add src/
git commit -m "feat: scaffold source tree and shared types"
```

---

## Phase 1 — State foundation

Goal: rock-solid persistence layer (atomic writes, JSONL logs, manifest CRUD). Tested in isolation. Nothing depends on this yet.

### Task 4 — Atomic write helper

**Files:**
- Create: `src/state/atomicWrite.ts`
- Test: `test/unit/state/atomicWrite.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// test/unit/state/atomicWrite.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAtomic, cleanStaleTmpFiles } from "../../../src/state/atomicWrite.js";

describe("writeAtomic", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes content atomically and the final file is readable", async () => {
    const path = join(dir, "state.json");
    await writeAtomic(path, '{"ok":true}');
    expect(await readFile(path, "utf8")).toBe('{"ok":true}');
  });

  it("does not leave .tmp files in the directory after a successful write", async () => {
    const path = join(dir, "state.json");
    await writeAtomic(path, "abc");
    const entries = await readdir(dir);
    expect(entries.filter((e) => e.includes(".tmp"))).toHaveLength(0);
    expect(entries).toContain("state.json");
  });

  it("preserves the previous file if writeAtomic is called with new content", async () => {
    const path = join(dir, "state.json");
    await writeAtomic(path, "v1");
    await writeAtomic(path, "v2");
    expect(await readFile(path, "utf8")).toBe("v2");
  });
});

describe("cleanStaleTmpFiles", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-clean-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("removes files matching the .tmp.<pid>.<ts> pattern", async () => {
    await writeFile(join(dir, "state.json.tmp.123.456"), "garbage");
    await writeFile(join(dir, "state.json"), "good");
    await cleanStaleTmpFiles(dir);
    const entries = await readdir(dir);
    expect(entries).toEqual(["state.json"]);
  });

  it("does not touch non-matching files", async () => {
    await writeFile(join(dir, "state.json"), "good");
    await writeFile(join(dir, "notes.md"), "keep");
    await cleanStaleTmpFiles(dir);
    const entries = await readdir(dir);
    expect(entries.sort()).toEqual(["notes.md", "state.json"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- atomicWrite`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/state/atomicWrite.ts`**

```ts
import { rename, writeFile, readdir, unlink } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { pid } from "node:process";

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
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (TMP_PATTERN.test(entry)) {
      await unlink(join(dir, entry));
      removed += 1;
    }
  }
  return removed;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- atomicWrite`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/state/atomicWrite.ts test/unit/state/atomicWrite.test.ts
git commit -m "feat(state): atomic write helper with stale tmp cleanup"
```

### Task 5 — Run log (JSONL append-only)

**Files:**
- Create: `src/state/runLog.ts`
- Test: `test/unit/state/runLog.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// test/unit/state/runLog.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLogEvent, readLogEvents } from "../../../src/state/runLog.js";
import type { LogEvent } from "../../../src/types.js";

describe("runLog", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "runlog-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("appends events as JSONL", async () => {
    const path = join(dir, "run-log.jsonl");
    const e1: LogEvent = { ts: "2026-05-04T00:00:00Z", type: "run_started", runId: "r1" };
    const e2: LogEvent = {
      ts: "2026-05-04T00:00:01Z",
      type: "phase_started",
      repoPath: "/r",
      phase: "analyze",
    };
    await appendLogEvent(path, e1);
    await appendLogEvent(path, e2);
    const raw = await readFile(path, "utf8");
    expect(raw.split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("reads back valid events and skips malformed lines", async () => {
    const path = join(dir, "run-log.jsonl");
    const e1: LogEvent = { ts: "2026-05-04T00:00:00Z", type: "run_started", runId: "r1" };
    await appendLogEvent(path, e1);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, (await readFile(path, "utf8")) + "{not json\n");
    const events = await readLogEvents(path);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("run_started");
  });

  it("returns [] when log file does not exist", async () => {
    const events = await readLogEvents(join(dir, "missing.jsonl"));
    expect(events).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- runLog`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/state/runLog.ts`**

```ts
import { appendFile, readFile } from "node:fs/promises";
import { LogEventSchema, type LogEvent } from "../types.js";

export async function appendLogEvent(path: string, event: LogEvent): Promise<void> {
  const line = JSON.stringify(event) + "\n";
  await appendFile(path, line, { flag: "a" });
}

export async function readLogEvents(path: string): Promise<LogEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: LogEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      const validated = LogEventSchema.safeParse(parsed);
      if (validated.success) out.push(validated.data);
    } catch {
      // skip malformed lines (last-line-corruption tolerance)
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- runLog`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/state/runLog.ts test/unit/state/runLog.test.ts
git commit -m "feat(state): append-only JSONL run log"
```

### Task 6 — Run index (manifest CRUD)

**Files:**
- Create: `src/state/runIndex.ts`
- Test: `test/unit/state/runIndex.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// test/unit/state/runIndex.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRunDir,
  loadManifest,
  saveManifest,
  listRuns,
} from "../../../src/state/runIndex.js";
import type { RunManifest } from "../../../src/types.js";
import { SCHEMA_VERSION } from "../../../src/types.js";

const baseManifest = (runId: string): RunManifest => ({
  runId,
  createdAt: "2026-05-04T00:00:00Z",
  authMode: "api",
  config: {
    targetDir: "/tmp/x",
    concurrency: 1,
    checkpointEvery: 1,
    onFailure: "skip-repo",
    maxRetries: 1,
    testGate: "per-repo",
    testTimeoutMs: 300_000,
    model: { default: "claude-sonnet-4-6" },
  },
  repos: [],
  budget: { tokensUsed: 0, startedAt: "2026-05-04T00:00:00Z" },
  status: "discovering",
  schemaVersion: SCHEMA_VERSION,
});

describe("runIndex", () => {
  let stateRoot: string;
  beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), "runindex-"));
  });
  afterEach(async () => {
    await rm(stateRoot, { recursive: true, force: true });
  });

  it("creates a run directory under the configured root", async () => {
    const dir = await createRunDir(stateRoot, "01HKQR3Z8M");
    expect(dir.endsWith("01HKQR3Z8M")).toBe(true);
  });

  it("round-trips a manifest", async () => {
    const dir = await createRunDir(stateRoot, "01HKQR3Z8M");
    const m = baseManifest("01HKQR3Z8M");
    await saveManifest(dir, m);
    const loaded = await loadManifest(dir);
    expect(loaded).toEqual(m);
  });

  it("lists runs sorted newest-first by runId", async () => {
    await createRunDir(stateRoot, "01HKMR7B2C");
    await createRunDir(stateRoot, "01HKQR3Z8M");
    await saveManifest(join(stateRoot, "01HKMR7B2C"), baseManifest("01HKMR7B2C"));
    await saveManifest(join(stateRoot, "01HKQR3Z8M"), baseManifest("01HKQR3Z8M"));
    const runs = await listRuns(stateRoot);
    expect(runs.map((r) => r.runId)).toEqual(["01HKQR3Z8M", "01HKMR7B2C"]);
  });

  it("throws StateCorruption when manifest fails schema", async () => {
    const dir = await createRunDir(stateRoot, "01HKQR3Z8M");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "manifest.json"), '{"runId":"x"}');
    await expect(loadManifest(dir)).rejects.toThrow(/State corruption/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- runIndex`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/state/runIndex.ts`**

```ts
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { RunManifestSchema, StateCorruption, type RunManifest } from "../types.js";
import { writeAtomic, cleanStaleTmpFiles } from "./atomicWrite.js";

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
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- runIndex`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/state/runIndex.ts test/unit/state/runIndex.test.ts
git commit -m "feat(state): run index with manifest CRUD"
```

### Task 7 — Per-repo state (`.agent/` CRUD)

**Files:**
- Create: `src/state/repoState.ts`
- Test: `test/unit/state/repoState.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// test/unit/state/repoState.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureAgentDir,
  saveRepoState,
  loadRepoState,
  writeProposal,
  writePlan,
  ensureGitignore,
} from "../../../src/state/repoState.js";
import type { RepoEntry } from "../../../src/types.js";

const baseRepo = (): RepoEntry => ({
  path: "/tmp/x",
  name: "x",
  stack: "jsts",
  status: "pending",
  testGate: true,
});

describe("repoState", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "reposrc-"));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("creates .agent and notes/ subdirs", async () => {
    await ensureAgentDir(repo);
    const { stat } = await import("node:fs/promises");
    expect((await stat(join(repo, ".agent"))).isDirectory()).toBe(true);
    expect((await stat(join(repo, ".agent", "notes"))).isDirectory()).toBe(true);
  });

  it("round-trips repo state", async () => {
    await ensureAgentDir(repo);
    const r = baseRepo();
    await saveRepoState(repo, r);
    const loaded = await loadRepoState(repo);
    expect(loaded).toEqual(r);
  });

  it("writes proposal markdown to the expected path", async () => {
    await ensureAgentDir(repo);
    const path = await writeProposal(repo, "# Proposal\n\nbody");
    expect(path).toBe(join(repo, ".agent", "completion-proposal.md"));
    expect(await readFile(path, "utf8")).toContain("# Proposal");
  });

  it("writes plan markdown to the expected path", async () => {
    await ensureAgentDir(repo);
    const path = await writePlan(repo, "# Plan");
    expect(path).toBe(join(repo, ".agent", "plan.md"));
    expect(await readFile(path, "utf8")).toBe("# Plan");
  });

  it("appends .agent/ to .gitignore if not present", async () => {
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, ".gitignore"), "node_modules\n");
    await ensureGitignore(repo);
    const content = await readFile(join(repo, ".gitignore"), "utf8");
    expect(content).toContain(".agent/");
  });

  it("does not duplicate .agent/ entry in .gitignore", async () => {
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, ".gitignore"), "node_modules\n.agent/\n");
    await ensureGitignore(repo);
    const content = await readFile(join(repo, ".gitignore"), "utf8");
    const occurrences = content.match(/\.agent\//g) ?? [];
    expect(occurrences).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- repoState`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/state/repoState.ts`**

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RepoEntrySchema, StateCorruption, type RepoEntry } from "../types.js";
import { writeAtomic, cleanStaleTmpFiles } from "./atomicWrite.js";

export const AGENT_DIR = ".agent";

export async function ensureAgentDir(repoPath: string): Promise<string> {
  const dir = join(repoPath, AGENT_DIR);
  await mkdir(join(dir, "notes"), { recursive: true });
  return dir;
}

export async function saveRepoState(repoPath: string, entry: RepoEntry): Promise<void> {
  const dir = await ensureAgentDir(repoPath);
  const validated = RepoEntrySchema.parse(entry);
  await writeAtomic(join(dir, "state.json"), JSON.stringify(validated, null, 2));
}

export async function loadRepoState(repoPath: string): Promise<RepoEntry> {
  const dir = join(repoPath, AGENT_DIR);
  await cleanStaleTmpFiles(dir);
  const path = join(dir, "state.json");
  const raw = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StateCorruption(path, `JSON parse failed: ${(err as Error).message}`);
  }
  const result = RepoEntrySchema.safeParse(parsed);
  if (!result.success) {
    throw new StateCorruption(path, `schema mismatch: ${result.error.message}`);
  }
  return result.data;
}

export async function writeProposal(repoPath: string, markdown: string): Promise<string> {
  const dir = await ensureAgentDir(repoPath);
  const path = join(dir, "completion-proposal.md");
  await writeAtomic(path, markdown);
  return path;
}

export async function writePlan(repoPath: string, markdown: string): Promise<string> {
  const dir = await ensureAgentDir(repoPath);
  const path = join(dir, "plan.md");
  await writeAtomic(path, markdown);
  return path;
}

export async function ensureGitignore(repoPath: string): Promise<void> {
  const path = join(repoPath, ".gitignore");
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (current.split("\n").some((l) => l.trim() === ".agent/" || l.trim() === ".agent")) return;
  const next = current.endsWith("\n") || current === "" ? current + ".agent/\n" : current + "\n.agent/\n";
  await writeFile(path, next);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- repoState`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/state/repoState.ts test/unit/state/repoState.test.ts
git commit -m "feat(state): per-repo .agent/ CRUD with gitignore management"
```

---

## Phase 2 — SDK wrapper + auth

Goal: single chokepoint for SDK calls; auth-mode resolution that supports both API key and subscription paths.

### Task 8 — Auth mode resolution

**Files:**
- Create: `src/auth/mode.ts`
- Test: `test/unit/auth/mode.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// test/unit/auth/mode.test.ts
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { resolveAuthMode, applyAuthMode } from "../../../src/auth/mode.js";

describe("resolveAuthMode", () => {
  it("returns explicit value when provided", () => {
    expect(resolveAuthMode({ flag: "api" })).toEqual({ mode: "api", source: "flag" });
    expect(resolveAuthMode({ flag: "subscription" })).toEqual({
      mode: "subscription",
      source: "flag",
    });
  });

  it("falls back to env var when flag is undefined", () => {
    expect(resolveAuthMode({ env: "subscription" })).toEqual({
      mode: "subscription",
      source: "env",
    });
  });

  it("returns null when neither flag nor env nor TTY available", () => {
    expect(resolveAuthMode({ interactive: false })).toBeNull();
  });
});

describe("applyAuthMode", () => {
  const original = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = original;
  });

  it("keeps API key in env when api mode chosen", () => {
    applyAuthMode("api");
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-test");
  });

  it("removes API key from env when subscription mode chosen", () => {
    applyAuthMode("subscription");
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("throws when api mode is chosen but no key is set", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => applyAuthMode("api")).toThrow(/ANTHROPIC_API_KEY/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- mode`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/auth/mode.ts`**

```ts
import type { AuthMode } from "../types.js";

export interface ResolveInput {
  flag?: AuthMode;
  env?: AuthMode;
  interactive?: boolean;
}

export interface ResolvedAuth {
  mode: AuthMode;
  source: "flag" | "env" | "prompt";
}

export function resolveAuthMode(input: ResolveInput): ResolvedAuth | null {
  if (input.flag) return { mode: input.flag, source: "flag" };
  if (input.env) return { mode: input.env, source: "env" };
  return null;
}

export function applyAuthMode(mode: AuthMode): void {
  if (mode === "api") {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        "auth=api requires ANTHROPIC_API_KEY in env (or use --auth=subscription)",
      );
    }
    return;
  }
  delete process.env.ANTHROPIC_API_KEY;
}

export function authWarnings(mode: AuthMode, concurrency: number): string[] {
  const warnings: string[] = [];
  if (mode === "subscription" && concurrency > 1) {
    warnings.push(
      `Subscription mode shares one quota window across all ${concurrency} parallel runs. ` +
        `Hitting the rate-limit ceiling is much more likely than at concurrency=1.`,
    );
  }
  return warnings;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- mode`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/auth/mode.ts test/unit/auth/mode.test.ts
git commit -m "feat(auth): auth mode resolution and env mutation"
```

### Task 9 — SDK wrapper with budget hooks

**Files:**
- Create: `src/orchestrator/budget.ts`
- Create: `src/sdk/query.ts`
- Test: `test/unit/orchestrator/budget.test.ts`
- Test: `test/unit/sdk/query.test.ts`

- [ ] **Step 1: Write failing test for budget tracker**

```ts
// test/unit/orchestrator/budget.test.ts
import { describe, expect, it } from "vitest";
import { BudgetTracker } from "../../../src/orchestrator/budget.js";
import { BudgetCapped } from "../../../src/types.js";

describe("BudgetTracker", () => {
  it("accumulates tokens across calls", () => {
    const t = new BudgetTracker({});
    t.add(1000);
    t.add(2500);
    expect(t.tokensUsed).toBe(3500);
  });

  it("throws BudgetCapped when token cap exceeded", () => {
    const t = new BudgetTracker({ maxTokens: 5000 });
    t.add(2000);
    expect(() => t.add(4000)).toThrow(BudgetCapped);
  });

  it("throws BudgetCapped on duration overrun via check()", () => {
    const t = new BudgetTracker({ maxDurationMs: 1 });
    return new Promise((resolve) => {
      setTimeout(() => {
        expect(() => t.check()).toThrow(BudgetCapped);
        resolve(undefined);
      }, 5);
    });
  });

  it("does not throw when caps are unset", () => {
    const t = new BudgetTracker({});
    t.add(10_000_000);
    expect(t.tokensUsed).toBe(10_000_000);
  });
});
```

- [ ] **Step 2: Implement `src/orchestrator/budget.ts`**

```ts
import { BudgetCapped } from "../types.js";

export interface BudgetOptions {
  maxTokens?: number;
  maxDurationMs?: number;
}

export class BudgetTracker {
  public tokensUsed = 0;
  public readonly startedAt = Date.now();
  constructor(private readonly options: BudgetOptions) {}

  add(tokens: number): void {
    this.tokensUsed += tokens;
    if (this.options.maxTokens !== undefined && this.tokensUsed > this.options.maxTokens) {
      throw new BudgetCapped(
        `token cap exceeded: used ${this.tokensUsed} > cap ${this.options.maxTokens}`,
      );
    }
  }

  check(): void {
    if (this.options.maxDurationMs !== undefined) {
      const elapsed = Date.now() - this.startedAt;
      if (elapsed > this.options.maxDurationMs) {
        throw new BudgetCapped(
          `duration cap exceeded: elapsed ${elapsed}ms > cap ${this.options.maxDurationMs}ms`,
        );
      }
    }
  }
}
```

- [ ] **Step 3: Run budget test to verify it passes**

Run: `pnpm test:unit -- budget`
Expected: 4 tests pass.

- [ ] **Step 4: Write failing test for SDK wrapper**

```ts
// test/unit/sdk/query.test.ts
import { describe, expect, it, vi } from "vitest";
import { runQuery } from "../../../src/sdk/query.js";
import { BudgetTracker } from "../../../src/orchestrator/budget.js";

describe("runQuery", () => {
  it("invokes the underlying query and accumulates tokens into the tracker", async () => {
    const fakeQuery = vi.fn(async function* () {
      yield { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } };
      yield {
        type: "result",
        result: "hi",
        usage: { input_tokens: 100, output_tokens: 200 },
      };
    });
    const tracker = new BudgetTracker({});
    const result = await runQuery({
      prompt: "test",
      allowedTools: ["Read"],
      cwd: "/tmp",
      tracker,
      queryFn: fakeQuery as never,
    });
    expect(result.tokensUsed).toBe(300);
    expect(result.finalText).toBe("hi");
    expect(tracker.tokensUsed).toBe(300);
    expect(fakeQuery).toHaveBeenCalledTimes(1);
  });

  it("normalizes the result shape with messages and durationMs", async () => {
    const fakeQuery = vi.fn(async function* () {
      yield { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } };
      yield { type: "result", result: "ok", usage: { input_tokens: 50, output_tokens: 50 } };
    });
    const tracker = new BudgetTracker({});
    const result = await runQuery({
      prompt: "p",
      allowedTools: ["Read"],
      cwd: "/tmp",
      tracker,
      queryFn: fakeQuery as never,
    });
    expect(result.messages).toHaveLength(2);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 5: Implement `src/sdk/query.ts`**

```ts
import type { BudgetTracker } from "../orchestrator/budget.js";

export interface QueryParams {
  prompt: string;
  allowedTools: string[];
  cwd: string;
  tracker: BudgetTracker;
  model?: string;
  systemPrompt?: string;
  queryFn?: AsyncGeneratorFn;
}

export interface QueryResult {
  messages: unknown[];
  finalText: string;
  tokensUsed: number;
  durationMs: number;
}

type AsyncGeneratorFn = (args: unknown) => AsyncGenerator<{
  type: string;
  message?: { content: Array<{ type: string; text?: string }> };
  result?: string;
  usage?: { input_tokens: number; output_tokens: number };
}>;

let cachedSdkQuery: AsyncGeneratorFn | null = null;
async function getDefaultQueryFn(): Promise<AsyncGeneratorFn> {
  if (cachedSdkQuery) return cachedSdkQuery;
  const mod = await import("@anthropic-ai/claude-agent-sdk");
  cachedSdkQuery = mod.query as unknown as AsyncGeneratorFn;
  return cachedSdkQuery;
}

export async function runQuery(params: QueryParams): Promise<QueryResult> {
  const queryFn = params.queryFn ?? (await getDefaultQueryFn());
  const startedAt = Date.now();
  const messages: unknown[] = [];
  let finalText = "";
  let inputTokens = 0;
  let outputTokens = 0;

  const stream = queryFn({
    prompt: params.prompt,
    options: {
      cwd: params.cwd,
      allowedTools: params.allowedTools,
      ...(params.model ? { model: params.model } : {}),
      ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
    },
  });

  for await (const msg of stream) {
    messages.push(msg);
    if (msg.type === "result") {
      finalText = msg.result ?? "";
      inputTokens = msg.usage?.input_tokens ?? 0;
      outputTokens = msg.usage?.output_tokens ?? 0;
    }
    params.tracker.check();
  }

  const tokensUsed = inputTokens + outputTokens;
  params.tracker.add(tokensUsed);

  return {
    messages,
    finalText,
    tokensUsed,
    durationMs: Date.now() - startedAt,
  };
}
```

- [ ] **Step 6: Run SDK test to verify it passes**

Run: `pnpm test:unit -- query`
Expected: 2 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/budget.ts src/sdk/query.ts \
  test/unit/orchestrator/budget.test.ts test/unit/sdk/query.test.ts
git commit -m "feat(sdk): wrapper with budget tracking and normalized result"
```

---

## Phase 3 — Stack detection and discovery

Goal: detect language stacks from manifest files; scan a directory for git repos.

### Task 10 — Stack detection and JS/TS profile

**Files:**
- Create: `src/stack/profiles/jsts.ts`
- Create: `src/stack/profiles/python.ts`
- Create: `src/stack/profiles/generic.ts`
- Create: `src/stack/detect.ts`
- Test: `test/unit/stack/detect.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// test/unit/stack/detect.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectStack } from "../../../src/stack/detect.js";

describe("detectStack", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "stack-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("detects jsts from package.json", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    expect(await detectStack(dir)).toBe("jsts");
  });

  it("detects python from pyproject.toml", async () => {
    await writeFile(join(dir, "pyproject.toml"), "[project]\nname='x'\n");
    expect(await detectStack(dir)).toBe("python");
  });

  it("detects python from requirements.txt", async () => {
    await writeFile(join(dir, "requirements.txt"), "requests==1.0\n");
    expect(await detectStack(dir)).toBe("python");
  });

  it("returns generic for unknown stacks", async () => {
    await mkdir(dir, { recursive: true });
    expect(await detectStack(dir)).toBe("generic");
  });

  it("prefers jsts when both package.json and pyproject.toml exist", async () => {
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, "pyproject.toml"), "");
    expect(await detectStack(dir)).toBe("jsts");
  });
});
```

- [ ] **Step 2: Implement `src/stack/profiles/jsts.ts`**

```ts
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
```

- [ ] **Step 3: Implement `src/stack/profiles/python.ts`**

```ts
import type { StackProfile } from "./types.js";

export const pythonProfile: StackProfile = {
  id: "python",
  displayName: "Python",
  manifestFiles: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"],
  defaultTestCommand: "pytest -x",
  defaultBuildCommand: "python -m build",
  conventions: [
    "Source typically lives at the repo root or in a package directory matching the project name.",
    "Tests typically live in `tests/` and use pytest; some projects use unittest in `test_*.py` files.",
    "Package manifest is `pyproject.toml` (modern) or `setup.py`/`requirements.txt` (legacy).",
    "Virtualenvs commonly in `.venv/`, `venv/`, or `__pypackages__/`; uv/poetry/pipenv may manage them.",
    "Common entry points: `__main__.py`, `cli.py`, console_scripts in pyproject.",
  ],
};
```

- [ ] **Step 4: Implement `src/stack/profiles/generic.ts`**

```ts
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
```

- [ ] **Step 5: Implement `src/stack/profiles/types.ts`**

```ts
import type { StackId } from "../../types.js";

export interface StackProfile {
  id: StackId;
  displayName: string;
  manifestFiles: string[];
  defaultTestCommand: string;
  defaultBuildCommand: string;
  conventions: string[];
}
```

- [ ] **Step 6: Implement `src/stack/detect.ts`**

```ts
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
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm test:unit -- detect`
Expected: 5 tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/stack/ test/unit/stack/
git commit -m "feat(stack): detection and JS/TS, Python, generic profiles"
```

### Task 11 — Discovery phase

**Files:**
- Create: `src/phases/discover.ts`
- Test: `test/unit/phases/discover.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// test/unit/phases/discover.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { discoverRepos } from "../../../src/phases/discover.js";

async function makeGitRepo(parent: string, name: string, files: Record<string, string> = {}) {
  const dir = join(parent, name);
  await mkdir(dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  await simpleGit(dir).init().add(".").commit("init", { "--allow-empty": null });
  return dir;
}

describe("discoverRepos", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "discover-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("finds direct child git repos", async () => {
    await makeGitRepo(root, "alpha", { "package.json": "{}", "README.md": "# alpha" });
    await makeGitRepo(root, "beta", { "pyproject.toml": "" });
    const repos = await discoverRepos({ targetDir: root, depth: 2 });
    const names = repos.map((r) => r.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
  });

  it("detects stack per repo", async () => {
    await makeGitRepo(root, "alpha", { "package.json": "{}" });
    await makeGitRepo(root, "beta", { "pyproject.toml": "" });
    const repos = await discoverRepos({ targetDir: root, depth: 2 });
    const map = Object.fromEntries(repos.map((r) => [r.name, r.stack]));
    expect(map.alpha).toBe("jsts");
    expect(map.beta).toBe("python");
  });

  it("ignores node_modules and .git directories", async () => {
    await mkdir(join(root, "node_modules", "fake"), { recursive: true });
    await makeGitRepo(root, "alpha", {});
    const repos = await discoverRepos({ targetDir: root, depth: 4 });
    expect(repos.map((r) => r.name)).toEqual(["alpha"]);
  });

  it("respects exclude patterns", async () => {
    await makeGitRepo(root, "alpha", {});
    await makeGitRepo(root, "alpha-legacy", {});
    const repos = await discoverRepos({
      targetDir: root,
      depth: 2,
      exclude: ["alpha-legacy"],
    });
    expect(repos.map((r) => r.name)).toEqual(["alpha"]);
  });

  it("reports hasReadme and hasTests flags", async () => {
    await makeGitRepo(root, "alpha", { "README.md": "# x", "package.json": "{}" });
    await mkdir(join(root, "alpha", "test"), { recursive: true });
    await writeFile(join(root, "alpha", "test", "x.test.ts"), "export {};");
    const repos = await discoverRepos({ targetDir: root, depth: 2 });
    expect(repos[0].hasReadme).toBe(true);
    expect(repos[0].hasTests).toBe(true);
  });
});
```

- [ ] **Step 2: Implement `src/phases/discover.ts`**

```ts
import { readdir, stat, access } from "node:fs/promises";
import { basename, join } from "node:path";
import { simpleGit } from "simple-git";
import { detectStack } from "../stack/detect.js";
import type { StackId } from "../types.js";

export interface DiscoveredRepo {
  path: string;
  name: string;
  stack: StackId;
  hasReadme: boolean;
  hasTests: boolean;
  lastCommitDate: string | null;
  isDirty: boolean;
}

export interface DiscoverParams {
  targetDir: string;
  depth?: number;
  exclude?: string[];
  include?: string[];
}

const ALWAYS_IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  "vendor",
  ".next",
  "coverage",
]);

async function isGitRepo(path: string): Promise<boolean> {
  try {
    await access(join(path, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function hasTestsInRepo(repo: string): Promise<boolean> {
  const candidates = ["test", "tests", "__tests__"];
  for (const c of candidates) {
    if (await fileExists(join(repo, c))) return true;
  }
  let entries: string[];
  try {
    entries = await readdir(repo);
  } catch {
    return false;
  }
  return entries.some((e) => /\.test\.[tj]sx?$/.test(e) || /^test_.*\.py$/.test(e));
}

function matchesAny(name: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((p) => {
    if (p.includes("*")) {
      const re = new RegExp("^" + p.replace(/\*/g, ".*") + "$");
      return re.test(name);
    }
    return p === name;
  });
}

async function walkForRepos(
  current: string,
  depth: number,
  acc: string[],
  exclude: string[] | undefined,
): Promise<void> {
  if (depth < 0) return;
  let entries: string[];
  try {
    entries = await readdir(current);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (ALWAYS_IGNORE.has(entry)) continue;
    if (matchesAny(entry, exclude)) continue;
    const full = join(current, entry);
    let s;
    try {
      s = await stat(full);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    if (await isGitRepo(full)) {
      acc.push(full);
      continue;
    }
    await walkForRepos(full, depth - 1, acc, exclude);
  }
}

export async function discoverRepos(params: DiscoverParams): Promise<DiscoveredRepo[]> {
  const depth = params.depth ?? 2;
  const found: string[] = [];
  await walkForRepos(params.targetDir, depth, found, params.exclude);

  const filtered = found.filter((p) => {
    const name = basename(p);
    if (params.include && !matchesAny(name, params.include)) return false;
    return true;
  });

  const out: DiscoveredRepo[] = [];
  for (const path of filtered) {
    const name = basename(path);
    const stack = await detectStack(path);
    const hasReadme = await fileExists(join(path, "README.md"));
    const hasTests = await hasTestsInRepo(path);
    let lastCommitDate: string | null = null;
    let isDirty = false;
    try {
      const g = simpleGit(path);
      const log = await g.log({ maxCount: 1 });
      lastCommitDate = log.latest?.date ?? null;
      const status = await g.status();
      isDirty = !status.isClean();
    } catch {
      // ignore — repo metadata best-effort
    }
    out.push({ path, name, stack, hasReadme, hasTests, lastCommitDate, isDirty });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm test:unit -- discover`
Expected: 5 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/phases/discover.ts test/unit/phases/discover.test.ts
git commit -m "feat(phases): repo discovery with stack detection and dirty flag"
```

---

## Phase 4 — TUI primitives

Goal: small composable TUI helpers for selection, confirmation, and checkpointing. Library: `@inquirer/prompts` (mature, simple API).

### Task 12 — Add inquirer dependency and select TUI

**Files:**
- Modify: `package.json` (add `@inquirer/prompts`)
- Create: `src/tui/select.ts`
- Create: `src/tui/confirm.ts`
- Test: `test/unit/tui/select.test.ts`

- [ ] **Step 1: Install dependency**

Run: `pnpm add @inquirer/prompts`
Expected: package.json updated.

- [ ] **Step 2: Implement `src/tui/select.ts`**

```ts
import { checkbox } from "@inquirer/prompts";
import type { DiscoveredRepo } from "../phases/discover.js";

export interface SelectReposParams {
  repos: DiscoveredRepo[];
  pageSize?: number;
}

export async function selectRepos(params: SelectReposParams): Promise<string[]> {
  if (params.repos.length === 0) return [];
  const selected = await checkbox<string>({
    message: "Select repos to include in this run",
    pageSize: params.pageSize ?? 15,
    choices: params.repos.map((r) => ({
      name: formatRepoLabel(r),
      value: r.path,
    })),
  });
  return selected;
}

function formatRepoLabel(r: DiscoveredRepo): string {
  const stack = `[${r.stack}]`.padEnd(10);
  const dirty = r.isDirty ? " (dirty)" : "";
  const last = r.lastCommitDate ? ` last:${r.lastCommitDate.slice(0, 10)}` : "";
  const tests = r.hasTests ? " ✓tests" : "";
  return `${r.name.padEnd(28)} ${stack}${last}${tests}${dirty}`;
}
```

- [ ] **Step 3: Implement `src/tui/confirm.ts`**

```ts
import { confirm, select, editor, input } from "@inquirer/prompts";

export async function confirmPrompt(message: string, defaultYes = true): Promise<boolean> {
  return confirm({ message, default: defaultYes });
}

export type ProposalAction = "accept" | "reject" | "reanalyze";

export async function proposalGate(): Promise<ProposalAction> {
  return select<ProposalAction>({
    message: "Completion proposal — what would you like to do?",
    choices: [
      { name: "Accept and proceed to planning", value: "accept" },
      { name: "Reject (skip this repo)", value: "reject" },
      { name: "Re-analyze with my notes", value: "reanalyze" },
    ],
  });
}

export type PlanAction = "accept" | "reject" | "replan";

export async function planGate(): Promise<PlanAction> {
  return select<PlanAction>({
    message: "Plan — what would you like to do?",
    choices: [
      { name: "Accept and proceed to execution", value: "accept" },
      { name: "Reject (skip this repo)", value: "reject" },
      { name: "Replan with my notes", value: "replan" },
    ],
  });
}

export async function captureNotes(prompt: string): Promise<string> {
  return editor({ message: prompt, postfix: ".md" });
}

export async function shortText(message: string): Promise<string> {
  return input({ message });
}
```

- [ ] **Step 4: Write smoke test for select formatter**

```ts
// test/unit/tui/select.test.ts
import { describe, expect, it } from "vitest";
import { formatRepoLabel } from "../../../src/tui/select.js";
```

> **Note:** `formatRepoLabel` is currently a private helper. Export it for testing by adding `export` to its declaration. Keep the test small — TUI rendering is not test-heavy by design (per spec §5).

- [ ] **Step 5: Update `src/tui/select.ts` to export the formatter**

Change `function formatRepoLabel` to `export function formatRepoLabel`.

- [ ] **Step 6: Complete the test**

```ts
// test/unit/tui/select.test.ts (full)
import { describe, expect, it } from "vitest";
import { formatRepoLabel } from "../../../src/tui/select.js";

describe("formatRepoLabel", () => {
  it("includes name, stack tag, last-commit date, tests indicator, dirty flag", () => {
    const out = formatRepoLabel({
      path: "/x/foo",
      name: "foo",
      stack: "jsts",
      hasReadme: true,
      hasTests: true,
      lastCommitDate: "2026-05-01T00:00:00Z",
      isDirty: true,
    });
    expect(out).toContain("foo");
    expect(out).toContain("[jsts]");
    expect(out).toContain("last:2026-05-01");
    expect(out).toContain("✓tests");
    expect(out).toContain("(dirty)");
  });
});
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm test:unit -- select`
Expected: 1 test passes.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml src/tui/select.ts src/tui/confirm.ts \
  test/unit/tui/select.test.ts
git commit -m "feat(tui): selection and confirmation primitives"
```

### Task 13 — Checkpoint TUI and render helpers

**Files:**
- Create: `src/tui/checkpoint.ts`
- Create: `src/tui/render.ts`
- Test: `test/unit/tui/render.test.ts`

- [ ] **Step 1: Implement `src/tui/checkpoint.ts`**

```ts
import { select } from "@inquirer/prompts";
import type { TaskState } from "../types.js";

export type CheckpointAction = "continue" | "skip" | "edit" | "quit" | "view";

export interface CheckpointInput {
  task: TaskState;
  filesChanged: string[];
  diffText: string;
}

export async function checkpoint(input: CheckpointInput): Promise<CheckpointAction> {
  process.stdout.write(formatCheckpointSummary(input));
  while (true) {
    const action = await select<CheckpointAction>({
      message: "What's next?",
      choices: [
        { name: "Continue to next task", value: "continue" },
        { name: "Skip remaining tasks for this repo", value: "skip" },
        { name: "View full diff", value: "view" },
        { name: "Edit plan in $EDITOR", value: "edit" },
        { name: "Quit (run will be paused)", value: "quit" },
      ],
    });
    if (action === "view") {
      process.stdout.write("\n----- diff -----\n" + input.diffText + "\n----------------\n");
      continue;
    }
    return action;
  }
}

export function formatCheckpointSummary(input: CheckpointInput): string {
  const head = `\n[checkpoint] task ${input.task.taskId.slice(0, 8)} — ${input.task.title}`;
  const stats = `   files changed: ${input.filesChanged.length}, tokens: ${input.task.tokensUsed}, duration: ${Math.round(input.task.durationMs / 1000)}s`;
  const sha = input.task.commitSha ? `   commit: ${input.task.commitSha.slice(0, 8)}` : "";
  return [head, stats, sha].filter(Boolean).join("\n") + "\n";
}
```

- [ ] **Step 2: Implement `src/tui/render.ts`**

```ts
import type { RunManifest } from "../types.js";

export function renderRunSummary(m: RunManifest): string {
  const lines: string[] = [];
  lines.push(`Run ${m.runId} ${m.status} — created ${m.createdAt}`);
  for (const repo of m.repos) {
    const sym = repoSymbol(repo.status);
    const counts = repo.taskState
      ? ` ${repo.taskState.filter((t) => t.status === "completed").length}/${repo.taskState.length} tasks`
      : "";
    lines.push(`  ${sym} ${repo.name.padEnd(28)} ${repo.status}${counts}`);
  }
  lines.push(`Tokens: ${m.budget.tokensUsed.toLocaleString()}`);
  return lines.join("\n");
}

export function repoSymbol(status: string): string {
  switch (status) {
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "skipped":
      return "⊘";
    default:
      return "•";
  }
}
```

- [ ] **Step 3: Write test for render helpers**

```ts
// test/unit/tui/render.test.ts
import { describe, expect, it } from "vitest";
import { renderRunSummary, repoSymbol } from "../../../src/tui/render.js";
import type { RunManifest } from "../../../src/types.js";
import { SCHEMA_VERSION } from "../../../src/types.js";

describe("repoSymbol", () => {
  it("maps statuses to symbols", () => {
    expect(repoSymbol("completed")).toBe("✓");
    expect(repoSymbol("failed")).toBe("✗");
    expect(repoSymbol("skipped")).toBe("⊘");
    expect(repoSymbol("running")).toBe("•");
  });
});

describe("renderRunSummary", () => {
  it("renders run header and per-repo lines", () => {
    const m: RunManifest = {
      runId: "01HKQR3Z8M",
      createdAt: "2026-05-04T00:00:00Z",
      authMode: "api",
      config: {
        targetDir: "/x",
        concurrency: 1,
        checkpointEvery: 1,
        onFailure: "skip-repo",
        maxRetries: 1,
        testGate: "per-repo",
        testTimeoutMs: 300_000,
        model: { default: "claude-sonnet-4-6" },
      },
      repos: [
        {
          path: "/x/foo",
          name: "foo",
          stack: "jsts",
          status: "completed",
          taskState: [
            {
              taskId: "11111111-1111-1111-1111-111111111111",
              title: "t",
              acceptanceCriteria: [],
              status: "completed",
              attempts: 1,
              tokensUsed: 100,
              durationMs: 1000,
            },
          ],
          testGate: true,
        },
      ],
      budget: { tokensUsed: 100, startedAt: "2026-05-04T00:00:00Z" },
      status: "completed",
      schemaVersion: SCHEMA_VERSION,
    };
    const out = renderRunSummary(m);
    expect(out).toContain("01HKQR3Z8M");
    expect(out).toContain("✓ foo");
    expect(out).toContain("1/1 tasks");
    expect(out).toContain("Tokens: 100");
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- render`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tui/checkpoint.ts src/tui/render.ts test/unit/tui/render.test.ts
git commit -m "feat(tui): checkpoint prompt and run summary rendering"
```

---

## Phase 5 — Analyzer

Goal: analyzer phase produces `completion-proposal.md` from a query against the SDK. Includes versioned prompt template with snapshot test.

### Task 14 — Analyze prompt template + snapshot

**Files:**
- Create: `src/sdk/prompts/analyze.ts`
- Test: `test/prompts/analyze.test.ts`

- [ ] **Step 1: Implement `src/sdk/prompts/analyze.ts`**

```ts
import type { StackProfile } from "../../stack/profiles/types.js";

export interface AnalyzePromptInput {
  repoPath: string;
  repoName: string;
  stackProfile: StackProfile;
  hasReadme: boolean;
  hasTests: boolean;
  lastCommitDate: string | null;
  userNotes?: string;
}

export function renderAnalyzePrompt(input: AnalyzePromptInput): string {
  const conventionsBlock = input.stackProfile.conventions
    .map((c, i) => `  ${i + 1}. ${c}`)
    .join("\n");

  const notesBlock = input.userNotes
    ? `\n## User notes from a previous attempt\n\n${input.userNotes.trim()}\n`
    : "";

  return `# Task: Analyze a code repository and propose what "completion" means

You are an expert software engineer. Inspect the repository at \`${input.repoPath}\` (named "${input.repoName}") and produce a concise markdown document titled \`completion-proposal.md\` that captures:

1. **Current state** — what this project appears to be, the major modules/files, what's implemented, what's stubbed.
2. **Apparent intent** — what the README and code suggest the project is trying to become.
3. **Proposed completion criteria** — concrete, testable bullet points describing what "v1 complete" would mean. Each bullet must be verifiable, not aspirational.
4. **Out of scope** — what you are deliberately NOT including in completion (so the user can correct you).
5. **Open questions** — anything ambiguous you would want the user to clarify.

## Stack context

This repo was detected as: **${input.stackProfile.displayName}** (\`${input.stackProfile.id}\`).

Conventions for this stack:
${conventionsBlock}

## Repository signals

- README present: ${input.hasReadme ? "yes" : "no"}
- Tests present: ${input.hasTests ? "yes" : "no"}
- Last commit: ${input.lastCommitDate ?? "unknown"}

## How to investigate

You have read-only tools available: \`Read\` for files, \`Bash\` for read-only commands like \`git log\`, \`git diff\`, \`grep\`, \`find\`. **Do not edit any files.** Do not write the proposal to disk yourself — return it as your final response and the orchestrator will persist it.

When in doubt about scope, prefer narrower completion criteria. The user will correct you. Don't pad with speculative features.
${notesBlock}

## Output format

Return only the completion-proposal markdown. No preamble, no postscript. Begin with \`# Completion Proposal — ${input.repoName}\` as the H1.`;
}
```

- [ ] **Step 2: Write inline snapshot test**

```ts
// test/prompts/analyze.test.ts
import { describe, expect, it } from "vitest";
import { renderAnalyzePrompt } from "../../src/sdk/prompts/analyze.js";
import { jstsProfile } from "../../src/stack/profiles/jsts.js";

describe("renderAnalyzePrompt", () => {
  it("renders the JS/TS variant correctly", () => {
    const out = renderAnalyzePrompt({
      repoPath: "/x/foo",
      repoName: "foo",
      stackProfile: jstsProfile,
      hasReadme: true,
      hasTests: true,
      lastCommitDate: "2026-04-01T00:00:00Z",
    });
    expect(out).toMatchInlineSnapshot();
  });

  it("appends user notes when provided", () => {
    const out = renderAnalyzePrompt({
      repoPath: "/x/foo",
      repoName: "foo",
      stackProfile: jstsProfile,
      hasReadme: false,
      hasTests: false,
      lastCommitDate: null,
      userNotes: "Focus on the public CLI surface only.",
    });
    expect(out).toContain("Focus on the public CLI surface only.");
  });
});
```

- [ ] **Step 3: Run test to capture snapshot**

Run: `pnpm test:prompts -- analyze --update`
Expected: snapshot written inline. Then run `pnpm test:prompts -- analyze` and confirm 2 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/sdk/prompts/analyze.ts test/prompts/analyze.test.ts
git commit -m "feat(prompts): analyze prompt template with inline snapshot"
```

### Task 15 — Analyze phase

**Files:**
- Create: `src/phases/analyze.ts`
- Test: `test/unit/phases/analyze.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// test/unit/phases/analyze.test.ts
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze } from "../../../src/phases/analyze.js";
import { jstsProfile } from "../../../src/stack/profiles/jsts.js";
import { BudgetTracker } from "../../../src/orchestrator/budget.js";

describe("analyze", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "analyze-"));
    await mkdir(join(repo, ".git"), { recursive: true });
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("calls the SDK with correct allowlist and writes the proposal", async () => {
    const fakeQuery = vi.fn(async function* () {
      yield {
        type: "result",
        result: "# Completion Proposal — foo\n\nstuff",
        usage: { input_tokens: 1000, output_tokens: 500 },
      };
    });
    const tracker = new BudgetTracker({});
    const result = await analyze({
      repoPath: repo,
      repoName: "foo",
      stackProfile: jstsProfile,
      hasReadme: true,
      hasTests: true,
      lastCommitDate: null,
      tracker,
      queryFn: fakeQuery as never,
    });

    expect(fakeQuery).toHaveBeenCalledTimes(1);
    const callArgs = fakeQuery.mock.calls[0][0] as { options: { allowedTools: string[] } };
    expect(callArgs.options.allowedTools).toEqual(["Read", "Bash"]);

    expect(result.proposalPath).toBe(join(repo, ".agent", "completion-proposal.md"));
    expect(result.tokensUsed).toBe(1500);
    const content = await readFile(result.proposalPath, "utf8");
    expect(content).toContain("# Completion Proposal");
  });
});
```

- [ ] **Step 2: Implement `src/phases/analyze.ts`**

```ts
import { runQuery } from "../sdk/query.js";
import type { BudgetTracker } from "../orchestrator/budget.js";
import { renderAnalyzePrompt } from "../sdk/prompts/analyze.js";
import { writeProposal } from "../state/repoState.js";
import type { StackProfile } from "../stack/profiles/types.js";

export interface AnalyzeParams {
  repoPath: string;
  repoName: string;
  stackProfile: StackProfile;
  hasReadme: boolean;
  hasTests: boolean;
  lastCommitDate: string | null;
  tracker: BudgetTracker;
  userNotes?: string;
  model?: string;
  queryFn?: Parameters<typeof runQuery>[0]["queryFn"];
}

export interface AnalyzeResult {
  proposalPath: string;
  tokensUsed: number;
  durationMs: number;
}

export async function analyze(params: AnalyzeParams): Promise<AnalyzeResult> {
  const prompt = renderAnalyzePrompt({
    repoPath: params.repoPath,
    repoName: params.repoName,
    stackProfile: params.stackProfile,
    hasReadme: params.hasReadme,
    hasTests: params.hasTests,
    lastCommitDate: params.lastCommitDate,
    userNotes: params.userNotes,
  });

  const result = await runQuery({
    prompt,
    allowedTools: ["Read", "Bash"],
    cwd: params.repoPath,
    tracker: params.tracker,
    model: params.model,
    queryFn: params.queryFn,
  });

  const proposalPath = await writeProposal(params.repoPath, result.finalText);
  return {
    proposalPath,
    tokensUsed: result.tokensUsed,
    durationMs: result.durationMs,
  };
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm test:unit -- analyze`
Expected: 1 test passes.

- [ ] **Step 4: Commit**

```bash
git add src/phases/analyze.ts test/unit/phases/analyze.test.ts
git commit -m "feat(phases): analyze phase calling SDK with read-only tools"
```

---

## Phase 6 — Planner

Goal: planning phase produces `plan.md` with parseable task list. Tasks have stable UUIDs.

### Task 16 — Plan prompt and plan markdown parser

**Files:**
- Create: `src/sdk/prompts/plan.ts`
- Create: `src/lib/planParser.ts`
- Test: `test/prompts/plan.test.ts`
- Test: `test/unit/lib/planParser.test.ts`

- [ ] **Step 1: Implement `src/sdk/prompts/plan.ts`**

```ts
import type { StackProfile } from "../../stack/profiles/types.js";

export interface PlanPromptInput {
  repoPath: string;
  repoName: string;
  stackProfile: StackProfile;
  proposalMarkdown: string;
  userNotes?: string;
}

export function renderPlanPrompt(input: PlanPromptInput): string {
  const notesBlock = input.userNotes
    ? `\n## User notes from a previous plan attempt\n\n${input.userNotes.trim()}\n`
    : "";

  return `# Task: Convert an approved completion proposal into an executable plan

You are an expert engineer planning the work needed to complete a project. The completion proposal below has been approved by the user. Your job is to break it into concrete, atomic tasks that will be executed one at a time by a coding agent.

## Approved completion proposal

${input.proposalMarkdown}

## Stack context

This repo is **${input.stackProfile.displayName}** (\`${input.stackProfile.id}\`).

## Output format — STRICT

Output a markdown document with the following structure:

\`\`\`
# Plan — ${input.repoName}

## Summary

<one paragraph summarizing the plan>

## Tasks

### task: <UUIDv4>
**Title:** <imperative one-line title>

**Acceptance criteria:**
- <criterion 1, testable>
- <criterion 2, testable>

**Dependencies:** none | <list other task UUIDs>

**Estimated effort:** small | medium | large

---

### task: <UUIDv4>
...
\`\`\`

## Constraints

- Each task must be independently committable. Do not create tasks that span multiple commits.
- Acceptance criteria must be verifiable by reading code or running tests, not subjective judgment.
- Each task should target less than 1 hour of equivalent dev work.
- Generate fresh UUIDv4 strings for each task — do NOT reuse IDs.
- The full plan should have between 3 and 30 tasks. Bias toward fewer, larger tasks over many tiny ones.
- Tools available to you: \`Read\` only. **You may not edit, create, or commit anything.** This phase produces a plan; another agent will execute.
${notesBlock}

## Output

Return only the plan markdown. No preamble.`;
}
```

- [ ] **Step 2: Write inline snapshot test for plan prompt**

```ts
// test/prompts/plan.test.ts
import { describe, expect, it } from "vitest";
import { renderPlanPrompt } from "../../src/sdk/prompts/plan.js";
import { jstsProfile } from "../../src/stack/profiles/jsts.js";

describe("renderPlanPrompt", () => {
  it("renders correctly", () => {
    const out = renderPlanPrompt({
      repoPath: "/x/foo",
      repoName: "foo",
      stackProfile: jstsProfile,
      proposalMarkdown: "# Completion Proposal — foo\n\nbody",
    });
    expect(out).toMatchInlineSnapshot();
  });
});
```

Run: `pnpm test:prompts -- plan --update`. Then `pnpm test:prompts -- plan` to verify it passes.

- [ ] **Step 3: Write failing test for plan parser**

```ts
// test/unit/lib/planParser.test.ts
import { describe, expect, it } from "vitest";
import { parsePlan } from "../../../src/lib/planParser.js";

const SAMPLE = `# Plan — foo

## Summary

Implement v1.

## Tasks

### task: 11111111-1111-1111-1111-111111111111
**Title:** Add the discovery module

**Acceptance criteria:**
- Discovers git repos under target dir
- Returns DiscoveredRepo[]

**Dependencies:** none
**Estimated effort:** small

---

### task: 22222222-2222-2222-2222-222222222222
**Title:** Add selection TUI

**Acceptance criteria:**
- Renders multi-select with stack badges
- Returns selected paths

**Dependencies:** 11111111-1111-1111-1111-111111111111
**Estimated effort:** small
`;

describe("parsePlan", () => {
  it("parses tasks with id, title, criteria, and dependencies", () => {
    const tasks = parsePlan(SAMPLE);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].taskId).toBe("11111111-1111-1111-1111-111111111111");
    expect(tasks[0].title).toBe("Add the discovery module");
    expect(tasks[0].acceptanceCriteria).toEqual([
      "Discovers git repos under target dir",
      "Returns DiscoveredRepo[]",
    ]);
  });

  it("returns [] when no tasks present", () => {
    expect(parsePlan("# Plan\n\nempty")).toEqual([]);
  });

  it("rejects malformed UUIDs (skips that task with warning)", () => {
    const bad = `# Plan\n\n## Tasks\n\n### task: not-a-uuid\n**Title:** x\n**Acceptance criteria:**\n- y\n`;
    expect(parsePlan(bad)).toEqual([]);
  });
});
```

- [ ] **Step 4: Implement `src/lib/planParser.ts`**

```ts
import type { TaskState } from "../types.js";

const TASK_BLOCK_RE = /###\s+task:\s+([0-9a-fA-F-]+)\s*\n([\s\S]*?)(?=\n###\s+task:|\n##\s|\n*$)/g;
const TITLE_RE = /\*\*Title:\*\*\s+(.+)/;
const CRITERIA_RE = /\*\*Acceptance criteria:\*\*\s*\n((?:\s*-\s+.+\n?)+)/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function parsePlan(markdown: string): TaskState[] {
  const tasks: TaskState[] = [];
  for (const match of markdown.matchAll(TASK_BLOCK_RE)) {
    const taskId = match[1];
    if (!UUID_RE.test(taskId)) continue;
    const body = match[2];
    const titleMatch = body.match(TITLE_RE);
    const criteriaMatch = body.match(CRITERIA_RE);
    const title = titleMatch?.[1].trim() ?? "Untitled task";
    const acceptanceCriteria = criteriaMatch
      ? criteriaMatch[1]
          .split("\n")
          .map((l) => l.replace(/^\s*-\s+/, "").trim())
          .filter(Boolean)
      : [];
    tasks.push({
      taskId,
      title,
      acceptanceCriteria,
      status: "pending",
      attempts: 0,
      tokensUsed: 0,
      durationMs: 0,
    });
  }
  return tasks;
}
```

- [ ] **Step 5: Run parser test to verify it passes**

Run: `pnpm test:unit -- planParser`
Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/sdk/prompts/plan.ts src/lib/planParser.ts \
  test/prompts/plan.test.ts test/unit/lib/planParser.test.ts
git commit -m "feat(planner): plan prompt template and markdown parser"
```

### Task 17 — Plan phase

**Files:**
- Create: `src/phases/plan.ts`
- Test: `test/unit/phases/plan.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// test/unit/phases/plan.test.ts
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plan } from "../../../src/phases/plan.js";
import { jstsProfile } from "../../../src/stack/profiles/jsts.js";
import { BudgetTracker } from "../../../src/orchestrator/budget.js";

const SAMPLE_PLAN = `# Plan — foo

## Summary

Two tasks.

## Tasks

### task: 11111111-1111-1111-1111-111111111111
**Title:** First task

**Acceptance criteria:**
- works

**Dependencies:** none
**Estimated effort:** small

---

### task: 22222222-2222-2222-2222-222222222222
**Title:** Second task

**Acceptance criteria:**
- also works

**Dependencies:** none
**Estimated effort:** small
`;

describe("plan", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "plan-"));
    await mkdir(join(repo, ".git"), { recursive: true });
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("calls SDK with Read-only allowlist and parses returned plan", async () => {
    const fakeQuery = vi.fn(async function* () {
      yield {
        type: "result",
        result: SAMPLE_PLAN,
        usage: { input_tokens: 800, output_tokens: 400 },
      };
    });
    const tracker = new BudgetTracker({});
    const result = await plan({
      repoPath: repo,
      repoName: "foo",
      stackProfile: jstsProfile,
      proposalMarkdown: "# Completion Proposal — foo\n\nbody",
      tracker,
      queryFn: fakeQuery as never,
    });
    const args = fakeQuery.mock.calls[0][0] as { options: { allowedTools: string[] } };
    expect(args.options.allowedTools).toEqual(["Read"]);
    expect(result.taskCount).toBe(2);
    expect(result.tasks[0].title).toBe("First task");
    expect(await readFile(result.planPath, "utf8")).toContain("First task");
  });
});
```

- [ ] **Step 2: Implement `src/phases/plan.ts`**

```ts
import { runQuery } from "../sdk/query.js";
import type { BudgetTracker } from "../orchestrator/budget.js";
import { renderPlanPrompt } from "../sdk/prompts/plan.js";
import { writePlan } from "../state/repoState.js";
import { parsePlan } from "../lib/planParser.js";
import type { StackProfile } from "../stack/profiles/types.js";
import type { TaskState } from "../types.js";

const AVG_TOKENS_PER_EXECUTE = 30_000;

export interface PlanParams {
  repoPath: string;
  repoName: string;
  stackProfile: StackProfile;
  proposalMarkdown: string;
  tracker: BudgetTracker;
  userNotes?: string;
  model?: string;
  queryFn?: Parameters<typeof runQuery>[0]["queryFn"];
}

export interface PlanResult {
  planPath: string;
  taskCount: number;
  tasks: TaskState[];
  estimatedTokens: number;
  estimatedDurationMs: number;
  tokensUsed: number;
  durationMs: number;
}

export async function plan(params: PlanParams): Promise<PlanResult> {
  const prompt = renderPlanPrompt({
    repoPath: params.repoPath,
    repoName: params.repoName,
    stackProfile: params.stackProfile,
    proposalMarkdown: params.proposalMarkdown,
    userNotes: params.userNotes,
  });
  const result = await runQuery({
    prompt,
    allowedTools: ["Read"],
    cwd: params.repoPath,
    tracker: params.tracker,
    model: params.model,
    queryFn: params.queryFn,
  });

  const planPath = await writePlan(params.repoPath, result.finalText);
  const tasks = parsePlan(result.finalText);
  const estimatedTokens = tasks.length * AVG_TOKENS_PER_EXECUTE;
  const estimatedDurationMs = tasks.length * 60_000; // 1 min/task rough heuristic

  return {
    planPath,
    taskCount: tasks.length,
    tasks,
    estimatedTokens,
    estimatedDurationMs,
    tokensUsed: result.tokensUsed,
    durationMs: result.durationMs,
  };
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm test:unit -- plan`
Expected: 1 test passes.

- [ ] **Step 4: Commit**

```bash
git add src/phases/plan.ts test/unit/phases/plan.test.ts
git commit -m "feat(phases): planning phase with parsed task output"
```

---

## Phase 7 — Executor

Goal: executor runs one task, agent edits files, orchestrator runs tests, orchestrator commits. Includes retry-with-feedback. Git helpers extracted to `lib/git.ts`.

### Task 18 — Git helpers

**Files:**
- Create: `src/lib/git.ts`
- Test: `test/unit/lib/git.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// test/unit/lib/git.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import {
  ensureBranch,
  stageAll,
  commitWithMessage,
  isWorkingTreeClean,
  hasChanges,
  getDiff,
} from "../../../src/lib/git.js";

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "git-"));
  const g = simpleGit(dir);
  await g.init();
  await g.addConfig("user.email", "test@example.com");
  await g.addConfig("user.name", "test");
  await writeFile(join(dir, "a.txt"), "hello");
  await g.add(".").commit("init");
  return dir;
}

describe("git helpers", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeRepo();
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("ensureBranch creates and switches to branch when missing", async () => {
    await ensureBranch(repo, "agent/t1");
    const status = await simpleGit(repo).status();
    expect(status.current).toBe("agent/t1");
  });

  it("ensureBranch is idempotent if branch already exists", async () => {
    await ensureBranch(repo, "agent/t1");
    await ensureBranch(repo, "agent/t1");
    const status = await simpleGit(repo).status();
    expect(status.current).toBe("agent/t1");
  });

  it("stageAll + commitWithMessage produces a new commit", async () => {
    await ensureBranch(repo, "agent/t1");
    await writeFile(join(repo, "b.txt"), "new");
    expect(await hasChanges(repo)).toBe(true);
    await stageAll(repo);
    const sha = await commitWithMessage(repo, "feat: add b");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await isWorkingTreeClean(repo)).toBe(true);
  });

  it("getDiff returns unified diff for changed files", async () => {
    await writeFile(join(repo, "a.txt"), "hello world");
    const diff = await getDiff(repo);
    expect(diff).toContain("+hello world");
  });
});
```

- [ ] **Step 2: Implement `src/lib/git.ts`**

```ts
import { simpleGit, type SimpleGit } from "simple-git";

export async function ensureBranch(repoPath: string, branch: string): Promise<void> {
  const g: SimpleGit = simpleGit(repoPath);
  const branches = await g.branchLocal();
  if (branches.all.includes(branch)) {
    if (branches.current !== branch) await g.checkout(branch);
    return;
  }
  await g.checkoutLocalBranch(branch);
}

export async function stageAll(repoPath: string): Promise<void> {
  await simpleGit(repoPath).add(".");
}

export async function commitWithMessage(repoPath: string, message: string): Promise<string> {
  const g = simpleGit(repoPath);
  const result = await g.commit(message);
  return result.commit;
}

export async function isWorkingTreeClean(repoPath: string): Promise<boolean> {
  const status = await simpleGit(repoPath).status();
  return status.isClean();
}

export async function hasChanges(repoPath: string): Promise<boolean> {
  return !(await isWorkingTreeClean(repoPath));
}

export async function getDiff(repoPath: string): Promise<string> {
  return simpleGit(repoPath).diff();
}

export async function getStagedDiff(repoPath: string): Promise<string> {
  return simpleGit(repoPath).diff(["--staged"]);
}

export async function getCurrentBranch(repoPath: string): Promise<string> {
  const status = await simpleGit(repoPath).status();
  return status.current ?? "";
}

export async function getHeadSha(repoPath: string): Promise<string> {
  return (await simpleGit(repoPath).revparse(["HEAD"])).trim();
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm test:unit -- git.test`
Expected: 4 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/git.ts test/unit/lib/git.test.ts
git commit -m "feat(lib): git helpers (branch/stage/commit/diff)"
```

### Task 19 — Execute prompt template

**Files:**
- Create: `src/sdk/prompts/execute.ts`
- Test: `test/prompts/execute.test.ts`

- [ ] **Step 1: Implement `src/sdk/prompts/execute.ts`**

```ts
import type { StackProfile } from "../../stack/profiles/types.js";
import type { TaskState } from "../../types.js";

export interface ExecutePromptInput {
  repoPath: string;
  repoName: string;
  stackProfile: StackProfile;
  task: TaskState;
  retryFeedback?: {
    previousFiles: string[];
    testCommand: string;
    testOutput: string;
    attemptNumber: number;
  };
}

export function renderExecutePrompt(input: ExecutePromptInput): string {
  const criteria = input.task.acceptanceCriteria.map((c) => `  - ${c}`).join("\n");
  const retryBlock = input.retryFeedback
    ? `\n## PREVIOUS ATTEMPT FAILED\n\nAttempt #${input.retryFeedback.attemptNumber} did not pass. Here's what we have:\n\n- Files modified: ${input.retryFeedback.previousFiles.join(", ") || "none"}\n- Test command: \`${input.retryFeedback.testCommand}\`\n- Test output (truncated to 4KB):\n\n\`\`\`\n${input.retryFeedback.testOutput.slice(0, 4096)}\n\`\`\`\n\nThings to consider:\n- The previous diff is preserved on the current branch — review it before re-editing.\n- The test failure usually means the logic is wrong, not the structure.\n- If you believe the test itself is wrong, say so explicitly and stop without further edits.\n\nTry again. If you cannot fix it in this attempt, return a clear explanation of what's blocking and don't make further edits.\n`
    : "";

  return `# Task: Execute one plan task in repository "${input.repoName}"

You are an expert engineer. Make the minimal code edits required to satisfy the acceptance criteria below.

## Task

**Title:** ${input.task.title}

**Acceptance criteria:**
${criteria}

## Stack context

This repo is **${input.stackProfile.displayName}** (\`${input.stackProfile.id}\`).

## Tools and permissions

You have: \`Read\`, \`Edit\`, \`Bash\`. Bash is restricted to a curated allowlist (test runners, build commands, package install for the detected stack, and read-only git operations).

**You may NOT run \`git commit\`, \`git push\`, \`git reset --hard\`, or \`git checkout main\`.** The orchestrator will commit your work after tests pass. Just use \`git add\` to stage if you want.

## How to work

1. Read enough of the codebase to understand the change in context.
2. Make the smallest edits that satisfy the acceptance criteria.
3. If the project has a test runner, run it. Iterate if needed.
4. When you believe the work is complete, return a short summary of what you changed.

If a task seems wrong (e.g., asks for something the codebase already does, or contradicts itself), say so and stop instead of making bad edits.
${retryBlock}`;
}
```

- [ ] **Step 2: Inline-snapshot test**

```ts
// test/prompts/execute.test.ts
import { describe, expect, it } from "vitest";
import { renderExecutePrompt } from "../../src/sdk/prompts/execute.js";
import { jstsProfile } from "../../src/stack/profiles/jsts.js";

describe("renderExecutePrompt", () => {
  const baseTask = {
    taskId: "11111111-1111-1111-1111-111111111111",
    title: "Add foo",
    acceptanceCriteria: ["foo() exists", "foo() is exported"],
    status: "pending" as const,
    attempts: 0,
    tokensUsed: 0,
    durationMs: 0,
  };

  it("renders without retry feedback", () => {
    const out = renderExecutePrompt({
      repoPath: "/x/foo",
      repoName: "foo",
      stackProfile: jstsProfile,
      task: baseTask,
    });
    expect(out).toMatchInlineSnapshot();
  });

  it("includes retry feedback when provided", () => {
    const out = renderExecutePrompt({
      repoPath: "/x/foo",
      repoName: "foo",
      stackProfile: jstsProfile,
      task: baseTask,
      retryFeedback: {
        previousFiles: ["src/foo.ts"],
        testCommand: "pnpm test",
        testOutput: "FAIL: foo not exported",
        attemptNumber: 1,
      },
    });
    expect(out).toContain("PREVIOUS ATTEMPT FAILED");
    expect(out).toContain("FAIL: foo not exported");
  });
});
```

Run: `pnpm test:prompts -- execute --update` then `pnpm test:prompts -- execute`. Expected 2 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/sdk/prompts/execute.ts test/prompts/execute.test.ts
git commit -m "feat(prompts): execute prompt with retry-with-feedback variant"
```

### Task 20 — Execute phase with retry logic and test gate

**Files:**
- Create: `src/phases/execute.ts`
- Test: `test/unit/phases/execute.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// test/unit/phases/execute.test.ts
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { execute } from "../../../src/phases/execute.js";
import { jstsProfile } from "../../../src/stack/profiles/jsts.js";
import { BudgetTracker } from "../../../src/orchestrator/budget.js";
import type { TaskState } from "../../../src/types.js";

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "exec-"));
  const g = simpleGit(dir);
  await g.init();
  await g.addConfig("user.email", "test@example.com");
  await g.addConfig("user.name", "test");
  await writeFile(join(dir, "a.txt"), "hello");
  await g.add(".").commit("init");
  return dir;
}

const baseTask: TaskState = {
  taskId: "11111111-1111-1111-1111-111111111111",
  title: "T",
  acceptanceCriteria: [],
  status: "pending",
  attempts: 0,
  tokensUsed: 0,
  durationMs: 0,
};

describe("execute", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeRepo();
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("commits successfully when agent makes edits and tests pass (or are skipped)", async () => {
    const fakeQuery = vi.fn(async function* () {
      // simulate the agent writing a file before returning
      await writeFile(join(repo, "b.txt"), "edit");
      yield { type: "result", result: "done", usage: { input_tokens: 100, output_tokens: 50 } };
    });
    const tracker = new BudgetTracker({});
    const result = await execute({
      repoPath: repo,
      repoName: "x",
      stackProfile: jstsProfile,
      task: baseTask,
      tracker,
      maxRetries: 0,
      testGateEnabled: false,
      testCommand: "",
      testTimeoutMs: 5000,
      queryFn: fakeQuery as never,
    });
    expect(result.status).toBe("completed");
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("fails task when agent makes no edits", async () => {
    const fakeQuery = vi.fn(async function* () {
      yield { type: "result", result: "claimed done", usage: { input_tokens: 50, output_tokens: 25 } };
    });
    const tracker = new BudgetTracker({});
    const result = await execute({
      repoPath: repo,
      repoName: "x",
      stackProfile: jstsProfile,
      task: baseTask,
      tracker,
      maxRetries: 0,
      testGateEnabled: false,
      testCommand: "",
      testTimeoutMs: 5000,
      queryFn: fakeQuery as never,
    });
    expect(result.status).toBe("failed");
    expect(result.failureReason).toMatch(/no files changed/i);
  });
});
```

- [ ] **Step 2: Implement `src/phases/execute.ts`**

```ts
import { spawn } from "node:child_process";
import { runQuery } from "../sdk/query.js";
import type { BudgetTracker } from "../orchestrator/budget.js";
import { renderExecutePrompt } from "../sdk/prompts/execute.js";
import {
  commitWithMessage,
  ensureBranch,
  getDiff,
  hasChanges,
  stageAll,
} from "../lib/git.js";
import type { StackProfile } from "../stack/profiles/types.js";
import type { TaskState } from "../types.js";

const EXECUTOR_TOOLS = ["Read", "Edit", "Bash"];

export interface ExecuteParams {
  repoPath: string;
  repoName: string;
  stackProfile: StackProfile;
  task: TaskState;
  tracker: BudgetTracker;
  maxRetries: number;
  testGateEnabled: boolean;
  testCommand: string;
  testTimeoutMs: number;
  model?: string;
  queryFn?: Parameters<typeof runQuery>[0]["queryFn"];
}

export interface ExecuteOutcome extends TaskState {
  filesChanged: string[];
  diff: string;
}

export async function execute(params: ExecuteParams): Promise<ExecuteOutcome> {
  const branch = `agent/${params.task.taskId.slice(0, 8)}`;
  await ensureBranch(params.repoPath, branch);

  const startedAt = Date.now();
  let attempts = 0;
  let lastTestOutput = "";
  let lastFiles: string[] = [];
  let totalTokens = 0;
  const maxAttempts = params.maxRetries + 1;

  while (attempts < maxAttempts) {
    attempts += 1;
    const prompt = renderExecutePrompt({
      repoPath: params.repoPath,
      repoName: params.repoName,
      stackProfile: params.stackProfile,
      task: params.task,
      retryFeedback:
        attempts > 1
          ? {
              previousFiles: lastFiles,
              testCommand: params.testCommand,
              testOutput: lastTestOutput,
              attemptNumber: attempts - 1,
            }
          : undefined,
    });

    const result = await runQuery({
      prompt,
      allowedTools: EXECUTOR_TOOLS,
      cwd: params.repoPath,
      tracker: params.tracker,
      model: params.model,
      queryFn: params.queryFn,
    });
    totalTokens += result.tokensUsed;

    if (!(await hasChanges(params.repoPath))) {
      // empty diff but agent claimed done — fail this attempt
      lastTestOutput = "Agent reported the task complete but made no file changes.";
      if (attempts >= maxAttempts) {
        return {
          ...params.task,
          status: "failed",
          attempts,
          tokensUsed: totalTokens,
          durationMs: Date.now() - startedAt,
          failureReason: lastTestOutput,
          filesChanged: [],
          diff: "",
        };
      }
      continue;
    }

    if (params.testGateEnabled && params.testCommand) {
      const testResult = await runTestCommand(
        params.repoPath,
        params.testCommand,
        params.testTimeoutMs,
      );
      lastTestOutput = testResult.output;
      lastFiles = await listChangedFiles(params.repoPath);
      if (!testResult.passed) {
        if (attempts < maxAttempts) {
          // commit a WIP for inspection but continue retrying
          await stageAll(params.repoPath);
          await commitWithMessage(params.repoPath, `agent: WIP attempt ${attempts}`);
          continue;
        }
        return {
          ...params.task,
          status: "failed",
          attempts,
          tokensUsed: totalTokens,
          durationMs: Date.now() - startedAt,
          failureReason: `Tests failed: ${testResult.output.slice(0, 500)}`,
          testOutput: testResult.output,
          filesChanged: lastFiles,
          diff: await getDiff(params.repoPath),
        };
      }
    }

    const diffText = await getDiff(params.repoPath);
    const filesChanged = await listChangedFiles(params.repoPath);
    await stageAll(params.repoPath);
    const message = `agent(${params.task.taskId.slice(0, 8)}): ${params.task.title}`;
    const commitSha = await commitWithMessage(params.repoPath, message);

    return {
      ...params.task,
      status: "completed",
      attempts,
      tokensUsed: totalTokens,
      durationMs: Date.now() - startedAt,
      commitSha,
      testOutput: lastTestOutput || undefined,
      filesChanged,
      diff: diffText,
    };
  }

  // unreachable
  return {
    ...params.task,
    status: "failed",
    attempts,
    tokensUsed: totalTokens,
    durationMs: Date.now() - startedAt,
    failureReason: "Exhausted retry loop",
    filesChanged: [],
    diff: "",
  };
}

async function runTestCommand(
  cwd: string,
  command: string,
  timeoutMs: number,
): Promise<{ passed: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ passed: false, output: stdout + stderr + "\n[timed out]" });
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ passed: code === 0, output: stdout + stderr });
    });
  });
}

async function listChangedFiles(repoPath: string): Promise<string[]> {
  const { simpleGit } = await import("simple-git");
  const status = await simpleGit(repoPath).status();
  return [...status.modified, ...status.created, ...status.deleted, ...status.renamed.map((r) => r.to)];
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm test:unit -- execute`
Expected: 2 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/phases/execute.ts test/unit/phases/execute.test.ts
git commit -m "feat(phases): executor with retry-with-feedback and test gate"
```

---

## Phase 8 — Orchestrator state machine

Goal: drive the per-repo loop, manage budget tracking and concurrency, persist state on each transition.

### Task 21 — Concurrency worker pool

**Files:**
- Create: `src/orchestrator/concurrency.ts`
- Test: `test/unit/orchestrator/concurrency.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// test/unit/orchestrator/concurrency.test.ts
import { describe, expect, it } from "vitest";
import { runWithConcurrency } from "../../../src/orchestrator/concurrency.js";

describe("runWithConcurrency", () => {
  it("processes all items with concurrency=1 sequentially", async () => {
    const order: number[] = [];
    const results = await runWithConcurrency([1, 2, 3], 1, async (n) => {
      order.push(n);
      return n * 2;
    });
    expect(order).toEqual([1, 2, 3]);
    expect(results).toEqual([2, 4, 6]);
  });

  it("limits in-flight count to concurrency cap", async () => {
    let inflight = 0;
    let maxObserved = 0;
    await runWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      inflight += 1;
      maxObserved = Math.max(maxObserved, inflight);
      await new Promise((r) => setTimeout(r, 10));
      inflight -= 1;
      return n;
    });
    expect(maxObserved).toBeLessThanOrEqual(2);
  });

  it("preserves input order in results array", async () => {
    const results = await runWithConcurrency([1, 2, 3, 4], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n * 5));
      return n;
    });
    expect(results).toEqual([1, 2, 3, 4]);
  });
});
```

- [ ] **Step 2: Implement `src/orchestrator/concurrency.ts`**

```ts
export async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const cap = Math.max(1, concurrency);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]!, idx);
    }
  }

  await Promise.all(Array.from({ length: cap }, () => worker()));
  return results;
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm test:unit -- concurrency`
Expected: 3 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/concurrency.ts test/unit/orchestrator/concurrency.test.ts
git commit -m "feat(orchestrator): worker-pool concurrency helper"
```

### Task 22 — Orchestrator state machine

**Files:**
- Create: `src/orchestrator/run.ts`
- Test: `test/unit/orchestrator/run.test.ts`

- [ ] **Step 1: Write failing test (happy path with mocked phases)**

```ts
// test/unit/orchestrator/run.test.ts
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { runOrchestration } from "../../../src/orchestrator/run.js";
import { ulid } from "ulid";
import type { RunConfig } from "../../../src/types.js";

async function makeFixtureRepo(parent: string, name: string): Promise<string> {
  const dir = join(parent, name);
  await mkdir(dir, { recursive: true });
  const g = simpleGit(dir);
  await g.init();
  await g.addConfig("user.email", "test@example.com");
  await g.addConfig("user.name", "test");
  await writeFile(join(dir, "package.json"), "{}");
  await g.add(".").commit("init");
  return dir;
}

const baseConfig = (target: string): RunConfig => ({
  targetDir: target,
  concurrency: 1,
  checkpointEvery: Number.MAX_SAFE_INTEGER, // yolo
  onFailure: "skip-repo",
  maxRetries: 0,
  testGate: "skip",
  testTimeoutMs: 30_000,
  model: { default: "claude-sonnet-4-6" },
});

describe("runOrchestration", () => {
  let target: string;
  let stateRoot: string;
  beforeEach(async () => {
    target = await mkdtemp(join(tmpdir(), "orchtgt-"));
    stateRoot = await mkdtemp(join(tmpdir(), "orchstate-"));
  });
  afterEach(async () => {
    await rm(target, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
  });

  it("runs discovery → analyze → plan → execute for each selected repo and finalizes", async () => {
    await makeFixtureRepo(target, "alpha");

    const fakeAnalyze = vi.fn(async () => ({
      proposalPath: "/dev/null",
      tokensUsed: 100,
      durationMs: 10,
    }));
    const fakePlan = vi.fn(async () => ({
      planPath: "/dev/null",
      taskCount: 1,
      tasks: [
        {
          taskId: "11111111-1111-1111-1111-111111111111",
          title: "T",
          acceptanceCriteria: [],
          status: "pending" as const,
          attempts: 0,
          tokensUsed: 0,
          durationMs: 0,
        },
      ],
      estimatedTokens: 1000,
      estimatedDurationMs: 60_000,
      tokensUsed: 200,
      durationMs: 10,
    }));
    const fakeExecute = vi.fn(async () => ({
      taskId: "11111111-1111-1111-1111-111111111111",
      title: "T",
      acceptanceCriteria: [],
      status: "completed" as const,
      attempts: 1,
      tokensUsed: 500,
      durationMs: 10,
      commitSha: "a".repeat(40),
      filesChanged: ["x.txt"],
      diff: "",
    }));

    const result = await runOrchestration({
      runId: ulid(),
      authMode: "api",
      config: baseConfig(target),
      stateRoot,
      selectRepos: async (repos) => repos.map((r) => r.path),
      proposalGate: async () => "accept",
      planGate: async () => "accept",
      checkpoint: async () => "continue",
      runConfirmation: async () => true,
      authConfirmation: async () => true,
      analyzeFn: fakeAnalyze,
      planFn: fakePlan,
      executeFn: fakeExecute,
    });

    expect(result.status).toBe("completed");
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0].status).toBe("completed");
    expect(fakeAnalyze).toHaveBeenCalledTimes(1);
    expect(fakePlan).toHaveBeenCalledTimes(1);
    expect(fakeExecute).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Implement `src/orchestrator/run.ts`**

```ts
import { join } from "node:path";
import { ulid } from "ulid";
import {
  applyAuthMode,
} from "../auth/mode.js";
import { discoverRepos, type DiscoveredRepo } from "../phases/discover.js";
import { analyze } from "../phases/analyze.js";
import { plan } from "../phases/plan.js";
import { execute } from "../phases/execute.js";
import { getStackProfile } from "../stack/detect.js";
import { BudgetTracker } from "./budget.js";
import { runWithConcurrency } from "./concurrency.js";
import {
  createRunDir,
  saveManifest,
} from "../state/runIndex.js";
import {
  ensureAgentDir,
  ensureGitignore,
  saveRepoState,
  writeProposal,
  writePlan,
} from "../state/repoState.js";
import { appendLogEvent } from "../state/runLog.js";
import { writeAtomic } from "../state/atomicWrite.js";
import {
  BudgetCapped,
  SCHEMA_VERSION,
  type AuthMode,
  type LogEvent,
  type RepoEntry,
  type RunConfig,
  type RunManifest,
  type TaskState,
} from "../types.js";
import { readFile } from "node:fs/promises";

export interface OrchestrationParams {
  runId?: string;
  authMode: AuthMode;
  config: RunConfig;
  stateRoot: string;
  selectRepos: (repos: DiscoveredRepo[]) => Promise<string[]>;
  proposalGate: (proposalPath: string) => Promise<"accept" | "reject" | "reanalyze">;
  planGate: (planPath: string) => Promise<"accept" | "reject" | "replan">;
  checkpoint: (
    taskOutcome: TaskState & { filesChanged: string[]; diff: string },
  ) => Promise<"continue" | "skip" | "edit" | "quit">;
  runConfirmation: (manifest: RunManifest) => Promise<boolean>;
  authConfirmation: (warnings: string[]) => Promise<boolean>;
  analyzeFn?: typeof analyze;
  planFn?: typeof plan;
  executeFn?: typeof execute;
}

export async function runOrchestration(p: OrchestrationParams): Promise<RunManifest> {
  applyAuthMode(p.authMode);

  const runId = p.runId ?? ulid();
  const runDir = await createRunDir(p.stateRoot, runId);
  const tracker = new BudgetTracker({
    maxTokens: p.config.maxTokens,
    maxDurationMs: p.config.maxDurationMs,
  });
  const logPath = join(runDir, "run-log.jsonl");
  const log = (e: LogEvent) => appendLogEvent(logPath, e);
  const now = () => new Date().toISOString();

  let manifest: RunManifest = {
    runId,
    createdAt: now(),
    authMode: p.authMode,
    config: p.config,
    repos: [],
    budget: { tokensUsed: 0, startedAt: now() },
    status: "discovering",
    schemaVersion: SCHEMA_VERSION,
  };

  const persist = async () => {
    manifest.budget.tokensUsed = tracker.tokensUsed;
    await saveManifest(runDir, manifest);
  };
  await log({ ts: now(), type: "run_started", runId });
  await persist();

  // Discover
  const discovered = await discoverRepos({
    targetDir: p.config.targetDir,
    exclude: p.config.exclude,
    include: p.config.include,
  });

  manifest.status = "selecting";
  await persist();
  const selectedPaths = await p.selectRepos(discovered);
  const selected = discovered.filter((r) => selectedPaths.includes(r.path));

  manifest.repos = selected.map<RepoEntry>((r) => ({
    path: r.path,
    name: r.name,
    stack: r.stack,
    status: "pending",
    testGate: p.config.testGate !== "skip",
  }));
  manifest.status = "preflight";
  await persist();

  for (const repo of selected) {
    await ensureAgentDir(repo.path);
    await ensureGitignore(repo.path);
  }

  const analyzeFn = p.analyzeFn ?? analyze;
  const planFn = p.planFn ?? plan;
  const executeFn = p.executeFn ?? execute;

  try {
    // Pre-flight: analyze + plan all repos before execution starts
    for (let i = 0; i < manifest.repos.length; i++) {
      const repo = manifest.repos[i]!;
      const profile = getStackProfile(repo.stack);
      repo.status = "analyzing";
      await persist();
      await log({ ts: now(), type: "phase_started", repoPath: repo.path, phase: "analyze" });

      const analyzeResult = await analyzeFn({
        repoPath: repo.path,
        repoName: repo.name,
        stackProfile: profile,
        hasReadme: discovered[i]?.hasReadme ?? false,
        hasTests: discovered[i]?.hasTests ?? false,
        lastCommitDate: discovered[i]?.lastCommitDate ?? null,
        tracker,
        model: p.config.model.analyze ?? p.config.model.default,
      });
      repo.proposalPath = analyzeResult.proposalPath;
      repo.status = "awaiting-proposal-approval";
      await persist();
      await log({
        ts: now(),
        type: "phase_completed",
        repoPath: repo.path,
        phase: "analyze",
        tokensUsed: analyzeResult.tokensUsed,
        durationMs: analyzeResult.durationMs,
      });

      const action = await p.proposalGate(analyzeResult.proposalPath);
      if (action === "reject") {
        repo.status = "skipped";
        await persist();
        continue;
      }
      // (re-analyze loop omitted for brevity; could be added later via orchestrator wrapper)

      repo.status = "planning";
      await persist();
      const proposalMd = await readFile(analyzeResult.proposalPath, "utf8");
      await log({ ts: now(), type: "phase_started", repoPath: repo.path, phase: "plan" });
      const planResult = await planFn({
        repoPath: repo.path,
        repoName: repo.name,
        stackProfile: profile,
        proposalMarkdown: proposalMd,
        tracker,
        model: p.config.model.plan ?? p.config.model.default,
      });
      repo.planPath = planResult.planPath;
      repo.taskState = planResult.tasks;
      repo.status = "awaiting-plan-approval";
      await persist();
      await log({
        ts: now(),
        type: "phase_completed",
        repoPath: repo.path,
        phase: "plan",
        tokensUsed: planResult.tokensUsed,
        durationMs: planResult.durationMs,
      });

      const planAction = await p.planGate(planResult.planPath);
      if (planAction === "reject") {
        repo.status = "skipped";
        await persist();
        continue;
      }
    }

    // Confirm aggregate
    manifest.status = "running";
    await persist();
    if (!(await p.runConfirmation(manifest))) {
      manifest.status = "paused";
      await persist();
      return manifest;
    }

    // Execute repos honoring concurrency
    const runnable = manifest.repos.filter(
      (r) => r.status !== "skipped" && r.taskState && r.taskState.length > 0,
    );

    await runWithConcurrency(runnable, p.config.concurrency, async (repo) => {
      const profile = getStackProfile(repo.stack);
      repo.status = "executing";
      await persist();
      const tasks = repo.taskState ?? [];
      let taskIdx = 0;
      for (const task of tasks) {
        await log({ ts: now(), type: "task_started", repoPath: repo.path, taskId: task.taskId });
        const outcome = await executeFn({
          repoPath: repo.path,
          repoName: repo.name,
          stackProfile: profile,
          task,
          tracker,
          maxRetries: p.config.maxRetries,
          testGateEnabled: repo.testGate,
          testCommand: profile.defaultTestCommand,
          testTimeoutMs: p.config.testTimeoutMs,
          model: p.config.model.execute ?? p.config.model.default,
        });
        Object.assign(task, outcome);
        await saveRepoState(repo.path, repo);
        await persist();
        if (outcome.status === "completed") {
          await log({
            ts: now(),
            type: "task_completed",
            repoPath: repo.path,
            taskId: task.taskId,
            commitSha: outcome.commitSha ?? "",
            tokensUsed: outcome.tokensUsed,
          });
        } else {
          await log({
            ts: now(),
            type: "task_failed",
            repoPath: repo.path,
            taskId: task.taskId,
            reason: outcome.failureReason ?? "unknown",
            willRetry: false,
          });
          if (p.config.onFailure === "skip-repo") {
            repo.status = "failed";
            await persist();
            return;
          }
          if (p.config.onFailure === "stop") {
            throw new Error(`fail-stop on task ${task.taskId}`);
          }
        }
        taskIdx += 1;
        if ((taskIdx + 1) % p.config.checkpointEvery === 0 && taskIdx + 1 < tasks.length) {
          await log({
            ts: now(),
            type: "checkpoint_paused",
            repoPath: repo.path,
            afterTaskId: task.taskId,
          });
          const action = await p.checkpoint(outcome);
          await log({
            ts: now(),
            type: "checkpoint_resumed",
            repoPath: repo.path,
            action,
          });
          if (action === "skip" || action === "quit") {
            if (action === "skip") repo.status = "skipped";
            return;
          }
        }
      }
      repo.status = "completed";
      await persist();
    });

    manifest.status = manifest.repos.every((r) => r.status === "completed" || r.status === "skipped")
      ? "completed"
      : "failed";
    await persist();
    await log({
      ts: now(),
      type: "run_finalized",
      status: manifest.status === "completed" ? "completed" : "failed",
      durationMs: Date.now() - new Date(manifest.createdAt).getTime(),
    });

    // Write summary.md
    const summary = renderSummary(manifest);
    await writeAtomic(join(runDir, "summary.md"), summary);
    return manifest;
  } catch (err) {
    if (err instanceof BudgetCapped) {
      manifest.status = "paused";
      await persist();
      await log({ ts: now(), type: "budget_capped", reason: err.message });
      return manifest;
    }
    manifest.status = "failed";
    await persist();
    throw err;
  }
}

function renderSummary(m: RunManifest): string {
  const lines = [`# Run ${m.runId}`, ``, `Status: ${m.status}`, ``];
  for (const repo of m.repos) {
    lines.push(`- ${repo.name}: ${repo.status}`);
  }
  lines.push(``, `Tokens used: ${m.budget.tokensUsed}`);
  return lines.join("\n");
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm test:unit -- run.test`
Expected: 1 test passes.

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/run.ts test/unit/orchestrator/run.test.ts
git commit -m "feat(orchestrator): state machine driving phases per repo"
```

---

## Phase 9 — CLI

Goal: actual `agent` binary with all commands and flags. Wires orchestration to terminal IO.

### Task 23 — CLI entry and `run` command

**Files:**
- Modify: `src/cli.ts`
- Create: `src/commands/run.ts`

- [ ] **Step 1: Replace `src/cli.ts`**

```ts
#!/usr/bin/env node
import { Command } from "commander";
import { runCommand } from "./commands/run.js";

const program = new Command();
program
  .name("agent")
  .description("Agent Orchestrator — run an agentic workflow against local git repos")
  .version("0.1.0");

program
  .command("run")
  .description("Start a new orchestration run")
  .option("--target <dir>", "directory to scan for repos", process.cwd())
  .option("--auth <mode>", "auth mode: api | subscription")
  .option("--concurrency <n>", "parallel repos", "1")
  .option("--checkpoint-every <n>", "pause every N tasks", "1")
  .option("--yolo", "skip checkpoints (equivalent to --checkpoint-every=∞)")
  .option("--max-tokens <n>", "hard cap on total tokens")
  .option("--max-duration <dur>", "hard cap on wall-clock (e.g. 2h, 90m)")
  .option("--on-failure <mode>", "stop|skip-task|skip-repo|retry", "skip-repo")
  .option("--max-retries <n>", "retry attempts before failure handling", "1")
  .option("--test-gate <mode>", "required|skip|per-repo", "per-repo")
  .option("--test-timeout <dur>", "max time per test run", "5m")
  .option("--model <id>", "default model", "claude-sonnet-4-6")
  .option("--include <glob...>", "whitelist patterns")
  .option("--exclude <glob...>", "blacklist patterns")
  .option("--non-interactive", "force non-interactive mode")
  .option("--dry-run", "skip execution; analyze + plan only")
  .action(runCommand);

program.parseAsync(process.argv).catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Implement `src/commands/run.ts`**

```ts
import { resolveAuthMode, applyAuthMode, authWarnings } from "../auth/mode.js";
import { runOrchestration } from "../orchestrator/run.js";
import { defaultStateRoot } from "../state/runIndex.js";
import { selectRepos } from "../tui/select.ts";
import { confirmPrompt, proposalGate, planGate } from "../tui/confirm.js";
import { checkpoint as checkpointTui } from "../tui/checkpoint.js";
import type { AuthMode, RunConfig } from "../types.js";

export interface RunCommandOpts {
  target: string;
  auth?: AuthMode;
  concurrency: string;
  checkpointEvery: string;
  yolo?: boolean;
  maxTokens?: string;
  maxDuration?: string;
  onFailure: RunConfig["onFailure"];
  maxRetries: string;
  testGate: RunConfig["testGate"];
  testTimeout: string;
  model: string;
  include?: string[];
  exclude?: string[];
  nonInteractive?: boolean;
  dryRun?: boolean;
}

export async function runCommand(opts: RunCommandOpts): Promise<void> {
  const interactive = !opts.nonInteractive && process.stdout.isTTY === true;

  const resolved = resolveAuthMode({
    flag: opts.auth,
    env: (process.env.AGENT_AUTH as AuthMode | undefined) ?? undefined,
    interactive,
  });
  if (!resolved) {
    console.error("--auth is required (api | subscription) when non-interactive");
    process.exit(4);
  }
  applyAuthMode(resolved.mode);

  const config: RunConfig = {
    targetDir: opts.target,
    concurrency: Number(opts.concurrency),
    checkpointEvery: opts.yolo ? Number.MAX_SAFE_INTEGER : Number(opts.checkpointEvery),
    onFailure: opts.onFailure,
    maxRetries: Number(opts.maxRetries),
    maxTokens: opts.maxTokens ? Number(opts.maxTokens) : undefined,
    maxDurationMs: opts.maxDuration ? parseDuration(opts.maxDuration) : undefined,
    testGate: opts.testGate,
    testTimeoutMs: parseDuration(opts.testTimeout),
    model: { default: opts.model },
    include: opts.include,
    exclude: opts.exclude,
  };

  const warnings = authWarnings(resolved.mode, config.concurrency);
  for (const w of warnings) console.warn(`WARNING: ${w}`);

  const result = await runOrchestration({
    authMode: resolved.mode,
    config,
    stateRoot: defaultStateRoot(),
    selectRepos: async (repos) =>
      interactive ? selectRepos({ repos }) : repos.map((r) => r.path),
    proposalGate: async () => (interactive ? proposalGate() : "accept"),
    planGate: async () => (interactive ? planGate() : "accept"),
    checkpoint: async (outcome) =>
      interactive
        ? checkpointTui({
            task: outcome,
            filesChanged: outcome.filesChanged,
            diffText: outcome.diff,
          })
        : "continue",
    runConfirmation: async () =>
      interactive
        ? confirmPrompt("Proceed with execution across all selected repos?", true)
        : true,
    authConfirmation: async (warns) =>
      interactive ? confirmPrompt(warns.join("\n") + "\nContinue?", true) : true,
  });

  if (result.status === "completed") {
    process.exit(0);
  }
  if (result.status === "paused") {
    process.exit(2);
  }
  if (result.status === "failed") {
    process.exit(5);
  }
  process.exit(1);
}

function parseDuration(s: string): number {
  const m = s.match(/^(\d+)\s*(ms|s|m|h)$/);
  if (!m) return Number(s) || 0;
  const n = Number(m[1]);
  const unit = m[2];
  const mult = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return n * mult;
}
```

- [ ] **Step 3: Verify the binary compiles**

Run: `pnpm build`
Expected: TypeScript compiles cleanly, `dist/cli.js` exists.

- [ ] **Step 4: Smoke test the CLI parser (no execution)**

Run: `pnpm dev -- --help`
Expected: top-level help is printed showing `run` subcommand.

Run: `pnpm dev -- run --help`
Expected: full flag table printed.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/commands/run.ts
git commit -m "feat(cli): entry point and run command wired to orchestrator"
```

### Task 24 — `resume`, `status`, `runs`, `doctor`, `init` commands

**Files:**
- Create: `src/commands/resume.ts`
- Create: `src/commands/status.ts`
- Create: `src/commands/runs.ts`
- Create: `src/commands/doctor.ts`
- Create: `src/commands/init.ts`
- Modify: `src/cli.ts` (register new commands)

- [ ] **Step 1: Implement `src/commands/init.ts`**

```ts
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
```

- [ ] **Step 2: Implement `src/commands/runs.ts`**

```ts
import { listRuns, defaultStateRoot } from "../state/runIndex.js";
import { renderRunSummary } from "../tui/render.js";

export async function runsListCommand(): Promise<void> {
  const runs = await listRuns(defaultStateRoot());
  if (runs.length === 0) {
    console.warn("No runs found.");
    return;
  }
  for (const { manifest } of runs) {
    console.warn(
      `${manifest.runId}  ${manifest.status.padEnd(10)}  ${manifest.repos.length} repos  ${manifest.createdAt}`,
    );
  }
}

export async function runsShowCommand(runId: string): Promise<void> {
  const runs = await listRuns(defaultStateRoot());
  const target = runs.find((r) => r.runId === runId);
  if (!target) {
    console.error(`Run ${runId} not found`);
    process.exit(1);
  }
  console.warn(renderRunSummary(target.manifest));
}
```

- [ ] **Step 3: Implement `src/commands/status.ts`**

```ts
import { access } from "node:fs/promises";
import { join } from "node:path";
import { listRuns, defaultStateRoot } from "../state/runIndex.js";
import { loadRepoState } from "../state/repoState.js";

export async function statusCommand(): Promise<void> {
  const cwd = process.cwd();
  const inRepo = await isInRepo(cwd);
  if (inRepo) {
    const state = await loadRepoState(cwd);
    console.warn(`Repo: ${state.name}`);
    console.warn(`Status: ${state.status}`);
    if (state.taskState) {
      const completed = state.taskState.filter((t) => t.status === "completed").length;
      console.warn(`Tasks: ${completed}/${state.taskState.length} completed`);
    }
    return;
  }
  const runs = await listRuns(defaultStateRoot());
  const active = runs.filter((r) => ["running", "paused"].includes(r.manifest.status));
  if (active.length === 0) {
    console.warn("No active runs.");
  } else {
    console.warn("Active runs:");
    for (const { manifest } of active) {
      console.warn(`  ${manifest.runId}  ${manifest.status}  ${manifest.repos.length} repos`);
    }
  }
}

async function isInRepo(cwd: string): Promise<boolean> {
  try {
    await access(join(cwd, ".agent", "state.json"));
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Implement `src/commands/resume.ts`**

```ts
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
  console.warn(`Resume support is incremental — for now, the orchestrator must be re-invoked manually.`);
  console.warn(`Target run: ${runId}`);
  console.warn(`Implementation note: full resume requires walking next-non-terminal logic; tracked for the resume task.`);
  process.exit(0);
}
```

> **Note:** Full resume is intentionally stubbed in v1; the spec calls for it but the implementation lands in the next iteration of execute()/orchestrator. The state files are already structured to support it.

- [ ] **Step 5: Implement `src/commands/doctor.ts`**

```ts
import { listRuns, defaultStateRoot } from "../state/runIndex.js";
import { cleanStaleTmpFiles } from "../state/atomicWrite.js";
import { join } from "node:path";

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
```

- [ ] **Step 6: Update `src/cli.ts` to register the new commands**

Append to `src/cli.ts` before `program.parseAsync`:

```ts
import { resumeCommand } from "./commands/resume.js";
import { statusCommand } from "./commands/status.js";
import { runsListCommand, runsShowCommand } from "./commands/runs.js";
import { doctorCommand } from "./commands/doctor.js";
import { initCommand } from "./commands/init.js";

program
  .command("resume [runId]")
  .description("Resume a paused run")
  .action((runId) => resumeCommand({ runId }));

program
  .command("status")
  .description("Show status (in-repo or global)")
  .action(statusCommand);

const runsCmd = program.command("runs").description("Manage runs");
runsCmd.command("list").action(runsListCommand);
runsCmd.command("show <runId>").action(runsShowCommand);

program
  .command("doctor [runId]")
  .description("Inspect / repair state")
  .option("--repair", "interactive repair (currently scan-only)")
  .action((runId, opts) => doctorCommand({ runId, repair: opts.repair }));

program
  .command("init [dir]")
  .description("Bootstrap config + .agentignore")
  .action((dir) => initCommand({ dir }));
```

- [ ] **Step 7: Verify build and smoke-test**

Run: `pnpm build`
Expected: clean compile.

Run: `pnpm dev -- --help`
Expected: shows all six commands (`run`, `resume`, `status`, `runs`, `doctor`, `init`).

Run: `pnpm dev -- runs list`
Expected: prints "No runs found." (or empty list).

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts src/commands/
git commit -m "feat(cli): resume, status, runs, doctor, init commands"
```

---

## Phase 10 — Integration tests with fixtures

Goal: end-to-end orchestrator runs against real fixture repos with mocked SDK calls.

### Task 25 — Set up test fixture: `jsts-tiny`

**Files:**
- Create: `test/fixtures/repos/jsts-tiny/` (full git repo)
- Create: `test/integration/full-run.test.ts`

- [ ] **Step 1: Create the fixture script and run it**

Create: `scripts/build-fixture-jsts-tiny.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
TARGET="$(pwd)/test/fixtures/repos/jsts-tiny"
rm -rf "$TARGET"
mkdir -p "$TARGET/src"
cd "$TARGET"
git init -q
git config user.email "test@example.com"
git config user.name "fixture"
cat > package.json <<EOF
{ "name": "jsts-tiny", "version": "0.0.0", "scripts": { "test": "node --test test/" } }
EOF
cat > README.md <<EOF
# jsts-tiny

A toy fixture for orchestrator tests. Has a greet() function and a passing test.
EOF
mkdir -p test
cat > src/greet.js <<EOF
export function greet(name) { return "hello " + name; }
EOF
cat > test/greet.test.js <<EOF
import { test } from "node:test";
import assert from "node:assert";
import { greet } from "../src/greet.js";
test("greets a name", () => { assert.equal(greet("world"), "hello world"); });
EOF
git add .
git commit -q -m "init"
```

Run: `chmod +x scripts/build-fixture-jsts-tiny.sh && ./scripts/build-fixture-jsts-tiny.sh`
Expected: `test/fixtures/repos/jsts-tiny/.git` populated.

- [ ] **Step 2: Add fixture build to package.json scripts**

Modify `package.json` scripts:

```json
"scripts": {
  "...": "...",
  "build:fixtures": "bash scripts/build-fixture-jsts-tiny.sh"
}
```

- [ ] **Step 3: Write integration test**

```ts
// test/integration/full-run.test.ts
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { runOrchestration } from "../../src/orchestrator/run.js";
import type { RunConfig } from "../../src/types.js";

describe("integration: full-run with jsts-tiny", () => {
  let target: string;
  let stateRoot: string;
  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "frun-"));
    target = join(dir, "target");
    stateRoot = join(dir, "state");
    await cp("test/fixtures/repos/jsts-tiny", join(target, "jsts-tiny"), { recursive: true });
  });
  afterEach(async () => {
    await rm(target, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
  });

  it("walks discover → analyze → plan → execute and finalizes", async () => {
    const config: RunConfig = {
      targetDir: target,
      concurrency: 1,
      checkpointEvery: Number.MAX_SAFE_INTEGER,
      onFailure: "skip-repo",
      maxRetries: 0,
      testGate: "skip",
      testTimeoutMs: 30_000,
      model: { default: "claude-sonnet-4-6" },
    };

    const fakeAnalyze = vi.fn(async () => ({
      proposalPath: "/dev/null",
      tokensUsed: 100,
      durationMs: 5,
    }));
    const fakePlan = vi.fn(async () => ({
      planPath: "/dev/null",
      taskCount: 1,
      tasks: [
        {
          taskId: "11111111-1111-1111-1111-111111111111",
          title: "T",
          acceptanceCriteria: [],
          status: "pending" as const,
          attempts: 0,
          tokensUsed: 0,
          durationMs: 0,
        },
      ],
      estimatedTokens: 100,
      estimatedDurationMs: 1000,
      tokensUsed: 200,
      durationMs: 5,
    }));
    const fakeExecute = vi.fn(async () => ({
      taskId: "11111111-1111-1111-1111-111111111111",
      title: "T",
      acceptanceCriteria: [],
      status: "completed" as const,
      attempts: 1,
      tokensUsed: 500,
      durationMs: 5,
      commitSha: "a".repeat(40),
      filesChanged: ["src/x.js"],
      diff: "+",
    }));

    const result = await runOrchestration({
      runId: ulid(),
      authMode: "api",
      config,
      stateRoot,
      selectRepos: async (repos) => repos.map((r) => r.path),
      proposalGate: async () => "accept",
      planGate: async () => "accept",
      checkpoint: async () => "continue",
      runConfirmation: async () => true,
      authConfirmation: async () => true,
      analyzeFn: fakeAnalyze,
      planFn: fakePlan,
      executeFn: fakeExecute,
    });

    expect(result.status).toBe("completed");
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0].name).toBe("jsts-tiny");
    expect(fakeAnalyze).toHaveBeenCalledTimes(1);
    expect(fakeExecute).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 4: Run integration test**

Run: `ANTHROPIC_API_KEY=dummy pnpm test:integration`
Expected: 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add scripts/ test/fixtures/ test/integration/ package.json
git commit -m "test(integration): jsts-tiny fixture and full-run smoke test"
```

---

## Phase 11 — E2E tests (gated)

Goal: smallest possible real-SDK exercise; gated by `RUN_E2E=1` so it doesn't run on every dev save.

### Task 26 — E2E: tiny analyze

**Files:**
- Create: `test/e2e/analyze.e2e.test.ts`

- [ ] **Step 1: Implement E2E test**

```ts
// test/e2e/analyze.e2e.test.ts
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { analyze } from "../../src/phases/analyze.js";
import { jstsProfile } from "../../src/stack/profiles/jsts.js";
import { BudgetTracker } from "../../src/orchestrator/budget.js";

const skipUnlessE2E = process.env.RUN_E2E === "1" ? describe : describe.skip;

skipUnlessE2E("e2e: analyze a tiny jsts repo", () => {
  it("produces a proposal containing expected sections", async () => {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY required for E2E");
    const dir = await mkdtemp(join(tmpdir(), "e2e-"));
    try {
      const repo = join(dir, "tiny");
      await mkdir(repo);
      const g = simpleGit(repo);
      await g.init();
      await g.addConfig("user.email", "test@example.com");
      await g.addConfig("user.name", "test");
      await writeFile(join(repo, "package.json"), JSON.stringify({ name: "tiny" }));
      await writeFile(join(repo, "README.md"), "# tiny\n\nA toy library that exports greet().");
      await writeFile(join(repo, "greet.js"), "export const greet = (n) => 'hi ' + n;\n");
      await g.add(".").commit("init");

      const tracker = new BudgetTracker({ maxTokens: 200_000 });
      const result = await analyze({
        repoPath: repo,
        repoName: "tiny",
        stackProfile: jstsProfile,
        hasReadme: true,
        hasTests: false,
        lastCommitDate: null,
        tracker,
        model: "claude-haiku-4-5-20251001",
      });
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(result.proposalPath, "utf8");
      expect(content).toMatch(/Completion Proposal/i);
      expect(result.tokensUsed).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
```

- [ ] **Step 2: Run E2E (manually, when ready)**

Run: `RUN_E2E=1 ANTHROPIC_API_KEY=$YOUR_KEY pnpm test:e2e`
Expected: 1 test passes (taking ~30-60s, costing ~$0.01).

- [ ] **Step 3: Commit**

```bash
git add test/e2e/
git commit -m "test(e2e): tiny analyze smoke test (gated by RUN_E2E)"
```

---

## Phase 12 — Documentation and packaging

### Task 27 — README and CHANGELOG

**Files:**
- Create: `README.md`
- Create: `CHANGELOG.md`

- [ ] **Step 1: Write `README.md`**

```md
# Agent Orchestrator

A single-machine CLI that walks a user through running an agentic workflow against local git repos: discover → analyze → plan → approve → execute, with resumable runs and per-task commits.

## Quick start

```bash
pnpm install
pnpm build
node ./dist/cli.js run --target=./projects --auth=api
```

See `docs/superpowers/specs/2026-05-04-agent-orchestrator-design.md` for the full design.

## Auth modes

- `--auth=api` — uses `ANTHROPIC_API_KEY` from your environment.
- `--auth=subscription` — uses your Claude Code OAuth session (Pro/Max plan).

## Commands

- `agent run` — start a new run
- `agent resume [runId]` — resume a paused run
- `agent status` — show status
- `agent runs list|show` — manage runs
- `agent doctor [runId]` — inspect/repair state
- `agent init [dir]` — bootstrap config

## Documentation

- Spec: `docs/superpowers/specs/2026-05-04-agent-orchestrator-design.md`
- Plan: `docs/superpowers/plans/2026-05-04-agent-orchestrator-implementation.md`
```

- [ ] **Step 2: Write `CHANGELOG.md`**

```md
# Changelog

## 0.1.0 (Unreleased)

- Initial scaffold with discover, analyze, plan, execute pipeline
- Atomic state writes + JSONL run log
- Tier-1 stack profiles: JS/TS, Python; generic fallback
- CLI commands: run, resume (stub), status, runs, doctor, init
- Auth modes: API key + subscription (OAuth fallback)
```

- [ ] **Step 3: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: initial README and CHANGELOG"
```

---

## Self-review pass

After all tasks complete, run the self-review checklist below.

**1. Spec coverage:**
- [ ] §1 Architecture — covered by Phase 0 (bootstrap), §2 layout
- [ ] §2 Components — every module has a task (Tasks 4–22)
- [ ] §3 Data flow — types in Task 3, persistence in Tasks 4–7, atomic writes everywhere
- [ ] §4 Error handling — Task 20 retry logic, Task 22 BudgetCapped handling, Task 24 doctor scan
- [ ] §5 Testing strategy — unit tests in every task, integration in Task 25, E2E in Task 26, prompt snapshots in Tasks 14/16/19
- [ ] §6 CLI surface — Tasks 23/24 cover all commands and flags

**2. Placeholder scan:**
- Search for "TBD", "TODO", "implement later" — none should remain in plan code blocks (only in spec deferred-decisions section).
- Resume command in Task 24 is intentionally stubbed (next iteration); flagged with a note.

**3. Type consistency:**
- `RunConfig`, `RepoEntry`, `TaskState`, `LogEvent` defined in Task 3 are referenced correctly in all subsequent tasks.
- `BudgetTracker.add()` and `.check()` consistent across budget/sdk/orchestrator usage.
- `executeFn` signature in Task 22 matches the return shape from Task 20 (`ExecuteOutcome` extends `TaskState`).

If any issue found during execution, fix inline and continue.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-04-agent-orchestrator-implementation.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for a plan this size.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
