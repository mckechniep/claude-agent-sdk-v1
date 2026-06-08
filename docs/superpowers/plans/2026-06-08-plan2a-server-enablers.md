# Plan 2A — Server Enablers (finalize + per-call model/effort) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the analyze/plan SSE routes two capabilities the new UI needs: a `finalize` flag that ends the analyze Q&A loop in one terminal pass (#4), and per-call `model`/`effort` overrides so the standalone preflight honors the landing defaults (#5-server).

**Architecture:** Both are tiny because the lower layers already support them. The iteration system already has a `"defaults"` mode meaning "stop asking, commit, incorporate the user's notes" — `finalize` just forces that mode regardless of iteration count. `analyzeStream`/`planStream` already accept `model?`/`effort?` and thread them to the SDK — only the *route layer* needs to parse and pass them. This is Plan 2A of 4 for the spec at `docs/superpowers/specs/2026-06-07-ui-ia-consolidation-design.md` (2B landing+defaults, 2C unified analyze, 2D branch picker follow).

**Tech Stack:** TypeScript (Node ESM, `.js` import extensions), Zod for route schemas, vitest (node env). Server code is covered by the **root** `pnpm typecheck` (`src/**`), unlike the UI.

**Conventions:** Full suite = `pnpm test`. Single file = `pnpm exec vitest run <path>`. Typecheck server = `pnpm typecheck`.

---

## Task A1: `finalize` forces the "defaults" iteration mode (#4 core)

**Files:**
- Modify: `src/sdk/prompts/iteration.ts` (`computeIterationMode`, `renderAnalyzeModeBlock`)
- Test: `test/prompts/iteration.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// test/prompts/iteration.test.ts
import { describe, expect, it } from "vitest";
import { computeIterationMode, renderAnalyzeModeBlock } from "../../src/sdk/prompts/iteration.js";

describe("computeIterationMode", () => {
  it("returns normal/narrow/defaults by iteration for balanced", () => {
    expect(computeIterationMode(1, "balanced")).toBe("normal");
    expect(computeIterationMode(3, "balanced")).toBe("narrow");
    expect(computeIterationMode(5, "balanced")).toBe("defaults");
  });

  it("forces 'defaults' when finalize is true, even at iteration 1", () => {
    expect(computeIterationMode(1, "balanced", true)).toBe("defaults");
    expect(computeIterationMode(1, "thorough", true)).toBe("defaults");
  });
});

describe("renderAnalyzeModeBlock", () => {
  it("emits the convergence block when finalize is true at iteration 1", () => {
    const block = renderAnalyzeModeBlock(1, "balanced", true);
    expect(block).toContain("Recommended defaults");
    expect(block).toContain("Do NOT ask further open questions");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/prompts/iteration.test.ts`
