import { useEffect, useRef, useState } from "react";
import { api, type AuthMode, type AuthStatus, type DiscoveredRepo } from "./api";
import { navigate } from "./router";
import { Breadcrumbs } from "./Breadcrumbs";
import type {
  AutonomyMode,
  ModelTier,
  OnFailure,
  RunConfig,
  TestGate,
} from "./runTypes";

// Tier → default model mapping. Mirrors src/orchestrator/tiers.ts; UI keeps
// its own copy to avoid a server round-trip just to render the form.
function modelForTier(tier: ModelTier): RunConfig["model"] {
  switch (tier) {
    case "thorough":
      return { default: "claude-opus-4-7" };
    case "fast":
      return { default: "claude-haiku-4-5-20251001" };
    case "balanced":
    case "custom":
    default:
      return { default: "claude-sonnet-4-6" };
  }
}

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

  const [autonomy, setAutonomy] = useState<AutonomyMode>("batched");
  const [tier, setTier] = useState<ModelTier>("balanced");
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

  const onSubmit = async (): Promise<void> => {
    if (!authMode || selected.size === 0 || submitting) return;
    const selectedRepos = scan.repos.filter((r) => selected.has(r.path));
    if (selectedRepos.length === 0) return;

    const config: RunConfig = {
      targetDir: targetDir.trim(),
      autonomy,
      tier,
      concurrency,
      checkpointEvery,
      onFailure,
      maxRetries,
      testGate,
      testTimeoutMs,
      model: modelForTier(tier),
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
            <span className="card-sub">scan a directory, pick the repos to run</span>
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
            <ul className="repo-select">
              {scan.repos.map((r) => {
                const isSelected = selected.has(r.path);
                return (
                  <li key={r.path} className={`repo-select-row ${isSelected ? "on" : ""}`}>
                    <label className="repo-select-label">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleRepo(r.path)}
                      />
                      <span className="repo-select-name">{r.name}</span>
                      <span className={`repo-stack repo-stack-${r.stack}`}>{r.stack}</span>
                      {r.isDirty && (
                        <span className="repo-flag repo-flag-dirty">dirty</span>
                      )}
                      <span className="repo-select-path" title={r.path}>
                        {r.path}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
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
            <span className="card-sub">
              how much autonomy and which model tier
            </span>
          </div>

          <div className="setting-grid">
            <label className="field">
              <span className="field-label">autonomy</span>
              <select
                className="field-input"
                value={autonomy}
                onChange={(e) => setAutonomy(e.target.value as AutonomyMode)}
              >
                <option value="manual">
                  manual — stop at every gate
                </option>
                <option value="batched">
                  batched — review proposal &amp; plan, then auto
                </option>
                <option value="yolo">yolo — no gates</option>
              </select>
            </label>

            <label className="field">
              <span className="field-label">tier</span>
              <select
                className="field-input"
                value={tier}
                onChange={(e) => setTier(e.target.value as ModelTier)}
              >
                <option value="thorough">thorough · opus</option>
                <option value="balanced">balanced · sonnet</option>
                <option value="fast">fast · haiku</option>
              </select>
            </label>

            <label className="field">
              <span className="field-label">concurrency</span>
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
              <label className="field">
                <span className="field-label">checkpoint every (tasks)</span>
                <input
                  className="field-input"
                  type="number"
                  min={0}
                  value={checkpointEvery}
                  onChange={(e) => setCheckpointEvery(Number(e.target.value))}
                />
              </label>
              <label className="field">
                <span className="field-label">on failure</span>
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
                <span className="field-label">max retries</span>
                <input
                  className="field-input"
                  type="number"
                  min={0}
                  value={maxRetries}
                  onChange={(e) => setMaxRetries(Number(e.target.value))}
                />
              </label>
              <label className="field">
                <span className="field-label">test gate</span>
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
                <span className="field-label">test timeout (ms)</span>
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
            <button
              className="btn btn-ghost"
              onClick={() => navigate("/")}
              disabled={submitting}
            >
              Cancel
            </button>
          </div>

          {!authMode && auth && (
            <p className="proposal-hint">
              No auth mode is selected. Go back to the home page and pick API key or
              subscription first.
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
