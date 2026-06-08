# Per-Phase Model & Effort Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken "tier" abstraction with direct per-phase Claude model + reasoning-effort selection, surfaced in the UI start-run form, the dashboard, and the CLI — with one server-side source of truth for harness configuration.

**Architecture:** Delete `tier`/`ModelTier` from the schema and both UIs (the tier→model mapping diverged between `ui/src/StartRunForm.tsx` and `src/orchestrator/modelTier.ts`, and the backend resolver was dead code). `RunConfig.model` already has the right per-phase shape; add a mirror `RunConfig.effort` object. Create `src/orchestrator/phaseAgents.ts` as the single home for each phase's harness spec (tools + model/effort resolution) — deliberately AgentDefinition-compatible for the v0.2 foreman work. Effort flows: `RunConfig.effort` → `run.ts` → phase params → `runQueryStream` → SDK `options.effort`.

**Tech Stack:** TypeScript (Node 20, NodeNext), Zod schemas, Vitest, Commander 12 (CLI), React 18 + Vite (UI), `@anthropic-ai/claude-agent-sdk` ^0.2.118.

---

## Context for the implementer

**Repo:** `/home/mckechniep/ai-llms/projects/claude-agent-sdk-v1`, branch `feat/v0.1-implementation`. Never commit to `main` (a git hook blocks it).

**Commands (run from repo root):**

| Action | Command | Notes |
|---|---|---|
| All tests | `pnpm test` | Do NOT use `pnpm test:unit` — its `--dir` flag conflicts with vitest config (known-broken script) |
| One test file | `pnpm vitest run test/unit/types.test.ts` | |
| Typecheck | `pnpm typecheck` | `tsc --noEmit`, covers `src/` + `test/` |
| Lint | `pnpm lint` | eslint; ignores `ui/**` |
| Server build | `pnpm build` | needed before CLI smoke tests |
| UI build + typecheck | `pnpm --prefix ui build` | UI has its own tsconfig; root typecheck does NOT cover `ui/src/*.tsx` |
| CLI smoke | `node dist/cli.js run --help` | `pnpm dev -- --help` does NOT work (pnpm/Commander `--` clash) |

**Conventions:**
- Conventional commits (`feat:`, `fix:`, `refactor:`), no AI attribution lines.
- Immutability, no silent error swallowing, files < 800 lines.
- Test data must conform to Zod schemas (ULIDs are 26 chars, timestamps `.000Z` ISO).

**⚠️ Do NOT confuse `tier` with `Thoroughness`.** `Thoroughness` (`"thorough" | "balanced" | "fast"` in `src/sdk/prompts/iteration.ts`, `src/server/routes.ts:45`, `ui/src/api.ts:4`) is a *prompt-depth* concept for analyze/plan iteration guidance. It shares names with the old tiers but is completely unrelated. **Leave every `Thoroughness`/`thoroughness` reference untouched.**

**Why no schema migration:** Zod's default object mode is `strip` — old on-disk manifests containing `config.tier` parse fine under the new schema (the unknown key is silently dropped). `SCHEMA_VERSION` stays at 2. The migration test fixtures (`test/unit/state/migrations.test.ts:18,26`) keep their `tier` references because they are raw-JSON inputs to the pre-validation `migrate()` function, which passes unknown keys through — those assertions still hold. **Do not edit migrations.test.ts.**

**SDK facts (verified against `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`):**
- `Options.effort?: EffortLevel` where `EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'` (sdk.d.ts:473, 1406).
- `'xhigh'`/`'max'` are restricted to Opus-family models; `'high'` is the SDK default.
- When `effort` is unset we must omit the key entirely (not pass `undefined`) so the SDK default applies.

## File structure

```
src/
├── types.ts                      # MODIFY: +opus-4-8, +EFFORT_LEVELS/EffortLevelSchema/effort field, −MODEL_TIERS/ModelTier/tier
├── orchestrator/
│   ├── modelTier.ts              # DELETE (dead code — never called in production paths)
│   ├── phaseAgents.ts            # CREATE: phase harness registry (tools, modelFor, effortFor, RECOMMENDED_MODELS)
│   └── run.ts                    # MODIFY: resolve model/effort via phaseAgents at 3 call sites
├── sdk/query.ts                  # MODIFY: QueryParams.effort → SDK options.effort
├── phases/
│   ├── analyze.ts                # MODIFY: effort param; tools from PHASE_AGENTS
│   ├── plan.ts                   # MODIFY: effort param; tools from PHASE_AGENTS
│   └── execute.ts                # MODIFY: effort param; tools from PHASE_AGENTS
├── cli.ts                        # MODIFY: --analyze-model/--plan-model/--execute-model/--effort flags
└── commands/run.ts               # MODIFY: validate + thread new flags into config

ui/src/
├── runTypes.ts                   # MODIFY: mirror schema changes by hand (established pattern)
├── modelConfig.ts                # CREATE: model/effort options, recommended defaults, pure config builders
├── StartRunForm.tsx              # MODIFY: tier dropdown → per-phase model/effort grid
├── RunDashboard.tsx              # MODIFY: tier display → per-phase model display
└── styles.css                    # MODIFY: append .phase-model-row styles

test/
├── unit/types.test.ts            # MODIFY: effort/opus-4-8 tests; remove tier tests
├── unit/orchestrator/
│   ├── modelTier.test.ts         # DELETE
│   ├── phaseAgents.test.ts       # CREATE
│   ├── run.test.ts               # MODIFY: −tier fixture; +model/effort threading test
│   └── step.test.ts              # MODIFY: −tier fixture line
├── unit/sdk/query.test.ts        # MODIFY: +effort passthrough tests
├── unit/server/
│   ├── crashRecovery.test.ts     # MODIFY: −tier fixture line
│   ├── runLoop.test.ts           # MODIFY: −tier fixture line
│   └── runRoutes.test.ts         # MODIFY: −tier fixture line
├── unit/state/runIndex.test.ts   # MODIFY: −tier fixture line
└── unit/ui/
    ├── modelConfig.test.ts       # CREATE
    └── runReducer.test.ts        # MODIFY: −tier fixture line (Task 7, with runTypes.ts)

docs/BACKLOG.md                   # MODIFY: v0.2 items (mid-run switching, live model list, per-model effort validation)
```

---

### Task 1: Schema — Opus 4.8 + effort levels in, tier out

**Files:**
- Modify: `src/types.ts:36-41,61,67-87`
- Modify: `test/unit/types.test.ts`
- Delete: `src/orchestrator/modelTier.ts`, `test/unit/orchestrator/modelTier.test.ts`
- Modify (mechanical, one line each — remove the `tier: "balanced",` line): `test/unit/orchestrator/run.test.ts:27`, `test/unit/orchestrator/step.test.ts:27`, `test/unit/server/crashRecovery.test.ts:21`, `test/unit/server/runLoop.test.ts:30`, `test/unit/server/runRoutes.test.ts:38`, `test/unit/state/runIndex.test.ts:16`

These all land in ONE commit because removing the `ModelTier` type breaks `modelTier.ts` compilation, and removing the `tier` schema field breaks every fixture that includes it.

- [ ] **Step 1: Rewrite `test/unit/types.test.ts` with the new expectations**

