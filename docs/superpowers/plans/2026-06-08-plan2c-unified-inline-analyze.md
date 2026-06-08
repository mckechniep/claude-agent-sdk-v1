# Plan 2C — Unified Inline-Analyze Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the two scan surfaces into one. Move the existing inline-analyze machine (currently on the home page) into the run surface so each repo can be analyzed inline AND independently selected to run; add the third "Submit answers & proceed" (finalize) button (#4-UI); make the analyze/proposal/plan surfaces resizable (#3 wired); and delete the home scanner so the landing is purely runs + defaults + auth + "New run" (#6).

**Architecture:** The analyze/plan state machine (`reduceAnalyze`/`reducePlan`, today pure functions in `App.tsx`) is lifted into `ui/src/analyze/` and **keyed by repoPath** so each repo retains its own proposal/plan (today a single-object state allows only one repo at a time). A `useAnalyzeFlow` hook wraps the keyed reducer + the API calls (including `finalize` + `buildPhaseOverride(defaults)`). The panel components move onto the run surface (`StartRunForm` → the unified surface), wrap their `<pre>` bodies in the `ResizablePanel` primitive from Plan 1, and gain the finalize button. Finally the home `card-discover`/`DiscoverReadout` is removed. Plan 2C of 4 for spec `docs/superpowers/specs/2026-06-07-ui-ia-consolidation-design.md` (2D = branch picker, last).

**Tech Stack:** React + TypeScript (Vite). UI typecheck = `pnpm typecheck:ui`; full suite = `pnpm test`. Tests are logic-only (node env) — only the keyed reducer (C1) is unit-tested; the hook + components are verified manually.

**Source map (from code exploration):**
- `AnalyzeState`/`PlanState`/`MessageEntry` types: `App.tsx:58-163`
- `reduceAnalyze`: `App.tsx:1578-1629`; `reducePlan`: `App.tsx:1522-1576`
- `DiscoverReadout`: `App.tsx:943-1049`; `RepoRow`: `1051-1140`; `AnalyzePanel`: `1142-1335`; `PlanPanel`: `1337-1520`; `IterationControl`: `1672-1741`; `IterationBanner`: `1631-1670`
- handlers: `onAnalyze:261-297`, `onApprove:299-324`, `onCloseAnalyze:326-333`, `onPlan:335-365`, `onApprovePlan:367-392`
- proposal markdown is raw `<pre className="proposal-body">{analyze.proposalMarkdown}</pre>` (no markdown lib)

---

## Task C1: extract types + a per-repo keyed analyze reducer (the keystone)

**Files:**
- Create: `ui/src/analyze/types.ts`
- Create: `ui/src/analyze/reducer.ts`
- Test: `test/unit/ui/analyzeReducer.test.ts`

> This is the only unit-tested task. It re-homes the state types and re-expresses the two reducers as a single repo-keyed reducer, so the multi-repo state machine is proven before any UI moves.

- [ ] **Step 1: Create the types module**

```ts
// ui/src/analyze/types.ts
import type { Thoroughness } from "../api";

export interface MessageEntry {
  id: number;
  subtype: string;
  summary: string;
  ts: number;
}

export type AnalyzeState =
  | { phase: "idle" }
  | { phase: "running"; repoPath: string; repoName: string; elapsedMs: number; messages: MessageEntry[]; previousNotes?: string }
  | {
      phase: "done";
      repoPath: string;
      repoName: string;
      messages: MessageEntry[];
      proposalPath: string;
      proposalMarkdown: string;
      tokensUsed: number;
      durationMs: number;
      approvedAt: string | null;
      previousNotes?: string;
    }
  | { phase: "error"; repoPath: string; repoName: string; message: string; messages: MessageEntry[] };

export type PlanState =
  | { phase: "idle" }
  | { phase: "running"; repoPath: string; repoName: string; elapsedMs: number; messages: MessageEntry[]; previousNotes?: string }
  | {
      phase: "done";
      repoPath: string;
      repoName: string;
      messages: MessageEntry[];
      planPath: string;
      planMarkdown: string;
      taskCount: number;
      estimatedTokens: number;
      estimatedDurationMs: number;
      tokensUsed: number;
      durationMs: number;
      approvedAt: string | null;
      previousNotes?: string;
    }
  | { phase: "error"; repoPath: string; repoName: string; message: string; messages: MessageEntry[] };

/** Per-repo analyze+plan bundle. The unified surface keeps one of these per
 *  repoPath so analyzing repo B never discards repo A's proposal. */
export interface RepoFlow {
  analyze: AnalyzeState;
  plan: PlanState;
  analyzeIteration: number;
  planIteration: number;
  thoroughness: Thoroughness;
}

export function emptyRepoFlow(): RepoFlow {
  return { analyze: { phase: "idle" }, plan: { phase: "idle" }, analyzeIteration: 1, planIteration: 1, thoroughness: "balanced" };
}
```

