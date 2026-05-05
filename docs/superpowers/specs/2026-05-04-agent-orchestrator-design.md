# Agent Orchestrator — Design Spec

**Status:** APPROVED — all 6 design sections approved by user. Ready for implementation planning.
**Date:** 2026-05-04
**Project root:** `/home/mckechniep/ai-llms/projects/claude-agent-sdk-v1`

## What this is

A single-machine CLI tool that walks a user through:

1. **Discovery** — scan a folder for git repos
2. **Selection** — multi-select TUI picker
3. **Analysis** — per-repo, agent reads README + code + TODOs and proposes "what completion looks like"
4. **Approval (proposal)** — user edits/confirms the completion proposal
5. **Planning** — agent drafts a concrete task plan against the approved proposal
6. **Approval (plan)** — user edits/confirms; orchestrator surfaces aggregate cost/time estimate
7. **Execution** — per-task: edit files → run tests → commit to `agent/<task>` branch → checkpoint
8. **Finalize** — write summary, close run log

Runs against either an Anthropic API key or a Pro/Max subscription via OAuth-fallback (chosen at startup, persisted to run manifest).

## Scope of v1

**In scope:**
- Local folder discovery (pluggable interface for GitHub later)
- Tier-1 stacks: JS/TS + Python (with specialized prompts and stack profiles)
- Tier-2 stacks: detected and processed via generic fallback prompt with "experimental" label
- Single-machine, single-user, terminal UI
- Run state persistence with atomic writes + append-only event log
- Resumable runs after crash, signal interrupt, or budget cap

**Not in v1:**
- Web UI
- GitHub repo source
- PR creation, push, merge
- MCP server integration
- Multi-user / cloud orchestration
- Daemon / background mode
- Shell completion
- Telemetry / analytics

---

## Locked-in design decisions

| # | Decision |
|---|---|
| Audience | Personal CLI for one user now, architected to ship to other devs later |
| Repo source | Local folders only in v1; pluggable interface so GitHub source slots in for v2 |
| Completion criteria | Agent proposes (`completion-proposal.md`), user edits/confirms before any planning |
| Trust model | Commit to `agent/<task>` branches only — no push, no PR, no merge |
| Test gate | Tests must pass to commit; configurable off per-repo when not feasible |
| Concurrency | Default 1; `--concurrency=N` flag; warn subscription users when N>1 (shared quota) |
| Approval cadence | Default stop after every task; `--checkpoint-every=N`; `--yolo` for full auto |
| Languages | JS/TS + Python tier-1 specialized prompts; other stacks detected → "experimental" generic prompt |
| Budget | Pre-flight estimate always on; `--max-tokens` + `--max-duration` hard caps; per-task spinning warning at 200k tokens |
| State | Central run-index (`~/.local/share/agent-orchestrator/runs/`) + per-repo gitignored `.agent/`; atomic writes; JSONL append-only run log |
| Failure handling | Default: retry once with feedback → skip repo; `--on-failure=stop\|skip-task\|skip-repo\|retry`; `--max-retries=N` (default 1) |
| Tools | Tiered per role: Analyzer = Read + read-only Bash, Planner = Read only, Executor = Read + Edit + Bash with curated install allowlist; no WebFetch in v1 |
| Auth | `--auth=api\|subscription` flag (or interactive prompt); persisted to run manifest so resume uses same mode |
| Architecture | Approach 2: orchestrator is plain TypeScript, SDK `query()` is a leaf primitive |

---

## §1 — High-level architecture

Single Node CLI. No daemon. Each invocation is a discrete process.

### Process model