Replace the entire file content with:

```typescript
import { describe, expect, it } from "vitest";
import { RunConfigSchema } from "../../src/types.js";

const minimalInput = {
  targetDir: "/tmp/example",
  concurrency: 1,
  checkpointEvery: 5,
  onFailure: "skip-repo" as const,
  maxRetries: 1,
  testGate: "skip" as const,
  testTimeoutMs: 30_000,
  model: { default: "claude-sonnet-4-6" as const },
};

describe("RunConfigSchema", () => {
  it("applies autonomy=supervised as the default", () => {
    const parsed = RunConfigSchema.parse(minimalInput);
    expect(parsed.autonomy).toBe("supervised");
  });

  it("preserves explicit autonomy choices", () => {
    const parsed = RunConfigSchema.parse({
      ...minimalInput,
      autonomy: "yolo",
    });
    expect(parsed.autonomy).toBe("yolo");
  });

  it("rejects invalid autonomy values", () => {
    expect(() => RunConfigSchema.parse({ ...minimalInput, autonomy: "auto" })).toThrow();
  });

  it("strips the legacy tier field from old configs instead of rejecting them", () => {
    // Pre-2026-06 manifests carry config.tier. Zod strip mode drops unknown
    // keys, so old runs stay loadable without a migration.
    const parsed = RunConfigSchema.parse({ ...minimalInput, tier: "balanced" });
    expect("tier" in parsed).toBe(false);
  });

  it("rejects unknown model IDs", () => {
    expect(() =>
      RunConfigSchema.parse({ ...minimalInput, model: { default: "claude-sonnet-3-5" } }),
    ).toThrow();
  });

  it("accepts all allowlisted model IDs as model.default", () => {
    for (const id of [
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-7",
      "claude-opus-4-8",
    ] as const) {
      const parsed = RunConfigSchema.parse({ ...minimalInput, model: { default: id } });
      expect(parsed.model.default).toBe(id);
    }
  });

  it("rejects unknown model IDs in per-phase overrides", () => {
    expect(() =>
      RunConfigSchema.parse({
        ...minimalInput,
        model: { default: "claude-sonnet-4-6", execute: "claude-opus-3" },
      }),
    ).toThrow();
  });

  it("leaves effort undefined when not provided", () => {
    const parsed = RunConfigSchema.parse(minimalInput);
    expect(parsed.effort).toBeUndefined();
  });

  it("accepts per-phase effort levels", () => {
    const parsed = RunConfigSchema.parse({
      ...minimalInput,
      effort: { default: "high", execute: "low" },
    });
    expect(parsed.effort?.default).toBe("high");
    expect(parsed.effort?.execute).toBe("low");
    expect(parsed.effort?.analyze).toBeUndefined();
  });

  it("accepts the full effort range including opus-only levels", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
      const parsed = RunConfigSchema.parse({ ...minimalInput, effort: { default: level } });
      expect(parsed.effort?.default).toBe(level);
    }
  });

  it("rejects unknown effort levels", () => {
    expect(() =>
      RunConfigSchema.parse({ ...minimalInput, effort: { default: "ultra" } }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run the test file and verify it fails**

Run: `pnpm vitest run test/unit/types.test.ts`
Expected: FAIL — "claude-opus-4-8" rejected by enum, `effort` key stripped (unknown), legacy-tier test passes trivially. The failures prove the schema work is real.

- [ ] **Step 3: Update `src/types.ts`**

Replace lines 36-41 (the `MODEL_TIERS` and `MODEL_IDS` consts):

```typescript
export const MODEL_TIERS = ["thorough", "balanced", "fast", "custom"] as const;
export const MODEL_IDS = [
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-7",
] as const;
```

with:

```typescript
export const MODEL_IDS = [
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-7",
  "claude-opus-4-8",
] as const;
// Reasoning effort forwarded to the SDK. 'xhigh'/'max' are Opus-only at the
// API level; the schema accepts them everywhere and the SDK errors loudly if
// a model doesn't support the requested level (preferable to silently
// downgrading). v0.2: validate per-model from the SDK's supportedEffortLevels.
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
```

Replace line 61 (`export type ModelTier = (typeof MODEL_TIERS)[number];`) with:

```typescript
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
```

After line 65 (`export const ModelIdSchema = z.enum(MODEL_IDS);`) add:

```typescript
export const EffortLevelSchema = z.enum(EFFORT_LEVELS);
```

In `RunConfigSchema`, delete line 70 (`tier: z.enum(MODEL_TIERS).default("balanced"),`) and, immediately after the closing `}),` of the `model:` object (line 84), add:

```typescript
  // Per-phase reasoning effort. Optional at every level: an unset phase falls
  // back to effort.default; an unset default means "let the SDK/model decide"
  // (the effort key is omitted from the SDK call entirely).
  effort: z
    .object({
      default: EffortLevelSchema.optional(),
      analyze: EffortLevelSchema.optional(),
      plan: EffortLevelSchema.optional(),
      execute: EffortLevelSchema.optional(),
    })
    .optional(),
```

- [ ] **Step 4: Delete the dead tier-resolution code**

```bash
rm src/orchestrator/modelTier.ts test/unit/orchestrator/modelTier.test.ts
```

(`resolveTierToModels` was never imported by `run.ts` or `runRoutes.ts` — verify with `grep -rn "modelTier" src/` which must return nothing after deletion.)

- [ ] **Step 5: Remove the `tier` line from the six test fixtures**

In each of these files, delete the single line `      tier: "balanced",` (exact line numbers as of plan-writing):
- `test/unit/orchestrator/run.test.ts:27`
- `test/unit/orchestrator/step.test.ts:27`
- `test/unit/server/crashRecovery.test.ts:21`
- `test/unit/server/runLoop.test.ts:30`
- `test/unit/server/runRoutes.test.ts:38`
- `test/unit/state/runIndex.test.ts:16`

Do NOT touch `test/unit/state/migrations.test.ts` (raw-JSON fixtures, see Context).

- [ ] **Step 6: Run the full suite, typecheck, lint**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: ALL PASS. Test count drops by ~6 (modelTier.test.ts removed) and gains ~6 (new schema tests).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(types): per-phase effort levels and opus 4.8; remove model tier

The tier abstraction caused a silent UI/backend divergence (the UI's
tier->model map disagreed with the never-called backend resolver).
Models and effort are now selected directly per phase. Old manifests
with config.tier remain loadable via Zod strip mode."
```

---

### Task 2: Phase agent registry