- [ ] **Step 2: Write the failing test**

```ts
// test/unit/ui/analyzeReducer.test.ts
import { describe, expect, it } from "vitest";
import { flowReducer, type FlowState } from "../../../ui/src/analyze/reducer";
import { emptyRepoFlow } from "../../../ui/src/analyze/types";

const A = "/r/a";
const B = "/r/b";

function withRepo(path: string): FlowState {
  return { [path]: emptyRepoFlow() };
}

describe("flowReducer", () => {
  it("starts analyze for a repo, stamping notes + bumping iteration", () => {
    const next = flowReducer(withRepo(A), {
      type: "analyze-start",
      repoPath: A,
      repoName: "a",
      iteration: 2,
      userNotes: "use webhooks",
    });
    expect(next[A].analyze).toMatchObject({ phase: "running", repoPath: A, previousNotes: "use webhooks" });
    expect(next[A].analyzeIteration).toBe(2);
    expect(next[A].plan).toEqual({ phase: "idle" }); // re-analyze invalidates plan
  });

  it("keeps repos isolated — analyzing B does not touch A's state", () => {
    let s: FlowState = { [A]: emptyRepoFlow(), [B]: emptyRepoFlow() };
    s = flowReducer(s, { type: "analyze-start", repoPath: A, repoName: "a", iteration: 1 });
    s = flowReducer(s, {
      type: "analyze-event",
      repoPath: A,
      repoName: "a",
      event: { type: "done", ok: true, proposalPath: "/p", proposalMarkdown: "# prop", tokensUsed: 5, durationMs: 9 },
    });
    s = flowReducer(s, { type: "analyze-start", repoPath: B, repoName: "b", iteration: 1 });
    expect(s[A].analyze.phase).toBe("done"); // A preserved
    expect(s[B].analyze.phase).toBe("running");
  });

  it("appends sdk messages with incrementing ids during a run", () => {
    let s = flowReducer(withRepo(A), { type: "analyze-start", repoPath: A, repoName: "a", iteration: 1 });
    s = flowReducer(s, { type: "analyze-event", repoPath: A, repoName: "a", event: { type: "sdk_message", subtype: "tool", summary: "read", ts: 1 } });
    s = flowReducer(s, { type: "analyze-event", repoPath: A, repoName: "a", event: { type: "sdk_message", subtype: "tool", summary: "grep", ts: 2 } });
    const a = s[A].analyze;
    expect(a.phase).toBe("running");
    if (a.phase === "running") {
      expect(a.messages.map((m) => m.id)).toEqual([0, 1]);
      expect(a.messages.map((m) => m.summary)).toEqual(["read", "grep"]);
    }
  });

  it("marks the proposal approved", () => {
    let s = flowReducer(withRepo(A), { type: "analyze-start", repoPath: A, repoName: "a", iteration: 1 });
    s = flowReducer(s, { type: "analyze-event", repoPath: A, repoName: "a", event: { type: "done", ok: true, proposalPath: "/p", proposalMarkdown: "x", tokensUsed: 1, durationMs: 1 } });
    s = flowReducer(s, { type: "approve-proposal", repoPath: A, at: "2026-06-08T00:00:00Z" });
    const a = s[A].analyze;
    expect(a.phase === "done" && a.approvedAt).toBe("2026-06-08T00:00:00Z");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm exec vitest run test/unit/ui/analyzeReducer.test.ts`
Expected: FAIL — cannot resolve `../../../ui/src/analyze/reducer`.

- [ ] **Step 4: Implement the reducer**

