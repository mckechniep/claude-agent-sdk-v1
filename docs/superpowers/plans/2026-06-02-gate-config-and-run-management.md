# Gate-Time Configuration & Run Management Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. This is a follow-up to `2026-06-01-model-effort-selection.md` (complete, pushed at 52b7433).

**Goal:** Move model/effort decisions to where the user has context to make them (the dashboard gates), simplify the start form, and add run deletion to the runs list.

**Why:** The per-phase model settings live on the start form, but analyze/plan/execute happen on the dashboard — the user configures blind and never revisits. Decision locality: the proposal gate is where you know the analyzer needs more horsepower; the run-confirmation gate is where the execute cost decision is real. Plus: the runs list has zero management controls.

**Architecture:** `StepDecisions` (the existing gate-decision payload) gains an optional `configPatch: {model?, effort?}` — applied to `manifest.config` by `applyDecisionsToState` before the next phase runs. Since the orchestrator resolves models at phase-call time (`modelFor(phase, manifest.config)`), patched config takes effect naturally, including cost attribution. Run deletion = `DELETE /api/run/:id` removing the run directory (never repo `.agent/` state), refused while the run's loop is active.

**Scope note:** configPatch is run-wide (not per-repo) — "re-analyze with Opus" changes the run's analyze model. Per-repo model overrides are a v0.2+ schema change; UI wording must be honest about this.

---

## Tasks

### Task 15: Server — config patch via gate decisions
- `src/orchestrator/run.ts`: `StepDecisions` interface gains `configPatch?: { model?: Partial<RunConfig["model"]>; effort?: RunConfig["effort"] }`; `applyDecisionsToState` merges it immutably into `manifest.config` (model fields merged over existing; effort same) and persists.
- `src/server/runRoutes.ts`: `StepDecisionsSchema` gains a `configPatch` object validated with `ModelIdSchema`/`EffortLevelSchema` optionals; `mergePendingDecisions` must merge configPatch too (later patch wins per key).
- Tests (step.test.ts): (a) decisions with configPatch at awaiting-run-confirmation → manifest.config.model.execute updated AND executeFn receives the new model; (b) configPatch + proposals reanalyze → analyze model updated for the re-analysis. Tests (runRoutes.test.ts): route accepts valid configPatch, rejects bad model IDs (400).

### Task 16: Server — delete run route
- `src/server/runRoutes.ts`: `handleDeleteRun(runId, deps)` — invalid ULID → 400; `isLoopActive(runId)` → 409 with "stop the run first"; missing dir → 404; else `rm -rf` the run dir → 200 `{deleted: runId}`.
- `src/server/routes.ts` (or wherever the dispatcher lives): wire `DELETE /api/run/:id`.
- Tests: 409 when loop active, 404 when missing, 200 + dir gone on success, repo `.agent/` untouched.

### Task 17: UI — start form model grid behind Advanced
- `ui/src/StartRunForm.tsx`: move the `.field-models` block (3-row grid + reset button) from the main `setting-grid` into the `advancedOpen && (...)` section (top of it). In the main settings area add a one-line readout: `models: {summary} · customize under advanced` using a `summaryOf(phaseSelections)` helper built on `shortLabel`.
- `ui/src/modelConfig.ts`: add `selectionSummary(sel: PhaseSelections): string` (sonnet / sonnet / haiku collapsed form) + test.

### Task 18: UI — gate model/effort controls
- `ui/src/api.ts` + `ui/src/runTypes.ts`: `StepDecisions` mirror gains `configPatch`.
- `ui/src/RunDashboard.tsx`:
  - `RunConfirmationGate`: execute model + effort `<select>`s (defaults = manifest.config values); included as `configPatch` in the `submitDecisions(runId, {runConfirmed: true, configPatch})` call. Only sent when changed from current config.
  - Proposal-gate re-analyze action: model picker ("re-analyze using [model] — applies to this run's analyze phase"); sent as configPatch alongside `proposals: {path: "reanalyze"}`.
  - Plan-gate re-plan action: same pattern for the plan model.
- CSS: reuse `.field-input` / `.phase-model-row` styles.

### Task 19: UI — runs list delete/clear controls
- `ui/src/api.ts`: `deleteRun(runId)` calling `DELETE /api/run/:id`.
- `ui/src/App.tsx` (home page runs list): per-run "✕" button → inline confirm ("Delete run + its logs? Repo state is untouched.") → delete → refresh list. Disabled (with tooltip) for runs whose status is running/stopping. Plus a "Clear finished" button when ≥2 completed/failed runs exist.
- CSS: subtle danger styling consistent with existing buttons.

### Task 20: Final verification + push
- Full battery (root + UI), update BACKLOG.md (per-repo model overrides as v0.2 item), push.

## Review ceremony
Same as round 1: implementer → spec review → quality review per task; server tasks (15, 16) and UI tasks (17, 18, 19) may share combined reviews at their natural verification boundaries.