**Files:**
- Create: `src/orchestrator/phaseAgents.ts`
- Create: `test/unit/orchestrator/phaseAgents.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/orchestrator/phaseAgents.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  PHASE_AGENTS,
  RECOMMENDED_MODELS,
  effortFor,
  modelFor,
} from "../../../src/orchestrator/phaseAgents.js";
import type { RunConfig } from "../../../src/types.js";

const baseConfig: RunConfig = {
  targetDir: "/tmp/x",
  autonomy: "supervised",
  concurrency: 1,
  checkpointEvery: 1,
  onFailure: "skip-repo",
  maxRetries: 1,
  testGate: "skip",
  testTimeoutMs: 30_000,
  model: { default: "claude-sonnet-4-6" },
};

describe("PHASE_AGENTS", () => {
  it("locks the per-phase tool allowlists (the safety envelope)", () => {
    expect(PHASE_AGENTS.analyze.tools).toEqual(["Read", "Bash"]);
    expect(PHASE_AGENTS.plan.tools).toEqual(["Read"]);
    expect(PHASE_AGENTS.execute.tools).toEqual(["Read", "Write", "Edit", "Bash"]);
  });
});

describe("modelFor", () => {
  it("falls back to model.default when no per-phase override exists", () => {
    expect(modelFor("analyze", baseConfig)).toBe("claude-sonnet-4-6");
    expect(modelFor("execute", baseConfig)).toBe("claude-sonnet-4-6");
  });

  it("prefers the per-phase override", () => {
    const config: RunConfig = {
      ...baseConfig,
      model: { default: "claude-sonnet-4-6", execute: "claude-haiku-4-5-20251001" },
    };
    expect(modelFor("execute", config)).toBe("claude-haiku-4-5-20251001");
    expect(modelFor("plan", config)).toBe("claude-sonnet-4-6");
  });
});

describe("effortFor", () => {
  it("returns undefined when effort is not configured at all", () => {
    expect(effortFor("analyze", baseConfig)).toBeUndefined();
  });

  it("falls back to effort.default for phases without an override", () => {
    const config: RunConfig = { ...baseConfig, effort: { default: "high" } };
    expect(effortFor("plan", config)).toBe("high");
  });

  it("prefers the per-phase effort override", () => {
    const config: RunConfig = {
      ...baseConfig,
      effort: { default: "high", execute: "low" },
    };
    expect(effortFor("execute", config)).toBe("low");
    expect(effortFor("analyze", config)).toBe("high");
  });
});

describe("RECOMMENDED_MODELS", () => {
  it("recommends sonnet by default and haiku for execute", () => {
    expect(RECOMMENDED_MODELS.default).toBe("claude-sonnet-4-6");
    expect(RECOMMENDED_MODELS.execute).toBe("claude-haiku-4-5-20251001");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run test/unit/orchestrator/phaseAgents.test.ts`
Expected: FAIL — "Cannot find module .../phaseAgents.js"

- [ ] **Step 3: Create `src/orchestrator/phaseAgents.ts`**

```typescript
import type { EffortLevel, ModelId, RunConfig } from "../types.js";

/**
 * Phase agent registry — the single home for each phase's harness shape.
 *
 * Each orchestration phase spawns a fresh, single-purpose SDK agent. This
 * registry declares what that agent gets: its tool allowlist and how its
 * model + reasoning effort are resolved from the run config. Phases import
 * their tools from here; the orchestrator resolves model/effort through here.
 *
 * v0.2 note: this shape is deliberately AgentDefinition-compatible (the
 * SDK's subagent declaration type) so a future foreman architecture can
 * pass these specs into query()'s `agents:` option with minimal change.
 */
export type AgentPhase = "analyze" | "plan" | "execute";

export interface PhaseAgentSpec {
  /** Tool allowlist for this phase's harness. */
  tools: string[];
}

export const PHASE_AGENTS: Record<AgentPhase, PhaseAgentSpec> = {
  // Read-only investigation: may run tests/git via Bash but never edits.
  analyze: { tools: ["Read", "Bash"] },
  // Document writer: reads the repo + proposal; the orchestrator persists
  // its output, so it needs no write access of its own.
  plan: { tools: ["Read"] },
  // The only phase allowed to change files.
  execute: { tools: ["Read", "Write", "Edit", "Bash"] },
};

/** Resolve the model for a phase: per-phase override, else the run default. */
export function modelFor(phase: AgentPhase, config: RunConfig): ModelId {
  return config.model[phase] ?? config.model.default;
}

/**
 * Resolve the reasoning effort for a phase: per-phase override, else the
 * run-level default, else undefined (= omit from the SDK call so the
 * SDK/model default applies).
 */
export function effortFor(phase: AgentPhase, config: RunConfig): EffortLevel | undefined {
  return config.effort?.[phase] ?? config.effort?.default;
}

/**
 * Recommended per-phase models: Sonnet for the reasoning phases; Haiku for
 * execute, where 80%+ of a run's tokens are spent and Haiku delivers ~90%
 * of the capability at roughly a third of the cost.
 *
 * The UI mirrors these values in ui/src/modelConfig.ts (it cannot import
 * server code — see the header comment in ui/src/runTypes.ts). Drift there
 * is cosmetic: the dropdowns show exactly which models will run, unlike the
 * old hidden tier→model mapping this registry replaces.
 */
export const RECOMMENDED_MODELS: RunConfig["model"] = {
  default: "claude-sonnet-4-6",
  execute: "claude-haiku-4-5-20251001",
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/unit/orchestrator/phaseAgents.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/phaseAgents.ts test/unit/orchestrator/phaseAgents.test.ts
git commit -m "feat(orchestrator): phase agent registry with model/effort resolution

Single home for each phase's harness spec (tools + model + effort).
AgentDefinition-compatible shape, ready for the v0.2 foreman pattern."
```

---

### Task 3: Effort flows through the SDK query layer

**Files:**
- Modify: `src/sdk/query.ts:3-15,106-115`
- Modify: `test/unit/sdk/query.test.ts` (append a describe block)

- [ ] **Step 1: Append the failing tests to `test/unit/sdk/query.test.ts`**

Add this describe block at the end of the file (inside nothing — top level, after the existing `describe("runQuery", ...)` block):

```typescript
describe("runQuery effort passthrough", () => {
  it("forwards effort to the SDK options when set", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const fakeQuery = vi.fn(async function* (args: unknown) {
      capturedOptions = (args as { options: Record<string, unknown> }).options;
      yield {
        type: "result",
        result: "ok",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    });
    const tracker = new BudgetTracker({});
    await runQuery({
      prompt: "test",
      allowedTools: ["Read"],
      cwd: "/tmp",
      tracker,
      model: "claude-sonnet-4-6",
      effort: "low",
      queryFn: fakeQuery as never,
    });
    expect(capturedOptions?.effort).toBe("low");
    expect(capturedOptions?.model).toBe("claude-sonnet-4-6");
  });

  it("omits the effort key entirely when unset so the SDK default applies", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const fakeQuery = vi.fn(async function* (args: unknown) {
      capturedOptions = (args as { options: Record<string, unknown> }).options;
      yield {
        type: "result",
        result: "ok",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    });
    const tracker = new BudgetTracker({});
    await runQuery({
      prompt: "test",
      allowedTools: ["Read"],
      cwd: "/tmp",
      tracker,
      queryFn: fakeQuery as never,
    });
    expect(capturedOptions).toBeDefined();
    expect("effort" in (capturedOptions ?? {})).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run test/unit/sdk/query.test.ts`
Expected: FAIL — first new test fails (`capturedOptions?.effort` is `undefined`); second passes already. Also a TS error on `effort: "low"` not existing in QueryParams (vitest surfaces it as a transform/type error or the property is silently dropped — either way the first assertion fails).

- [ ] **Step 3: Add `effort` to `QueryParams` in `src/sdk/query.ts`**

