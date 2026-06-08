# Plan 2B — Landing Defaults (DefaultsPanel + preflight inherits defaults) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface global model/effort **defaults** on the landing page (visible before scanning, #5-UI), make new runs inherit them, and make the standalone preflight analyze/plan calls send them — so the defaults actually govern preflight, not just the eventual run.

**Architecture:** Purely **additive** — the home `card-discover` scanner/analyze stays put (it's replaced in 2C, not here). We extract the per-phase grid into a shared `PhaseModelGrid`, add a controlled `DefaultsPanel` to the landing backed by the (already-tested) `loadDefaults`/`saveDefaults` core, lift a `defaults` state into `App`, and thread it through `onAnalyze`/`onPlan` + the API client (the routes already accept `model`/`effort` from Plan 2A). Plan 2B of 4 for spec `docs/superpowers/specs/2026-06-07-ui-ia-consolidation-design.md`.

**Tech Stack:** React + TypeScript (Vite), vitest (node env — pure-core tests only). UI typecheck = `pnpm typecheck:ui` (added in B0); full suite = `pnpm test`.

**Conventions:** Tests are logic-only (no jsdom/RTL). Components are verified manually with `pnpm dev:ui`. The one new pure helper (`buildPhaseOverride`) is TDD'd.

---

## Task B0: add a `typecheck:ui` script

**Files:**
- Modify: `package.json` (root `scripts`)

> The root `pnpm typecheck` only covers `src/**`; UI changes need `tsc -p ui/tsconfig.json`. This task makes a named command so later steps reference `pnpm typecheck:ui`.

- [ ] **Step 1: Add the script**

In root `package.json`, in `"scripts"`, add after the `"typecheck"` line:

```json
    "typecheck:ui": "tsc -p ui/tsconfig.json --noEmit",
```

- [ ] **Step 2: Verify it runs clean**

Run: `pnpm typecheck:ui`
Expected: exit 0 (no output).

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: add typecheck:ui script for the UI tsconfig"
```

---

## Task B1: extract `PhaseModelGrid` shared component

**Files:**
- Create: `ui/src/PhaseModelGrid.tsx`
- Modify: `ui/src/StartRunForm.tsx` (replace the inline grid at lines ~392-428 with the component)

> Behavior-preserving refactor so the grid can be reused by `DefaultsPanel`. No test (pure markup); verified by typecheck + the manual check that the start form's Advanced grid still works.

- [ ] **Step 1: Create the component**

```tsx
// ui/src/PhaseModelGrid.tsx
import {
  AGENT_PHASES,
  MODEL_OPTIONS,
  effortOptionsFor,
  type AgentPhase,
  type EffortChoice,
  type PhaseSelections,
} from "./modelConfig";
import type { ModelId } from "./runTypes";

/**
 * The per-phase (analyze / plan / execute) model + effort selector grid.
 * Controlled — the parent owns the selections. Shared by the start-run form's
 * Advanced section and the landing DefaultsPanel.
 */
export function PhaseModelGrid({
  selections,
  onModelChange,
  onEffortChange,
  onReset,
}: {
  selections: PhaseSelections;
  onModelChange: (phase: AgentPhase, model: ModelId) => void;
  onEffortChange: (phase: AgentPhase, effort: EffortChoice) => void;
  onReset?: () => void;
}) {
  return (
    <>
      {AGENT_PHASES.map((phase) => (
        <div key={phase} className="phase-model-row">
          <span className="phase-model-name">{phase}</span>
          <select
            className="field-input"
            value={selections[phase].model}
            onChange={(e) => onModelChange(phase, e.target.value as ModelId)}
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
            value={selections[phase].effort}
            onChange={(e) => onEffortChange(phase, e.target.value as EffortChoice)}
            aria-label={`${phase} effort`}
          >
            {effortOptionsFor(selections[phase].model).map((lvl) => (
              <option key={lvl} value={lvl}>
                {lvl === "default" ? "model default" : lvl}
              </option>
            ))}
          </select>
        </div>
      ))}
      {onReset && (
        <button className="btn btn-ghost btn-reset-models" onClick={onReset} type="button">
          ↺ Reset to recommended
        </button>
      )}
    </>
  );
}
```

- [ ] **Step 2: Use it in `StartRunForm`**

In `ui/src/StartRunForm.tsx`, add the import near the other local imports:
```tsx
import { PhaseModelGrid } from "./PhaseModelGrid";
```
Then replace the inline block — the `{AGENT_PHASES.map((phase) => ( ... ))}` grid AND the `↺ Reset to recommended` button that follows it (lines ~392-428) — with:
```tsx
                <PhaseModelGrid
                  selections={phaseSelections}
                  onModelChange={setPhaseModel}
                  onEffortChange={setPhaseEffort}
                  onReset={() => setPhaseSelections(recommendedSelections())}
                />
```
Leave the surrounding `<div className="field field-models">` + its label/InfoBadge intact. After this, `AGENT_PHASES`, `MODEL_OPTIONS`, and `effortOptionsFor` may become unused imports in `StartRunForm.tsx` — remove them from its import list if so (typecheck will flag unused if `noUnusedLocals` is on; otherwise remove for tidiness).

- [ ] **Step 3: Typecheck + manual**

Run: `pnpm typecheck:ui`
Expected: exit 0.
Manual: `pnpm dev:ui` → `#/runs/new` → open **Advanced settings** → the model/effort grid renders and changing a model still clamps effort + the reset button works.

- [ ] **Step 4: Commit**

```bash
git add ui/src/PhaseModelGrid.tsx ui/src/StartRunForm.tsx
git commit -m "refactor(ui): extract shared PhaseModelGrid from StartRunForm"
```

---

## Task B2: API client sends `model`/`effort`; add `buildPhaseOverride` helper

**Files:**
- Modify: `ui/src/modelDefaults.ts` (add `buildPhaseOverride`)
- Test: `test/unit/ui/modelDefaults.test.ts` (extend)
- Modify: `ui/src/api.ts` (`streamAnalyze` + `streamPlan` accept + send `model`/`effort`)

- [ ] **Step 1: Write the failing test (extend the existing file)**

Append to `test/unit/ui/modelDefaults.test.ts`:

```ts
import { buildPhaseOverride } from "../../../ui/src/modelDefaults";

describe("buildPhaseOverride", () => {
  it("omits effort when it is the model default", () => {
    expect(buildPhaseOverride({ model: "claude-sonnet-4-6", effort: "default" })).toEqual({
      model: "claude-sonnet-4-6",
    });
  });

  it("includes effort when it is an explicit level", () => {
    expect(buildPhaseOverride({ model: "claude-opus-4-8", effort: "high" })).toEqual({
      model: "claude-opus-4-8",
      effort: "high",
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run test/unit/ui/modelDefaults.test.ts`
Expected: FAIL — `buildPhaseOverride` is not exported.

- [ ] **Step 3: Implement the helper**

Append to `ui/src/modelDefaults.ts` (and extend the existing import from `./runTypes` to include `EffortLevel`):

```ts
import type { EffortLevel } from "./runTypes";

/** Map a phase selection to the analyze/plan request override, dropping the
 *  "default" effort sentinel (which means "let the model decide"). */
export function buildPhaseOverride(sel: PhaseSelection): { model: ModelId; effort?: EffortLevel } {
  return sel.effort === "default"
    ? { model: sel.model }
    : { model: sel.model, effort: sel.effort };
}
```

> `PhaseSelection`, `ModelId` are already imported in this file (`PhaseSelection` from `./modelConfig`, `ModelId` from `./runTypes`); only add `EffortLevel`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run test/unit/ui/modelDefaults.test.ts`
Expected: PASS (7 tests — 5 prior + 2 new).

- [ ] **Step 5: Thread `model`/`effort` through the API client**

In `ui/src/api.ts`:

1. In `streamAnalyze`, extend the `args` type with `model?: ModelId; effort?: EffortLevel;` (alongside `thoroughness?`), and after the existing `if (args.thoroughness) q.set("thoroughness", args.thoroughness);` add:
```ts
    if (args.model) q.set("model", args.model);
    if (args.effort) q.set("effort", args.effort);
```
2. Do the identical change in `streamPlan`.
3. Ensure `ModelId` and `EffortLevel` are imported at the top of `api.ts` (it already imports `EffortLevel`, `ModelId` from `./runTypes` — confirm both are in the import list, add any missing).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm typecheck:ui`
Expected: exit 0.

```bash
git add ui/src/modelDefaults.ts ui/src/api.ts test/unit/ui/modelDefaults.test.ts
git commit -m "feat(ui): API client sends per-phase model/effort; buildPhaseOverride helper"
```

---

## Task B3: DefaultsPanel on the landing

**Files:**
- Create: `ui/src/DefaultsPanel.tsx`
- Modify: `ui/src/App.tsx` (lift `defaults` state; render the panel in the landing `<main>`)
- Modify: `ui/src/styles.css` (`.card-defaults` grid slot)

> Controlled component (App owns the state, persists via `saveDefaults`). Manual-verify the panel.

- [ ] **Step 1: Create the component**

```tsx
// ui/src/DefaultsPanel.tsx
import { InfoBadge } from "./InfoBadge";
import { PhaseModelGrid } from "./PhaseModelGrid";
import {
  clampEffort,
  recommendedSelections,
  selectionSummary,
  type AgentPhase,
  type EffortChoice,
  type PhaseSelections,
} from "./modelConfig";
import type { ModelId } from "./runTypes";

/**
 * Landing-page editor for the global model/effort defaults. New runs inherit
 * these, and the preflight analyze/plan calls send them. Controlled — App owns
 * the state and persistence.
 */
export function DefaultsPanel({
  value,
  onChange,
}: {
  value: PhaseSelections;
  onChange: (next: PhaseSelections) => void;
}) {
  const setModel = (phase: AgentPhase, model: ModelId) =>
    onChange({ ...value, [phase]: { model, effort: clampEffort(model, value[phase].effort) } });
  const setEffort = (phase: AgentPhase, effort: EffortChoice) =>
    onChange({ ...value, [phase]: { ...value[phase], effort } });

  return (
    <section className="card card-defaults">
      <div className="card-head">
        <h2>Run defaults</h2>
        <span className="card-sub">{selectionSummary(value)}</span>
      </div>
      <p className="muted">
        New runs inherit these, and analysis you run below uses them.
        <InfoBadge label="About run defaults">
          These set the model + reasoning effort for each phase. A new run starts
          from them; you can still override per-decision at the dashboard gates
          (re-analyze / re-plan / run-confirmation).
        </InfoBadge>
      </p>
      <div className="field field-models">
        <PhaseModelGrid
          selections={value}
          onModelChange={setModel}
          onEffortChange={setEffort}
          onReset={() => onChange(recommendedSelections())}
        />
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Lift `defaults` state into `App` and render the panel**

In `ui/src/App.tsx`:

1. Add imports:
```tsx
import { DefaultsPanel } from "./DefaultsPanel";
import { loadDefaults, saveDefaults } from "./modelDefaults";
import type { PhaseSelections } from "./modelConfig";
```
2. Inside the `App` component, near the other `useState` calls, add:
```tsx
  const [defaults, setDefaults] = useState<PhaseSelections>(() => loadDefaults(window.localStorage));
  const updateDefaults = (next: PhaseSelections): void => {
    setDefaults(next);
    saveDefaults(next, window.localStorage);
  };
```
3. In the landing `<main>`, render the panel **above** the `card-discover` section (so defaults sit before the scanner):
```tsx
        <DefaultsPanel value={defaults} onChange={updateDefaults} />
```
Place this line immediately before `<section className="card card-discover">` (App.tsx ~line 629).

- [ ] **Step 3: Add the grid slot CSS**

In `ui/src/styles.css`, the landing grid currently defines `.card-auth` (col 1, rows 1-2), `.card-runs` (col 2, row 1), `.card-discover` (full width, row 3). Add `.card-defaults` at col 2, row 2 (the open slot), and include it in the mobile collapse. Find the `.card-discover { grid-column: 1 / span 2; grid-row: 3; }` rule and add **before** it:
```css
.card-defaults {
  grid-column: 2;
  grid-row: 2;
}
```
Then in the `@media (max-width: 820px)` block, add `.card-defaults` to the selector list alongside `.card-auth, .card-runs, .card-discover` so it also collapses to a single column.

- [ ] **Step 4: Typecheck + manual**

Run: `pnpm typecheck:ui`
Expected: exit 0.
Manual: `pnpm dev:ui` → home page shows a **Run defaults** card with the per-phase grid; changing a model persists across a page reload (it reads `localStorage`); the summary line updates.

- [ ] **Step 5: Commit**

```bash
git add ui/src/DefaultsPanel.tsx ui/src/App.tsx ui/src/styles.css
git commit -m "feat(ui): Run defaults panel on the landing (persisted model/effort)"
```

---

## Task B4: preflight + new runs inherit the defaults

**Files:**
- Modify: `ui/src/App.tsx` (`onAnalyze`, `onPlan` send the defaults' override)
- Modify: `ui/src/StartRunForm.tsx` (seed `phaseSelections` from `loadDefaults`)

- [ ] **Step 1: Send defaults from `onAnalyze` / `onPlan`**

In `ui/src/App.tsx`:

1. Add the import:
```tsx
import { buildPhaseOverride } from "./modelDefaults";
```
2. In `onAnalyze`, the `api.streamAnalyze({ ... })` argument object (App.tsx ~272) — add the analyze override. Change:
```tsx
      {
        repoPath: repo.path,
        mode: chosenMode,
        userNotes,
        iteration: iter,
        thoroughness,
      },
```
to:
```tsx
      {
        repoPath: repo.path,
        mode: chosenMode,
        userNotes,
        iteration: iter,
        thoroughness,
        ...buildPhaseOverride(defaults.analyze),
      },
```
3. In `onPlan`, make the identical change to the `api.streamPlan({ ... })` argument object (App.tsx ~339), using `buildPhaseOverride(defaults.plan)`.

- [ ] **Step 2: Seed the start form from defaults**

In `ui/src/StartRunForm.tsx`:

1. Add the import:
```tsx
import { loadDefaults } from "./modelDefaults";
```
2. Change the `phaseSelections` initializer (line ~36) from:
```tsx
  const [phaseSelections, setPhaseSelections] = useState<PhaseSelections>(recommendedSelections);
```
to:
```tsx
  const [phaseSelections, setPhaseSelections] = useState<PhaseSelections>(() =>
    loadDefaults(window.localStorage),
  );
```
`recommendedSelections` is still imported (used by the grid's reset) — leave that import.

- [ ] **Step 3: Typecheck + full suite**

Run: `pnpm typecheck:ui && pnpm typecheck && pnpm test`
Expected: both typechecks exit 0; all tests pass (prior + 2 new from B2).

- [ ] **Step 4: Manual verification**

`pnpm dev:ui`:
- Set the **analyze** default to Opus on the landing → analyze a repo in the Discover card → the run log / network shows the analyze stream carrying `model=claude-opus-4-8`.
- Open **New run** → the model summary reflects the landing defaults (not the hard-coded recommended set).

- [ ] **Step 5: Commit**

```bash
git add ui/src/App.tsx ui/src/StartRunForm.tsx
git commit -m "feat(ui): preflight analyze/plan + new runs inherit the landing defaults"
```

---

## Self-Review

**Spec coverage (2B portion):** #5-UI — defaults visible before scanning (B3), new runs inherit (B4 step 2), preflight sends them (B4 step 1, over the routes 2A enabled). ✓

**Placeholder scan:** none. Component code is complete; wiring steps show exact before/after. The one new behavioral helper (`buildPhaseOverride`) is TDD'd; the rest are typed wiring + manual verification (no jsdom to render components in).

**Type consistency:** `buildPhaseOverride(sel: PhaseSelection): { model: ModelId; effort?: EffortLevel }` matches the `streamAnalyze`/`streamPlan` arg additions (`model?: ModelId; effort?: EffortLevel`) and the server `AnalyzeQuery`/`PlanQuery` (`ModelIdSchema`/`EffortLevelSchema`) from 2A. `DefaultsPanel`'s `value`/`onChange` mirror App's `defaults`/`updateDefaults`. `PhaseModelGrid` is consumed identically by `StartRunForm` and `DefaultsPanel`.

**Non-breaking check:** The home `card-discover` scanner/analyze is untouched (removed only in 2C). Adding `.card-defaults` at col 2 / row 2 fills the previously-empty grid slot without moving `card-auth`/`card-runs`/`card-discover`.

**Risk note:** App.tsx is large; B3/B4 add a handful of lines (state + one render line + two arg spreads + imports) rather than restructuring it — the structural slim-down is deferred to 2C.