```ts
// ui/src/analyze/reducer.ts
import type { AnalyzeEvent, PlanEvent } from "../api";
import { emptyRepoFlow, type AnalyzeState, type MessageEntry, type PlanState, type RepoFlow } from "./types";

export type FlowState = Record<string, RepoFlow>;

export type FlowAction =
  | { type: "analyze-start"; repoPath: string; repoName: string; iteration: number; userNotes?: string }
  | { type: "analyze-event"; repoPath: string; repoName: string; event: AnalyzeEvent }
  | { type: "approve-proposal"; repoPath: string; at: string }
  | { type: "plan-start"; repoPath: string; repoName: string; iteration: number; userNotes?: string }
  | { type: "plan-event"; repoPath: string; repoName: string; event: PlanEvent }
  | { type: "approve-plan"; repoPath: string; at: string }
  | { type: "close"; repoPath: string };

function msg(messages: MessageEntry[], subtype: string, summary: string, ts: number): MessageEntry[] {
  return [...messages, { id: messages.length, subtype, summary, ts }];
}

function reduceAnalyze(prev: AnalyzeState, event: AnalyzeEvent, repoName: string): AnalyzeState {
  switch (event.type) {
    case "started":
      return { phase: "running", repoPath: event.repoPath, repoName: event.repoName, elapsedMs: 0, messages: [] };
    case "progress":
      return prev.phase === "running" ? { ...prev, elapsedMs: event.durationMs } : prev;
    case "sdk_message":
      return prev.phase === "running" ? { ...prev, messages: msg(prev.messages, event.subtype, event.summary, event.ts) } : prev;
    case "done":
      if (prev.phase !== "running") return prev;
      return {
        phase: "done",
        repoPath: prev.repoPath,
        repoName: prev.repoName,
        messages: prev.messages,
        proposalPath: event.proposalPath,
        proposalMarkdown: event.proposalMarkdown,
        tokensUsed: event.tokensUsed,
        durationMs: event.durationMs,
        approvedAt: null,
        ...(prev.previousNotes ? { previousNotes: prev.previousNotes } : {}),
      };
    case "error": {
      const messages = prev.phase === "running" ? prev.messages : prev.phase === "done" ? prev.messages : [];
      const repoPath = prev.phase !== "idle" ? prev.repoPath : "";
      return { phase: "error", repoPath, repoName, message: event.message, messages };
    }
  }
}

function reducePlan(prev: PlanState, event: PlanEvent, repoName: string): PlanState {
  switch (event.type) {
    case "started":
      return { phase: "running", repoPath: event.repoPath, repoName: event.repoName, elapsedMs: 0, messages: [] };
    case "progress":
      return prev.phase === "running" ? { ...prev, elapsedMs: event.durationMs } : prev;
    case "sdk_message":
      return prev.phase === "running" ? { ...prev, messages: msg(prev.messages, event.subtype, event.summary, event.ts) } : prev;
    case "done":
      if (prev.phase !== "running") return prev;
      return {
        phase: "done",
        repoPath: prev.repoPath,
        repoName: prev.repoName,
        messages: prev.messages,
        planPath: event.planPath,
        planMarkdown: event.planMarkdown,
        taskCount: event.taskCount,
        estimatedTokens: event.estimatedTokens,
        estimatedDurationMs: event.estimatedDurationMs,
        tokensUsed: event.tokensUsed,
        durationMs: event.durationMs,
        approvedAt: null,
        ...(prev.previousNotes ? { previousNotes: prev.previousNotes } : {}),
      };
    case "error": {
      const messages = prev.phase === "running" ? prev.messages : prev.phase === "done" ? prev.messages : [];
      const repoPath = prev.phase !== "idle" ? prev.repoPath : "";
      return { phase: "error", repoPath, repoName, message: event.message, messages };
    }
  }
}

/** Reduce one action against the keyed flow state. Unknown repoPath keys are
 *  created lazily so the UI can dispatch before seeding. */
export function flowReducer(state: FlowState, action: FlowAction): FlowState {
  const cur = state[action.repoPath] ?? emptyRepoFlow();
  switch (action.type) {
    case "analyze-start":
      return {
        ...state,
        [action.repoPath]: {
          ...cur,
          analyzeIteration: action.iteration,
          planIteration: 1,
          analyze: {
            phase: "running",
            repoPath: action.repoPath,
            repoName: action.repoName,
            elapsedMs: 0,
            messages: [],
            ...(action.userNotes ? { previousNotes: action.userNotes } : {}),
          },
          plan: { phase: "idle" },
        },
      };
    case "analyze-event":
      return { ...state, [action.repoPath]: { ...cur, analyze: reduceAnalyze(cur.analyze, action.event, action.repoName) } };
    case "approve-proposal":
      return cur.analyze.phase === "done"
        ? { ...state, [action.repoPath]: { ...cur, analyze: { ...cur.analyze, approvedAt: action.at } } }
        : state;
    case "plan-start":
      return {
        ...state,
        [action.repoPath]: {
          ...cur,
          planIteration: action.iteration,
          plan: {
            phase: "running",
            repoPath: action.repoPath,
            repoName: action.repoName,
            elapsedMs: 0,
            messages: [],
            ...(action.userNotes ? { previousNotes: action.userNotes } : {}),
          },
        },
      };
    case "plan-event":
      return { ...state, [action.repoPath]: { ...cur, plan: reducePlan(cur.plan, action.event, action.repoName) } };
    case "approve-plan":
      return cur.plan.phase === "done"
        ? { ...state, [action.repoPath]: { ...cur, plan: { ...cur.plan, approvedAt: action.at } } }
        : state;
    case "close":
      return { ...state, [action.repoPath]: emptyRepoFlow() };
  }
}
```