In the `QueryParams` interface, after `model?: string;` (line 8), add:

```typescript
  // Reasoning effort forwarded to the SDK ('low' | 'medium' | 'high' |
  // 'xhigh' | 'max'). Typed as string to keep the SDK layer decoupled from
  // types.ts (same convention as `model`). Omitted from the SDK call when
  // unset so the SDK/model default applies.
  effort?: string;
```

In the `queryFn(...)` call options object (lines 106-115), after the `...(params.model ? { model: params.model } : {}),` line, add:

```typescript
      ...(params.effort ? { effort: params.effort } : {}),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/unit/sdk/query.test.ts`
Expected: PASS (all tests in file, including the 2 new ones)

- [ ] **Step 5: Commit**

```bash
git add src/sdk/query.ts test/unit/sdk/query.test.ts
git commit -m "feat(sdk): forward reasoning effort to SDK query options"
```

---

### Task 4: Phases accept effort and take tools from the registry

**Files:**
- Modify: `src/phases/analyze.ts:19,52-60`
- Modify: `src/phases/plan.ts:22,55-61`
- Modify: `src/phases/execute.ts:19,31,101-109`
- Modify: `test/unit/phases/execute.test.ts` (the existing allowlist-verification test keeps asserting the literal tool list — no change needed; verify it still passes)

- [ ] **Step 1: Update `src/phases/analyze.ts`**

Add the import at the top (after the existing imports):

```typescript
import { PHASE_AGENTS } from "../orchestrator/phaseAgents.js";
```

In `AnalyzeParams`, after `model?: string;` (line 19), add:

```typescript
  effort?: string;
```

In the `runQueryStream({...})` call, replace:

```typescript
    allowedTools: ["Read", "Bash"],
```

with:

```typescript
    allowedTools: PHASE_AGENTS.analyze.tools,
```

and after `model: params.model,` add:

```typescript
    effort: params.effort,
```

- [ ] **Step 2: Update `src/phases/plan.ts`** (same pattern)

Add the import:

```typescript
import { PHASE_AGENTS } from "../orchestrator/phaseAgents.js";
```

In `PlanParams`, after `model?: string;` (line 22), add:

```typescript
  effort?: string;
```

In the `runQueryStream({...})` call, replace `allowedTools: ["Read"],` with `allowedTools: PHASE_AGENTS.plan.tools,` and after `model: params.model,` add `effort: params.effort,`.

- [ ] **Step 3: Update `src/phases/execute.ts`**

Add the import:

```typescript
import { PHASE_AGENTS } from "../orchestrator/phaseAgents.js";
```

Replace line 19:

```typescript
const EXECUTOR_TOOLS = ["Read", "Write", "Edit", "Bash"];
```

with:

```typescript
const EXECUTOR_TOOLS = PHASE_AGENTS.execute.tools;
```

In `ExecuteParams`, after `model?: string;` (line 31), add:

```typescript
  effort?: string;
```

In the `runQueryStream({...})` call (line ~101), after `model: params.model,` add:

```typescript
      effort: params.effort,
```

- [ ] **Step 4: Run the phase tests + typecheck**

Run: `pnpm vitest run test/unit/phases/ && pnpm typecheck`
Expected: PASS — including execute.test.ts's existing allowlist-verification test (the literal list is unchanged, only its source moved).

- [ ] **Step 5: Commit**

```bash
git add src/phases/analyze.ts src/phases/plan.ts src/phases/execute.ts
git commit -m "refactor(phases): take tool allowlists from phase agent registry; accept effort"
```

---

### Task 5: Orchestrator resolves model + effort via the registry

**Files:**
- Modify: `src/orchestrator/run.ts:183,223,303` (+ import)
- Modify: `test/unit/orchestrator/run.test.ts` (add one test)

- [ ] **Step 1: Add the failing test to `test/unit/orchestrator/run.test.ts`**

Add this test inside the existing `describe("runOrchestration", ...)` block, after the first happy-path test. It reuses the file's existing `makeFixtureRepo`, `baseConfig`, and `ulid` helpers and the same fake phase-fn shapes (copy the fakes from the happy-path test verbatim where indicated):

```typescript
  it("threads per-phase model and effort from config into each phase fn", async () => {
    await makeFixtureRepo(target, "alpha");

    // Identical fakes to the happy-path test above (same return shapes).
    const fakeAnalyze = vi.fn(async () => ({
      proposalPath: "/dev/null",
      proposalMarkdown: "",
      tokensUsed: 100,
      durationMs: 10,
    }));
    const fakePlan = vi.fn(async () => ({
      planPath: "/dev/null",
      planMarkdown: "",
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

    const config = {
      ...baseConfig(target),
      model: {
        default: "claude-sonnet-4-6" as const,
        execute: "claude-haiku-4-5-20251001" as const,
      },
      effort: { default: "high" as const, execute: "low" as const },
    };

    const result = await runOrchestration({
      runId: ulid(),
      authMode: "api",
      config,
      stateRoot,
      selectRepos: async (repos) => repos.map((r) => r.path),
      proposalGate: async () => "accept",
      planGate: async () => "accept",
      runConfirmation: async () => true,
      authConfirmation: async () => true,
      analyzeFn: fakeAnalyze,
      planFn: fakePlan,
      executeFn: fakeExecute,
    });

    expect(result.status).toBe("completed");
    expect(fakeAnalyze).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-4-6", effort: "high" }),
    );
    expect(fakePlan).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-4-6", effort: "high" }),
    );
    expect(fakeExecute).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-haiku-4-5-20251001", effort: "low" }),
    );
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run test/unit/orchestrator/run.test.ts`
Expected: FAIL — phase fns receive no `effort` key (and `toHaveBeenCalledWith` + `objectContaining({ effort: ... })` fails).

- [ ] **Step 3: Update `src/orchestrator/run.ts`**

Add the import near the other orchestrator imports:

```typescript
import { effortFor, modelFor } from "./phaseAgents.js";
```

Replace line 183:

```typescript
      model: manifest.config.model.plan ?? manifest.config.model.default,
```

with:

```typescript
      model: modelFor("plan", manifest.config),
      effort: effortFor("plan", manifest.config),
```

Replace line 223:

```typescript
          model: manifest.config.model.analyze ?? manifest.config.model.default,
```

with:

```typescript
          model: modelFor("analyze", manifest.config),
          effort: effortFor("analyze", manifest.config),
```

Replace line 303:

```typescript
        model: manifest.config.model.execute ?? manifest.config.model.default,
```

with:

```typescript
        model: modelFor("execute", manifest.config),
        effort: effortFor("execute", manifest.config),
```

(Line numbers shift slightly as you edit — match on the `model: manifest.config.model.<phase> ?? manifest.config.model.default` text, which appears exactly three times.)

- [ ] **Step 4: Run the orchestrator tests + full suite**

