# Plan 2D — Per-Repo Base-Branch Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user pick, per repo on the run surface, which local branch the orchestrator forks its `agent/*` work off of — defaulting to the repo's current branch — and check that base out before any agent branch is created, refusing dirty base-switches up front.

**Architecture:** `discover.ts` already opens a `simpleGit(path)` to read status; it gains `currentBranch` + `localBranches` from `g.branchLocal()`. The chosen `baseBranch` rides per-repo in the existing `startRun` `selectedRepos` payload (a `DiscoveredRepo`), is validated server-side by a pure `validateBaseBranches` guard (reject dirty switches + non-existent branches **before the run is created**), is persisted into the manifest `RepoEntry`, and is checked out **once per repo** in `run.ts`'s `advanceRunning` bootstrap (the natural per-repo seam, before the per-task `agent/<taskId>` branches fork). The UI adds a per-row `<select>` of local branches. This is Plan 2D of the IA-consolidation spec (`docs/superpowers/specs/2026-06-07-ui-ia-consolidation-design.md` §#2), sequenced last and deliberately minimal.

**Tech Stack:** TypeScript (Node server + React/Vite UI). Server typecheck = `pnpm typecheck`; UI typecheck = `pnpm typecheck:ui`; full suite = `pnpm test`; single file = `pnpm exec vitest run <path>`. `simple-git` for git ops. The pure validator (D2) is the only unit-tested keystone; D1 extends the fixture-based discover test; D3/D4 (git + React) are verified by typecheck + full suite + manual.

**Source map (from code exploration):**
- `DiscoveredRepo` (server): `src/phases/discover.ts:8-22`; populated in `describeRepo` `src/phases/discover.ts:120-148` (already builds `const g = simpleGit(path)` + calls `g.status()` at :128-132).
- `DiscoveredRepo` (UI mirror): `ui/src/api.ts:47-60`.
- `DiscoveredRepoSchema`: `src/server/runRoutes.ts:39-51`; `handleStartRun`: `src/server/runRoutes.ts:156-192` (maps `selectedRepos` at :185-190).
- `RepoEntrySchema`: `src/types.ts:121-134`. `LogEventSchema` union: `src/types.ts:187-323`.
- `initManifest` repo-entry build: `src/orchestrator/run.ts:120-155` (the `.map` at :133-143).
- `advanceRunning` per-repo bootstrap: `src/orchestrator/run.ts:351-356` (`repo.status = "executing"; await persist();` then the task loop). `executeFn` call site: :359-373.
- `ensureBranch`: `src/lib/git.ts:3-11` (checks out existing branch, else `checkoutLocalBranch`). `run.ts` does **not** import `lib/git` yet.
- Discover fixture test: `test/unit/phases/discover.test.ts` (`makeGitRepo` helper at :14-24). Start-run test: `test/unit/server/runRoutes.test.ts`.

---

## Task D1: discover reports `currentBranch` + `localBranches`

**Files:**
- Modify: `src/phases/discover.ts` (DiscoveredRepo type + describeRepo)
- Modify: `ui/src/api.ts` (UI DiscoveredRepo mirror)
- Test: `test/unit/phases/discover.test.ts`