> Note: this re-expresses the App.tsx reducers. The only behavioral changes are (a) keying by repoPath, (b) computing message ids from `messages.length` instead of a ref counter (deterministic + reducer-pure), and (c) stamping `previousNotes`/iteration inside `analyze-start`/`plan-start` instead of at the call site.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm exec vitest run test/unit/ui/analyzeReducer.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm typecheck:ui`
Expected: exit 0.

```bash
git add ui/src/analyze/types.ts ui/src/analyze/reducer.ts test/unit/ui/analyzeReducer.test.ts
git commit -m "feat(ui): per-repo analyze/plan reducer + types (keystone for unified surface)"
```

---

## Task C2: `useAnalyzeFlow` hook

**Files:**
- Create: `ui/src/analyze/useAnalyzeFlow.ts`

> React wrapper over the C1 reducer; owns the SSE stream refs and the API calls. Verified manually (no jsdom). Exposes one entry per repo plus actions bound by repoPath.

- [ ] **Step 1: Create the hook**

```ts
// ui/src/analyze/useAnalyzeFlow.ts
import { useReducer, useRef } from "react";
import { api, type AuthMode, type DiscoveredRepo, type Thoroughness } from "../api";
import { buildPhaseOverride } from "../modelDefaults";
import type { PhaseSelections } from "../modelConfig";
import { flowReducer, type FlowState } from "./reducer";
import { emptyRepoFlow, type RepoFlow } from "./types";

interface Args {
  mode: AuthMode | null;
  defaults: PhaseSelections;
}

export interface AnalyzeFlow {
  get: (repoPath: string) => RepoFlow;
  analyze: (repo: DiscoveredRepo, userNotes?: string) => void;
  proceedWithAnswers: (repo: DiscoveredRepo, userNotes: string) => void;
  approve: (repo: DiscoveredRepo) => void;
  plan: (repo: DiscoveredRepo, userNotes?: string) => void;
  approvePlan: (repo: DiscoveredRepo, taskCount: number) => void;
  close: (repoPath: string) => void;
  setThoroughness: (repoPath: string, t: Thoroughness) => void;
}