Run: `pnpm vitest run test/unit/orchestrator/ && pnpm test && pnpm typecheck && pnpm lint`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/run.ts test/unit/orchestrator/run.test.ts
git commit -m "feat(orchestrator): resolve per-phase model and effort through the agent registry"
```

---

### Task 6: CLI per-phase model + effort flags

**Files:**
- Modify: `src/cli.ts:30` (add 4 options after the existing `--model`)
- Modify: `src/commands/run.ts:9-26,42-63`

- [ ] **Step 1: Add the new options to `src/cli.ts`**

After line 30 (`.option("--model <id>", "default model", "claude-sonnet-4-6")`), add:

```typescript
  .option("--analyze-model <id>", "model override for the analyze phase")
  .option("--plan-model <id>", "model override for the plan phase")
  .option("--execute-model <id>", "model override for the execute phase")
  .option("--effort <level>", "reasoning effort for all phases: low|medium|high|xhigh|max")
```

- [ ] **Step 2: Update `src/commands/run.ts`**

Update the import on line 6 to include the effort schema:

```typescript
import { EffortLevelSchema, ModelIdSchema, RunConfigSchema } from "../types.js";
```

Update the import on line 7 to include the new types:

```typescript
import type { AuthMode, EffortLevel, ModelId, RunConfig } from "../types.js";
```

In `RunCommandOpts`, after `model: string;` (line 21), add:

```typescript
  analyzeModel?: string;
  planModel?: string;
  executeModel?: string;
  effort?: string;
```

(Commander camelCases `--analyze-model` to `analyzeModel` automatically.)

After the existing `--model` validation block (lines 42-48), add:

```typescript
  const parsePhaseModel = (flag: string, value: string | undefined): ModelId | undefined => {
    if (value === undefined) return undefined;
    const parsed = ModelIdSchema.safeParse(value);
    if (!parsed.success) {
      console.error(
        `Invalid ${flag} "${value}". Allowed values: ${ModelIdSchema.options.join(", ")}`,
      );
      process.exit(4);
    }
    return parsed.data;
  };
  const analyzeModel = parsePhaseModel("--analyze-model", opts.analyzeModel);
  const planModel = parsePhaseModel("--plan-model", opts.planModel);
  const executeModel = parsePhaseModel("--execute-model", opts.executeModel);

  let effortDefault: EffortLevel | undefined;
  if (opts.effort !== undefined) {
    const effortParse = EffortLevelSchema.safeParse(opts.effort);
    if (!effortParse.success) {
      console.error(
        `Invalid --effort "${opts.effort}". Allowed values: ${EffortLevelSchema.options.join(", ")}`,
      );
      process.exit(4);
    }
    effortDefault = effortParse.data;
  }
```

In the `RunConfigSchema.safeParse({...})` call, replace:

```typescript
    model: { default: modelParse.data },
```

with:

```typescript
    model: {
      default: modelParse.data,
      analyze: analyzeModel,
      plan: planModel,
      execute: executeModel,
    },
    effort: effortDefault ? { default: effortDefault } : undefined,
```

- [ ] **Step 3: Build and smoke-test the CLI**

Run: `pnpm build && node dist/cli.js run --help`
Expected: help output lists `--analyze-model`, `--plan-model`, `--execute-model`, `--effort` alongside `--model`.

Run: `node dist/cli.js run --target /tmp --model claude-opus-4-8 --effort silly --non-interactive --auth subscription 2>&1 | head -2`
Expected: `Invalid --effort "silly". Allowed values: low, medium, high, xhigh, max` and exit before any orchestration starts.

- [ ] **Step 4: Run the suite + typecheck + lint**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/commands/run.ts
git commit -m "feat(cli): per-phase model overrides and reasoning effort flags"
```

---

### Task 7: UI types mirror + model config module

**Files:**
- Modify: `ui/src/runTypes.ts:8-12,45-67`
- Create: `ui/src/modelConfig.ts`
- Create: `test/unit/ui/modelConfig.test.ts`
- Modify: `test/unit/ui/runReducer.test.ts:16` (remove the `tier: "balanced",` fixture line)

- [ ] **Step 1: Write the failing test for the config builders**

Create `test/unit/ui/modelConfig.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  buildEffortMap,
  buildModelMap,
  effortOptionsFor,
  recommendedSelections,
} from "../../../ui/src/modelConfig";

describe("recommendedSelections", () => {
  it("recommends sonnet for analyze/plan and haiku for execute, all at default effort", () => {
    const sel = recommendedSelections();
    expect(sel.analyze).toEqual({ model: "claude-sonnet-4-6", effort: "default" });
    expect(sel.plan).toEqual({ model: "claude-sonnet-4-6", effort: "default" });
    expect(sel.execute).toEqual({ model: "claude-haiku-4-5-20251001", effort: "default" });
  });
});

describe("buildModelMap", () => {
  it("emits an explicit model per phase plus a default", () => {
    const map = buildModelMap(recommendedSelections());
    expect(map).toEqual({
      default: "claude-sonnet-4-6",
      analyze: "claude-sonnet-4-6",
      plan: "claude-sonnet-4-6",
      execute: "claude-haiku-4-5-20251001",
    });
  });
});

describe("buildEffortMap", () => {
  it("returns undefined when every phase is at model-default effort", () => {
    expect(buildEffortMap(recommendedSelections())).toBeUndefined();
  });

  it("includes only the phases with explicit effort", () => {
    const sel = recommendedSelections();
    sel.execute = { ...sel.execute, effort: "low" };
    expect(buildEffortMap(sel)).toEqual({ execute: "low" });
  });
});

describe("effortOptionsFor", () => {
  it("offers xhigh/max only on opus models", () => {
    expect(effortOptionsFor("claude-opus-4-8")).toContain("xhigh");
    expect(effortOptionsFor("claude-opus-4-8")).toContain("max");
    expect(effortOptionsFor("claude-sonnet-4-6")).not.toContain("xhigh");
    expect(effortOptionsFor("claude-haiku-4-5-20251001")).not.toContain("max");
  });

  it("always offers the model-default sentinel first", () => {
    expect(effortOptionsFor("claude-sonnet-4-6")[0]).toBe("default");
    expect(effortOptionsFor("claude-opus-4-8")[0]).toBe("default");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run test/unit/ui/modelConfig.test.ts`
Expected: FAIL — "Cannot find module .../ui/src/modelConfig"

- [ ] **Step 3: Update `ui/src/runTypes.ts`**

Replace lines 8-12:

```typescript
export type ModelTier = "thorough" | "balanced" | "fast" | "custom";
export type ModelId =
  | "claude-sonnet-4-6"
  | "claude-haiku-4-5-20251001"
  | "claude-opus-4-7";
```

with:

```typescript
export type ModelId =
  | "claude-sonnet-4-6"
  | "claude-haiku-4-5-20251001"
  | "claude-opus-4-7"
  | "claude-opus-4-8";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface EffortMap {
  default?: EffortLevel;
  analyze?: EffortLevel;
  plan?: EffortLevel;
  execute?: EffortLevel;
}
```

In the `RunConfig` interface, delete the line `  tier: ModelTier;` (line 55) and after `  model: ModelMap;` (line 64) add:

```typescript
  effort?: EffortMap;
```

- [ ] **Step 4: Remove the `tier` fixture line from `test/unit/ui/runReducer.test.ts:16`**

Delete the single line `      tier: "balanced",` from the config fixture.

- [ ] **Step 5: Create `ui/src/modelConfig.ts`**

