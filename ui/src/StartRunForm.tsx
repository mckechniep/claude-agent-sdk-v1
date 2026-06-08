import { useEffect, useRef, useState } from "react";
import { api, type AuthMode, type AuthStatus, type DiscoveredRepo } from "./api";
import { navigate } from "./router";
import { Breadcrumbs } from "./Breadcrumbs";
import { InfoBadge } from "./InfoBadge";
import { PhaseModelGrid } from "./PhaseModelGrid";
import { AnalyzePanel } from "./analyze/AnalyzePanel";
import { useAnalyzeFlow } from "./analyze/useAnalyzeFlow";
import { ResizablePanel } from "./ui/ResizablePanel";
import { loadDefaults } from "./modelDefaults";
import type { AutonomyMode, ModelId, OnFailure, RunConfig, TestGate } from "./runTypes";
import {
  buildEffortMap,
  buildModelMap,
  clampEffort,
  recommendedSelections,
  selectionSummary,
  type AgentPhase,
  type EffortChoice,
  type PhaseSelections,
} from "./modelConfig";

interface ScanState {
  phase: "idle" | "scanning" | "done" | "error";
  repos: DiscoveredRepo[];
  message?: string;
}

export function StartRunForm() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);
  const [targetDir, setTargetDir] = useState("~/projects");
  const [scanDepth, setScanDepth] = useState(2);
  const [scan, setScan] = useState<ScanState>({ phase: "idle", repos: [] });
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [autonomy, setAutonomy] = useState<AutonomyMode>("supervised");
  const [phaseSelections, setPhaseSelections] = useState<PhaseSelections>(() =>
    loadDefaults(window.localStorage),
  );
  const [concurrency, setConcurrency] = useState(1);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [checkpointEvery, setCheckpointEvery] = useState(1);
  const [onFailure, setOnFailure] = useState<OnFailure>("skip-repo");
  const [maxRetries, setMaxRetries] = useState(1);
  const [testGate, setTestGate] = useState<TestGate>("skip");
  const [testTimeoutMs, setTestTimeoutMs] = useState(300_000);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const scanRef = useRef<{ close: () => void } | null>(null);

  // Inline analyze: which repo rows have their analyze panel open. The analyze
  // flow itself is keyed by repoPath in the hook, so collapsing a row never
  // discards its proposal/plan — re-expanding shows it again. Analyze is fully
  // decoupled from the select-to-run checkbox.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Per-repo chosen base branch (the branch agent/* work forks off). Absent
  // ⇒ the repo's current branch. Decoupled from select + analyze.
  const [baseBranches, setBaseBranches] = useState<Map<string, string>>(new Map());
  const flow = useAnalyzeFlow({ mode: authMode, defaults: phaseSelections });

  useEffect(() => {
    void api.authStatus().then((status) => {
      setAuth(status);
      const detected =
        status.preferredAuthMode ??
        (status.subscriptionDetected ? "subscription" : status.apiKeyDetected ? "api" : null);
      if (detected) setAuthMode(detected);
    });
    return () => scanRef.current?.close();
  }, []);

  const onScan = (): void => {
    if (scan.phase === "scanning") return;
    const path = targetDir.trim();
    if (!path) return;
    scanRef.current?.close();
    setScan({ phase: "scanning", repos: [] });
    setSelected(new Set());
    setExpanded(new Set());
    setBaseBranches(new Map());
    scanRef.current = api.streamDiscover({ path, depth: scanDepth }, (event) => {
      setScan((prev) => {
        switch (event.type) {
          case "started":
            return { phase: "scanning", repos: [] };
          case "repo":
            return { ...prev, repos: [...prev.repos, event.repo] };
          case "done":
            return { phase: "done", repos: prev.repos };
          case "error":
            return { phase: "error", repos: prev.repos, message: event.message };
          default:
            return prev;
        }
      });
    });
  };

  const toggleRepo = (path: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleExpanded = (path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const collapse = (path: string): void => {
    setExpanded((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  };

  const setBaseBranch = (path: string, branch: string): void => {
    setBaseBranches((prev) => {
      const next = new Map(prev);
      next.set(path, branch);
      return next;
    });
  };

  const setPhaseModel = (phase: AgentPhase, model: ModelId): void => {
    setPhaseSelections((prev) => {
      const current = prev[phase];
      const effort = clampEffort(model, current.effort);
      return { ...prev, [phase]: { model, effort } };
    });
  };

  const setPhaseEffort = (phase: AgentPhase, effort: EffortChoice): void => {
    setPhaseSelections((prev) => ({ ...prev, [phase]: { ...prev[phase], effort } }));
  };

  const onSubmit = async (): Promise<void> => {
    if (!authMode || selected.size === 0 || submitting) return;
    const selectedRepos = scan.repos
      .filter((r) => selected.has(r.path))
      .map((r) => ({ ...r, baseBranch: baseBranches.get(r.path) ?? r.currentBranch }));
    if (selectedRepos.length === 0) return;

    const effort = buildEffortMap(phaseSelections);
    const config: RunConfig = {
      targetDir: targetDir.trim(),
      autonomy,
      concurrency,
      checkpointEvery,
      onFailure,
      maxRetries,
      testGate,
      testTimeoutMs,
      model: buildModelMap(phaseSelections),
      ...(effort ? { effort } : {}),
    };

    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await api.startRun({ config, authMode, selectedRepos });
      navigate(`/runs/${res.runId}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  const canSubmit =
    !submitting &&
    authMode !== null &&
    selected.size > 0 &&
    scan.phase !== "scanning" &&
    targetDir.trim().length > 0;

  return (
    <div className="page">
      <header className="hdr">
        <div className="hdr-mark">
          <span className="hdr-glyph">◆</span>
          <span className="hdr-name">start a new run</span>
        </div>
        <div className="hdr-meta">
          <span className="hdr-meta-label">local dev</span>
          <span className="hdr-meta-dot" />
          <span className="hdr-meta-value">:3737 ⇄ :5173</span>
        </div>
      </header>
      <Breadcrumbs crumbs={[{ label: "Home", href: "/" }, { label: "New run" }]} />

      <main className="form-grid">
        <section className="card card-form">
          <div className="card-head">
            <h2>1 · Target & repo selection</h2>
            <span className="card-sub">
              scan a directory, analyze repos inline, pick which to run
            </span>
          </div>

          <div className="scan-form">
            <label className="field">
              <span className="field-label">target dir</span>
              <input
                className="field-input"
                type="text"
                value={targetDir}
                onChange={(e) => setTargetDir(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onScan();
                }}
                spellCheck={false}
              />
            </label>
            <label className="field field-depth">
              <span className="field-label">depth</span>
              <select
                className="field-input"
                value={scanDepth}
                onChange={(e) => setScanDepth(Number(e.target.value))}
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="btn btn-primary"
              onClick={onScan}
              disabled={scan.phase === "scanning" || targetDir.trim().length === 0}
            >
              {scan.phase === "scanning" ? "scanning…" : "Scan"}
            </button>
          </div>

          {scan.phase === "scanning" && scan.repos.length === 0 && (
            <div className="scan-empty-state">walking directory tree…</div>
          )}

          {scan.repos.length > 0 && (
            <ResizablePanel
              storageKey="repo-select"
              title={`${scan.repos.length} repo${scan.repos.length === 1 ? "" : "s"} · drag ↘ or ⤢ to grow`}
              minHeight={360}
            >
              <ul className="repo-select">
                {scan.repos.map((r) => {
                  const isSelected = selected.has(r.path);
                  const f = flow.get(r.path);
                  const isExpanded = expanded.has(r.path);
                  // Tolerate discover payloads without branch info (older server,
                  // pre-restart dev server, or a non-git edge) — never crash the row.
                  const localBranches = r.localBranches ?? [];
                  const currentBranch = r.currentBranch ?? "";
                  const aPhase = f.analyze.phase;
                  const proposalApproved =
                    f.analyze.phase === "done" && f.analyze.approvedAt !== null;
                  const planApproved = f.plan.phase === "done" && f.plan.approvedAt !== null;
                  // Live, session-only status of the inline analyze flow. Distinct
                  // from the persisted r.hasApproved* flags below (which come from
                  // the repo's .agent/ dir on disk).
                  const sessionBadge = planApproved
                    ? { cls: "approved", text: "plan ✓ (this session)" }
                    : proposalApproved
                      ? { cls: "approved", text: "proposal ✓ (this session)" }
                      : aPhase === "running"
                        ? { cls: "live", text: "analyzing…" }
                        : aPhase === "done"
                          ? { cls: "done", text: "proposal ready" }
                          : aPhase === "error"
                            ? { cls: "err", text: "analyze failed" }
                            : null;
                  const toggleLabel = isExpanded
                    ? "▾ analysis"
                    : aPhase === "idle"
                      ? "Analyze ▸"
                      : "▸ analysis";
                  return (
                    <li key={r.path} className={`repo-select-row ${isSelected ? "on" : ""}`}>
                      <div className="repo-select-head">
                        <label className="repo-select-label">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleRepo(r.path)}
                          />
                          <span className="repo-select-name">{r.name}</span>
                          <span className={`repo-stack repo-stack-${r.stack}`}>{r.stack}</span>
                          {r.isDirty && <span className="repo-flag repo-flag-dirty">dirty</span>}
                          {r.hasApprovedPlan ? (
                            <span
                              className="repo-flag repo-flag-approved"
                              title="This repo has a valid approved plan — the run will skip analyze and plan and go straight to execution."
                            >
                              plan ✓ · skips to execute
                            </span>
                          ) : r.hasApprovedProposal ? (
                            <span
                              className="repo-flag repo-flag-proposal"
                              title="This repo has a valid approved proposal — the run will skip analyze and go straight to planning."
                            >
                              proposal ✓ · skips analyze
                            </span>
                          ) : null}
                          <span className="repo-select-path" title={r.path}>
                            {r.path}
                          </span>
                        </label>
                        {sessionBadge && (
                          <span
                            className={`repo-flag repo-analyze-badge repo-analyze-${sessionBadge.cls}`}
                          >
                            {sessionBadge.text}
                          </span>
                        )}
                        {localBranches.length > 1 && !r.isDirty ? (
                          <select
                            className="repo-base-select"
                            value={baseBranches.get(r.path) ?? currentBranch}
                            onChange={(e) => setBaseBranch(r.path, e.target.value)}
                            title="base branch — agent work forks off this branch"
                            aria-label={`base branch for ${r.name}`}
                          >
                            {localBranches.map((b) => (
                              <option key={b} value={b}>
                                {b === currentBranch ? `${b} (current)` : b}
                              </option>
                            ))}
                          </select>
                        ) : currentBranch || r.isDirty ? (
                          <span
                            className="repo-base-static"
                            title={
                              r.isDirty
                                ? "commit or stash to switch base branch"
                                : "only one local branch"
                            }
                          >
                            ⎇ {currentBranch || "—"}
                            {r.isDirty ? " · dirty" : ""}
                          </span>
                        ) : null}
                        <button
                          type="button"
                          className="btn btn-ghost btn-tight repo-analyze-toggle"
                          onClick={() => toggleExpanded(r.path)}
                          aria-expanded={isExpanded}
                          title="Analyze this repo inline — independent of whether it's selected to run."
                        >
                          {toggleLabel}
                        </button>
                      </div>
                      {isExpanded && (
                        <div className="repo-analyze-inline">
                          <AnalyzePanel
                            repo={r}
                            flow={f}
                            onAnalyze={(notes) => flow.analyze(r, notes)}
                            onProceed={(notes) => flow.proceedWithAnswers(r, notes)}
                            onApprove={() => flow.approve(r)}
                            onPlan={(notes) => flow.plan(r, notes)}
                            onApprovePlan={(tc) => flow.approvePlan(r, tc)}
                            onClose={() => collapse(r.path)}
                            onThoroughnessChange={(t) => flow.setThoroughness(r.path, t)}
                          />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </ResizablePanel>
          )}

          {scan.phase === "done" && scan.repos.length === 0 && (
            <div className="scan-empty-state">no git repos found at this depth</div>
          )}

          {scan.phase === "error" && (
            <pre className="scan-err-body">{scan.message ?? "scan failed"}</pre>
          )}
        </section>

        <section className="card card-form">
          <div className="card-head">
            <h2>2 · Run settings</h2>
            <span className="card-sub">how much autonomy, and which model + effort per phase</span>
          </div>

          <div className="setting-grid">
            <label className="field">
              <span className="field-label">
                autonomy
                <InfoBadge label="About autonomy">
                  Controls how the background loop runs and which approval gates stop it.
                  <ul>
                    <li>
                      <code>manual</code> — no background loop. You POST <code>/step</code> yourself
                      to advance each phase. Analyze runs one repo at a time. Every gate is a manual
                      click. Pick this when you want full control or are debugging the orchestrator
                      itself.
                    </li>
                    <li>
                      <code>supervised</code> — background loop drives the run between gates.{" "}
                      <strong>Still stops at every approval gate</strong> (proposal, plan,
                      run-start); the loop auto-resumes when you submit a decision. Preflight runs
                      repos in parallel. Pick this when you want hands-off scheduling but still want
                      to review each proposal + plan + the final go-no-go.
                    </li>
                    <li>
                      <code>yolo</code> — background loop runs end-to-end with{" "}
                      <strong>no gates at all</strong>. Proposals, plans, and run-start are
                      auto-approved as they appear. Pick this when you trust the plan and want
                      zero-touch execution.
                    </li>
                  </ul>
                </InfoBadge>
              </span>
              <select
                className="field-input"
                value={autonomy}
                onChange={(e) => setAutonomy(e.target.value as AutonomyMode)}
              >
                <option value="manual">manual — stop at every gate</option>
                <option value="supervised">
                  supervised — loop auto-runs between gates, you approve each
                </option>
                <option value="yolo">yolo — no gates</option>
              </select>
            </label>

            <div className="field field-models-summary">
              <span className="field-label">models</span>
              <button
                type="button"
                className="models-summary-readout"
                onClick={() => setAdvancedOpen(true)}
                title="Models and effort are configured under Advanced settings. The dashboard also lets you change them at each approval gate."
              >
                {selectionSummary(phaseSelections)}
                <span className="models-summary-hint">customize ▸</span>
              </button>
            </div>

            <label className="field">
              <span className="field-label">
                concurrency
                <InfoBadge label="About concurrency">
                  How many repos the executor processes in parallel. Each parallel slot runs its own
                  SDK query — useful when working across independent repos, but multiplies token
                  spend per wall-clock minute. Stay at <code>1</code> unless you&apos;ve set{" "}
                  <code>--max-concurrent-anthropic-requests</code> high enough to handle the burst.
                </InfoBadge>
              </span>
              <select
                className="field-input"
                value={concurrency}
                onChange={(e) => setConcurrency(Number(e.target.value))}
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n} repo{n === 1 ? "" : "s"} in parallel
                  </option>
                ))}
              </select>
            </label>

            <div className="field field-auth-readout">
              <span className="field-label">auth mode</span>
              <span className="field-readout">
                {authMode ?? "not configured — set on home page first"}
              </span>
            </div>
          </div>

          <button
            className="btn btn-ghost btn-disclosure"
            onClick={() => setAdvancedOpen((v) => !v)}
            aria-expanded={advancedOpen}
          >
            {advancedOpen ? "▾" : "▸"} Advanced settings
          </button>

          {advancedOpen && (
            <div className="setting-grid setting-grid-advanced">
              <div className="field field-models">
                <span className="field-label">
                  models &amp; effort
                  <InfoBadge label="About models and effort">
                    Each phase spawns its own agent, so each phase can run a different Claude model
                    and reasoning effort.
                    <ul>
                      <li>
                        <strong>Recommended:</strong> Sonnet for analyze/plan, Haiku for execute.
                        80%+ of a run&apos;s tokens are spent in execute — Haiku is ~90% of the
                        capability at roughly a third of the cost.
                      </li>
                      <li>
                        Bump execute to Sonnet/Opus for gnarly refactors. Bump <em>effort</em>{" "}
                        instead of model when a phase needs more thinking rather than more
                        capability.
                      </li>
                      <li>
                        <em>effort</em> = how much reasoning the model does per response. Leave on
                        &quot;model default&quot; unless you have a reason. <code>xhigh</code>/
                        <code>max</code> are Opus-only.
                      </li>
                    </ul>
                  </InfoBadge>
                </span>

                <PhaseModelGrid
                  selections={phaseSelections}
                  onModelChange={setPhaseModel}
                  onEffortChange={setPhaseEffort}
                  onReset={() => setPhaseSelections(recommendedSelections())}
                />
              </div>

              <label className="field">
                <span className="field-label">
                  checkpoint every (tasks)
                  <InfoBadge label="About checkpoint cadence">
                    Pauses the loop after every N completed tasks so you can inspect progress before
                    more work happens. <code>0</code>
                    disables checkpointing (loop runs until completion or failure). <code>
                      1
                    </code>{" "}
                    is the default — stop after each task. Useful for unfamiliar repos where you
                    want a look-see before committing more SDK budget.
                  </InfoBadge>
                </span>
                <input
                  className="field-input"
                  type="number"
                  min={0}
                  value={checkpointEvery}
                  onChange={(e) => setCheckpointEvery(Number(e.target.value))}
                />
              </label>
              <label className="field">
                <span className="field-label">
                  on failure
                  <InfoBadge label="About failure handling">
                    What to do when a task fails (test gate failure, agent can&apos;t make progress,
                    etc.).
                    <ul>
                      <li>
                        <code>stop</code> — halt the entire run on first failure.
                      </li>
                      <li>
                        <code>skip-task</code> — mark the task failed, move to the next task in this
                        repo.
                      </li>
                      <li>
                        <code>skip-repo</code> — mark the whole repo failed, move to the next repo.
                      </li>
                      <li>
                        <code>retry</code> — re-attempt the task up to <code>max retries</code>{" "}
                        times.
                      </li>
                    </ul>
                  </InfoBadge>
                </span>
                <select
                  className="field-input"
                  value={onFailure}
                  onChange={(e) => setOnFailure(e.target.value as OnFailure)}
                >
                  <option value="stop">stop the run</option>
                  <option value="skip-task">skip task, continue repo</option>
                  <option value="skip-repo">skip repo, continue run</option>
                  <option value="retry">retry the task</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">
                  max retries
                  <InfoBadge label="About retries">
                    How many additional attempts the executor gets when a task fails. Applies to
                    both <code>retry</code> on-failure mode and the executor&apos;s built-in
                    test-gate retry (when the agent makes changes but tests fail, it sees the
                    failing output and tries again). <code>1</code>
                    means up to 2 total attempts; <code>0</code> = no retries.
                  </InfoBadge>
                </span>
                <input
                  className="field-input"
                  type="number"
                  min={0}
                  value={maxRetries}
                  onChange={(e) => setMaxRetries(Number(e.target.value))}
                />
              </label>
              <label className="field">
                <span className="field-label">
                  test gate
                  <InfoBadge label="About the test gate">
                    Whether to run the repo&apos;s test command after each task and only commit if
                    it passes.
                    <ul>
                      <li>
                        <code>required</code> — must pass to commit. Safest, slowest.
                      </li>
                      <li>
                        <code>skip</code> — commit edits without testing. Fastest, riskiest.
                      </li>
                      <li>
                        <code>per-repo</code> — use the <code>testGate</code> field set per-repo in
                        the manifest.
                      </li>
                    </ul>
                    The test command is auto-detected from the stack profile (e.g.{" "}
                    <code>pnpm test</code> for jsts).
                  </InfoBadge>
                </span>
                <select
                  className="field-input"
                  value={testGate}
                  onChange={(e) => setTestGate(e.target.value as TestGate)}
                >
                  <option value="skip">skip (no test enforcement)</option>
                  <option value="required">required (block on test fail)</option>
                  <option value="per-repo">per-repo (use repo's setting)</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">
                  test timeout (ms)
                  <InfoBadge label="About test timeout">
                    How long the test command can run before being killed and treated as a failure.
                    Defaults to 5 minutes (<code>300000</code> ms). Bump higher for slow integration
                    suites; lower if you want fast feedback on a tight unit test loop.
                  </InfoBadge>
                </span>
                <input
                  className="field-input"
                  type="number"
                  min={1000}
                  value={testTimeoutMs}
                  onChange={(e) => setTestTimeoutMs(Number(e.target.value))}
                />
              </label>
            </div>
          )}
        </section>

        <section className="card card-form">
          <div className="card-head">
            <h2>3 · Launch</h2>
            <span className="card-sub">
              {selected.size === 0
                ? "select at least one repo above"
                : `${selected.size} repo${selected.size === 1 ? "" : "s"} selected`}
            </span>
          </div>

          {submitError && <pre className="scan-err-body">{submitError}</pre>}

          <div className="proposal-actions">
            <button
              className="btn btn-primary"
              onClick={() => void onSubmit()}
              disabled={!canSubmit}
            >
              {submitting ? "starting…" : "Start run"}
            </button>
            <button className="btn btn-ghost" onClick={() => navigate("/")} disabled={submitting}>
              Cancel
            </button>
          </div>

          {!authMode && auth && (
            <p className="proposal-hint">
              No auth mode is selected. Go back to the home page and pick API key or subscription
              first.
            </p>
          )}
        </section>
      </main>

      <footer className="ftr">
        <span>v0.1 · new run</span>
      </footer>
    </div>
  );
}

export default StartRunForm;