export function useAnalyzeFlow({ mode, defaults }: Args): AnalyzeFlow {
  const [state, dispatch] = useReducer(flowReducer, {} as FlowState);
  // One stream per repoPath so concurrent-repo guards are explicit.
  const streams = useRef<Map<string, { close: () => void }>>(new Map());
  const thoroughness = useRef<Map<string, Thoroughness>>(new Map());
  const autoApprove = useRef<Set<string>>(new Set());

  const startAnalyze = (repo: DiscoveredRepo, userNotes: string | undefined, finalize: boolean, iteration: number) => {
    if (!mode) return;
    streams.current.get(repo.path)?.close();
    dispatch({ type: "analyze-start", repoPath: repo.path, repoName: repo.name, iteration, ...(userNotes ? { userNotes } : {}) });
    if (finalize) autoApprove.current.add(repo.path);
    else autoApprove.current.delete(repo.path);
    const handle = api.streamAnalyze(
      {
        repoPath: repo.path,
        mode,
        userNotes,
        iteration,
        thoroughness: thoroughness.current.get(repo.path) ?? "balanced",
        ...buildPhaseOverride(defaults.analyze),
        ...(finalize ? { finalize: true } : {}),
      },
      (event) => {
        dispatch({ type: "analyze-event", repoPath: repo.path, repoName: repo.name, event });
        if (event.type === "done" && autoApprove.current.has(repo.path)) {
          autoApprove.current.delete(repo.path);
          void api
            .approveProposal({ repoPath: repo.path, proposalPath: event.proposalPath })
            .then(() => dispatch({ type: "approve-proposal", repoPath: repo.path, at: new Date().toISOString() }));
        }
      },
    );
    streams.current.set(repo.path, handle);
  };

  return {
    get: (repoPath) => state[repoPath] ?? emptyRepoFlow(),
    analyze: (repo, userNotes) =>
      startAnalyze(repo, userNotes, false, userNotes ? (state[repo.path]?.analyzeIteration ?? 1) + 1 : 1),
    proceedWithAnswers: (repo, userNotes) =>
      startAnalyze(repo, userNotes, true, (state[repo.path]?.analyzeIteration ?? 1) + 1),
    approve: (repo) => {
      const f = state[repo.path];
      if (f?.analyze.phase !== "done") return;
      void api
        .approveProposal({ repoPath: repo.path, proposalPath: f.analyze.proposalPath })
        .then(() => dispatch({ type: "approve-proposal", repoPath: repo.path, at: new Date().toISOString() }));
    },
    plan: (repo, userNotes) => {
      if (!mode) return;
      const iter = userNotes ? (state[repo.path]?.planIteration ?? 1) + 1 : 1;
      dispatch({ type: "plan-start", repoPath: repo.path, repoName: repo.name, iteration: iter, ...(userNotes ? { userNotes } : {}) });
      const handle = api.streamPlan(
        {
          repoPath: repo.path,
          mode,
          userNotes,
          iteration: iter,
          thoroughness: thoroughness.current.get(repo.path) ?? "balanced",
          ...buildPhaseOverride(defaults.plan),
        },
        (event) => dispatch({ type: "plan-event", repoPath: repo.path, repoName: repo.name, event }),
      );
      streams.current.set(repo.path + "#plan", handle);
    },
    approvePlan: (repo, taskCount) => {
      const f = state[repo.path];
      if (f?.plan.phase !== "done") return;
      void api
        .approvePlan({ repoPath: repo.path, planPath: f.plan.planPath, taskCount })
        .then(() => dispatch({ type: "approve-plan", repoPath: repo.path, at: new Date().toISOString() }));
    },
    close: (repoPath) => {
      streams.current.get(repoPath)?.close();
      streams.current.get(repoPath + "#plan")?.close();
      dispatch({ type: "close", repoPath });
    },
    setThoroughness: (repoPath, t) => thoroughness.current.set(repoPath, t),
  };
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm typecheck:ui`
Expected: exit 0.

```bash
git add ui/src/analyze/useAnalyzeFlow.ts
git commit -m "feat(ui): useAnalyzeFlow hook (per-repo, finalize-aware, defaults-aware)"
```

---

## Task C3: move the panels onto a shared module; add finalize button + ResizablePanel

**Files:**
- Create: `ui/src/analyze/AnalyzePanel.tsx`, `ui/src/analyze/PlanPanel.tsx`, `ui/src/analyze/IterationControl.tsx` (move from `App.tsx`)
- Modify: those panels to (a) read state from a `RepoFlow`, (b) wrap proposal/plan/answer bodies in `ResizablePanel`, (c) add the third proposal-gate button

> A move + targeted enhancement. Verified manually. The components keep their existing CSS class names so styling carries over.

- [ ] **Step 1: Move `IterationControl` + `IterationBanner`** from `App.tsx:1631-1741` into `ui/src/analyze/IterationControl.tsx` (export both). Update their imports (`Thoroughness` from `../api`). No behavior change.

- [ ] **Step 2: Move `AnalyzePanel`** from `App.tsx:1142-1335` into `ui/src/analyze/AnalyzePanel.tsx`. Change its props to take the analyze/plan from a `RepoFlow` plus a `repo: DiscoveredRepo` and the `AnalyzeFlow` actions. Wrap the proposal body:

Replace `<pre className="proposal-body">{analyze.proposalMarkdown}</pre>` (App.tsx:1258) with:
```tsx
            <ResizablePanel storageKey="proposal" title="completion-proposal.md">
              <pre className="proposal-body">{analyze.proposalMarkdown}</pre>
            </ResizablePanel>
```
(`import { ResizablePanel } from "../ui/ResizablePanel";`)

Then add the **third button** to the proposal gate. Between the existing "Submit notes / answers" button and "Approve as-is" (App.tsx:1278-1302), insert:
```tsx
              <button
                className="btn btn-proceed"
                onClick={() => onProceed(notes.trim())}
                disabled={notes.trim().length === 0}
                title="Fold your answers into the proposal and move straight to planning — no more questions."
              >
                → Submit answers &amp; proceed
              </button>
```
where `onProceed` is a new prop wired in C4 to `proceedWithAnswers`. Keep the existing two buttons. Update the discard-warning copy to mention that "Submit answers & proceed" WILL use the notes.

- [ ] **Step 3: Move `PlanPanel`** from `App.tsx:1337-1520` into `ui/src/analyze/PlanPanel.tsx`. Wrap its plan body (App.tsx:1451) the same way:
```tsx
            <ResizablePanel storageKey="plan" title="plan.md">
              <pre className="proposal-body">{plan.planMarkdown}</pre>
            </ResizablePanel>
```
(No third button on the plan gate — finalize is an analyze-gate concept.)

- [ ] **Step 4: Add CSS for the proceed button.** Append to `ui/src/styles.css`:
```css
.btn-proceed {
  background: var(--ok, #2d7d46);
  color: #fff;
  border: 1px solid transparent;
}
.btn-proceed:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm typecheck:ui`
Expected: exit 0 (the panels won't be *rendered* yet — App still has its own copies until C5 — but they must compile standalone).

```bash
git add ui/src/analyze/AnalyzePanel.tsx ui/src/analyze/PlanPanel.tsx ui/src/analyze/IterationControl.tsx ui/src/styles.css
git commit -m "feat(ui): movable AnalyzePanel/PlanPanel with ResizablePanel + finalize button"
```

---

## Task C4: wire inline analyze + select into the run surface

**Files:**
- Modify: `ui/src/StartRunForm.tsx` (the repo-select list gains inline analyze; uses `useAnalyzeFlow`)

> The run surface already has scan + select checkboxes + launch. This task expands each repo row so it can ALSO analyze inline (decoupled from selection).

- [ ] **Step 1:** In `StartRunForm`, call the hook near the top of the component:
```tsx
  const flow = useAnalyzeFlow({ mode: authMode, defaults: loadDefaults(window.localStorage) });
```
(imports: `useAnalyzeFlow` from `./analyze/useAnalyzeFlow`, `AnalyzePanel` from `./analyze/AnalyzePanel`.)

- [ ] **Step 2:** In the repo-select `<li>` (StartRunForm:206-240), keep the existing `<label>` (checkbox + name + flags) and add, below it, an **Analyze** toggle button + the inline `AnalyzePanel` when expanded. Track an `expanded: Set<string>` state. For each repo `r`:
```tsx
                    <button
                      type="button"
                      className="btn btn-ghost btn-tight"
                      onClick={() => toggleExpanded(r.path)}
                    >
                      {flow.get(r.path).analyze.phase === "idle" ? "Analyze ▸" : "▾ analysis"}
                    </button>
                    {expanded.has(r.path) && (
                      <AnalyzePanel
                        repo={r}
                        flow={flow.get(r.path)}
                        onAnalyze={(notes) => flow.analyze(r, notes)}
                        onProceed={(notes) => flow.proceedWithAnswers(r, notes)}
                        onApprove={() => flow.approve(r)}
                        onPlan={(notes) => flow.plan(r, notes)}
                        onApprovePlan={(tc) => flow.approvePlan(r, tc)}
                        onClose={() => flow.close(r.path)}
                        onThoroughnessChange={(t) => flow.setThoroughness(r.path, t)}
                      />
                    )}
```
(Exact prop names must match the `AnalyzePanel` props you defined in C3 — reconcile them.)

- [ ] **Step 3:** The select checkbox stays exactly as-is (decoupled). The `plan ✓ · skips to execute` flag already shows approval state from `r.hasApprovedPlan`; the live `flow.get(r.path)` badge supplements it during a session.

- [ ] **Step 4: Typecheck + manual**

Run: `pnpm typecheck:ui`
Manual: `pnpm dev:ui` → New run → scan → expand a repo → analyze inline → verify: the proposal renders in a **resizable/maximizable** panel; the **three buttons** appear; "→ Submit answers & proceed" finalizes (no more questions) and advances to plan; selecting the repo's checkbox is independent of analyzing it; "Run selected (N)" still launches.

- [ ] **Step 5: Commit**

```bash
git add ui/src/StartRunForm.tsx
git commit -m "feat(ui): inline analyze in the run surface, decoupled from select-to-run"
```

---

## Task C5: remove the home scanner; slim App to the landing

**Files:**
- Modify: `ui/src/App.tsx` (delete the discover/analyze machinery)
- Modify: `ui/src/router.ts` / `ui/src/Root.tsx` if the `refine` deep-link needs to point at the run surface

> Now that the run surface owns analyze, the home page's scanner + analyze are dead. Remove them; the landing keeps runs + DefaultsPanel + auth + "New run".

- [ ] **Step 1:** Delete from `App.tsx`: the `card-discover` `<section>` (App.tsx:629-688, now ends after `DefaultsPanel`), the `DiscoverReadout`/`RepoRow`/`AnalyzePanel`/`PlanPanel`/`IterationControl`/`IterationBanner` component definitions (943-1741), the `reduceAnalyze`/`reducePlan`/`reduceDiscover` functions (904-941, 1522-1629), the `AnalyzeState`/`PlanState`/`DiscoverState`/`MessageEntry` types (58-163 — keep any still used), the analyze/plan/discover handlers (`onAnalyze`/`onApprove`/`onCloseAnalyze`/`onPlan`/`onApprovePlan`/`onScan`/`reduceDiscover` usage), and the related `useState`/`useRef` declarations (discover, analyzeState, planState, iterations, the stream/message refs, `scanPath`, `scanDepth`).

- [ ] **Step 2:** Keep in `App.tsx`: auth card, runs list, `DefaultsPanel`, the "New run" button, `chosenMode`/auth state. The `refine` deep-link (`?refine=analyze&repoPath=`) previously pre-filled the home scanner — repoint it: in `Root.tsx`/`App`, when `refine` is present, `navigate("/runs/new")` (the run surface) instead of pre-filling the now-deleted home scanner. Remove `RefineParams` wiring from `App` if it no longer has a scanner to target.

- [ ] **Step 3: Typecheck + full suite**

Run: `pnpm typecheck:ui && pnpm test`
Expected: typecheck exit 0; all tests green. Watch for now-unused imports in `App.tsx` — remove them.

- [ ] **Step 4: Manual verification**

`pnpm dev:ui`:
- Home page = runs list + Run defaults + auth + "New run" only (no Discover card).
- The full flow works end-to-end on the run surface: scan → analyze (inline, resizable, three-button) → select → Run selected → dashboard.

- [ ] **Step 5: Commit**

```bash
git add ui/src/App.tsx ui/src/router.ts ui/src/Root.tsx
git commit -m "feat(ui): remove home scanner; landing is runs + defaults + auth + New run (#6)"
```

---

## Self-Review

**Spec coverage (2C):** #6 unified single-scanner surface (C4 + C5), analyze decoupled from select (C4), #4-UI three-button finalize (C3 + C2), #3 resizable analyze surfaces wired (C3). ✓

**Placeholder scan:** C1/C2 are full code. C3-C5 are move-with-named-adaptations against exact line ranges from code exploration; the *new* code (finalize button, ResizablePanel wrap, hook) is shown literally. The reconciliation note in C4 step 2 ("prop names must match C3") is a real dependency, not a placeholder — C3 defines the props, C4 consumes them.

**Type consistency:** `FlowState`/`FlowAction`/`RepoFlow`/`AnalyzeState`/`PlanState` are defined in C1 and consumed by C2's hook and C3's panels. `AnalyzeFlow` (C2) is the surface C4 calls. `buildPhaseOverride` + `loadDefaults` come from Plan 2B; `ResizablePanel` from Plan 1; `finalize`/model/effort query params from Plan 2A.

**Risk note:** C5 is the largest deletion and the only irreversible-feeling step; do it last and lean on the full suite + manual pass. C3/C4 reference the same components, so do C3 (define) before C4 (consume). This plan is best executed task-by-task with a manual check after C4 before the C5 deletion.

**Sequencing caveat:** C4's "one analyze in-flight" simplification from the spec is relaxed here — `useAnalyzeFlow` keys streams per repo, so multiple repos *can* analyze concurrently. If that proves confusing or costly in the manual pass, add a guard in C4 (disable other Analyze buttons while any `flow.get(p).analyze.phase === "running"`) — noted, not pre-built (YAGNI until observed).