```
┌──────────────────────────────────────────────────────────────────┐
│  $ agent <command> [flags]                                       │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  CLI entry (src/cli.ts)                                    │  │
│  │  - parses args, loads config, dispatches to commands       │  │
│  └────────────────────────────────────────────────────────────┘  │
│                            │                                     │
│  ┌─────────────────────────┴──────────────────────────────────┐  │
│  │  Orchestrator (src/orchestrator/run.ts)                    │  │
│  │  - state machine: discover → select → per-repo loop        │  │
│  │  - manages run-level state, budget, concurrency, approvals │  │
│  └─────────────────────────┬──────────────────────────────────┘  │
│                            │                                     │
│   ┌────────────┬───────────┼───────────┬────────────┐            │
│   ▼            ▼           ▼           ▼            ▼            │
│ Discovery  Analyzer    Planner     Executor    StateStore        │
│ (no LLM)   (query())   (query())   (query())   (file I/O)        │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

The SDK's `query()` is a leaf call. Each phase module calls `query()` with a focused prompt, scoped tool allowlist, and the relevant repo cwd. The orchestrator never holds an open `query()` connection across phases.

### Run lifecycle (happy path)

```
1. discover()       → list of candidate repos in target folder
2. select()         → user picks N repos (TUI multi-select)
3. preflightAll()   → analysis + planning for all repos, estimates total cost
4. confirmRun()     → user reviews aggregate plan + cost, approves
5. for repo in selected:
     5a. for task in repo.plan:
            execute(task)
            runTests(repo) if configured
            commit(task)
            checkpoint() if (taskIdx+1) % checkpointEvery == 0
     5b. mark repo done