> `describeRepo` already constructs `simpleGit(path)` and calls `g.status()`. Add one `g.branchLocal()` call inside the same try and surface two new fields. The UI type mirrors them so the run surface can read them off the discover stream.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/phases/discover.test.ts` (inside the `describe("discoverRepos", ...)` block):

```ts
  it("reports current branch and local branches", async () => {
    const dir = await makeGitRepo(root, "alpha", { "package.json": "{}" });
    await simpleGit(dir).checkoutLocalBranch("feature/x");
    const repos = await discoverRepos({ targetDir: root, depth: 2 });
    const r = repos[0]!;
    expect(r.currentBranch).toBe("feature/x");
    expect(r.localBranches).toContain("feature/x");
    expect(r.localBranches).toContain(r.currentBranch);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run test/unit/phases/discover.test.ts`
Expected: FAIL — `r.currentBranch` is `undefined` (field does not exist yet).

- [ ] **Step 3: Add the fields to the `DiscoveredRepo` type**

In `src/phases/discover.ts`, extend the interface (`:8-22`):

```ts
export interface DiscoveredRepo {
  path: string;
  name: string;
  stack: StackId;
  hasReadme: boolean;
  hasTests: boolean;
  lastCommitDate: string | null;
  isDirty: boolean;
  // Local git branches + the currently checked-out one. The run surface uses
  // these to offer a per-repo base-branch picker (default = currentBranch).
  currentBranch: string;
  localBranches: string[];
  // The user-chosen base branch agent/* work forks off. Set by the run surface
  // in the start-run payload; absent during discovery itself.
  baseBranch?: string;
  // Prior orchestrator state (from the repo's .agent/ directory). Lets the
  // UI badge repos that already have approved work, and lets run bootstrap
  // skip re-analysis. Flags are validity-checked — a dangling/stale approval
  // reports false.
  hasApprovedProposal: boolean;
  hasApprovedPlan: boolean;
}
```

- [ ] **Step 4: Populate them in `describeRepo`**

In `src/phases/discover.ts:120-148`, add two locals and one `branchLocal()` call inside the existing try, then include them in the returned object:

```ts
export async function describeRepo(path: string): Promise<DiscoveredRepo> {
  const name = basename(path);
  const stack = await detectStack(path);
  const hasReadme = await fileExists(join(path, "README.md"));
  const hasTests = await hasTestsInRepo(path);
  let lastCommitDate: string | null = null;
  let isDirty = false;
  let currentBranch = "";
  let localBranches: string[] = [];
  try {
    const g = simpleGit(path);
    const log = await g.log({ maxCount: 1 });
    lastCommitDate = log.latest?.date ?? null;
    const status = await g.status();
    isDirty = !status.isClean();
    const branches = await g.branchLocal();
    currentBranch = branches.current ?? "";
    localBranches = branches.all;
  } catch {
    // ignore — repo metadata best-effort
  }
  const priorState = await readPriorApprovalState(path);
  return {
    path,
    name,
    stack,
    hasReadme,
    hasTests,
    lastCommitDate,
    isDirty,
    currentBranch,
    localBranches,
    hasApprovedProposal: priorState.proposalApproved,
    hasApprovedPlan: priorState.planApproved,
  };
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm exec vitest run test/unit/phases/discover.test.ts`
Expected: PASS (all discover tests, including the new one).

- [ ] **Step 6: Mirror the fields in the UI type**

In `ui/src/api.ts`, extend the `DiscoveredRepo` interface (`:47-60`) — add the three fields after `isDirty`:

```ts
  isDirty: boolean;
  // Local branches + current branch, from the discover stream. Drives the
  // per-repo base-branch picker on the run surface.
  currentBranch: string;
  localBranches: string[];
  // The chosen base branch, attached by the run surface before startRun.
  baseBranch?: string;
```

- [ ] **Step 7: Typecheck + commit**

Run: `pnpm typecheck && pnpm typecheck:ui`
Expected: both exit 0.

```bash
git add src/phases/discover.ts ui/src/api.ts test/unit/phases/discover.test.ts
git commit -m "feat(discover): report currentBranch + localBranches per repo (base-branch picker groundwork)"
```

---

## Task D2: schema + manifest carry `baseBranch`; start-run dirty-refuse validation (keystone)

**Files:**
- Modify: `src/types.ts` (`RepoEntrySchema` gains `baseBranch`)
- Modify: `src/server/runRoutes.ts` (schema + pure `validateBaseBranches` + handler guard + map)
- Modify: `src/orchestrator/run.ts` (`initManifest` maps `baseBranch`)
- Test: `test/unit/server/runRoutes.test.ts`

> The only unit-tested task. `validateBaseBranches` is a pure function: a base-branch switch is only safe on a clean tree and to a branch that exists locally. Validating before the run is ever created means a doomed run never starts (matches spec §7 "refuse the auto-checkout and surface inline").

- [ ] **Step 1: Write the failing test**

Add to `test/unit/server/runRoutes.test.ts` (new `describe` block; adjust the import path to the existing one used in that file):

```ts
import { validateBaseBranches } from "../../../src/server/runRoutes.js";

describe("validateBaseBranches", () => {
  const base = { name: "alpha", isDirty: false, currentBranch: "main", localBranches: ["main", "dev"] };

  it("allows an absent baseBranch (defaults to current)", () => {
    expect(validateBaseBranches([{ ...base }])).toBeNull();
  });

  it("allows baseBranch equal to current (no switch)", () => {
    expect(validateBaseBranches([{ ...base, baseBranch: "main" }])).toBeNull();
  });

  it("allows a clean switch to another local branch", () => {
    expect(validateBaseBranches([{ ...base, baseBranch: "dev" }])).toBeNull();
  });

  it("refuses a switch when the tree is dirty", () => {
    const err = validateBaseBranches([{ ...base, isDirty: true, baseBranch: "dev" }]);
    expect(err).toMatch(/alpha/);
    expect(err).toMatch(/uncommitted|stash|commit/i);
  });

  it("refuses a base branch that is not a local branch", () => {
    const err = validateBaseBranches([{ ...base, baseBranch: "nope" }]);
    expect(err).toMatch(/not a local branch/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run test/unit/server/runRoutes.test.ts`
Expected: FAIL — `validateBaseBranches` is not exported / not defined.

- [ ] **Step 3: Add `baseBranch` to the manifest repo entry**

In `src/types.ts:121-134`, add one optional field to `RepoEntrySchema` (after `testGate`):

```ts
  testGate: z.boolean(),
  // The branch agent/* work forks off for this repo (chosen on the run
  // surface; defaults to the repo's current branch). Absent ⇒ no checkout.
  baseBranch: z.string().optional(),
});
export type RepoEntry = z.infer<typeof RepoEntrySchema>;
```

- [ ] **Step 4: Extend the API schema + write the validator + wire the guard**

In `src/server/runRoutes.ts`, extend `DiscoveredRepoSchema` (`:39-51`) with three optional fields (older UI builds omit them and still validate):

```ts
  isDirty: z.boolean(),
  currentBranch: z.string().optional(),
  localBranches: z.array(z.string()).optional(),
  baseBranch: z.string().optional(),
  // Optional: UI sends these when it knows the prior approval state. Older UI
  // builds that don't include them still validate correctly (Zod strips them).
  hasApprovedProposal: z.boolean().optional(),
  hasApprovedPlan: z.boolean().optional(),
});
```

Add the pure validator just below the schemas (before `handleStartRun`):

```ts
/** A base-branch switch is only safe on a clean tree, and the target must be
 *  an existing local branch. Returns a human error string for the first
 *  offending repo, or null if every repo is fine. Validated up front so a
 *  doomed run never starts (spec §7). */
export function validateBaseBranches(
  repos: {
    name: string;
    isDirty: boolean;
    currentBranch?: string;
    localBranches?: string[];
    baseBranch?: string;
  }[],
): string | null {
  for (const r of repos) {
    const base = r.baseBranch;
    if (!base || base === r.currentBranch) continue; // default / no switch
    if (r.localBranches && !r.localBranches.includes(base)) {
      return `${r.name}: base branch "${base}" is not a local branch`;
    }
    if (r.isDirty) {
      return `${r.name}: working tree has uncommitted changes — commit or stash before switching base branch to "${base}"`;
    }
  }
  return null;
}
```

In `handleStartRun` (`:161`, right after destructuring `selectedRepos`), add the guard:

```ts
  const { config, authMode, selectedRepos } = parsed.data;

  const baseBranchError = validateBaseBranches(selectedRepos);
  if (baseBranchError) {
    return { status: 400, body: { error: baseBranchError } };
  }
```

In the `selectedRepos.map((r) => ({ ... }))` (`:185-190`), default the two discover fields so the orchestrator's required `DiscoveredRepo` shape is satisfied, and carry `baseBranch` through (the spread already includes it, but make the defaults explicit):

```ts
      selectedRepos: selectedRepos.map((r) => ({
        ...r,
        stack: r.stack as StackId,
        currentBranch: r.currentBranch ?? "",
        localBranches: r.localBranches ?? [],
        hasApprovedProposal: r.hasApprovedProposal ?? false,
        hasApprovedPlan: r.hasApprovedPlan ?? false,
      })),
```

- [ ] **Step 5: Map `baseBranch` into the manifest in `initManifest`**

In `src/orchestrator/run.ts:133-143`, add one line to the repo-entry object (after `testGate`):

```ts
      selectedRepos.map(async (r) => ({
        path: r.path,
        name: r.name,
        stack: r.stack,
        hasReadme: r.hasReadme,
        hasTests: r.hasTests,
        lastCommitDate: r.lastCommitDate ?? undefined,
        status: "pending" as const,
        testGate: config.testGate !== "skip",
        baseBranch: r.baseBranch ?? r.currentBranch,
        ...(await restorePriorState(r.path)),
      })),
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm exec vitest run test/unit/server/runRoutes.test.ts`
Expected: PASS (the 5 new validator tests + the existing start-run tests).

- [ ] **Step 7: Typecheck + commit**

Run: `pnpm typecheck`
Expected: exit 0.

```bash
git add src/types.ts src/server/runRoutes.ts src/orchestrator/run.ts test/unit/server/runRoutes.test.ts
git commit -m "feat(server): baseBranch in manifest + start-run dirty-switch validation"
```

---

## Task D3: check the base branch out at execute bootstrap

**Files:**
- Modify: `src/types.ts` (add a `repo_failed` LogEvent variant)
- Modify: `src/orchestrator/run.ts` (`advanceRunning` checkout + import)

> The base must be checked out **once per repo, before any `agent/<taskId>` branch forks**. `advanceRunning`'s `runWithConcurrency` body is exactly that seam. `ensureBranch` is idempotent (no-op if already on the branch), so call it unconditionally when `baseBranch` is set. Start-run already rejected dirty switches, so this is a safety net: a checkout failure (e.g. branch deleted between scan and run) fails just that repo, not the batch. No pure unit test — verified by typecheck + full suite + manual; the testable safety lives in D2's validator.

- [ ] **Step 1: Add a `repo_failed` LogEvent variant**

In `src/types.ts`, inside the `LogEventSchema` discriminated union (`:187-322`), add a variant (place it near `task_failed` at `:221-228`):

```ts
  z.object({
    ts: z.string().datetime(),
    type: z.literal("repo_failed"),
    repoPath: z.string(),
    reason: z.string(),
  }),
```

- [ ] **Step 2: Import `ensureBranch` into the run loop**

In `src/orchestrator/run.ts`, add the import alongside the other `../lib/*` / `../state/*` imports near the top of the file:

```ts
import { ensureBranch } from "../lib/git.js";
```

- [ ] **Step 3: Check out the base branch in `advanceRunning`**

In `src/orchestrator/run.ts:351-355`, insert the checkout between `await persist();` and `const tasks = ...`:

```ts
  await runWithConcurrency(runnable, manifest.config.concurrency, async (repo) => {
    const profile = getStackProfile(repo.stack);
    repo.status = "executing";
    await persist();
    // Base-branch checkout (#2): fork agent/* branches off the user's chosen
    // base. Idempotent — no-op when already on it. Start-run validated this is
    // a clean/safe switch; a checkout failure here fails only this repo.
    if (repo.baseBranch) {
      try {
        await ensureBranch(repo.path, repo.baseBranch);
      } catch (err) {
        repo.status = "failed";
        await persist();
        await log({
          ts: nowIso(),
          type: "repo_failed",
          repoPath: repo.path,
          reason: `base-branch checkout failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
    }
    const tasks = repo.taskState ?? [];
```

- [ ] **Step 4: Typecheck + full suite**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck exit 0; all tests green (no test asserts the new branch behavior, but nothing regresses, and the new `repo_failed` event must still satisfy `LogEventSchema`).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/orchestrator/run.ts
git commit -m "feat(orchestrator): check out per-repo base branch before forking agent/* branches"
```

---

## Task D4: base-branch picker on the run surface

**Files:**
- Modify: `ui/src/StartRunForm.tsx` (per-repo base-branch `<select>` + send `baseBranch` on submit)
- Modify: `ui/src/styles.css` (picker styling)

> Each repo row gains a small base-branch control in its header. Clean tree + >1 local branch ⇒ a `<select>` defaulting to `currentBranch`. Dirty tree or a single branch ⇒ a static read-only label (you can't safely switch a dirty repo — matches D2's server guard and spec §7). On submit, the chosen base is merged per-repo into the `selectedRepos` payload. Verified manually.

- [ ] **Step 1: Track per-repo base-branch choice**

In `ui/src/StartRunForm.tsx`, near the other repo-list state (the `expanded` Set added in 2C), add:

```tsx
  const [baseBranches, setBaseBranches] = useState<Map<string, string>>(new Map());
  const setBaseBranch = (path: string, branch: string): void => {
    setBaseBranches((prev) => {
      const next = new Map(prev);
      next.set(path, branch);
      return next;
    });
  };
```

And reset it on rescan, alongside the existing `setSelected(new Set()); setExpanded(new Set());` in `onScan`:

```tsx
    setSelected(new Set());
    setExpanded(new Set());
    setBaseBranches(new Map());
```

- [ ] **Step 2: Render the picker in the repo row header**

In the repo `<div className="repo-select-head">` (the row added in 2C), add the control after the session badge and before the `Analyze` toggle button. Use the values computed in the row's map body (`r`, and the existing `const f = flow.get(r.path)`):

```tsx
                      {r.localBranches.length > 1 && !r.isDirty ? (
                        <select
                          className="repo-base-select"
                          value={baseBranches.get(r.path) ?? r.currentBranch}
                          onChange={(e) => setBaseBranch(r.path, e.target.value)}
                          title="base branch — agent work forks off this branch"
                          aria-label={`base branch for ${r.name}`}
                        >
                          {r.localBranches.map((b) => (
                            <option key={b} value={b}>
                              {b === r.currentBranch ? `${b} (current)` : b}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span
                          className="repo-base-static"
                          title={
                            r.isDirty
                              ? "commit or stash to switch base branch"
                              : "only one local branch"
                          }
                        >
                          ⎇ {r.currentBranch || "—"}
                          {r.isDirty ? " · dirty" : ""}
                        </span>
                      )}
```

- [ ] **Step 3: Send `baseBranch` per-repo on submit**

In `onSubmit`, change the `selectedRepos` construction (currently `scan.repos.filter((r) => selected.has(r.path))`) to attach the chosen base:

```tsx
    const selectedRepos = scan.repos
      .filter((r) => selected.has(r.path))
      .map((r) => ({ ...r, baseBranch: baseBranches.get(r.path) ?? r.currentBranch }));
    if (selectedRepos.length === 0) return;
```

- [ ] **Step 4: Style the picker**

Append to `ui/src/styles.css` (near the other `.repo-select-*` / `.repo-analyze-*` rules added in 2C):

```css
.repo-base-select {
  flex: none;
  font-size: 11.5px;
  padding: 2px 6px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--bg);
  color: var(--ink-mute);
  max-width: 160px;
}

.repo-base-static {
  flex: none;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-faint);
  white-space: nowrap;
}
```

- [ ] **Step 5: Typecheck + manual verification**

Run: `pnpm typecheck:ui`
Manual: `pnpm dev:ui` → New run → scan a directory that includes a repo with multiple local branches and one dirty repo. Verify:
- A clean, multi-branch repo shows a `<select>` defaulting to `(current)`; picking another branch sticks.
- A dirty repo shows the static `⎇ <branch> · dirty` label (no switch offered).
- Selecting a non-current base on a clean repo and launching → the run starts; the dashboard's first agent branch forks off the chosen base (inspect with `git log --graph` in the repo, or the agent branch's merge-base).
- Forcing a dirty base-switch (if you bypass the UI guard) → the server returns the 400 from `validateBaseBranches` (surfaced via the existing `submitError` `<pre>`).

- [ ] **Step 6: Commit**

```bash
git add ui/src/StartRunForm.tsx ui/src/styles.css
git commit -m "feat(ui): per-repo base-branch picker on the run surface (#2)"
```

---

## Self-Review

**Spec coverage (§#2 + §6 "Base-branch plumbing" + §7 edge cases):**
- discover reports `currentBranch` + `localBranches` → **D1**. ✓
- per-repo `baseBranch` in the start-run payload, defaulting to `currentBranch` → **D2** (schema + map) + **D4** (UI default). ✓
- validated server-side → **D2** `validateBaseBranches` (400 before the run exists). ✓
- run checks out the base via `ensureBranch` before agent branches → **D3** (`advanceRunning`). ✓
- dirty tree + base switch refused → **D2** (server) + **D4** (UI shows static label, no switch). ✓
- base branch must exist locally (re-validate) → **D2** (`localBranches` membership) + **D3** safety-net (checkout failure fails the repo, not the batch). ✓

**Placeholder scan:** D1/D2/D4 are full literal code. D3 shows the exact insertion with real `LogEvent` variant + import. The only non-literal is D4 step 2's placement ("after the session badge, before the Analyze toggle") — that is a positional instruction against the concrete 2C row structure, not a placeholder; the JSX to insert is given verbatim.

**Type consistency:** `currentBranch: string` / `localBranches: string[]` / `baseBranch?: string` are defined identically on the server `DiscoveredRepo` (D1), the UI `DiscoveredRepo` (D1), and accepted (optional) by `DiscoveredRepoSchema` (D2). `RepoEntry.baseBranch?: string` (D2) is read by `advanceRunning` (D3). `validateBaseBranches`'s structural param matches the Zod-parsed `selectedRepos` shape. The server map defaults `currentBranch ?? ""` / `localBranches ?? []` so the orchestrator's required `DiscoveredRepo` fields are always satisfied. `initManifest` defaults `baseBranch: r.baseBranch ?? r.currentBranch`.

**Risk notes:**
- **TOCTOU** (branch deleted/tree dirtied between scan and run): accepted. Start-run validates against the scan-time snapshot; D3's checkout is wrapped so a stale-state failure fails only that repo. A pre-execute live re-validation is a v0.2 follow-up, not needed for v0.1.
- **Analyze/plan run on the repo's current branch, not the chosen base.** The checkout happens at execute bootstrap (where branching matters), not before preflight. For v0.1 this is acceptable (analyze/plan are read-only and largely branch-agnostic); the spec's "before analyze" wording is satisfied in spirit for the part that mutates history. If analysis-on-base proves necessary, add the same `ensureBranch` guard at the top of `advancePreflightOnce`'s per-repo analyze (noted, not built — YAGNI).
- **`branchLocal().current` is `""` for detached HEAD.** Then the picker shows `⎇ —` and (if >1 branch and clean) a select with no `(current)` marker; `baseBranch ?? currentBranch` defaults to `""` ⇒ no checkout. Harmless.
