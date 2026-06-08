# Wrapper Orchestrator Integration — Implementation Plan

**Date drafted:** 2026-05-24
**Branch target:** `feat/v0.1-implementation` (continues v0.1)
**Estimated scope:** ~15 tasks across 6 phases (A-F), ~10-17 hours of focused work, likely 2-3 sessions.

## Goal

Bring the web wrapper (`pnpm dev:ui`) to feature parity with the CLI by wiring it into the `step()` state machine landed in commit `946508e`. After this work:

- A user can start a full multi-repo orchestration run from the browser at `localhost:5173`
- The UI streams live state updates from the JSONL run log, no polling
- All autonomy modes (`manual`/`batched`/`yolo`) work through the UI
- Paused runs are resumable from both the UI and the CLI
- The CLI's stub resume is replaced by a real implementation in the same work

## Why this work is now (not v0.2 as previously memo-ed)

The Style 2 reshape (commit `946508e`, 2026-05-22 decisions memo) was explicitly motivated by HTTP/serverless deployment: *"every request runs to completion, no in-stack pause."* The `step()` API was designed for an HTTP caller. The UI is that caller. Deferring this to v0.2 would leave the architectural prep without a consumer.

## Locked-in design decisions (from 2026-05-24 design conversation)

| Decision | Choice | Rationale |
|---|---|---|
| **Run lifecycle** | Hybrid — server-driven loop for batched/yolo, UI-driven step calls for manual | Honors autonomy modes' contracts; yolo is meaningless if UI loops manually |
| **State updates** | Log-tail event-sourced — UI subscribes to JSONL events, reduces to view-model | Producer side (`appendLogEvent`) already exists from Phase 1/8; durable replay on UI reload; lowest-latency UX |
| **Execute UX** | Compact task list + click-to-expand foreground panel | Matches Vercel/Linear patterns; supports parallel-task observation + per-task debugging |
| **Concurrency UI** | Grid of repo cards | Wide-screen-friendly; parallel-runs render naturally |
| **Start-a-run form** | Minimal + advanced disclosure, reads `.agentrc.json` defaults | Most users only need target+autonomy+tier; advanced for power use |
| **Resume scope** | Implement in BOTH UI and CLI in this work | Disk state is already resumable; ~30min extra to backfill CLI |

## Architecture

### Server routes (new in `src/server/routes.ts`)

```
POST /api/run/start
  body: { config: RunConfig, authMode: AuthMode }
  resp: { runId, manifest }
  side-effect: if autonomy ∈ {batched, yolo} → kick off background loop

POST /api/run/:id/step
  body: { decisions: StepDecisions }
  resp: { manifest }
  use:  primarily manual mode, also explicit advance from UI

POST /api/run/:id/decisions
  body: { proposals?: {[path]: ProposalAction}, plans?: {[path]: PlanAction}, runConfirmed?: boolean }
  resp: { manifest }
  side-effect: in batched/yolo, the background loop sees these and continues

GET  /api/run/:id/manifest
  resp: { manifest }

GET  /api/run/:id/log?fromByte=N
  resp: { events: LogEvent[], nextByte: N }   // replay

GET  /api/run/:id/log/stream?fromByte=N
  resp: SSE stream of `LogEvent` objects     // delta from offset

POST /api/run/:id/resume
  resp: { manifest }
  side-effect: re-enter the background loop on a paused manifest
```

### Background loop manager (new in `src/server/runLoop.ts`)

```ts
const activeLoops = new Map<string, AbortController>()

export function startBackgroundLoop(runId: string, params: StepParams): void
export function abortLoop(runId: string): void
export function isLoopActive(runId: string): boolean
```

Loop body: `while !aborted && manifest.status not in terminal → step(...) → persist → emit log event → loop`. Background loops do NOT auto-resume after a process restart — user must explicitly hit `POST /api/run/:id/resume`.

### UI architecture