6. finalize()       → write summary, close run log
```

Each step writes to the state store atomically. Resuming a killed run replays from the latest persisted state.

### Module structure (`src/`)

```
src/
├── cli.ts                      # entry, arg parsing, command dispatch
├── commands/                   # one file per CLI subcommand
│   ├── run.ts
│   ├── resume.ts
│   ├── status.ts
│   ├── runs.ts                 # list, show, abort, prune
│   ├── doctor.ts
│   └── init.ts
├── orchestrator/
│   ├── run.ts                  # main state machine
│   ├── phases.ts               # phase function dispatcher
│   ├── budget.ts               # token/duration tracking, cap enforcement
│   └── concurrency.ts          # worker pool (default size 1)
├── phases/
│   ├── discover.ts             # no LLM — fs scan + git detection
│   ├── analyze.ts              # query() → completion-proposal.md
│   ├── plan.ts                 # query() → plan.md
│   └── execute.ts              # query() per task with retry+test gate
├── tui/
│   ├── select.ts
│   ├── confirm.ts
│   ├── checkpoint.ts
│   └── render.ts
├── state/
│   ├── runIndex.ts             # central manifest CRUD
│   ├── repoState.ts            # per-repo .agent/ CRUD
│   ├── runLog.ts               # JSONL append-only event log
│   ├── atomicWrite.ts
│   └── migrations/             # schema version migrations
├── auth/mode.ts                # auth resolution + warnings
├── sdk/
│   ├── query.ts                # SDK wrapper
│   └── prompts/                # versioned prompt templates per phase + lang
│       ├── analyze.ts
│       ├── plan.ts
│       └── execute.ts
├── stack/
│   ├── detect.ts               # manifest-based stack detection
│   └── profiles/
│       ├── jsts.ts
│       ├── python.ts
│       └── generic.ts
├── lib/
│   ├── git.ts
│   ├── log.ts
│   └── env.ts
└── types.ts
```

Files target 100–300 lines each. Phase modules independently importable + testable.

---

## §2 — Component responsibilities

Each module documented as: *what it does / how it's used / what it depends on.*

- **Discovery (`phases/discover.ts`)** — recursive `fs` scan (depth-limited, default 2) for git repos; returns `{path, name, hasReadme, hasTests, lastCommitDate, stack, isDirty}`. Pure I/O, no LLM. Ignores `node_modules`, `.git`, `dist`, etc., respects `.agentignore`. Depends on `fs/promises`, `simple-git`, `stack/detect`.

- **Selection (`tui/select.ts`)** — multi-select TUI list with name/stack badge/last-commit/dirty flag. Returns selected paths. Library TBD between `@inquirer/prompts` and `clack`; locked in at implementation time based on prototyping.

- **Analyzer (`phases/analyze.ts`)** — `query()` with allowlist `[Read, RO-Bash]`. Reads README, scans tree, greps TODO/FIXME, infers completion. Outputs `<repo>/.agent/completion-proposal.md`. Returns `{proposalPath, tokensUsed, durationMs}`.

- **Approval gate — proposal (`tui/confirm.ts`)** — opens proposal in `$EDITOR`; `[a]ccept / [r]eject / re-analyze with notes`. Reject drops repo. Re-analyze captures notes to `<repo>/.agent/notes/`, loops back to analyzer.

- **Planner (`phases/plan.ts`)** — `query()` with allowlist `[Read]` only. Output: `plan.md` with parseable task list (frontmatter + numbered tasks + acceptance criteria, each with stable UUID). Returns `{planPath, taskCount, estimatedTokens, estimatedDuration}`.

- **Approval gate — plan (`tui/confirm.ts`)** — same shape as proposal. Also adjusts per-repo `testGate` if user opts out. After all repos planned, orchestrator shows aggregate run summary (total tasks, estimated tokens, projected cost or quota usage) for one run-level confirm.

- **Executor (`phases/execute.ts`)** — `query()` per task with `[Read, Edit, Bash-curated]`. After agent finishes its work, executor runs configured test command in plain TS, checks exit code, commits-or-bails. Agent's tool allowlist explicitly excludes `git commit` — orchestrator stages and commits, agent only edits files.

- **Approval gate — checkpoint (`tui/checkpoint.ts`)** — after each task (or every N): `[c]ontinue / [s]kip-task / [v]iew-diff / [e]dit-plan / [q]uit-run`. `[v]iew-diff` is non-state-changing — it shows the diff and loops back to the prompt without emitting a log event. The other four map directly to `LogEvent.checkpoint_resumed.action`. `--yolo` skips this gate entirely.

- **Orchestrator (`orchestrator/run.ts`)** — state machine; reads auth, drives per-repo loop, manages worker pool, enforces budget, handles failures, persists state on every transition. Pure function `(config, stateStore, sdkClient) → finalRunState` for testability.

- **State store** — `runIndex.ts` (manifest CRUD), `repoState.ts` (per-repo `.agent/` CRUD), `runLog.ts` (append-only JSONL). All full-doc writes via `atomicWrite.ts`. Zod-validated reads. Schema versioned with migration support in `state/migrations/`.

- **Auth (`auth/mode.ts`)** — resolves `--auth=` or interactive prompt; `api` mode requires `ANTHROPIC_API_KEY`; `subscription` mode `delete process.env.ANTHROPIC_API_KEY` to force OAuth fallback. Persists choice to manifest. Surfaces warnings (e.g., subscription + N>1) before run starts.

- **SDK wrapper (`sdk/query.ts`)** — wraps `query()`: injects auth, pre-binds tool allowlist, tracks tokens to `orchestrator/budget`, throws `BudgetCapped` on cap hit, returns normalized `{messages, tokensUsed, durationMs, finalText}`. **No other module imports from `@anthropic-ai/claude-agent-sdk` directly.**

- **Stack profiles (`stack/profiles/`)** — one file per stack: `{name, detect, testCommand, buildCommand, conventions}`. `conventions` feeds prompt templates. Adding a stack = one new file + registry entry.

### Bash command allowlist for executor

```
test runners:    pnpm test, npm test, yarn test, pytest, go test
build:           pnpm build, npm run build, tsc, python -m build
package install: pnpm add/install, npm install, pip install, uv add
git (read-only): git status, git diff, git log, git show
git (write):     git add  (NOT commit, NOT push, NOT reset --hard, NOT checkout main)
```

Anything outside the allowlist triggers a mid-run prompt: "agent wants to run `<cmd>`, allow this once / always / never?"

---

## §3 — Data flow

### Key types (`src/types.ts`)

```ts
interface RunManifest {
  runId: string;                      // ULID, time-sortable
  createdAt: string;                  // ISO 8601
  authMode: "api" | "subscription";
  config: RunConfig;
  repos: RepoEntry[];
  budget: BudgetState;
  status: "discovering" | "selecting" | "preflight" | "running" | "paused" | "completed" | "failed";
  schemaVersion: number;              // for migration
}

interface RunConfig {
  targetDir: string;
  concurrency: number;
  checkpointEvery: number;            // Infinity = --yolo
  onFailure: "stop" | "skip-task" | "skip-repo" | "retry";
  maxRetries: number;
  maxTokens?: number;
  maxDurationMs?: number;
  testGate: "required" | "skip" | "per-repo";
  testTimeoutMs: number;
  model: { default: string; analyze?: string; plan?: string; execute?: string };
  include?: string[];
  exclude?: string[];
}

interface RepoEntry {
  path: string;
  name: string;
  stack: "jsts" | "python" | "generic";
  status: "pending" | "analyzing" | "awaiting-proposal-approval"
        | "planning" | "awaiting-plan-approval" | "executing"
        | "completed" | "failed" | "skipped";
  proposalPath?: string;
  planPath?: string;
  taskState?: TaskState[];
  testGate: boolean;                  // resolved per-repo
}