Expected: FAIL — `computeIterationMode` currently takes 2 args; the finalize test gets `normal`, not `defaults` (TypeScript may also error on the 3rd arg — that's still a red).

- [ ] **Step 3: Add the `finalize` parameter**

In `src/sdk/prompts/iteration.ts`, change `computeIterationMode` and `renderAnalyzeModeBlock` to accept an optional `finalize` flag. Replace the two function signatures/bodies' opening:

```ts
export function computeIterationMode(
  iteration: number,
  thoroughness: Thoroughness,
  finalize = false,
): IterationMode {
  if (finalize) return "defaults";
  const t = THRESHOLDS[thoroughness];
  if (iteration >= t.defaults) return "defaults";
  if (iteration >= t.narrow) return "narrow";
  return "normal";
}
```

And update `renderAnalyzeModeBlock`'s signature + its first line (leave the rest of the function body unchanged):

```ts
export function renderAnalyzeModeBlock(
  iteration: number,
  thoroughness: Thoroughness,
  finalize = false,
): string {
  const mode = computeIterationMode(iteration, thoroughness, finalize);
  // ...rest of the function body is unchanged...
```

> Leave `renderPlanModeBlock` unchanged — `finalize` is an analyze-gate (proposal) concept; the plan gate already converges via its own iteration counter.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/prompts/iteration.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sdk/prompts/iteration.ts test/prompts/iteration.test.ts
git commit -m "feat(prompts): finalize flag forces the analyze 'defaults' convergence mode"
```

---

## Task A2: thread `finalize` through the analyze prompt, phase, and route (#4 wiring)

**Files:**
- Modify: `src/sdk/prompts/analyze.ts` (`AnalyzePromptInput`, `renderAnalyzePrompt`)
- Modify: `src/phases/analyze.ts` (`AnalyzeParams`, the `renderAnalyzePrompt({...})` call)
- Modify: `src/server/routes.ts` (`AnalyzeQuery`, the analyze query extraction, the `analyzeStream({...})` call)
- Test: `test/prompts/analyze-finalize.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// test/prompts/analyze-finalize.test.ts
import { describe, expect, it } from "vitest";
import { renderAnalyzePrompt } from "../../src/sdk/prompts/analyze.js";
import { jstsProfile } from "../../src/stack/profiles/jsts.js";

describe("renderAnalyzePrompt finalize", () => {
  it("injects the convergence (defaults) guidance when finalize is true", () => {
    const out = renderAnalyzePrompt({
      repoPath: "/x/foo",
      repoName: "foo",
      stackProfile: jstsProfile,
      hasReadme: true,
      hasTests: true,
      lastCommitDate: null,
      userNotes: "use webhooks too; pin the SDK",
      iteration: 1,
      finalize: true,
    });
    expect(out).toContain("Recommended defaults");
    expect(out).toContain("User notes for this iteration");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/prompts/analyze-finalize.test.ts`
Expected: FAIL — `finalize` is not a known property of `AnalyzePromptInput` (TS error) and the defaults text is not injected at iteration 1.

- [ ] **Step 3a: Add `finalize` to the prompt input**

In `src/sdk/prompts/analyze.ts`, add `finalize?: boolean;` to `AnalyzePromptInput` (after `thoroughness?`), and pass it to the mode block. Change line 32 from:

```ts
  const modeBlock = renderAnalyzeModeBlock(iteration, thoroughness);
```
to:
```ts
  const modeBlock = renderAnalyzeModeBlock(iteration, thoroughness, input.finalize);
```

- [ ] **Step 3b: Add `finalize` to the analyze phase params**

In `src/phases/analyze.ts`, add `finalize?: boolean;` to `AnalyzeParams` (after `effort?: string;`), and pass it into the prompt. In the `renderAnalyzePrompt({...})` call (lines 41-52), add after `thoroughness: params.thoroughness,`:

```ts
    finalize: params.finalize,
```

- [ ] **Step 3c: Accept `finalize` on the analyze route**

In `src/server/routes.ts`:

1. Add `finalize` to `AnalyzeQuery` (the `z.object` at ~line 47):
```ts
  finalize: z.boolean().optional(),
```

2. In the analyze query extraction block (~line 370, where `userNotes`/`iteration`/`thoroughness` are read), add to the object passed to `AnalyzeQuery.safeParse`:
```ts
    finalize: query.get("finalize") === "true",
```

3. In the `analyzeStream({...})` call (~line 441), add alongside the existing spread passthroughs:
```ts
      ...(parsed.data.finalize ? { finalize: true } : {}),
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm exec vitest run test/prompts/analyze-finalize.test.ts && pnpm typecheck`
Expected: test PASS (1 test); typecheck exit 0 (the `finalize` type flows prompt → phase → route).

- [ ] **Step 5: Commit**

```bash
git add src/sdk/prompts/analyze.ts src/phases/analyze.ts src/server/routes.ts test/prompts/analyze-finalize.test.ts
git commit -m "feat(server): finalize flag on the analyze route ends the Q&A loop in one pass"
```

---

## Task A3: per-call `model`/`effort` on the analyze + plan routes (#5-server)

**Files:**
- Modify: `src/server/routes.ts` (imports; `AnalyzeQuery` + `PlanQuery`; both query extractions; both stream calls)

> No new unit test: `analyzeStream`/`planStream` already accept and exercise `model`/`effort` (src/phases/analyze.ts:20-21, plan.ts:23-24); this task is a typed passthrough at the route layer over SSE handlers that have no unit harness. Coverage = `pnpm typecheck` + the manual run in 2B (where the UI starts sending these). See Self-Review.

- [ ] **Step 1: Import the schemas**

In `src/server/routes.ts`, extend the existing `from "../types.js"` import to include the model/effort schemas:

```ts
import { AUTH_MODES, ModelIdSchema, EffortLevelSchema, type AuthMode } from "../types.js";
```

- [ ] **Step 2: Add `model`/`effort` to both query schemas**

To `AnalyzeQuery` (~line 47) AND `PlanQuery` (~line 60), add:

```ts
  model: ModelIdSchema.optional(),
  effort: EffortLevelSchema.optional(),
```

- [ ] **Step 3: Read them from the query string in both handlers**

In the analyze query-extraction object (~line 370) AND the plan query-extraction object (~line 530), add:

```ts
    model: query.get("model") ?? undefined,
    effort: query.get("effort") ?? undefined,
```

- [ ] **Step 4: Pass them into both stream calls**

In the `analyzeStream({...})` call (~line 441) AND the `planStream({...})` call (~line 620), add alongside the existing spreads:

```ts
      ...(parsed.data.model ? { model: parsed.data.model } : {}),
      ...(parsed.data.effort ? { effort: parsed.data.effort } : {}),
```

- [ ] **Step 5: Typecheck + full suite + commit**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck exit 0; all tests pass (prior count + 4 new from A1/A2).

```bash
git add src/server/routes.ts
git commit -m "feat(server): analyze + plan routes accept per-call model and effort"
```

---

## Self-Review

**Spec coverage (2A portion):**
- #4-server (finalize) → A1 (mode override, tested) + A2 (threading prompt→phase→route, prompt-level test + typecheck). ✓
- #5-server (per-call model/effort) → A3 (route schema + passthrough; phase already supports). ✓
- #2, the UI parts of #4/#5, #6 → out of scope (2B/2C/2D).

**Placeholder scan:** none. Approximate line numbers (`~441`) are anchors to known call sites already located; each step shows the exact code to add. The one untested task (A3) explains *why* (SSE handlers have no unit harness; the logic underneath is already tested) rather than hand-waving.

**Type consistency:** `finalize?: boolean` is added identically in `AnalyzePromptInput`, `AnalyzeParams`, and `AnalyzeQuery` (as `z.boolean().optional()`), and read from the query as `query.get("finalize") === "true"`. `ModelIdSchema`/`EffortLevelSchema` come from `src/types.ts` (confirmed) — the same source `runRoutes.ts` imports them from. `analyzeStream`/`planStream` already declare `model?: string`/`effort?: string`, so passing `ModelId`/`EffortLevel` (string enums) is assignable.

**Risk note:** A2/A3 edit the same `src/server/routes.ts` analyze handler region; do A2 before A3 so the diffs stack cleanly (A2 adds `finalize`, A3 adds `model`/`effort` to the same schema + call). Both are additive — existing callers that omit the new params are unaffected (all optional).