- **New route**: `/runs/:id` — multi-repo run dashboard
- **New route**: `/runs/new` — start-a-run form
- **Existing home stays** as the landing page (auth + smoke + recent-runs list + "Start new run" CTA → `/runs/new`)
- **Event reducer** (`ui/src/runReducer.ts`): pure `(state, event) => state` mapping `LogEvent` shape into a `RunViewModel`
- **State management**: stays vanilla `useReducer` + `useState` for now (no new deps; revisit if reducer logic gets unwieldy)
- **Routing**: hash-based (`#/runs/:id`) for v0.1 — avoids adding `react-router` dependency, fine for single-user local tool. Revisit if more routes appear.

## Phases and tasks

### Phase A — Server step() exposure (3 tasks, ~2-3h)

**Task A1: Background loop helper module**
- Create `src/server/runLoop.ts` with `startBackgroundLoop`, `abortLoop`, `isLoopActive`
- Map-of-AbortControllers pattern; serialize step() calls per runId (no parallel step() on same run)
- Emit `runLoop.started`, `runLoop.paused`, `runLoop.completed`, `runLoop.aborted` events into the JSONL log
- Test: mock step() returning controlled status sequences, verify loop progression and pause behavior

**Task A2: Run lifecycle routes**
- Add to `routes.ts`: `handleStartRun`, `handleStepRun`, `handleSubmitDecisions`, `handleGetManifest`, `handleResumeRun`
- Wire request body validation via Zod (reuse existing `RunConfigSchema`, add new schemas for decisions)
- Apply existing auth-mode pattern (mutate `process.env.ANTHROPIC_API_KEY` per request, restore in finally)
- Test: route handlers with mocked `step()` and `runLoop`

**Task A3: Wire routes into server dispatch + integration smoke test**
- Register routes in `src/server/index.ts` request router
- Test via curl: start run with autonomy=manual, expect manifest with `status: "discovering"`; submit decisions; expect status advances

### Phase B — Log SSE replay + stream (2 tasks, ~1-2h)

**Task B1: Log replay endpoint**
- `GET /api/run/:id/log?fromByte=N` — open the JSONL file, seek to byte N, stream lines as JSON array
- Returns `{ events: LogEvent[], nextByte: number }` so client knows where to resume
- Handles file-not-found (404), seek-past-end (empty events, nextByte unchanged)
- Test: write a JSONL fixture, replay from byte 0 and from mid-file

**Task B2: Log SSE delta stream**
- `GET /api/run/:id/log/stream?fromByte=N` — replay from N, then watch file with `fs.watch` or polling; emit new lines as SSE events
- Handles file-doesn't-exist-yet (wait for creation), client disconnect (stop watching)
- Reuse `src/server/sse.ts` `openSseStream` helper
- Test: write events to a temp JSONL, subscribe, verify events arrive within 100ms

### Phase C — UI event reducer + API client (3 tasks, ~2-3h)

**Task C1: Define `LogEvent` shape + `RunViewModel`**
- Extend or formalize the `LogEvent` types from `state/runLog.ts` so server-emitted events match what the reducer consumes
- Define `RunViewModel = { runId, status, repos: RepoViewModel[], budget, currentRepoPath?, currentTaskId? }`
- Both types live in a shared `src/types.ts` section (already the pattern)

**Task C2: UI event reducer**
- `ui/src/runReducer.ts`: `(state: RunViewModel, event: LogEvent) => RunViewModel`
- Pattern match on `event.type`; update only the affected slice (immutable spread)
- Handle unknown event types gracefully (return state unchanged + console.warn)
- Test: feed a sequence of synthetic events, verify reducer output (vitest in `ui/`)

**Task C3: API client functions**
- Extend `ui/src/api.ts` with: `startRun`, `submitDecisions`, `stepRun`, `getManifest`, `getRunLog`, `streamRunLog`, `resumeRun`
- Typed responses using shared `RunViewModel` / `RunManifest` types
- `streamRunLog` returns an `EventSource` or async iterator; UI manages lifecycle

### Phase D — UI dashboard + screens (5 tasks, ~4-6h)

**Task D1: Hash-based routing in `App.tsx`**
- Listen on `hashchange` events; dispatch on hash path
- Routes: `/` (existing home), `#/runs/new`, `#/runs/:id`
- Existing home gets a "Recent runs" list + "Start new run" CTA