interface TaskState {
  taskId: string;                     // UUID, stable across resumes and plan edits
  title: string;
  acceptanceCriteria: string[];
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  attempts: number;
  commitSha?: string;                 // SHA of the SUCCESSFUL commit only;
                                      // WIP retry commits exist on the branch
                                      // but are not recorded here
  tokensUsed: number;
  durationMs: number;
  testOutput?: string;
  failureReason?: string;
}

type PhaseName = "discover" | "analyze" | "plan" | "execute";

interface BudgetState {
  tokensUsed: number;
  startedAt: string;
  estimatedTotalTokens?: number;
  costUsd?: number;                   // API mode only
}

type LogEvent =
  | { ts: string; type: "run_started"; runId: string }
  | { ts: string; type: "phase_started"; repoPath: string; phase: PhaseName }
  | { ts: string; type: "phase_completed"; repoPath: string; phase: PhaseName; tokensUsed: number; durationMs: number }
  | { ts: string; type: "task_started"; repoPath: string; taskId: string }
  | { ts: string; type: "task_completed"; repoPath: string; taskId: string; commitSha: string; tokensUsed: number }
  | { ts: string; type: "task_failed"; repoPath: string; taskId: string; reason: string; willRetry: boolean }
  | { ts: string; type: "checkpoint_paused"; repoPath: string; afterTaskId: string }
  | { ts: string; type: "checkpoint_resumed"; repoPath: string; action: "continue" | "skip" | "edit" | "quit" }
  | { ts: string; type: "budget_warning"; reason: string; tokensUsed: number }
  | { ts: string; type: "budget_capped"; reason: string }
  | { ts: string; type: "run_finalized"; status: "completed" | "failed"; durationMs: number };
```

All persistent shapes Zod-validated on read. Schema mismatch → typed `StateCorruption` error → `agent doctor` repair path.

### Filesystem layout

```
~/.local/share/agent-orchestrator/runs/<run-id>/
  ├── manifest.json            # RunManifest, atomic-rewritten
  ├── run-log.jsonl            # append-only LogEvent stream
  ├── selected-repos.json      # snapshot at run start
  └── summary.md               # written on finalize

<each-selected-repo>/.agent/    # gitignored on first run
  ├── completion-proposal.md   # human-editable
  ├── plan.md                  # human-editable
  ├── state.json               # RepoEntry + TaskState[]
  └── notes/                   # re-analyze/re-plan user notes
      ├── 2026-05-04-analyze.md
      └── 2026-05-04-plan.md
