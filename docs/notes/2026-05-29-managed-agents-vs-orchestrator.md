# Managed Agents (self-hosted sandboxes) vs. agent-orchestrator

> Analysis note, 2026-05-29. Compares Anthropic's **Managed Agents → Self-hosted
> sandboxes → "Always-on (SDK)"** offering against this project's architecture,
> and identifies one concrete convergence opportunity for v0.2+.
>
> Source: https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes
> (beta header `managed-agents-2026-04-01`).

## TL;DR

They look like the same category ("run long-lived agent sessions with lifecycle
control") but are **architectural mirror images**. The difference is *who owns
the agent loop*:

- **Managed Agents:** Anthropic owns the orchestration (the reasoning/agent
  loop). You own only a **worker** that executes tool calls (`bash`, `read`,
  `write`, `edit`, `glob`, `grep`) inside infra you control.
- **agent-orchestrator:** *We* own the orchestration (the
  discover → analyze → plan → execute state machine, prompts, budget, gating).
  The SDK's `query()` is a leaf primitive we call per phase.

They are **complementary, not competitive**.

## The core inversion: who owns the agent loop

| | Anthropic Managed Agents (self-hosted sandbox) | agent-orchestrator |
|---|---|---|
| Runs the reasoning/agent loop | Anthropic's servers | Our code (`step()` in `src/orchestrator/run.ts`) |
| What you own | A worker that executes tool calls in your infra | The entire workflow + prompts + budget + gating |
| What Anthropic owns | The brain: which tools to call, when, the conversation | Nothing — `query()` is a per-phase sub-routine |
| Direction of control | Inversion of control: Anthropic enqueues, your worker claims | We drive every phase transition |
| Tool execution | Anthropic-defined toolset run locally by your worker | Phase-scoped allowlists (e.g. executor = `Read,Write,Edit,Bash`) |

This is the "Approach 2" decision locked early in the project: the orchestrator
is plain TypeScript driving a state machine; the SDK is called per-phase with
focused prompts and scoped allowlists. Managed Agents puts the orchestration
boundary in the exact opposite place.

## The uncanny part: the work-queue plumbing is nearly identical

Despite the inversion, the **lifecycle primitives** Anthropic describes map
almost 1:1 onto what landed in Phase A. We independently converged on the same
shape — a poller, claimable work items, AbortController-based stop, crash
reclaim, a stats surface. The only real difference is *what's inside a work
item*: for them it's "run this tool call"; for us it's "advance this multi-repo
run by one phase."

| Anthropic concept | Our equivalent |
|---|---|
| `EnvironmentWorker.run()` — polls continuously ("Always-on SDK") | `startBackgroundLoop` in `src/server/runLoop.ts` (batched/yolo) |
| `.handle_item()` — claim one, handle, exit | A single `step()` call (UI-driven manual mode) |
| Webhook-triggered variant — wake on `session.status_run_started`, then poll | `submitDecisions` auto-restarting a dormant loop (`e163236`) |
| `work.stop` (graceful, or `force: true`) | `POST /api/run/:id/stop` (drain in-flight vs immediate) |
| `work.stats` → `depth`, `pending`, `workers_polling` | `activeLoopCount` / `isLoopActive` + concurrency cap |
| `reclaim_older_than_ms` — re-claim work from a dead worker | `sweepCrashedRuns` on startup + heartbeat recovery |
| `/workspace`, `/mnt/session/outputs` | `.agent/` per-repo dirs + `~/.local/share/agent-orchestrator/runs/` |
| Skills downloaded to `/workspace/skills/<name>/` | No equivalent — we use per-phase prompts, not Skills |

### SDK helper layering (for reference)

Anthropic's SDK exposes three levels, useful as a vocabulary check against ours:

- `EnvironmentWorker` — out-of-the-box worker; polling + setup + execution end to
  end. (≈ our `startBackgroundLoop` + `step()` wiring.)
- `work.poller()` — claims sessions, hands you each one so you decide what
  happens per session (e.g. launch a container). (≈ our dispatcher deciding to
  spawn/advance a run.)
- `tool_runner()` / `AgentToolContext` + `beta_agent_toolset_20260401(env)` —
  the execution layer for a single session's tool calls. (No clean analogue — we
  don't expose a generic toolset; each phase hard-codes its allowlist.)

## Auth: the most instructive contrast (ties to keyStore.ts)

Anthropic deliberately uses **two different credentials**:

- **Environment key** (`sk-ant-oat01-…`, an OAuth token) — scoped to the
  environment, safe to place on the worker host / inside the sandbox.
- **Org API key** (`sk-ant-…`) — and the docs explicitly **warn**: *"Setting
  `ANTHROPIC_API_KEY` on the worker host exposes an organization-scoped
  credential to agent tool calls."* Monitoring/ops calls (`work.stats`,
  `work.stop`) use the org key and are meant to run **outside** the worker host.