**Task D2: Start-a-run form (`#/runs/new`)**
- Read `.agentrc.json` from user-supplied target dir (or skip if missing) for defaults
- Visible inputs: target dir, autonomy mode, tier, concurrency, repo multiselect (calls `/api/discover/stream`)
- "Advanced settings" disclosure: all remaining `RunConfig` fields
- On submit: `POST /api/run/start`, navigate to `#/runs/:id` with returned runId

**Task D3: Run dashboard shell (`#/runs/:id`)**
- Open log stream on mount; replay then subscribe
- Header: run status, budget, autonomy mode, "Pause"/"Resume" button
- Body: grid of `<RepoCard />` per repo in the manifest
- Footer: live log tail (collapsed by default, expand to see raw events)

**Task D4: `RepoCard` component**
- Props: `repo: RepoViewModel`
- Shows: name, stack, current status (analyzing / awaiting-proposal / planning / awaiting-plan / executing-task-N / completed / failed / skipped)
- If awaiting-proposal-approval: inline "Review proposal" → opens existing analyze panel
- If awaiting-plan-approval: inline "Review plan" → opens existing plan panel
- If executing: shows compact task list with current task highlighted; click any task → foreground panel

**Task D5: `TaskForegroundPanel` component**
- Props: `task: TaskState`, `eventStream: AsyncIterable<LogEvent>`
- Renders live SDK output filtered to this task: model messages, tool calls, file writes, bash output
- Shows: tokens used, duration, attempt number, commit SHA when done
- On task completion, persists last view; user can click another task to switch

### Phase E — Resume backfill in CLI (1 task, ~30min)

**Task E1: Real resume in `src/commands/resume.ts`**
- Replace the stub. After identifying the target paused runId, call `step()` in a loop until manifest reaches a terminal state OR the next gate
- For gates, prompt via existing TUI primitives (`proposalGate`, `planGate`, `runConfirmation`)
- Exit codes match `runCommand`: 0=completed, 2=paused-again, 5=failed
- Test: not adding new tests; manual smoke against a fixture paused run

### Phase F — End-to-end validation + dashboard polish (3 tasks, ~3-4h)

**Task F1: Manual e2e against a small repo**
- Pick a tiny throwaway repo
- Start a run via UI, autonomy=manual, single repo, `--test-gate skip`
- Verify each phase progresses, decision gates surface in UI, execute streams live, completion summary renders
- Then test a yolo run with the same repo
- Then test resume: pause mid-execute, hit Resume, verify it continues

**Task F2: Dashboard layout — relocate "Raw events" into the status header card**
- The run-status / `DashboardHeader` card (status legend + `loop / liveness / budget /
  autonomy / tier` meta rows + Stop button) has a large block of vertical dead space
  beneath its content; the `LogTail` "Raw events" card sits separately lower down.
- Move `LogTail` to render underneath the status content + Stop button, inside the same
  card region — two stacked sub-sections of one card — so the dead space is used.
- Files: `DashboardHeader` + `LogTail` in `ui/src/RunDashboard.tsx`; adjust
  `.card-run-header` / `.card-log-tail` CSS so they read as one card. Mind the existing
  meta-row tooltips/InfoBadges. (See [[project_ui_backlog]].)