```

### Cross-cutting flows

- **Budget tracking**: every `query()` increments `BudgetState.tokensUsed` via the SDK wrapper; cap exceeded → throw `BudgetCapped` → orchestrator catches → mark `paused` → exit code 2 (resumable).
- **Run log**: `runLog.append(event)` writes one JSON line per state-meaningful event. Source of truth for "what happened"; manifest is source of truth for "current state."
- **Resume**: `agent resume <id>` loads manifest, finds next non-terminal repo + next non-terminal task, re-enters state machine at that point. Skipped/failed honored. Log re-opened in append mode.
- **Stable task IDs**: TaskState IDs are UUIDs (not indices) so the user can edit `plan.md` mid-run — reorder/delete/add tasks — without breaking resume.
- **Atomic writes**: all full-document writes via `writeAtomic(path, data)` (write `.tmp.<pid>.<ts>` → rename). Append-only log uses `O_APPEND`. On startup, scan + delete stray `.tmp.*` files.

### Persisted vs transient

**Persisted:** decisions, plans, state transitions, commits, test outputs, summaries.
**Transient:** raw SDK message streams, TUI state, stack profile data, non-test bash output (debug-logged only).
**Rule:** persist decisions, not deliberations.

---

## §4 — Error handling & failure semantics

### Failure taxonomy

| Class | Trigger | Recoverable? | Default action |
|---|---|---|---|
| Test failure | Test command exits non-zero after agent's edits | Often | Retry once with test output as feedback |
| Agent error | SDK `query()` throws (rate limit, network, content policy, malformed tool call) | Sometimes | Retry once with error context; honor SDK `retry-after` if present |
| Budget cap | Token cap or duration cap exceeded mid-task | No (hard stop) | Persist partial state, mark run `paused`, exit 2 |
| User interrupt (SIGINT/SIGTERM) | Ctrl-C, terminal closed | No | Trap signal, finish current atomic write, mark `paused`, exit 130 |
| Hard crash (SIGKILL/OOM/panic) | Uncatchable | No | On next run, recover from on-disk state — atomic writes guarantee no torn files |

### Retry-with-feedback flow

When a task fails recoverably, the orchestrator builds an enriched prompt with:
- Original task instructions
- What the previous attempt did (modified files, ran tests)
- Truncated test/error output (4KB cap)
- Hint to consider that the structure may be right but logic wrong, or vice versa
- Explicit instruction: if the test itself seems wrong, say so and stop

The retry runs in the **same** `agent/<task-id>` branch — the failed work is preserved as a checkpoint commit (`agent: WIP attempt 1`) so the user can inspect it. The retry agent gets `Read` access to the previous attempt's diff.

After `--max-retries` exhausted (default 1, meaning 2 total attempts), fall through to the configured `--on-failure` action:
- `stop` → halt entire run, downstream repos marked not-attempted
- `skip-task` → mark task failed, advance to next task in same repo
- `skip-repo` (default) → mark repo failed, advance to next repo
- `retry` → loop indefinitely (warning emitted; intended for `--yolo` against throwaway repos)

### Run summary format

Final summary distinguishes outcomes:

```
Run 01HKQR3Z8M completed in 47m 12s
  ✓ projects/foo            12/12 tasks completed (commits on agent/foo-*)
  ⚠ projects/bar            8/14 tasks completed, 1 failed, 5 not-attempted
                            see .agent/state.json for details
  ⊘ projects/baz            skipped after analysis (user rejected proposal)
  ✗ projects/qux            failed during planning (model returned content-policy error)

Tokens: 1.84M / 2.5M cap   Cost (API): $11.42
```

Written to `<run-dir>/summary.md` and rendered in terminal. No silent drops.

### Crash recovery

**Crash mid-`query()`.** Agent's edits may be partially on disk in the working tree. On resume:
- If working tree dirty: `[d]iscard / [c]ommit-as-WIP / [k]eep-and-continue?`
- If clean: resume the task from scratch (idempotent)

**Crash mid-commit.** Git's commit operation is filesystem-atomic — either the new commit object exists with the new tree, or it doesn't. We either see it and advance, or don't and re-attempt.

**Crash mid-state-write.** Solved by `writeAtomic`. On resume: scan + delete stray `.tmp.<pid>.<ts>` files, load `manifest.json` and `state.json` cleanly.

**Reconciliation invariant:** on every resume, the orchestrator's first action after loading state is to walk per-repo branches and verify their tip commit matches the last `commitSha` in `TaskState`. Mismatch → repo state marked `corrupted` → user prompted to run `agent doctor`.

### `agent doctor` capabilities

- `agent doctor` — scans all runs, surfaces issues, no changes
- `agent doctor <run-id>` — deep inspection of one run
- `agent doctor <run-id> --repair` — interactive repair (per-issue choices)
- `agent doctor <run-id> --rebuild-from-log` — regenerate manifest + per-repo state from JSONL log (only possible because log is append-only and complete)

### Spinning task detection

Per-task token budget warning at 200k (configurable). When tripped:
1. Log `budget_warning` event with reason `"task_spinning"`
2. Soft prompt: *"Task `t3` has used 217k tokens — likely stuck. Force-fail this task? [y/N]"*
3. If yes → `TaskAbandoned` error → fall through to failure handling (no retry)
4. If no (or `--yolo`) → continue but bump warning threshold

### Edge cases

- **Test runner crashes/hangs.** Treated as test failure. Test command runs under `--test-timeout` (default 5min); timeout = test fail.
- **Agent makes no edits but claims success.** Detected by `git diff --quiet` after `query()`. Empty diff + claimed-complete = retry with feedback "you reported the task complete but no files changed."
- **Empty/missing commit message.** Orchestrator generates the message itself (in TS) — agent only stages files via `git add`. Removes a class of "agent forgot to commit" / "commit message is gibberish" failures.
- **User edits plan during checkpoint pause.** Reconciliation: re-parse `plan.md`, diff against stored `TaskState[]` by ID. New IDs → pending. Missing IDs → skipped. Existing IDs keep status.
- **Rate limit during run.** SDK throws with `retry-after`. Wrapper sleeps that long and retries once before propagating. Not counted toward `attempts`.
- **Disk full during state write.** `writeAtomic` fails at `writeFile(tmp, ...)` — caught, surfaced as fatal error, exit code 3. Previous good state intact.

---

## §5 — Testing strategy

### Test pyramid

```
                      ┌─────────────────────┐
                      │   E2E (cheap, few)  │   ~5 tests, real SDK, tiny repos
                      └─────────────────────┘
                  ┌────────────────────────────┐
                  │   Integration (medium)     │   ~20 tests, mocked SDK, real fs
                  └────────────────────────────┘
        ┌──────────────────────────────────────────────┐
        │   Unit (fast, many)                          │   ~150 tests, isolated
        └──────────────────────────────────────────────┘