That warning describes the exact shape of our **executor**: we run Claude with
`Bash`/`Write`/`Edit` against the user's repos, with `ANTHROPIC_API_KEY` in
`process.env` on the same host. A `bash` tool call could in principle
`echo $ANTHROPIC_API_KEY`.

We sidestep this via **trust scope, not isolation**: agent-orchestrator is a
personal localhost tool where the operator is the only principal, so the agent
reading the operator's own key is a non-event. This is the same honesty applied
to `src/auth/keyStore.ts` (machine-bound encryption protects the file if it
leaks *off* the box, not against local processes running as the same user).

**If this tool ever became multi-tenant or ran others' repos**, Anthropic's
scoped-token model is the pattern to adopt: a per-run capability token, not the
raw org key in `env`.

## What each solves that the other doesn't

**Managed Agents provides (we don't):**
- A production-grade, Anthropic-maintained agent loop — no orchestration to write or tune.
- A work queue with horizontal scaling (scale on `depth`, liveness via `workers_polling`).
- Compliance posture — ZDR / HIPAA BAA eligibility; data-stays-in-network as a first-class property.
- Per-session container isolation patterns (Cloudflare / Daytona / Modal / Vercel guides).

**agent-orchestrator provides (Managed Agents doesn't):**
- A domain-specific multi-repo workflow: discover → analyze → plan → execute with
  per-repo gating, completion proposals, and iteration loops. Managed Agents has
  no concept of "your local repos" or "approve this plan before executing."
- Human-in-the-loop approval gates at proposal and plan stages (manual/batched/yolo).
- Subscription-mode auth (Pro/Max OAuth). Managed Agents is API-key /
  environment-key only — no Pro/Max plan billing.
- A purpose-built UI for the workflow (RepoCards, foreground panels, the auth card).
- Durable run state: JSONL event log + manifest persistence + crash recovery.
  Note: **Memory is not yet supported with self-hosted sandboxes**, so this is
  something they currently lack here.

## Convergence opportunity (v0.2+, not now)

Keep our discover → analyze → plan state machine as the orchestrator, but swap
the **execute** phase's `query()` call for a Managed Agents *session* targeting a
**self-hosted environment**. The code-editing agent would then run in an
isolated per-repo container with a **scoped environment key**, while our state
machine still owns the workflow and gating.

Why it's attractive:
- Directly fixes the "org key visible to `bash` tool calls" exposure for the
  highest-risk phase (executor), without changing analyze/plan.
- Adds real per-run sandbox isolation (fresh FS, resource limits, network policy)
  that we don't have today.

Why it's not now:
- Beta surface (`managed-agents-2026-04-01`); API-key/environment-key only (loses
  subscription-mode billing for that phase).
- Requires standing up a worker + environment + per-session container spawner —
  meaningful infra for a personal tool.
- No Memory support yet in self-hosted sandboxes.

**Status:** idea captured for v0.2 planning. No action in v0.1. Revisit if/when
the tool moves beyond single-operator localhost use, or if executor sandbox
isolation becomes a requirement.

## Related

- Project memory: `[[project_agent_orchestrator]]`, `[[plan_wrapper_orchestrator_integration]]`
- Auth honesty / threat model: `src/auth/keyStore.ts` module doc comment
- MCP tunnels (orthogonal: controls *how Anthropic reaches your MCP servers*, not where code runs)