```typescript
import type { EffortLevel, EffortMap, ModelId, ModelMap } from "./runTypes";

// Mirrors src/orchestrator/phaseAgents.ts RECOMMENDED_MODELS (the UI cannot
// import server code — see the header comment in runTypes.ts). Drift here is
// cosmetic, not behavioral: the dropdowns always show exactly which models
// will run.

export type AgentPhase = "analyze" | "plan" | "execute";
export const AGENT_PHASES: AgentPhase[] = ["analyze", "plan", "execute"];

export interface ModelOption {
  id: ModelId;
  label: string;
  hint: string;
}

export const MODEL_OPTIONS: ModelOption[] = [
  { id: "claude-opus-4-8", label: "Opus 4.8", hint: "deepest reasoning · highest cost" },
  { id: "claude-opus-4-7", label: "Opus 4.7", hint: "deep reasoning · high cost" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", hint: "strong default · moderate cost" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", hint: "fastest · cheapest" },
];

export const RECOMMENDED_MODELS: ModelMap = {
  default: "claude-sonnet-4-6",
  execute: "claude-haiku-4-5-20251001",
};

// "default" sentinel = let the SDK/model decide; the effort key is omitted
// from the run config entirely for that phase.
export type EffortChoice = "default" | EffortLevel;

const BASE_EFFORT_OPTIONS: EffortChoice[] = ["default", "low", "medium", "high"];
const OPUS_EFFORT_OPTIONS: EffortChoice[] = ["default", "low", "medium", "high", "xhigh", "max"];

/** xhigh/max are Opus-only at the API level — hide them for other models. */
export function effortOptionsFor(model: ModelId): EffortChoice[] {
  return model.startsWith("claude-opus") ? OPUS_EFFORT_OPTIONS : BASE_EFFORT_OPTIONS;
}

export interface PhaseSelection {
  model: ModelId;
  effort: EffortChoice;
}

export type PhaseSelections = Record<AgentPhase, PhaseSelection>;

export function recommendedSelections(): PhaseSelections {
  return {
    analyze: { model: RECOMMENDED_MODELS.default, effort: "default" },
    plan: { model: RECOMMENDED_MODELS.default, effort: "default" },
    execute: {
      model: RECOMMENDED_MODELS.execute ?? RECOMMENDED_MODELS.default,
      effort: "default",
    },
  };
}

/** Collapse per-phase selections into the RunConfig.model map. Every phase is
 * explicit; `default` is kept as a fallback (analyze's model, arbitrarily). */
export function buildModelMap(sel: PhaseSelections): ModelMap {
  return {
    default: sel.analyze.model,
    analyze: sel.analyze.model,
    plan: sel.plan.model,
    execute: sel.execute.model,
  };
}

/** Collapse per-phase effort into the RunConfig.effort map. Phases left at
 * "default" are omitted; returns undefined when nothing is overridden. */
export function buildEffortMap(sel: PhaseSelections): EffortMap | undefined {
  const map: EffortMap = {};
  if (sel.analyze.effort !== "default") map.analyze = sel.analyze.effort;
  if (sel.plan.effort !== "default") map.plan = sel.plan.effort;
  if (sel.execute.effort !== "default") map.execute = sel.execute.effort;
  return Object.keys(map).length > 0 ? map : undefined;
}
```

- [ ] **Step 6: Run the new test + the UI reducer test + typecheck**

Run: `pnpm vitest run test/unit/ui/ && pnpm typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add ui/src/runTypes.ts ui/src/modelConfig.ts test/unit/ui/modelConfig.test.ts test/unit/ui/runReducer.test.ts
git commit -m "feat(ui): model/effort config module and schema mirror; remove tier type"
```

---

### Task 8: StartRunForm — per-phase model/effort grid

**Files:**
- Modify: `ui/src/StartRunForm.tsx:6-27,43-44,107-118,237-243,294-316`
- Modify: `ui/src/styles.css` (append)

The UI form has no component tests (established pattern: visual surfaces are verified by build + manual smoke; pure logic was extracted and tested in Task 7).

- [ ] **Step 1: Replace the imports and delete `modelForTier`**

Replace lines 6-27 (the type import block AND the entire `modelForTier` function with its comment):

```tsx
import type {
  AutonomyMode,
  ModelTier,
  OnFailure,
  RunConfig,
  TestGate,
} from "./runTypes";

// Tier → default model mapping. Mirrors src/orchestrator/tiers.ts; UI keeps
// its own copy to avoid a server round-trip just to render the form.
function modelForTier(tier: ModelTier): RunConfig["model"] {
  switch (tier) {
    case "thorough":
      return { default: "claude-opus-4-7" };
    case "fast":
      return { default: "claude-haiku-4-5-20251001" };
    case "balanced":
    case "custom":
    default:
      return { default: "claude-sonnet-4-6" };
  }
}
```

with:

```tsx
import type { AutonomyMode, ModelId, OnFailure, RunConfig, TestGate } from "./runTypes";
import {
  AGENT_PHASES,
  MODEL_OPTIONS,
  buildEffortMap,
  buildModelMap,
  effortOptionsFor,
  recommendedSelections,
  type AgentPhase,
  type EffortChoice,
  type PhaseSelections,
} from "./modelConfig";
```

- [ ] **Step 2: Replace the tier state with phase selections**

Replace line 44 (`  const [tier, setTier] = useState<ModelTier>("balanced");`) with:

```tsx
  const [phaseSelections, setPhaseSelections] = useState<PhaseSelections>(recommendedSelections);
```

Then add these two handlers after the `toggleRepo` function (after line ~100):

```tsx
  const setPhaseModel = (phase: AgentPhase, model: ModelId): void => {
    setPhaseSelections((prev) => {
      const current = prev[phase];
      // xhigh/max are opus-only; clamp effort back to default if the new
      // model doesn't support the currently-selected level.
      const effort = effortOptionsFor(model).includes(current.effort)
        ? current.effort
        : ("default" as const);
      return { ...prev, [phase]: { model, effort } };
    });
  };

  const setPhaseEffort = (phase: AgentPhase, effort: EffortChoice): void => {
    setPhaseSelections((prev) => ({ ...prev, [phase]: { ...prev[phase], effort } }));
  };
```

- [ ] **Step 3: Update the config built on submit**

Replace lines 107-118 (the `const config: RunConfig = {...}` literal):

```tsx
    const config: RunConfig = {
      targetDir: targetDir.trim(),
      autonomy,
      tier,
      concurrency,
      checkpointEvery,
      onFailure,
      maxRetries,
      testGate,
      testTimeoutMs,
      model: modelForTier(tier),
    };
```

with:

```tsx
    const effort = buildEffortMap(phaseSelections);
    const config: RunConfig = {
      targetDir: targetDir.trim(),
      autonomy,
      concurrency,
      checkpointEvery,
      onFailure,
      maxRetries,
      testGate,
      testTimeoutMs,
      model: buildModelMap(phaseSelections),
      ...(effort ? { effort } : {}),
    };
```

- [ ] **Step 4: Update the section subtitle**

Replace (around line 240-242):

```tsx
            <span className="card-sub">
              how much autonomy and which model tier
            </span>
```

with:

```tsx
            <span className="card-sub">
              how much autonomy, and which model + effort per phase
            </span>
```