```

**Framework:** Vitest. Coverage target: 80%, enforced in CI.

### Layer 1 — Unit tests

Per-module isolation, no real SDK calls, no real filesystem (use `memfs`). Each phase tested by mocking `sdk/query`:

```ts
test("analyzer writes proposal markdown to .agent/", async () => {
  const fakeQuery = vi.fn().mockResolvedValue({
    finalText: "# Completion Proposal\n\n...",
    tokensUsed: 12_400,
    durationMs: 8_200,
    messages: [],
  });
  const result = await analyze({
    repoPath: "/fake/repo",
    stackProfile: jstsProfile,
    deps: { query: fakeQuery, fs: memfs },
  });
  expect(fakeQuery).toHaveBeenCalledWith(expect.objectContaining({
    options: expect.objectContaining({
      allowedTools: ["Read", "Bash"],
      cwd: "/fake/repo",
    }),
  }));
  expect(memfs.existsSync("/fake/repo/.agent/completion-proposal.md")).toBe(true);
});
```

Coverage focus:
- **State store** — 100% branch coverage, including corruption simulation (kill `writeAtomic` between rename steps)
- **Orchestrator state machine** — every transition; failure cases include rejected proposal/plan, retry-then-success, retry-exhausted, budget-cap-mid-task, SIGINT-mid-task
- **Budget tracking** — accumulation across calls, cap throws `BudgetCapped`, partial-task tokens still counted
- **Failure handling** — every `--on-failure` × every failure class
- **Stack detection** — fixtures of manifest files
- **Git helpers** — uses `simple-git` against tmp-dir real git repos
- **CLI parser** — every flag, every conflict (e.g., `--yolo` + `--checkpoint-every` errors)

### Layer 2 — Integration tests

Real filesystem, real git, mocked SDK. Fixtures:

```
test/fixtures/repos/
├── jsts-tiny/              # minimal JS/TS repo with tests
├── jsts-no-tests/          # tests testGate=skip path
├── jsts-failing-tests/     # tests retry path (agent's edits break tests)
├── python-tiny/            # minimal poetry/uv project
├── unknown-stack/          # tests generic fallback
├── dirty-tree/             # uncommitted changes (tests dirty-flag handling)
└── empty/                  # just a .git, edge case
```

Each fixture committed verbatim into the repo (real `.git` and all). Tests `cp -r` to tmp dir per test.

Scenarios covered:
- Happy path single-repo
- Multi-repo with concurrency=1 and concurrency=2
- Test failure → retry succeeds
- Test failure → retry fails → skip-repo
- Budget cap mid-task → resume picks up at same task
- SIGINT → resume picks up at same task
- User edits plan mid-run (manually mutate `plan.md` between checkpoints)
- `agent doctor --rebuild-from-log` reconstructs manifest from JSONL

### Layer 3 — Prompt snapshot tests

Inline snapshots for prompts so prompt edits show up in PR diffs:

```ts
test("analyze prompt renders correctly for jsts repo", () => {
  const rendered = renderAnalyzePrompt({
    stackProfile: jstsProfile,
    repoSummary: { hasReadme: true, hasTests: true, fileCount: 47 },
  });
  expect(rendered).toMatchInlineSnapshot(/* committed inline */);
});
```

Prompt regressions are subtle (a single removed sentence can change agent behavior). Inline snapshots force the change to appear in the PR diff.

### Layer 4 — End-to-end tests

Real SDK calls against tiny purpose-built repos with Haiku 4.5. Gated behind `RUN_E2E=1`. Run on CI nightly + before release tags.

E2E set:
1. `e2e:analyze-jsts` — analyzer against 5-file fixture, assert proposal contains expected sections, token usage within bounds
2. `e2e:plan-from-proposal` — feed proposal to planner, assert plan parses into ≥2 tasks
3. `e2e:execute-tiny-task` — executor against a 1-line bug, assert: edit happened, tests pass, commit on `agent/<task>` branch
4. `e2e:retry-flow` — repo where obvious fix breaks a different test; assert retry with feedback
5. `e2e:auth-modes` — both `--auth=api` and `--auth=subscription` complete a trivial query (manual run before release)

Total CI cost <$1/week.

### What we don't test heavily

- TUI rendering (test inputs/outputs of TUI functions, not ANSI)
- Specific LLM output content (assert shape, not text)
- Network conditions (SDK's responsibility)

### CI shape

```yaml
- pnpm install
- pnpm typecheck
- pnpm lint
- pnpm test:unit          # ~5s, every push
- pnpm test:integration   # ~30s, every push
- pnpm test:prompts       # ~2s, every push
- pnpm test:e2e           # nightly + release tags only
- pnpm coverage:report    # fail < 80%
```

---

## §6 — CLI surface

### Command structure

```
agent <command> [flags] [args]

