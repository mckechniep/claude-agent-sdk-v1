# UI Information-Architecture Consolidation — Design

> **Status:** Approved (brainstorm complete) · **Date:** 2026-06-07 · **Branch target:** new worktree off `feat/v0.1-implementation`
> **Next step:** `superpowers:writing-plans` → task-by-task implementation plan.
> **Source feedback:** six live-test observations (#1–#6) captured during Phase F1.

## 1. Context & Problem

The web UI has **three hash routes** (`ui/src/Root.tsx`): `/` → `App` (home), `#new-run` → `StartRunForm`, `#run/:id` → `RunDashboard`. Two structural problems surfaced during live testing:

- **Scanning is implemented twice.** The home page's `card-discover` calls `api.streamDiscover` (App.tsx) *and* `StartRunForm` calls it independently — two scanners over the same directory.
- **Configuration is divorced from where work happens.** Analyze/Plan/Approve run on the home page's `card-discover`; per-phase model/effort lives only in `StartRunForm`'s Advanced section. So the analyze you run on the home page never uses the model config you set on the start form — they are disconnected surfaces.

Round-2 work ("decision locality") added per-gate model/effort **overrides** on `RunDashboard`. What's missing is **defaults visible up front**, and a single coherent flow.

This spec also folds in five smaller UX issues from the same session (mapped in §8).

## 2. Goals & Non-Goals

**Goals**
- Collapse to **one scanner** and one coherent flow.
- Make analyzing a repo and selecting it to run **independent actions** — the user is never forced to run a repo they analyzed.
- Surface **global model/effort defaults before scanning**, while keeping the shipped per-gate overrides.
- Give the analyze surfaces **real room** (resizable + maximizable); stop the "slit".
- Fix tooltip clipping, add the "submit answers & proceed" action, and add a per-repo local base-branch picker.

**Non-Goals**
- No change to the orchestration engine, run lifecycle, or gate semantics beyond what #2/#4 require.
- No per-repo model overrides (still run-wide; v0.2 backlog).
- No new runtime dependencies (no `floating-ui`, no resizable-panel library).
- No automated e2e/Playwright harness in this pass (optional follow-up only).

## 3. Decisions (brainstorm outcomes)

1. **Option A** — collapse the two scan surfaces; home becomes a dashboard + defaults.
2. **Unified + decoupled (B-flavored)** — one surface; analyze ≠ select-to-run. Analyzing never commits to a run.
3. **Lean landing (option 1)** — landing holds runs list + global defaults + auth + a "New run" button; the unified scan/analyze/select/launch surface is a separate route.
4. **Inline analyze** — repo rows expand in place; analyze several repos without leaving the list.
5. **Three-button proposal gate** — `↻ Submit & re-analyze`, `→ Submit answers & proceed` (new, #4), `Approve as-is`.
6. **Spacious surfaces (#3 is a hard requirement)** — questions / proposal / plan / answer box are resizable + maximizable.
7. **Build via Approach 1** — refactor in place, extract a shared analyze module; sub-choices: hand-rolled portal for the tooltip (#1), native CSS `resize` + maximize overlay (#3).
8. **One spec, everything; #2 (branch picker) sequenced last** so it is deferrable without re-speccing.

## 4. Architecture — three surfaces, one job each

**Landing — `/`** (today's `App`, slimmed to a dashboard)
- Runs list (open + finished; delete / clear-finished — already shipped).
- **Global model & effort defaults** (analyze / plan / execute) — visible and settable before anything else.
- Auth / key status.
- A single **"+ New run"** → unified surface.
- Removed: the `card-discover` scanner and `DiscoverReadout`.

**Unified run surface — `#new-run`** (today's `StartRunForm`, evolved)
- The **only** scanner.
- One repo list; each row = `select ☐` · name/stack · **state badge** (`not analyzed → proposal → plan ✓`) · **base-branch picker** · inline-expanding **Analyze**.
- Inline expansion = questions · resizable answer box · the three buttons · proposal/plan render.
- **"Run selected (N)"** acts only on ticked repos.
- Inherits the landing defaults.

**Run dashboard — `#run/:id`** (shape unchanged)
- Live phase progress; gates with model/effort **overrides** (shipped); execute stream; spend readout.

**Defaults chain (resolves #5 vs round-2):** landing defaults → run inherits (snapshot at launch) → gate overrides per-decision. Three layers of one setting; not a contradiction.

**Navigation:** landing → New run → unified surface → Run selected → run dashboard → back to landing.

## 5. Components & Module Structure (Approach 1)

The central move is breaking up the ~1700-line `App.tsx`. Logic is already separable from layout (analyze/plan flow runs through `api.ts` + a reducer), so extraction is mostly relocation, not rewrite.

**New — unified run surface** (`ui/src/runSurface/`)
- `RunSurface.tsx` — evolves from `StartRunForm`: the one scanner + repo list + "Run selected".
- `RepoRow.tsx` — one row: select checkbox, name/stack, state badge, base-branch picker, expand toggle.
- `AnalyzePanel.tsx` — inline expansion (questions, resizable answer box, proposal/plan render, three buttons). Extracted from `App.tsx`'s `DiscoverReadout`.
- `useAnalyzeFlow.ts` — hook: per-repo analyze/plan/approve handlers + SSE + iteration counters. Interface ≈ `{ state, analyze, reanalyze, proceedWithAnswers, approve, plan, approvePlan }`. Extracted from `App.tsx`'s `onAnalyze/onApprove/onPlan/onApprovePlan` + iteration state. **Analyze state becomes a per-repo map keyed by repo path** (today it is a single object — one repo at a time).

**Landing** (`App.tsx` slimmed → effectively `Landing.tsx`)
- Keeps: runs list + auth + "New run".
- Gains: `DefaultsPanel.tsx` — global model/effort defaults editor, built on the existing per-phase grid + `modelConfig.ts` helpers (`selectionSummary`, `buildModelMap`).
- Loses: `card-discover` + `DiscoverReadout` (moved to `runSurface/`).

**Shared primitives** (`ui/src/ui/`)
- `InfoBadge.tsx` — upgraded in place to a `document.body` **portal** (#1). Same prop signature → its ~6 call sites are untouched.
- `ResizablePanel.tsx` — native `resize: both` + a maximize overlay state (#3). Wraps questions / proposal / plan / answer box.

**Shared config** (`ui/src/modelConfig.ts`)
- `useModelDefaults()` — read/write global defaults to `localStorage`; fallback to recommended (`sonnet/sonnet/haiku`) when empty.

**Server**
- *(for #5)* Analyze **and plan** routes accept `model` (and `effort`) params, so the standalone preflight analyze/plan honor the landing defaults. Today they fall back to a server default — that is the disconnect behind #5; without this wiring the defaults would be cosmetic for preflight.
- *(for #4)* Analyze route/prompt — a `finalize` flag: one terminal pass that incorporates answers, asks nothing further; the UI then auto-approves.
- *(for #2, sequenced last)* `src/phases/discover.ts` adds `currentBranch` + `localBranches` (via `simpleGit().branchLocal()`); **each selected-repo entry in the start-run payload gains a per-repo `baseBranch`** (defaulting to `currentBranch`), validated server-side; the run calls `ensureBranch(repoPath, baseBranch)` before analyze, then branches `agent/*` off it.

## 6. Data Flow & State

**Defaults chain.** `DefaultsPanel` ↔ `useModelDefaults()` ↔ `localStorage`. `RunSurface` initializes its working config from defaults on mount. On "Run selected", config is **snapshotted into the manifest** (immutability — editing defaults later never mutates a started run; the orchestrator already resolves `modelFor(phase, manifest.config)`). Gate overrides patch `manifest.config` per-decision mid-run. The standalone **preflight** analyze/plan calls (which run before any run exists) also send the analyze/plan defaults, so defaults govern preflight too — not just the eventual run.

**Decoupled analyze vs select.** Analyze state = per-repo map keyed by path inside `useAnalyzeFlow` (each repo retains its own proposal/plan/iteration). Select state = independent `Set<repoPath>`. Source of truth across reloads = `.agent/` disk markers surfaced via the discover payload's `hasApprovedProposal` / `hasApprovedPlan`, which drive the state badge and survive refresh.

**Base-branch plumbing (#2).** `discover.ts` reports `currentBranch` + `localBranches` → `RepoRow` picker defaults to `currentBranch`, lists local branches only → chosen `baseBranch` travels per-repo in the `startRun` payload → run calls `ensureBranch` to check it out before analyze/execute.

**#4 "Submit answers & proceed" flow.** Answer-box notes + click → `POST` analyze with `finalize: true` + notes → server runs **one** pass (prompt: incorporate answers, ask nothing further, finalize) → writes proposal → auto-approves → UI flips the repo's badge to plan state and kicks plan generation. Contrast: `↻ Submit & re-analyze` posts without `finalize`; `Approve as-is` writes the approval with no new pass (and warns on unsaved answer text).

## 7. Error Handling & Edge Cases

**Data-loss / safety**
- **Dirty tree + base-branch switch.** `ensureBranch` does a real `git checkout`. If a repo `isDirty` and chosen base ≠ current, **refuse the auto-checkout** and surface inline ("commit/stash before switching base branch"). Clean tree → proceed.
- **Branch checkout failure** (branch deleted between scan and run, conflicts) → re-validate against `localBranches` at launch; on failure, fail that repo's run inline, don't crash the batch.
- **Unsaved answers on "Approve as-is"** → confirm-warn before discarding (fixes today's silent-drop).

**Behavioral**
- **One analyze in-flight at a time.** Other rows' Analyze buttons disabled with an "analyzing *X*…" hint while one streams.
- **Re-analyze / finalize invalidates downstream plan** via the existing `writeProposal` cascade (removes `plan.md` + `plan-approved.json` — backlog A3, done). The finalize path reuses it.
- **Reload mid-analyze.** In-flight state is in-memory → lost on refresh; the badge re-derives from disk. Re-viewing prior proposal markdown post-reload would need `GET /api/proposal|plan` (optional add, §9).
- **Selected repo with proposal-but-no-plan** → running it does the plan phase on the dashboard behind the gate; badge says "needs plan".

**UI primitives**
- **InfoBadge portal**: recompute position on scroll/resize, clean up on unmount, preserve keyboard focus + mobile pinned-click toggle.
- **Maximize overlay**: Escape-to-close + focus trap; respects `prefers-reduced-motion`; size optionally persisted per panel type.

**Empty / fallback**: no repos found, scan error, nothing selected (Run disabled), analyze error keeps the proposal visible (existing inline-error pattern), `useModelDefaults` fallback when `localStorage` empty.

## 8. Mapping to the six feedback items

| # | Feedback | Addressed by |
|---|----------|--------------|
| 1 | Tooltip clipped next to "balanced" | `InfoBadge` → `document.body` portal (§5) |
| 2 | Branch selection / picker (local only) | discover payload `currentBranch`+`localBranches`, `RepoRow` picker, `ensureBranch` (§5–7); **sequenced last** |
| 3 | Resize the discover/repo/analyze boxes | `ResizablePanel` (native resize + maximize) on all analyze surfaces (§5) |
| 4 | "Submit answers & proceed" third button | analyze `finalize` flag + the three-button gate (§5–6) |
| 5 | Settings visible before scanning | `DefaultsPanel` on the landing + defaults chain (§4, §6) |
| 6 | Confusing two-surface scan→run path | Option A unified IA (§4) |

## 9. Build Approach, Scope & Sequencing

**Approach 1 — refactor in place, extract `useAnalyzeFlow` first.** Sub-choices: hand-rolled portal (#1), native CSS resize + maximize overlay (#3). Implemented in a **git worktree** off `feat/v0.1-implementation` so the live dev server is never disturbed; one dev-server restart at the end.

**Build order (UI first, #2 last):**
1. `InfoBadge` portal (#1) — small, unblocks #3.
2. `ResizablePanel` primitive (#3).
3. `useAnalyzeFlow` extraction + per-repo state machine (+ tests, written first).
4. `useModelDefaults` + `DefaultsPanel` on the landing, **and wire the preflight analyze/plan calls to send those defaults** (#5).
5. `RunSurface` / `RepoRow` / `AnalyzePanel` — unified surface with decoupled select + three-button gate (#4, #6); delete the duplicate scanner.
6. Slim `App.tsx` → landing.
7. **#2 branch picker** — server discover payload + run config schema + `ensureBranch` wiring + `RepoRow` picker (last; deferrable).

**Optional follow-ups (not in scope unless requested):** `GET /api/proposal|plan` for post-reload markdown re-view; a lightweight Playwright smoke for landing → new run → launch.

## 10. Testing (TDD; keep all 298 green; 80%+ on new modules)

**UI unit** (`test/unit/ui/`): `useAnalyzeFlow` (per-repo isolation, reanalyze iteration, finalize→auto-approve→plan, approve-as-is, one-in-flight guard) — written first; `useModelDefaults` (read/write/fallback/snapshot); `RepoRow` badge derivation; base-branch picker (default, local-only, dirty warning); `InfoBadge` portal (target + behavior, not pixels); `ResizablePanel` (maximize/escape/persist).

**Server unit** (`test/unit/phases`, `test/unit/server`): `discover.ts` branch payload (mock `branchLocal`); per-repo `baseBranch` validation in the start-run payload; `ensureBranch` in run path + dirty-tree refusal (extend `git.test.ts`); analyze/plan routes accept + apply `model`/`effort` params; analyze `finalize` path (one pass, auto-approve, plan-invalidation).

**Prompt** (`test/prompts/`): analyze `finalize` mode asserts "incorporate answers, ask nothing further".

**Manual**: an F1-style pass (landing → new run → scan → analyze → select → launch) after build. Native drag-resize is not unit-tested (browser-owned); we test the logic we own + verify the rest manually.

## 11. References

- Visual mockups (this brainstorm): `.superpowers/brainstorm/2150100-1780876827/content/` — `current-ia`, `proposed-unified`, `inline-analyze`, `spacious-analyze`, `final-architecture`.
- Round-2 work this builds on: `docs/superpowers/plans/2026-06-02-gate-config-and-run-management.md`.
- Backlog items touched/related: `docs/BACKLOG.md` (per-repo model overrides; persist approvals across reload; mid-run model/effort switching).