- [ ] **Step 5: Replace the tier dropdown with the per-phase grid**

Replace the entire tier `<label className="field">...</label>` block (lines 294-316 — from `<label className="field">` containing `tier` through its closing `</label>`):

```tsx
            <label className="field">
              <span className="field-label">
                tier
                <InfoBadge label="About model tier">
                  Picks the Claude model for analyze / plan / execute.
                  <ul>
                    <li><code>thorough</code> — Opus 4.7 across phases. Best reasoning, highest cost.</li>
                    <li><code>balanced</code> — Sonnet 4.6. Solid default for most refactor work.</li>
                    <li><code>fast</code> — Haiku 4.5. Cheapest, fastest; best for small well-scoped tasks.</li>
                  </ul>
                  Switch to <code>custom</code> later in the manifest config to override per phase.
                </InfoBadge>
              </span>
              <select
                className="field-input"
                value={tier}
                onChange={(e) => setTier(e.target.value as ModelTier)}
              >
                <option value="thorough">thorough · opus</option>
                <option value="balanced">balanced · sonnet</option>
                <option value="fast">fast · haiku</option>
              </select>
            </label>
```

with:

```tsx
            <div className="field field-models">
              <span className="field-label">
                models &amp; effort
                <InfoBadge label="About models and effort">
                  Each phase spawns its own agent, so each phase can run a
                  different Claude model and reasoning effort.
                  <ul>
                    <li>
                      <strong>Recommended:</strong> Sonnet for analyze/plan,
                      Haiku for execute. 80%+ of a run&apos;s tokens are spent
                      in execute — Haiku is ~90% of the capability at roughly
                      a third of the cost.
                    </li>
                    <li>
                      Bump execute to Sonnet/Opus for gnarly refactors. Bump{" "}
                      <em>effort</em> instead of model when a phase needs more
                      thinking rather than more capability.
                    </li>
                    <li>
                      <em>effort</em> = how much reasoning the model does per
                      response. Leave on &quot;model default&quot; unless you
                      have a reason. <code>xhigh</code>/<code>max</code> are
                      Opus-only.
                    </li>
                  </ul>
                </InfoBadge>
              </span>

              {AGENT_PHASES.map((phase) => (
                <div key={phase} className="phase-model-row">
                  <span className="phase-model-name">{phase}</span>
                  <select
                    className="field-input"
                    value={phaseSelections[phase].model}
                    onChange={(e) => setPhaseModel(phase, e.target.value as ModelId)}
                    aria-label={`${phase} model`}
                  >
                    {MODEL_OPTIONS.map((opt) => (
                      <option key={opt.id} value={opt.id}>
                        {opt.label} — {opt.hint}
                      </option>
                    ))}
                  </select>
                  <select
                    className="field-input"
                    value={phaseSelections[phase].effort}
                    onChange={(e) => setPhaseEffort(phase, e.target.value as EffortChoice)}
                    aria-label={`${phase} effort`}
                  >
                    {effortOptionsFor(phaseSelections[phase].model).map((lvl) => (
                      <option key={lvl} value={lvl}>
                        {lvl === "default" ? "model default" : lvl}
                      </option>
                    ))}
                  </select>
                </div>
              ))}

              <button
                className="btn btn-ghost btn-reset-models"
                onClick={() => setPhaseSelections(recommendedSelections())}
                type="button"
              >
                ↺ Reset to recommended
              </button>
            </div>
```

- [ ] **Step 6: Append the grid styles to `ui/src/styles.css`**

Append at the end of the file:

```css
/* Per-phase model + effort selection grid (StartRunForm) */
.field-models {
  grid-column: 1 / -1;
}

.phase-model-row {
  display: grid;
  grid-template-columns: 5.5rem minmax(0, 1fr) minmax(0, 11rem);
  gap: 0.5rem;
  align-items: center;
  margin-block: 0.375rem;
}

.phase-model-name {
  font-size: 0.8125rem;
  opacity: 0.75;
  text-transform: lowercase;
  letter-spacing: 0.02em;
}

.btn-reset-models {
  margin-top: 0.5rem;
  justify-self: start;
  font-size: 0.8125rem;
}

@media (max-width: 720px) {
  .phase-model-row {
    grid-template-columns: 1fr;
    gap: 0.25rem;
  }
}
```

- [ ] **Step 7: Build the UI to verify it compiles**

Run: `pnpm --prefix ui build`
Expected: `tsc -b` passes (no references to `tier`/`ModelTier`/`modelForTier` remain in this file) and Vite build succeeds.

- [ ] **Step 8: Commit**

```bash
git add ui/src/StartRunForm.tsx ui/src/styles.css
git commit -m "feat(ui): per-phase model and effort selection replaces the tier dropdown"
```

---

### Task 9: RunDashboard — show models instead of tier

**Files:**
- Modify: `ui/src/RunDashboard.tsx:553-566,891,1014-1028,1308-1321`

- [ ] **Step 1: Replace the tier MetaRow (lines 553-566)**

Replace:

```tsx
          <MetaRow label="tier">
            <span className="run-header-meta-pill" title={describeTier(m.config.tier)}>
              {m.config.tier}
            </span>
            <InfoBadge label="Model tier legend" placement="bottom">
              <strong>Tier</strong> picks the model used for analyze / plan / execute:
              <ul>
                <li><code>thorough</code> — Opus 4.7 across the board. Most expensive, best reasoning.</li>
                <li><code>balanced</code> — Sonnet 4.6 default. Good for most tasks.</li>
                <li><code>fast</code> — Haiku 4.5 default. Cheapest, fastest, smallest context.</li>
                <li><code>custom</code> — per-phase model overrides set in config.</li>
              </ul>
            </InfoBadge>
          </MetaRow>
```

with:

```tsx
          <MetaRow label="models">
            <span className="run-header-meta-pill" title="Models used per phase">
              {modelSummary(m.config.model)}
            </span>
            <InfoBadge label="Per-phase models" placement="bottom">
              Each phase spawns its own agent with its own model:
              <ul>
                <li>analyze — <code>{m.config.model.analyze ?? m.config.model.default}</code></li>
                <li>plan — <code>{m.config.model.plan ?? m.config.model.default}</code></li>
                <li>execute — <code>{m.config.model.execute ?? m.config.model.default}</code></li>
              </ul>
              {m.config.effort && (
                <>
                  Effort overrides:
                  <ul>
                    {m.config.effort.default && (
                      <li>default — <code>{m.config.effort.default}</code></li>
                    )}
                    {m.config.effort.analyze && (
                      <li>analyze — <code>{m.config.effort.analyze}</code></li>
                    )}
                    {m.config.effort.plan && (
                      <li>plan — <code>{m.config.effort.plan}</code></li>
                    )}
                    {m.config.effort.execute && (
                      <li>execute — <code>{m.config.effort.execute}</code></li>
                    )}
                  </ul>
                </>
              )}
            </InfoBadge>
          </MetaRow>
```

- [ ] **Step 2: Update the "Start a new run" prose (line 891)**

Replace:

```tsx
          when you want to change the config (tier, autonomy, on-failure
```

with:

```tsx
          when you want to change the config (models, autonomy, on-failure
```