Commands:
  run                  Start a new orchestration run
  resume <run-id>      Resume a paused or crashed run
  status               Show status (in-repo or global)
  runs                 list / show / abort / prune
  doctor [run-id]      Inspect / repair state
  init [dir]           Bootstrap config + .agentignore in a directory
  --help, -h
  --version, -v
```

Binary name: `agent`. Library: `commander` (chosen for maturity); `clipanion` is a v1.5+ candidate if commander's help formatting proves too plain.

### `agent run` flag table

| Flag | Default | Description |
|---|---|---|
| `--target=<dir>` | `$PWD` | Directory to scan for repos |
| `--auth=<mode>` | prompt if interactive, else error | `api` or `subscription` |
| `--concurrency=<n>` | `1` | Parallel repos |
| `--checkpoint-every=<n>` | `1` | Pause for review every N tasks |
| `--yolo` | off | Equivalent to `--checkpoint-every=∞`; mutually exclusive with `--checkpoint-every` |
| `--max-tokens=<n>` | unset | Hard cap on total tokens |
| `--max-duration=<dur>` | unset | Hard cap on wall-clock (e.g. `2h`, `90m`) |
| `--on-failure=<mode>` | `skip-repo` | `stop\|skip-task\|skip-repo\|retry` |
| `--max-retries=<n>` | `1` | Retry attempts before failure handling |
| `--test-gate=<mode>` | `per-repo` | `required\|skip\|per-repo` |
| `--test-timeout=<dur>` | `5m` | Max time for a single test run |
| `--model=<id>` | `claude-sonnet-4-6` | Model used (override per-phase via config file) |
| `--include=<glob>` | none | Repeatable whitelist for discovery |
| `--exclude=<glob>` | none | Repeatable blacklist (merged with `.agentignore`) |
| `--non-interactive` | auto-detect | Force non-interactive (CI-friendly) |
| `--auto-approve-proposal` | off | Skip proposal approval gate (CI; emits warning at start) |
| `--auto-approve-plan` | off | Skip plan approval gate (CI; emits warning at start) |
| `--config=<path>` | `.agentrc.json` if present | Load config from file |
| `--no-color` | TTY-aware | Disable ANSI colors |
| `--log-level=<lvl>` | `info` | `debug\|info\|warn\|error\|silent` |
| `--dry-run` | off | Run discovery + analysis + planning, skip execution |

### `agent resume <run-id>`

Resumes a `paused` or interrupted run. Most flags persisted from original; overridable: `--auth` (only same mode), `--checkpoint-every`, `--yolo`, `--max-tokens` (raise only, lower would orphan in-progress work), `--max-duration` (raise only), `--on-failure`, `--non-interactive`.

If `<run-id>` omitted and exactly one paused run exists, resume that. If multiple, list and error.

### `agent status`

In-repo mode (with `.agent/` present):
```
Repo: foo
Last run: 01HKQR3Z8M (active, paused at checkpoint after task t7/t12)
Plan: .agent/plan.md (12 tasks, 7 completed, 1 failed, 4 pending)
Branches: agent/t1..t7 (7 commits ahead of main)
Resume: agent resume 01HKQR3Z8M
```

Global mode:
```
Active runs:
  01HKQR3Z8M  paused      3 repos     started 47m ago    1.2M / 2M tokens