**Task F3: Make the budget/spend readout self-explanatory**
- Today the "Spend breakdown" popover (`SpendReadout` in `ui/src/RunDashboard.tsx`)
  stacks two unlabeled lists — a per-auth-mode split and a per-model split — that a
  user can read as contradictory (e.g. "api · 725,504 tok" and "claude-haiku · 725,504
  tok" look like two different totals when they're the SAME spend grouped two ways).
- Add clear section labels and a one-line legend so each number is unambiguous:
  - Header the auth list **"By billing mode"** and the model list **"By model"**, and
    state that **both groupings cover the same total run spend, just sliced differently**
    (auth rows sum to the total; model rows sum to the total).
  - Clarify the units: token counts are **cumulative for the whole run** (sum of
    input+output across every turn — fixed in `7cb8c9d`); the dollar figure is the
    **SDK-reported cost** ("billed" for api = real money, "≈ equiv" for subscription =
    notional, "no per-run charge" when $0).
  - Consider labeling the headline pill itself (e.g. `total tokens` / `billed`) so the
    collapsed view is also clear without opening the popover.
- Goal: a user glancing at the readout can tell exactly what each number reflects
  without needing this conversation. Pure labeling/copy + light layout — no math change.

## Open implementation questions

These don't block writing the plan but will need decisions during implementation:

1. **Per-task SDK output rendering — reuse or new?** The existing analyze/plan SSE panels render model messages and tool calls with row-fade-in motion. The `TaskForegroundPanel` should reuse that visual language. Refactor decision: extract a shared `<MessageCascade events={...} />` component or duplicate styling.

2. **Concurrency limit on background loops.** Server has no upper bound today. Should we cap at e.g. 5 concurrent runs to avoid resource exhaustion? Default: yes, soft cap with a config knob.

3. **UI dist size budget.** Currently 168kb JS / 52kb gz. New components + reducer likely add 30-50kb. Still well under the 300kb app-page budget from `~/.claude/rules/web/performance.md`. Note in commit if it crosses 200kb.

4. **AbortController on UI navigate-away.** If user closes the `/runs/:id` tab mid-yolo-run, what happens? Default: server continues, user can re-attach by reloading. Alternative: send `POST /api/run/:id/pause` on `beforeunload`. Default is friendlier for "kick it off then come back later" UX.

5. **Error UX for failed runs in UI.** What does a `RepoCard` with `status: "failed"` show? At minimum the failure reason; ideally a "View log" affordance and a "Retry" button. v0.1 scope: just show failure reason + commit SHAs of completed tasks; defer retry to v0.2.

## Commit cadence

One commit per task per Phase 9 convention. Atop current HEAD `7caf5ee`:

```
A1: feat(server): background loop helper for step() orchestration
A2: feat(server): run lifecycle routes (start/step/decisions/manifest/resume)
A3: chore(server): wire run lifecycle routes into dispatcher
B1: feat(server): log replay endpoint with byte-offset cursor
B2: feat(server): log SSE delta stream
C1: feat(types): LogEvent + RunViewModel shapes
C2: feat(ui): run event reducer with vitest coverage
C3: feat(ui): API client for run lifecycle endpoints
D1: feat(ui): hash-based routing + Recent runs panel
D2: feat(ui): start-a-run form with .agentrc.json defaults
D3: feat(ui): run dashboard shell with log replay/stream
D4: feat(ui): RepoCard component with embedded approval flows
D5: feat(ui): TaskForegroundPanel with live SDK message cascade
E1: feat(cli): real resume implementation; remove stub
F1: docs: end-to-end validation notes
```

## Acceptance criteria

- [ ] `pnpm dev:ui` starts both server and Vite as before
- [ ] User can start a run from `#/runs/new` against a real target dir
- [ ] Run dashboard updates in real-time without polling
- [ ] All three autonomy modes work end-to-end (manual, batched, yolo)
- [ ] Approval gates surface inline in repo cards; reuse existing analyze/plan UIs
- [ ] Per-task execute output streams live in foreground panel
- [ ] Paused runs can be resumed from UI
- [ ] Paused runs can be resumed from CLI (`agent resume <id>`)
- [ ] Existing CLI behavior unchanged (regression check: full `pnpm test` still green)
- [ ] No new failing tests; existing 107 still pass
- [ ] UI dist size stays under 250kb JS / 80kb gz

## What's still v0.2 after this

- Mid-task execute checkpoint resume (a task that died mid-edit still needs full-task restart; SDK-message-level checkpointing is too invasive for v0.1)
- Branch cleanup for stale `agent/*` branches when plan iteration mints new UUIDs
- Disk-side stale-plan invalidation cascade (when proposal is rewritten, automatically remove `plan-approved.json`)
- Per-task retry button in UI
- Multi-user / multi-session collision detection
- Hardening of `runTestCommand`'s shell-injection surface if we ever expose custom test commands via UI

## Next session entry point

After reading this plan, the natural starting task is **A1 (background loop helper)** — it's small, testable in isolation, and unblocks all of Phase A. The order A→B→C→D→E→F respects dependencies: server endpoints exist before UI consumes them; reducer exists before screens use it; resume backfill comes last because it depends on `/api/run/:id/resume` existing.

Implementation should follow the established subagent-driven pattern (implementer → spec-compliance review → code-quality review → commit per task) consistent with prior phases.
