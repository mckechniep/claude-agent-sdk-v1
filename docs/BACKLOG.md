# agent-orchestrator — deferred work & backlog

> Tracked roundup of everything intentionally deferred, parked, or noted-but-not-built.
> Compiled 2026-05-29 from project memory + in-repo plan/spec. Grouped by how soon it bites.
> Items are deferrals/ideas unless marked **DONE** or **(fixing)**.

## A. Pre-1.0 polish — do before declaring v0.1 "done"

UI/disk-state gaps that surface once you run → reload → resume. (Source: Phase 6 live testing.)

- [ ] **Persist approvals across page reload.** `approvedAt` lives only in React state; a browser refresh forgets a repo was approved. Disk markers (`proposal-approved.json`, `plan-approved.json`) already exist — hydrate on mount via `api.getApproval` / `getPlanApproval`. Needs new `GET /api/proposal?repoPath=…` + `GET /api/plan?repoPath=…` to re-read the markdown (today it only travels through the SSE `done` event).
- [ ] **Approval badges on RepoRow.** Show "✓ proposal approved / ✓ plan approved" next to the Analyze button so partial-pipeline repos are visible at a glance.
- [x] **Stale plan-approval after re-analyze. DONE 2026-05-29.** Re-analyzing left `plan-approved.json` + `plan.md` on disk built against the *previous* proposal → a resume could execute a stale plan. Fixed: `writeProposal` now `rm`s `plan.md` + `plan-approved.json` (idempotent), so a new proposal forces plan regeneration. (`src/state/repoState.ts`)

## B. v0.2 backlog — explicitly chosen NOT to ship in v0.1

- [ ] **`agent-orch list-models` CLI** — fetch/cache live model IDs from the Anthropic API instead of the hardcoded Zod enum (fixes "Anthropic adds/retires a model" brittleness). v0.1 fails loud on unknown IDs.
- [ ] **Per-phase configurable budget caps** — currently hardcoded (60s smoke / 10min analyze / 15min plan) in `routes.ts`; load from config.
- [ ] **Parallel preflight in `step()`** — analyze (and plan) run serially per-repo today → N×~10min for N repos. Style 2 should dispatch parallel analyze across all selected repos in one `step()`.
- [ ] **Batched-mode parallel plan generation** — batched does parallel analyze but serial plan/execute; restructure `advancePreflightOnce` to parallelize plan work after approvals land.
- [ ] **Branch cleanup** for stale `agent/*` branches when a task UUID changes between plan iterations.
- [ ] **Disk-side stale-plan invalidation cascade** — the general version of A3 (proposal rewrite → remove downstream plan artifacts), ideally centralized in the state layer.
- [ ] **Harden `runTestCommand`** — `spawn(cmd, { shell: true })` is injection-safe only because commands come from hardcoded stack profiles. Harden before exposing user-configurable test commands.
- [ ] **Mid-task execute resume** — a task that crashes mid-implementation can't resume from partial state (currently full-task restart; cheap-ish at Haiku rates).
- [ ] **`filesChanged` / `diff` persistence** — Zod strip-mode drops these from persisted state; add to `TaskStateSchema` if resumed runs need "what changed in the last task."
- [ ] **Per-run configurable cache TTL** — `cacheTtl: "5m" | "1h"` on RunConfig; default `1h` for `manual` so long human-review pauses don't evict the executor cache.
- [ ] **Prompt caching for analyze + plan phases** — currently executor-only; the re-analyze/re-plan iteration loop hits a cacheable hot path worth wiring (same `[universal, repoContext, BOUNDARY]` pattern).
- [ ] **Pending-decisions persistence** — the server's `pendingDecisions` Map is in-memory; lost on restart. v0.2: `runDir/pending-decisions.json`.
- [ ] **Background-loop concurrency cap** — no upper bound today; proposed soft cap ~5 with a config knob.
- [ ] **Multi-user / multi-session collision detection.**

## C. Architectural — captured, not committed

- [ ] **Run the execute phase in a Managed Agents self-hosted sandbox** with a scoped environment key (see `docs/notes/2026-05-29-managed-agents-vs-orchestrator.md`). Fixes the "org API key visible to `bash` tool calls" exposure; only worth it if this leaves single-operator localhost use.

## D. Known papercuts — fix anytime

- [ ] **`pnpm test:unit` / `test:integration` / `test:prompts` / `test:e2e` are broken** — `--dir test/unit` conflicts with the vitest `include` glob (resolves to `test/unit/test/**`). Use `pnpm test`. One-line `package.json` fix.

## E. Testing infrastructure — separate from Phase F

- [ ] **Automated integration harness** (old "Phase 10") — `test/integration/` + a `jsts-tiny` fixture running `runOrchestration()` end-to-end. Phase F is a *manual* validation pass; this is the repeatable/CI version.

## Done (recorded so they're not re-listed as open)

- Wrapper Phases A–E (UI drives full runs e2e; CLI resume wired to `step()`).
- Run lifecycle UX: stop / recover / retry-from-failure / explain. (Retry button was a v0.1 deferral — now shipped.)
- UI API-key entry with machine-bound encryption.
- Resume-aware confirmation gate.
- SDK-sourced cost tracking (per-model) + mixed-auth billing switch (UI + CLI, per-auth-mode attribution).

## Active milestone

**Phase F** (`docs/superpowers/plans/2026-05-24-wrapper-orchestrator-integration.md`):
- **F1** — manual e2e against a small repo (user-run).
- **F2** — dashboard: relocate "Raw events" card into the status header card to use the dead space.
- **F3** — make the budget/spend readout self-explanatory: label the breakdown "By billing mode" vs "By model" (same total, two slicings), clarify tokens are cumulative + cost is SDK-reported. Copy/labeling only.