Recent runs (last 5):
  01HKMR7B2C  completed   2 repos     2d ago             ✓ all tasks
```

### `agent runs <subcommand>`

```
agent runs list                   # all runs (active + historical)
agent runs show <run-id>          # detailed: per-repo, task table, log tail
agent runs abort <run-id>         # mark paused run as abandoned (state preserved)
agent runs prune --older-than=30d # delete run dirs older than N days (state only — not branches)
```

### `agent doctor`

```
agent doctor                          # scan all runs, no changes
agent doctor <run-id>                 # deep inspection
agent doctor <run-id> --repair        # interactive repair
agent doctor <run-id> --rebuild-from-log  # regenerate state from log
```

### `agent init [dir]`

Bootstrap a directory with `.agentrc.json` (commented starter) and `.agentignore` (`node_modules`, `.git`, `dist`, `__pycache__`, `target`, `vendor`, ...). Idempotent.

### Config file (`.agentrc.json`)

```json
{
  "$schema": "https://...",
  "auth": "subscription",
  "concurrency": 1,
  "checkpointEvery": 1,
  "onFailure": "skip-repo",
  "maxRetries": 1,
  "testGate": "per-repo",
  "testTimeout": "5m",
  "include": ["projects/*"],
  "exclude": ["projects/legacy-*", "experiments/**"],
  "model": {
    "default": "claude-sonnet-4-6",
    "analyze": "claude-haiku-4-5-20251001",
    "plan": "claude-sonnet-4-6",
    "execute": "claude-sonnet-4-6"
  },
  "stacks": {
    "jsts": { "testCommand": "pnpm test --run" },
    "python": { "testCommand": "pytest -x" }
  }
}
```

### Env var equivalents

Every flag has an `AGENT_*` env var:

```
AGENT_AUTH=api
AGENT_CONCURRENCY=2
AGENT_CHECKPOINT_EVERY=5
AGENT_ON_FAILURE=skip-repo
AGENT_MAX_TOKENS=2000000
AGENT_NON_INTERACTIVE=1
AGENT_LOG_LEVEL=debug
```

### Precedence (highest wins)

1. CLI flags
2. Env vars (`AGENT_*`)
3. Config file (`.agentrc.json`)
4. Built-in defaults

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Run completed (all repos completed or skipped-by-user) |
| 1 | Unhandled error (bug; prints stack + run-id) |
| 2 | Run paused — resumable |
| 3 | Fatal state error (corrupt manifest, disk full, schema mismatch) |
| 4 | Configuration error (invalid flag combo, missing API key in api mode) |
| 5 | All repos failed |
| 130 | SIGINT — state persisted, resumable |

### Interactive vs non-interactive

Auto-detect via `process.stdout.isTTY && process.stdin.isTTY`. Override with `--non-interactive`.

When non-interactive:
- Approval gates error unless preempted by `--auto-approve-proposal`/`--auto-approve-plan`
- `$EDITOR` invocations skipped (proposals/plans accepted as-is)
- Checkpoint pauses skipped (`--yolo` recommended for clarity)
- `--auth` must be specified (no prompt fallback)

### Versioning

`agent --version` shows: package version, SDK version, Node version, OS, run-state-schema version. Migrations live in `src/state/migrations/<from>-to-<to>.ts`; `agent doctor` performs migrations on first read of an older schema.

---

## Decisions deferred to implementation

These are flagged so the implementation plan addresses them rather than re-deciding mid-build:

- **TUI library**: `@inquirer/prompts` vs `clack`. Both mature; pick during prototyping based on multi-select ergonomics and color/style fit.
- **JSON Schema URL for `.agentrc.json`**: needs a stable URL once we publish the schema. Likely `https://github.com/<owner>/<repo>/raw/main/schema/agentrc.schema.json` — final URL set when repo is created.
- **Initial CLI binary distribution**: `npm install -g` vs `npx`-friendly bin field vs Bun-compiled binary. Decide during packaging step.

These are deliberate gaps, not oversights. None of them affect the architecture above.

---

## Next step

Invoke `superpowers:writing-plans` to draft the implementation plan from this spec.