- [ ] **Step 3: Update the run-confirmation gate prose (lines 1014-1028)**

Replace:

```tsx
      <p className="run-gate-detail">
        {isResume ? (
          <>
            Clicking <strong>Confirm &amp; resume</strong> continues from where this run stopped —
            it skips the finished tasks and picks up the remaining {remaining} with the configured
            model tier ({vm.manifest.config.tier}).
          </>
        ) : (
          <>
            Clicking <strong>Confirm &amp; start execution</strong> hands control to the executor.
            Each task runs against its repo with the configured model tier (
            {vm.manifest.config.tier}), commits to a per-task branch when tests pass, and reports
            progress live below.
          </>
        )}
      </p>
```

with:

```tsx
      <p className="run-gate-detail">
        {isResume ? (
          <>
            Clicking <strong>Confirm &amp; resume</strong> continues from where this run stopped —
            it skips the finished tasks and picks up the remaining {remaining} with the configured
            models ({modelSummary(vm.manifest.config.model)}).
          </>
        ) : (
          <>
            Clicking <strong>Confirm &amp; start execution</strong> hands control to the executor.
            Each task runs against its repo with the configured execute model (
            {shortModelName(vm.manifest.config.model.execute ?? vm.manifest.config.model.default)}
            ), commits to a per-task branch when tests pass, and reports progress live below.
          </>
        )}
      </p>
```

- [ ] **Step 4: Replace `describeTier` with the model helpers (lines 1308-1321)**

Replace:

```tsx
function describeTier(tier: string): string {
  switch (tier) {
    case "thorough":
      return "Uses Claude Opus 4.7 for analyze, plan, and execute. Highest quality reasoning, highest cost.";
    case "balanced":
      return "Uses Claude Sonnet 4.6 across phases. Good default for most refactor/feature work.";
    case "fast":
      return "Uses Claude Haiku 4.5. Cheapest and fastest; best for small, well-scoped tasks.";
    case "custom":
      return "Per-phase model overrides defined in the run config.";
    default:
      return tier;
  }
}
```

with:

```tsx
function shortModelName(id: string): string {
  if (id.startsWith("claude-opus-4-8")) return "opus 4.8";
  if (id.startsWith("claude-opus-4-7")) return "opus 4.7";
  if (id.startsWith("claude-opus")) return "opus";
  if (id.startsWith("claude-sonnet")) return "sonnet 4.6";
  if (id.startsWith("claude-haiku")) return "haiku 4.5";
  return id;
}

function modelSummary(model: {
  default: string;
  analyze?: string;
  plan?: string;
  execute?: string;
}): string {
  const a = shortModelName(model.analyze ?? model.default);
  const p = shortModelName(model.plan ?? model.default);
  const e = shortModelName(model.execute ?? model.default);
  if (a === p && p === e) return a;
  return `${a} / ${p} / ${e}`;
}
```

- [ ] **Step 5: Build the UI**

Run: `pnpm --prefix ui build && grep -n "tier\|Tier" ui/src/RunDashboard.tsx ui/src/StartRunForm.tsx ui/src/runTypes.ts`
Expected: build passes; the grep returns NO matches in any of the three files.

- [ ] **Step 6: Commit**

```bash
git add ui/src/RunDashboard.tsx
git commit -m "feat(ui): dashboard shows per-phase models and effort instead of tier"
```

---

### Task 10: Final verification, backlog updates, manual smoke

**Files:**
- Modify: `docs/BACKLOG.md` (append v0.2 items)

- [ ] **Step 1: Full verification battery**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build && pnpm --prefix ui build`
Expected: ALL PASS. Also confirm zero `tier` references remain outside allowed locations:

Run: `grep -rn "tier" src/ ui/src/ --include="*.ts" --include="*.tsx" -i | grep -v "frontier\|Thoroughness\|thoroughness"`
Expected: only `src/sdk/query.ts:162` ("mixed-tier runs" prose comment — update the word to "mixed-model" while you're there) and nothing else. The migration test fixture references in `test/` are intentionally kept.

- [ ] **Step 2: Append v0.2 items to `docs/BACKLOG.md`**

Append under the existing backlog structure (match the file's current heading style):

```markdown
## Model & effort selection — deferred to v0.2

- **Mid-run model/tier switching** — extend resume / retry-from-failure routes
  (which already accept `authMode`) to accept a model/effort override; the next
  spawned harness reads the new values from the manifest. Per-model cost
  attribution already works.
- **Live model list from the Anthropic API** — replace the hardcoded
  `MODEL_IDS` Zod enum with a fetched + cached allowlist (the
  `agent-orch list-models` idea). Removes the "new model ships, enum is stale"
  problem this round papered over by adding claude-opus-4-8 manually.
- **Per-model effort validation** — the SDK exposes `supportedEffortLevels`
  per model; validate xhigh/max against it instead of allowing them
  schema-wide and trusting the SDK to error.
- **Foreman/worker model split** — when the foreman pattern lands, add
  `foreman` and `worker` keys to the model/effort maps (the per-phase record
  shape was chosen so this is additive).
```

- [ ] **Step 3: Manual smoke test (requires the user)**

Run: `pnpm dev:ui`

Verify in the browser (http://localhost:5173):
1. Start-a-run form shows three phase rows (analyze/plan/execute), each with a model dropdown and an effort dropdown.
2. Defaults are Sonnet/Sonnet/Haiku, all at "model default" effort.
3. Selecting Haiku for a phase removes xhigh/max from that phase's effort options; selecting Opus 4.8 adds them back.
4. "Reset to recommended" restores defaults.
5. Starting a run shows the models pill in the dashboard header (e.g. "sonnet 4.6 / sonnet 4.6 / haiku 4.5").

- [ ] **Step 4: Commit and push**

```bash
git add docs/BACKLOG.md
git commit -m "docs: backlog items for v0.2 model selection follow-ups"
git push origin feat/v0.1-implementation
```

---

## Self-review notes

- **Spec coverage:** ✅ kill tier (Tasks 1, 8, 9) · per-phase model selection UI (Task 8) · effort levels end-to-end (Tasks 1, 3, 4, 5, 6, 8) · Opus 4.8 (Task 1) · recommendation note + reset (Task 8) · single source of truth (Task 2) · CLI parity (Task 6) · dashboard display (Task 9) · v0.2 deferred items documented (Task 10).
- **Type consistency check:** `EffortLevel`/`EffortLevelSchema`/`EFFORT_LEVELS` (types.ts, Task 1) ↔ `effortFor` returns `EffortLevel | undefined` (Task 2) ↔ `QueryParams.effort?: string` (Task 3, intentionally untyped at SDK boundary, same as `model`) ↔ UI `EffortChoice = "default" | EffortLevel` (Task 7). `modelFor` returns `ModelId`. `PhaseSelections`/`buildModelMap`/`buildEffortMap` names match between Tasks 7 and 8.
- **Known intentional asymmetry:** the CLI gets a run-level `--effort` only (no per-phase effort flags) — YAGNI; the UI is the primary surface for fine-grained control.
- **What this plan does NOT do:** repomix/grepai context supply chain (separate plan: `2026-06-01-context-supply-chain.md`, to be written), foreman pattern (v0.2), mid-run switching (v0.2).
