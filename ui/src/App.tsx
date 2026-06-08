import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type AnalyzeEvent,
  type AuthMode,
  type AuthStatus,
  type DiscoveredRepo,
  type DiscoverEvent,
  type PlanEvent,
  type RunsResponse,
  type SmokeEvent,
  type Thoroughness,
} from "./api";
import { navigate, type RefineParams } from "./router";
import { Breadcrumbs } from "./Breadcrumbs";
import { InfoBadge } from "./InfoBadge";
import { DefaultsPanel } from "./DefaultsPanel";
import { buildPhaseOverride, loadDefaults, saveDefaults } from "./modelDefaults";
import type { PhaseSelections } from "./modelConfig";

function parentDir(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx > 0 ? p.slice(0, idx) : p;
}

// Thoroughness thresholds mirror src/sdk/prompts/iteration.ts. UI copy uses
// these to show users when narrowing/defaults kick in.
const THOROUGHNESS_BOUNDS: Record<Thoroughness, { narrow: number; defaults: number }> = {
  thorough: { narrow: 4, defaults: 6 },
  balanced: { narrow: 3, defaults: 5 },
  fast: { narrow: 2, defaults: 3 },
};

function modeForIteration(
  iteration: number,
  thoroughness: Thoroughness,
): "normal" | "narrow" | "defaults" {
  const t = THOROUGHNESS_BOUNDS[thoroughness];
  if (iteration >= t.defaults) return "defaults";
  if (iteration >= t.narrow) return "narrow";
  return "normal";
}

type LoadState<T> = { phase: "loading" } | { phase: "ok"; data: T } | { phase: "err"; error: string };

function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): [LoadState<T>, () => void] {
  const [state, setState] = useState<LoadState<T>>({ phase: "loading" });
  const reload = useCallback(() => {
    setState({ phase: "loading" });
    fn()
      .then((data) => setState({ phase: "ok", data }))
      .catch((err: unknown) => setState({ phase: "err", error: err instanceof Error ? err.message : String(err) }));
  }, deps);
  useEffect(reload, [reload]);
  return [state, reload];
}

interface MessageEntry {
  id: number;
  subtype: string;
  summary: string;
  ts: number;
}

type SmokeState =
  | { phase: "idle" }
  | {
      phase: "streaming";
      startedAt: number;
      elapsedMs: number;
      messages: MessageEntry[];
    }
  | {
      phase: "done";
      ok: true;
      response: string;
      tokensUsed: number;
      durationMs: number;
      messages: MessageEntry[];
    }
  | { phase: "error"; message: string; messages: MessageEntry[] };

type DiscoverState =
  | { phase: "idle" }
  | {
      phase: "scanning";
      path: string;
      depth: number;
      elapsedMs: number;
      repos: DiscoveredRepo[];
    }
  | {
      phase: "done";
      path: string;
      depth: number;
      count: number;
      durationMs: number;
      repos: DiscoveredRepo[];
    }
  | { phase: "error"; message: string; repos: DiscoveredRepo[] };

type AnalyzeState =
  | { phase: "idle" }
  | {
      phase: "running";
      repoPath: string;
      repoName: string;
      elapsedMs: number;
      messages: MessageEntry[];
      previousNotes?: string;
    }
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
  | {
      phase: "error";
      repoPath: string;
      repoName: string;
      message: string;
      messages: MessageEntry[];
    };

type PlanState =
  | { phase: "idle" }
  | {
      phase: "running";
      repoPath: string;
      repoName: string;
      elapsedMs: number;
      messages: MessageEntry[];
      previousNotes?: string;
    }
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
  | {
      phase: "error";
      repoPath: string;
      repoName: string;
      message: string;
      messages: MessageEntry[];
    };

export default function App({ refine }: { refine?: RefineParams } = {}) {
  const [authState, reloadAuth] = useAsync<AuthStatus>(() => api.authStatus(), []);
  const [runsState, reloadRuns] = useAsync<RunsResponse>(() => api.listRuns(), []);
  const [chosenMode, setChosenMode] = useState<AuthMode | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const [smoke, setSmoke] = useState<SmokeState>({ phase: "idle" });
  const [discover, setDiscover] = useState<DiscoverState>({ phase: "idle" });
  const [scanPath, setScanPath] = useState<string>("~/projects");
  const [scanDepth, setScanDepth] = useState<number>(2);
  const [analyzeState, setAnalyzeState] = useState<AnalyzeState>({ phase: "idle" });
  const [planState, setPlanState] = useState<PlanState>({ phase: "idle" });
  const [thoroughness, setThoroughness] = useState<Thoroughness>("balanced");
  const [defaults, setDefaults] = useState<PhaseSelections>(() =>
    loadDefaults(window.localStorage),
  );
  const updateDefaults = (next: PhaseSelections): void => {
    setDefaults(next);
    saveDefaults(next, window.localStorage);
  };
  const [analyzeIteration, setAnalyzeIteration] = useState(1);
  const [planIteration, setPlanIteration] = useState(1);
  const streamRef = useRef<{ close: () => void } | null>(null);
  const discoverStreamRef = useRef<{ close: () => void } | null>(null);
  const analyzeStreamRef = useRef<{ close: () => void } | null>(null);
  const planStreamRef = useRef<{ close: () => void } | null>(null);
  const messageIdRef = useRef(0);
  const analyzeMessageIdRef = useRef(0);
  const planMessageIdRef = useRef(0);

  useEffect(() => {
    if (authState.phase === "ok" && chosenMode === null) {
      const detected =
        authState.data.preferredAuthMode ??
        (authState.data.subscriptionDetected
          ? "subscription"
          : authState.data.apiKeyDetected
            ? "api"
            : null);
      if (detected) setChosenMode(detected);
    }
  }, [authState, chosenMode]);

  // Cross-link prefill: when the dashboard sends us here with refine params,
  // pre-fill the scan path so the user just has to click Scan to find the
  // target repo. Auto-scan is intentionally not done — the user might want
  // to adjust the depth or path first.
  useEffect(() => {
    if (refine?.repoPath) {
      setScanPath(parentDir(refine.repoPath));
    }
  }, [refine]);

  useEffect(
    () => () => {
      streamRef.current?.close();
      discoverStreamRef.current?.close();
      analyzeStreamRef.current?.close();
      planStreamRef.current?.close();
    },
    [],
  );

  const onSelectMode = async (mode: AuthMode) => {
    setChosenMode(mode);
    await api.setAuthMode(mode);
    reloadAuth();
  };

  const onSmoke = () => {
    if (!chosenMode || smoke.phase === "streaming") return;
    streamRef.current?.close();
    messageIdRef.current = 0;
    setSmoke({ phase: "streaming", startedAt: Date.now(), elapsedMs: 0, messages: [] });

    streamRef.current = api.streamSmoke(chosenMode, (event: SmokeEvent) => {
      setSmoke((prev) => reduceSmoke(prev, event, () => ++messageIdRef.current));
    });
  };

  const onScan = () => {
    if (discover.phase === "scanning") return;
    const path = scanPath.trim();
    if (!path) return;
    discoverStreamRef.current?.close();
    setDiscover({ phase: "scanning", path, depth: scanDepth, elapsedMs: 0, repos: [] });
    discoverStreamRef.current = api.streamDiscover(
      { path, depth: scanDepth },
      (event: DiscoverEvent) => {
        setDiscover((prev) => reduceDiscover(prev, event));
      },
    );
  };

  const onAnalyze = (repo: DiscoveredRepo, userNotes?: string) => {
    if (!chosenMode) return;
    if (analyzeState.phase === "running") return;
    analyzeStreamRef.current?.close();
    planStreamRef.current?.close();
    analyzeMessageIdRef.current = 0;
    // Refinements (userNotes present) increment the iteration counter; a
    // first-time analyze on a repo resets to 1.
    const iter = userNotes ? analyzeIteration + 1 : 1;
    setAnalyzeIteration(iter);
    setPlanIteration(1); // plan starts fresh once analyze re-runs
    setAnalyzeState({
      phase: "running",
      repoPath: repo.path,
      repoName: repo.name,
      elapsedMs: 0,
      messages: [],
      ...(userNotes ? { previousNotes: userNotes } : {}),
    });
    // Re-analyzing invalidates any in-memory plan for this repo.
    setPlanState({ phase: "idle" });
    analyzeStreamRef.current = api.streamAnalyze(
      {
        repoPath: repo.path,
        mode: chosenMode,
        userNotes,
        iteration: iter,
        thoroughness,
        ...buildPhaseOverride(defaults.analyze),
      },
      (event: AnalyzeEvent) => {
        setAnalyzeState((prev) =>
          reduceAnalyze(prev, event, repo.name, () => ++analyzeMessageIdRef.current),
        );
      },
    );
  };

  const onApprove = async () => {
    if (analyzeState.phase !== "done") return;
    try {
      await api.approveProposal({
        repoPath: analyzeState.repoPath,
        proposalPath: analyzeState.proposalPath,
      });
      setAnalyzeState((prev) =>
        prev.phase === "done" ? { ...prev, approvedAt: new Date().toISOString() } : prev,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Surface failure inline via the existing error phase. Keep proposal visible.
      setAnalyzeState((prev) =>
        prev.phase === "done"
          ? {
              phase: "error",
              repoPath: prev.repoPath,
              repoName: prev.repoName,
              message: `approve failed: ${message}`,
              messages: prev.messages,
            }
          : prev,
      );
    }
  };

  const onCloseAnalyze = () => {
    analyzeStreamRef.current?.close();
    planStreamRef.current?.close();
    setAnalyzeState({ phase: "idle" });
    setPlanState({ phase: "idle" });
    setAnalyzeIteration(1);
    setPlanIteration(1);
  };

  const onPlan = (repo: DiscoveredRepo, userNotes?: string) => {
    if (!chosenMode) return;
    if (planState.phase === "running") return;
    planStreamRef.current?.close();
    planMessageIdRef.current = 0;
    const iter = userNotes ? planIteration + 1 : 1;
    setPlanIteration(iter);
    setPlanState({
      phase: "running",
      repoPath: repo.path,
      repoName: repo.name,
      elapsedMs: 0,
      messages: [],
      ...(userNotes ? { previousNotes: userNotes } : {}),
    });
    planStreamRef.current = api.streamPlan(
      {
        repoPath: repo.path,
        mode: chosenMode,
        userNotes,
        iteration: iter,
        thoroughness,
        ...buildPhaseOverride(defaults.plan),
      },
      (event: PlanEvent) => {
        setPlanState((prev) =>
          reducePlan(prev, event, repo.name, () => ++planMessageIdRef.current),
        );
      },
    );
  };

  const onApprovePlan = async () => {
    if (planState.phase !== "done") return;
    try {
      await api.approvePlan({
        repoPath: planState.repoPath,
        planPath: planState.planPath,
        taskCount: planState.taskCount,
      });
      setPlanState((prev) =>
        prev.phase === "done" ? { ...prev, approvedAt: new Date().toISOString() } : prev,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setPlanState((prev) =>
        prev.phase === "done"
          ? {
              phase: "error",
              repoPath: prev.repoPath,
              repoName: prev.repoName,
              message: `approve failed: ${message}`,
              messages: prev.messages,
            }
          : prev,
      );
    }
  };

  return (
    <div className="page">
      <header className="hdr">
        <div className="hdr-mark">
          <span className="hdr-glyph">◆</span>
          <span className="hdr-name">agent-orchestrator</span>
        </div>
        <div className="hdr-meta">
          <span className="hdr-meta-label">local dev</span>
          <span className="hdr-meta-dot" />
          <span className="hdr-meta-value">:3737 ⇄ :5173</span>
        </div>
      </header>
      <Breadcrumbs crumbs={[{ label: "Home" }]} />
      {refine && (
        <div className="refine-banner">
          <span>
            <strong>Refine flow:</strong> dashboard sent you here to refine the{" "}
            <strong>{refine.kind}</strong> for <code>{refine.repoPath}</code>. Scan
            path is pre-filled to <code>{parentDir(refine.repoPath)}</code> — click
            Scan to find the repo, then Analyze / Plan to refine. Your edits write
            to disk and the dashboard will pick them up on next refresh.
          </span>
        </div>
      )}

      <main className="grid">
        <section className="card card-auth">
          <div className="card-head">
            <h2>Authentication</h2>
            <span className="card-sub">how this session will bill</span>
          </div>

          {authState.phase === "loading" && <p className="muted">checking credentials…</p>}
          {authState.phase === "err" && <p className="err">failed: {authState.error}</p>}
          {authState.phase === "ok" && (
            <>
              <ModeRow
                mode="api"
                label="API key"
                hint="pay-per-token via ANTHROPIC_API_KEY"
                available={authState.data.apiKeyDetected}
                unavailableHint="paste a key below — no server restart needed"
                selected={chosenMode === "api"}
                onSelect={onSelectMode}
              />
              <ApiKeyEntry status={authState.data} onChanged={reloadAuth} />
              <ModeRow
                mode="subscription"
                label="Claude subscription"
                hint="OAuth via your Pro/Max plan (~/.claude/.credentials.json)"
                available={authState.data.subscriptionDetected}
                unavailableHint="run `claude /login` in your terminal first"
                selected={chosenMode === "subscription"}
                onSelect={onSelectMode}
              />

              <div className="action-row">
                <button
                  className="btn btn-primary"
                  onClick={onSmoke}
                  disabled={
                    !chosenMode ||
                    smoke.phase === "streaming" ||
                    (chosenMode === "api" && !authState.data.apiKeyDetected) ||
                    (chosenMode === "subscription" && !authState.data.subscriptionDetected)
                  }
                >
                  {smoke.phase === "streaming" ? "streaming…" : "Test connection"}
                </button>
                <ElapsedReadout smoke={smoke} />
              </div>

              <SmokeStream smoke={smoke} />
            </>
          )}
        </section>

        <section className="card card-runs">
          <div className="card-head">
            <h2>Runs</h2>
            <div className="card-head-actions">
              {runsState.phase === "ok" && (() => {
                const finished = runsState.data.runs.filter(
                  (r) => r.status === "completed" || r.status === "failed",
                );
                if (finished.length < 2) return null;
                if (confirmingClear) {
                  return (
                    <span className="run-clear-confirm">
                      <span className="run-clear-confirm-label">
                        Delete {finished.length} finished runs?
                      </span>
                      <button
                        className="btn btn-danger btn-tight"
                        onClick={() => {
                          void Promise.allSettled(
                            finished.map((r) => api.deleteRun(r.runId)),
                          ).then((results) => {
                            const failed = results.filter((r) => r.status === "rejected").length;
                            setConfirmingClear(false);
                            if (failed > 0) {
                              setClearError(`${failed} of ${finished.length} could not be deleted`);
                            } else {
                              setClearError(null);
                            }
                            reloadRuns();
                          });
                        }}
                      >
                        Delete all
                      </button>
                      <button
                        className="btn btn-ghost btn-tight"
                        onClick={() => setConfirmingClear(false)}
                      >
                        Keep
                      </button>
                    </span>
                  );
                }
                return (
                  <button
                    className="btn btn-ghost btn-tight"
                    onClick={() => {
                      setClearError(null);
                      setConfirmingClear(true);
                    }}
                  >
                    Clear finished ({finished.length})
                  </button>
                );
              })()}
              <button
                className="btn btn-primary btn-tight"
                onClick={() => navigate("/runs/new")}
                title="open the start-a-run form"
              >
                + Start new run
              </button>
              <button
                className="btn btn-ghost"
                onClick={reloadRuns}
                aria-label="refresh runs"
              >
                refresh
              </button>
            </div>
          </div>
          {clearError && <p className="err" style={{ marginTop: 0 }}>{clearError}</p>}
          {runsState.phase === "loading" && <p className="muted">loading…</p>}
          {runsState.phase === "err" && <p className="err">failed: {runsState.error}</p>}
          {runsState.phase === "ok" && (
            <>
              <p className="muted state-root">{runsState.data.stateRoot}</p>
              {runsState.data.runs.length === 0 ? (
                <div className="empty">
                  <p className="empty-title">no runs yet</p>
                  <p className="empty-body">
                    Click <strong>Start new run</strong> above to launch an orchestration
                    run; it'll appear here once it's underway.
                  </p>
                </div>
              ) : (
                <ul className="runs">
                  {runsState.data.runs.map((r) => {
                    const isActive = r.status === "running" || r.status === "stopping";
                    const isConfirming = confirmingDelete === r.runId;
                    return (
                      <li key={r.runId} className="run">
                        <button
                          className="run-link"
                          onClick={() => navigate(`/runs/${r.runId}`)}
                          title="open run dashboard"
                        >
                          <code className="run-id">{r.runId}</code>
                        </button>
                        <span className={`pill pill-${r.status}`}>{r.status}</span>
                        <span className="run-meta">
                          <span>
                            {r.repoCount} repo{r.repoCount === 1 ? "" : "s"}
                          </span>
                          <span>{r.tokensUsed.toLocaleString()} tok</span>
                          <span>{r.authMode}</span>
                        </span>
                        {isConfirming ? (
                          <span className="run-delete-confirm">
                            <span
                              className="run-delete-confirm-label"
                              title="Removes this run's logs and manifest. Repo .agent state (proposals, plans, approvals) is untouched."
                            >
                              Delete run + logs?
                            </span>
                            <button
                              className="btn btn-danger btn-tight"
                              onClick={() => {
                                setDeleteError(null);
                                api.deleteRun(r.runId)
                                  .then(() => {
                                    setConfirmingDelete(null);
                                    reloadRuns();
                                  })
                                  .catch((err: unknown) => {
                                    setConfirmingDelete(null);
                                    setDeleteError(
                                      err instanceof Error ? err.message : String(err),
                                    );
                                  });
                              }}
                            >
                              Delete
                            </button>
                            <button
                              className="btn btn-ghost btn-tight"
                              onClick={() => setConfirmingDelete(null)}
                            >
                              Keep
                            </button>
                          </span>
                        ) : (
                          <button
                            className="btn btn-ghost btn-tight run-delete-btn"
                            aria-label="Delete run"
                            title={
                              isActive
                                ? "Stop the run before deleting"
                                : "Removes this run's logs and manifest. Repo .agent state (proposals, plans, approvals) is untouched."
                            }
                            disabled={isActive}
                            onClick={() => {
                              setDeleteError(null);
                              setConfirmingDelete(r.runId);
                            }}
                          >
                            ✕
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {deleteError && <p className="err" style={{ marginTop: 0 }}>{deleteError}</p>}
            </>
          )}
        </section>

        <DefaultsPanel value={defaults} onChange={updateDefaults} />

        <section className="card card-discover">
          <div className="card-head">
            <h2>Discover</h2>
            <span className="card-sub">scan a directory for git repos</span>
          </div>

          <div className="scan-form">
            <label className="field">
              <span className="field-label">path</span>
              <input
                className="field-input"
                type="text"
                value={scanPath}
                onChange={(e) => setScanPath(e.target.value)}
                placeholder="~/projects"
                spellCheck={false}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onScan();
                }}
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
              disabled={discover.phase === "scanning" || scanPath.trim().length === 0}
            >
              {discover.phase === "scanning" ? "scanning…" : "Scan"}
            </button>
          </div>

          <DiscoverReadout
            discover={discover}
            analyze={analyzeState}
            plan={planState}
            chosenMode={chosenMode}
            onAnalyze={onAnalyze}
            onApprove={onApprove}
            onCloseAnalyze={onCloseAnalyze}
            onPlan={onPlan}
            onApprovePlan={onApprovePlan}
            thoroughness={thoroughness}
            onThoroughnessChange={setThoroughness}
            analyzeIteration={analyzeIteration}
            planIteration={planIteration}
          />
        </section>
      </main>

      <footer className="ftr">
        <span>v0.1 · auth · smoke · discover · sse</span>
      </footer>
    </div>
  );
}

function reduceSmoke(
  prev: SmokeState,
  event: SmokeEvent,
  nextId: () => number,
): SmokeState {
  switch (event.type) {
    case "started": {
      return { phase: "streaming", startedAt: event.ts, elapsedMs: 0, messages: [] };
    }
    case "progress": {
      if (prev.phase !== "streaming") return prev;
      return { ...prev, elapsedMs: event.durationMs };
    }
    case "sdk_message": {
      const entry: MessageEntry = {
        id: nextId(),
        subtype: event.subtype,
        summary: event.summary,
        ts: event.ts,
      };
      if (prev.phase === "streaming") {
        return { ...prev, messages: [...prev.messages, entry] };
      }
      return prev;
    }
    case "done": {
      const messages = prev.phase === "streaming" ? prev.messages : [];
      return {
        phase: "done",
        ok: true,
        response: event.response,
        tokensUsed: event.tokensUsed,
        durationMs: event.durationMs,
        messages,
      };
    }
    case "error": {
      const messages = prev.phase === "streaming" ? prev.messages : [];
      return { phase: "error", message: event.message, messages };
    }
  }
}

function ApiKeyEntry({ status, onChanged }: { status: AuthStatus; onChanged: () => void }) {
  const [value, setValue] = useState("");
  const [persist, setPersist] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const detected = status.apiKeyDetected;
  const persisted = status.apiKeyPersisted ?? false;
  const tooShort = value.trim().length < 20;

  const save = async () => {
    if (tooShort) {
      setErr("That key looks too short.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.setApiKey(value.trim(), persist);
      setValue(""); // never keep the secret in component state longer than needed
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed to save key");
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.clearApiKey();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed to forget key");
    } finally {
      setBusy(false);
    }
  };

  if (detected) {
    return (
      <div className="keybox keybox-active">
        <span className="keybox-state">
          <span className="dot dot-ok" aria-hidden />
          {persisted ? "key saved · encrypted on this machine" : "key active · from environment"}
        </span>
        {persisted && (
          <button className="btn btn-ghost btn-sm" onClick={forget} disabled={busy}>
            {busy ? "…" : "Forget key"}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="keybox keybox-entry">
      <div className="keybox-row">
        <input
          id="api-key-input"
          type="password"
          className="keybox-input"
          placeholder="sk-ant-… paste your key"
          value={value}
          autoComplete="off"
          spellCheck={false}
          aria-label="Anthropic API key"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
          disabled={busy}
        />
        <button
          className="btn btn-primary btn-sm"
          onClick={() => void save()}
          disabled={busy || tooShort}
        >
          {busy ? "saving…" : "Save key"}
        </button>
      </div>
      <label className="keybox-persist">
        <input
          type="checkbox"
          checked={persist}
          onChange={(e) => setPersist(e.target.checked)}
          disabled={busy}
        />
        remember on this machine (encrypted, survives restart)
      </label>
      {err && <p className="err keybox-err">{err}</p>}
      <p className="muted keybox-note">
        Encrypted with a key derived from this machine — protects the file if it leaks off this box,
        not from processes running as you.
      </p>
    </div>
  );
}

function ModeRow(props: {
  mode: AuthMode;
  label: string;
  hint: string;
  available: boolean;
  unavailableHint: string;
  selected: boolean;
  onSelect: (mode: AuthMode) => void;
}) {
  const disabled = !props.available;
  return (
    <button
      className={`mode ${props.selected ? "mode-on" : ""} ${disabled ? "mode-disabled" : ""}`}
      onClick={() => !disabled && props.onSelect(props.mode)}
      disabled={disabled}
      aria-pressed={props.selected}
    >
      <span className={`dot ${props.available ? "dot-ok" : "dot-off"}`} aria-hidden />
      <span className="mode-body">
        <span className="mode-label">{props.label}</span>
        <span className="mode-hint">{props.available ? props.hint : props.unavailableHint}</span>
      </span>
      <span className="mode-state">{props.available ? (props.selected ? "active" : "available") : "unset"}</span>
    </button>
  );
}

function ElapsedReadout({ smoke }: { smoke: SmokeState }) {
  if (smoke.phase === "streaming") {
    return (
      <span className="action-hint">
        <span className="pulse" /> streaming · {(smoke.elapsedMs / 1000).toFixed(1)}s elapsed
      </span>
    );
  }
  if (smoke.phase === "done") {
    return (
      <span className="action-hint">
        finished in {(smoke.durationMs / 1000).toFixed(1)}s · {smoke.tokensUsed} tok
      </span>
    );
  }
  if (smoke.phase === "error") {
    return <span className="action-hint err">stream failed</span>;
  }
  return <span className="action-hint">sends one short prompt and shows live SDK events</span>;
}

function reduceDiscover(prev: DiscoverState, event: DiscoverEvent): DiscoverState {
  switch (event.type) {
    case "started": {
      return {
        phase: "scanning",
        path: event.path,
        depth: event.depth,
        elapsedMs: 0,
        repos: [],
      };
    }
    case "progress": {
      if (prev.phase !== "scanning") return prev;
      return { ...prev, elapsedMs: event.durationMs };
    }
    case "repo": {
      if (prev.phase === "scanning") {
        return { ...prev, repos: [...prev.repos, event.repo] };
      }
      return prev;
    }
    case "done": {
      if (prev.phase !== "scanning") return prev;
      return {
        phase: "done",
        path: prev.path,
        depth: prev.depth,
        count: event.count,
        durationMs: event.durationMs,
        repos: prev.repos,
      };
    }
    case "error": {
      const repos = prev.phase === "scanning" ? prev.repos : [];
      return { phase: "error", message: event.message, repos };
    }
  }
}

interface DiscoverReadoutProps {
  discover: DiscoverState;
  analyze: AnalyzeState;
  plan: PlanState;
  chosenMode: AuthMode | null;
  onAnalyze: (repo: DiscoveredRepo, userNotes?: string) => void;
  onApprove: () => void;
  onCloseAnalyze: () => void;
  onPlan: (repo: DiscoveredRepo, userNotes?: string) => void;
  onApprovePlan: () => void;
  thoroughness: Thoroughness;
  onThoroughnessChange: (t: Thoroughness) => void;
  analyzeIteration: number;
  planIteration: number;
}

function DiscoverReadout({
  discover,
  analyze,
  plan,
  chosenMode,
  onAnalyze,
  onApprove,
  onCloseAnalyze,
  onPlan,
  onApprovePlan,
  thoroughness,
  onThoroughnessChange,
  analyzeIteration,
  planIteration,
}: DiscoverReadoutProps) {
  if (discover.phase === "idle") {
    return (
      <p className="muted scan-empty">
        scans for git repos under the path, captures stack + dirty + last commit per repo
      </p>
    );
  }

  const isScanning = discover.phase === "scanning";
  const isErr = discover.phase === "error";

  return (
    <div className={`scan ${isScanning ? "scan-live" : isErr ? "scan-err" : "scan-done"}`}>
      <div className="scan-head">
        <span className="scan-label">
          {isScanning ? (
            <>
              <span className="pulse" />
              scanning · {(discover.elapsedMs / 1000).toFixed(1)}s · {discover.repos.length} found
            </>
          ) : isErr ? (
            "scan failed"
          ) : (
            <>
              {discover.count} repo{discover.count === 1 ? "" : "s"} ·{" "}
              {(discover.durationMs / 1000).toFixed(1)}s
            </>
          )}
        </span>
        {!isErr && <span className="scan-meta">depth {discover.depth}</span>}
      </div>

      {discover.repos.length === 0 && isScanning && (
        <div className="scan-empty-state">walking directory tree…</div>
      )}

      {discover.repos.length > 0 && (
        <ul className="repos">
          {discover.repos.map((repo) => {
            const isActive = analyze.phase !== "idle" && analyze.repoPath === repo.path;
            const otherRunning =
              (analyze.phase === "running" && analyze.repoPath !== repo.path) ||
              (plan.phase === "running" && plan.repoPath !== repo.path);
            const repoPlan = plan.phase !== "idle" && plan.repoPath === repo.path ? plan : null;
            return (
              <RepoRow
                key={repo.path}
                repo={repo}
                isActive={isActive}
                disabled={!chosenMode || otherRunning}
                onAnalyze={(notes) => onAnalyze(repo, notes)}
                onApprove={onApprove}
                analyze={isActive ? analyze : null}
                plan={repoPlan}
                onClose={onCloseAnalyze}
                onPlan={(notes) => onPlan(repo, notes)}
                onApprovePlan={onApprovePlan}
                chosenMode={chosenMode}
                thoroughness={thoroughness}
                onThoroughnessChange={onThoroughnessChange}
                analyzeIteration={analyzeIteration}
                planIteration={planIteration}
              />
            );
          })}
        </ul>
      )}

      {isErr && <pre className="scan-err-body">{discover.message}</pre>}

      {discover.repos.length === 0 && discover.phase === "done" && (
        <div className="scan-empty-state">no git repos found at this depth</div>
      )}
    </div>
  );
}

interface RepoRowProps {
  repo: DiscoveredRepo;
  isActive: boolean;
  disabled: boolean;
  onAnalyze: (userNotes?: string) => void;
  onApprove: () => void;
  onClose: () => void;
  onPlan: (userNotes?: string) => void;
  onApprovePlan: () => void;
  analyze: AnalyzeState | null;
  plan: PlanState | null;
  chosenMode: AuthMode | null;
  thoroughness: Thoroughness;
  onThoroughnessChange: (t: Thoroughness) => void;
  analyzeIteration: number;
  planIteration: number;
}

function RepoRow({
  repo,
  isActive,
  disabled,
  onAnalyze,
  onApprove,
  onClose,
  onPlan,
  onApprovePlan,
  analyze,
  plan,
  chosenMode,
  thoroughness,
  onThoroughnessChange,
  analyzeIteration,
  planIteration,
}: RepoRowProps) {
  const date = repo.lastCommitDate ? formatRelative(repo.lastCommitDate) : "no commits";
  const buttonLabel = (() => {
    if (isActive && analyze) {
      if (analyze.phase === "running") return "analyzing…";
      if (analyze.phase === "done") return "re-analyze";
      if (analyze.phase === "error") return "retry";
    }
    return "Analyze";
  })();
  return (
    <li className="repo-row">
      <div className="repo-head">
        <span className="repo-name">{repo.name}</span>
        <span className={`repo-stack repo-stack-${repo.stack}`}>{repo.stack}</span>
        {repo.isDirty && <span className="repo-flag repo-flag-dirty">dirty</span>}
        <span className="repo-row-spacer" />
        <button
          className={`btn btn-row ${isActive ? "btn-row-on" : ""}`}
          onClick={() => onAnalyze()}
          disabled={disabled || (isActive && analyze?.phase === "running")}
          title={!chosenMode ? "select an auth mode above first" : undefined}
        >
          {buttonLabel}
        </button>
      </div>
      <div className="repo-path" title={repo.path}>
        {repo.path}
      </div>
      <div className="repo-meta">
        <span className={`repo-chip ${repo.hasReadme ? "repo-chip-on" : "repo-chip-off"}`}>
          {repo.hasReadme ? "readme ✓" : "no readme"}
        </span>
        <span className={`repo-chip ${repo.hasTests ? "repo-chip-on" : "repo-chip-off"}`}>
          {repo.hasTests ? "tests ✓" : "no tests"}
        </span>
        <span className="repo-chip">{date}</span>
      </div>
      {isActive && analyze && analyze.phase !== "idle" && (
        <AnalyzePanel
          analyze={analyze}
          plan={plan}
          onClose={onClose}
          onReanalyze={(notes) => onAnalyze(notes)}
          onApprove={onApprove}
          onPlan={(notes) => onPlan(notes)}
          onApprovePlan={onApprovePlan}
          thoroughness={thoroughness}
          onThoroughnessChange={onThoroughnessChange}
          analyzeIteration={analyzeIteration}
          planIteration={planIteration}
        />
      )}
    </li>
  );
}

interface AnalyzePanelProps {
  analyze: AnalyzeState;
  plan: PlanState | null;
  onClose: () => void;
  onReanalyze: (userNotes?: string) => void;
  onApprove: () => void;
  onPlan: (userNotes?: string) => void;
  onApprovePlan: () => void;
  thoroughness: Thoroughness;
  onThoroughnessChange: (t: Thoroughness) => void;
  analyzeIteration: number;
  planIteration: number;
}

function AnalyzePanel({
  analyze,
  plan,
  onClose,
  onReanalyze,
  onApprove,
  onPlan,
  onApprovePlan,
  thoroughness,
  onThoroughnessChange,
  analyzeIteration,
  planIteration,
}: AnalyzePanelProps) {
  const [notes, setNotes] = useState<string>("");
  if (analyze.phase === "idle") return null;
  const isRunning = analyze.phase === "running";
  const isErr = analyze.phase === "error";
  const isDone = analyze.phase === "done";
  const isApproved = isDone && analyze.approvedAt !== null;
  const submittedNotes = isRunning || isDone ? analyze.previousNotes : undefined;
  const isRefinement = Boolean(submittedNotes);

  const headerLabel = isApproved ? (
    "approved"
  ) : isRunning ? (
    <>
      <span className="pulse" />
      {isRefinement ? "refining with your notes" : "analyzing"} ·{" "}
      {(analyze.elapsedMs / 1000).toFixed(1)}s
    </>
  ) : isErr ? (
    "analyze failed"
  ) : (
    <>
      proposal · {(analyze.durationMs / 1000).toFixed(1)}s · {analyze.tokensUsed.toLocaleString()} tok
    </>
  );

  return (
    <div
      className={`analyze ${
        isApproved
          ? "analyze-approved"
          : isRunning
            ? "analyze-live"
            : isErr
              ? "analyze-err"
              : "analyze-done"
      }`}
    >
      <div className="analyze-head">
        <span className="analyze-label">{headerLabel}</span>
        <div className="analyze-head-actions">
          <IterationControl
            iteration={analyzeIteration}
            thoroughness={thoroughness}
            onThoroughnessChange={onThoroughnessChange}
            label="analyze"
          />
          <button className="btn btn-ghost btn-tight" onClick={onClose}>
            close
          </button>
        </div>
      </div>

      {analyze.messages.length > 0 && (
        <ul className="stream-log analyze-log">
          {analyze.messages.map((m) => (
            <li key={m.id} className="stream-row">
              <span className={`stream-pill stream-pill-${m.subtype}`}>{m.subtype}</span>
              <span className="stream-summary">{m.summary || <em className="muted">·</em>}</span>
            </li>
          ))}
        </ul>
      )}

      {isRunning && analyze.messages.length === 0 && (
        <div className="stream-empty">waiting for first SDK message…</div>
      )}

      {isDone && (
        <div className="proposal">
          <div className="proposal-head">
            <span className="proposal-label">
              completion-proposal.md
              {isRefinement && <span className="iter-badge">refined</span>}
            </span>
            <span className="proposal-path" title={analyze.proposalPath}>
              {analyze.proposalPath}
            </span>
          </div>

          {isRefinement && submittedNotes && (
            <div className="iter-notes">
              <span className="iter-notes-label">you asked for</span>
              <p className="iter-notes-body">{submittedNotes}</p>
              <span className="iter-notes-hint">
                read the proposal below to see how it was incorporated
              </span>
            </div>
          )}

          <pre className="proposal-body">{analyze.proposalMarkdown}</pre>

          {!isApproved && (
            <div className="proposal-feedback">
              <IterationBanner
                iteration={analyzeIteration}
                thoroughness={thoroughness}
                kind="analyze"
              />
              <label className="field">
                <span className="field-label">your reply to the analyzer</span>
                <textarea
                  className="field-input field-textarea"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="answer the open questions, correct misunderstandings, narrow scope — the analyzer will refine the proposal using these"
                  rows={4}
                  spellCheck
                />
              </label>
              <div className="proposal-actions">
                <button
                  className="btn btn-primary"
                  onClick={() => onReanalyze(notes.trim() || undefined)}
                  disabled={notes.trim().length === 0}
                  title={
                    notes.trim().length === 0
                      ? "type a reply above to submit it to the analyzer"
                      : "send your reply back to the analyzer to refine the proposal"
                  }
                >
                  Submit notes / answers
                </button>
                <button
                  className="btn btn-ghost btn-approve"
                  onClick={onApprove}
                  title={
                    notes.trim().length > 0
                      ? `proceeds with the current proposal — your ${notes.trim().length} chars of notes will NOT be sent to the analyzer or saved`
                      : "lock in the current proposal as-is, move on to the planner phase"
                  }
                >
                  Approve as-is
                </button>
              </div>
              {notes.trim().length > 0 && (
                <p className="proposal-hint">
                  Heads up: <strong>Approve as-is</strong> will discard the {notes.trim().length}{" "}
                  characters in the box above.
                </p>
              )}
            </div>
          )}

          {isApproved && analyze.approvedAt && (
            <div className="approved-banner">
              <span className="approved-mark">✓</span>
              <span>proposal approved {formatRelative(analyze.approvedAt)}</span>
            </div>
          )}
        </div>
      )}

      {isApproved && (
        <PlanPanel
          plan={plan}
          onPlan={onPlan}
          onApprovePlan={onApprovePlan}
          thoroughness={thoroughness}
          onThoroughnessChange={onThoroughnessChange}
          planIteration={planIteration}
        />
      )}

      {isErr && <pre className="scan-err-body">{analyze.message}</pre>}
    </div>
  );
}

interface PlanPanelProps {
  plan: PlanState | null;
  onPlan: (userNotes?: string) => void;
  onApprovePlan: () => void;
  thoroughness: Thoroughness;
  onThoroughnessChange: (t: Thoroughness) => void;
  planIteration: number;
}

function PlanPanel({
  plan,
  onPlan,
  onApprovePlan,
  thoroughness,
  onThoroughnessChange,
  planIteration,
}: PlanPanelProps) {
  const [notes, setNotes] = useState<string>("");
  const isRunning = plan?.phase === "running";
  const isErr = plan?.phase === "error";
  const isDone = plan?.phase === "done";
  const isApproved = isDone && plan.approvedAt !== null;
  const isIdle = !plan || plan.phase === "idle";
  const submittedNotes =
    plan && (plan.phase === "running" || plan.phase === "done") ? plan.previousNotes : undefined;
  const isRefinement = Boolean(submittedNotes);

  const headerLabel = isIdle ? (
    "planner — break the proposal into committable tasks"
  ) : isApproved ? (
    "plan approved"
  ) : isRunning ? (
    <>
      <span className="pulse" />
      {isRefinement ? "refining plan with your notes" : "planning"} ·{" "}
      {(plan.elapsedMs / 1000).toFixed(1)}s
    </>
  ) : isErr ? (
    "plan failed"
  ) : isDone ? (
    <>
      plan · {plan.taskCount} task{plan.taskCount === 1 ? "" : "s"} ·{" "}
      {(plan.durationMs / 1000).toFixed(1)}s · {plan.tokensUsed.toLocaleString()} tok
    </>
  ) : null;

  const panelClass = isApproved
    ? "plan plan-approved"
    : isRunning
      ? "plan plan-live"
      : isErr
        ? "plan plan-err"
        : isDone
          ? "plan plan-done"
          : "plan plan-idle";

  return (
    <div className={panelClass}>
      <div className="plan-head">
        <span className="plan-label">{headerLabel}</span>
        <div className="analyze-head-actions">
          {!isIdle && (
            <IterationControl
              iteration={planIteration}
              thoroughness={thoroughness}
              onThoroughnessChange={onThoroughnessChange}
              label="plan"
            />
          )}
          {isIdle && (
            <button className="btn btn-primary btn-tight" onClick={() => onPlan()}>
              Generate plan
            </button>
          )}
        </div>
      </div>

      {plan && plan.phase !== "idle" && plan.messages.length > 0 && (
        <ul className="stream-log analyze-log">
          {plan.messages.map((m) => (
            <li key={m.id} className="stream-row">
              <span className={`stream-pill stream-pill-${m.subtype}`}>{m.subtype}</span>
              <span className="stream-summary">{m.summary || <em className="muted">·</em>}</span>
            </li>
          ))}
        </ul>
      )}

      {isRunning && plan.messages.length === 0 && (
        <div className="stream-empty">waiting for first SDK message…</div>
      )}

      {isDone && (
        <div className="proposal">
          <div className="proposal-head">
            <span className="proposal-label">
              plan.md
              {isRefinement && <span className="iter-badge">refined</span>}
            </span>
            <span className="proposal-path" title={plan.planPath}>
              {plan.planPath}
            </span>
          </div>

          {isRefinement && submittedNotes && (
            <div className="iter-notes">
              <span className="iter-notes-label">you asked for</span>
              <p className="iter-notes-body">{submittedNotes}</p>
              <span className="iter-notes-hint">
                read the plan below to see how it was incorporated
              </span>
            </div>
          )}

          <pre className="proposal-body">{plan.planMarkdown}</pre>

          {!isApproved && (
            <div className="proposal-feedback">
              <IterationBanner
                iteration={planIteration}
                thoroughness={thoroughness}
                kind="plan"
              />
              <label className="field">
                <span className="field-label">your reply to the planner</span>
                <textarea
                  className="field-input field-textarea"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="re-shape the task list — split, merge, reorder, add acceptance criteria. The planner will refine the plan and preserve unchanged task IDs."
                  rows={4}
                  spellCheck
                />
              </label>
              <div className="proposal-actions">
                <button
                  className="btn btn-primary"
                  onClick={() => onPlan(notes.trim() || undefined)}
                  disabled={notes.trim().length === 0}
                  title={
                    notes.trim().length === 0
                      ? "type a reply above to submit it to the planner"
                      : "send your reply back to the planner to refine the task list"
                  }
                >
                  Submit notes / answers
                </button>
                <button
                  className="btn btn-ghost btn-approve"
                  onClick={onApprovePlan}
                  title={
                    notes.trim().length > 0
                      ? `proceeds with the current plan — your ${notes.trim().length} chars of notes will NOT be sent to the planner or saved`
                      : "lock in the current plan, ready for the executor phase"
                  }
                >
                  Approve plan
                </button>
              </div>
              {notes.trim().length > 0 && (
                <p className="proposal-hint">
                  Heads up: <strong>Approve plan</strong> will discard the {notes.trim().length}{" "}
                  characters in the box above.
                </p>
              )}
            </div>
          )}

          {isApproved && plan.approvedAt && (
            <div className="approved-banner">
              <span className="approved-mark">✓</span>
              <span>
                plan approved {formatRelative(plan.approvedAt)} · {plan.taskCount} task
                {plan.taskCount === 1 ? "" : "s"} queued for executor phase
              </span>
            </div>
          )}
        </div>
      )}

      {isErr && plan && <pre className="scan-err-body">{plan.message}</pre>}
    </div>
  );
}

function reducePlan(
  prev: PlanState,
  event: PlanEvent,
  repoName: string,
  nextId: () => number,
): PlanState {
  switch (event.type) {
    case "started": {
      return {
        phase: "running",
        repoPath: event.repoPath,
        repoName: event.repoName,
        elapsedMs: 0,
        messages: [],
      };
    }
    case "progress": {
      if (prev.phase !== "running") return prev;
      return { ...prev, elapsedMs: event.durationMs };
    }
    case "sdk_message": {
      if (prev.phase !== "running") return prev;
      const entry: MessageEntry = {
        id: nextId(),
        subtype: event.subtype,
        summary: event.summary,
        ts: event.ts,
      };
      return { ...prev, messages: [...prev.messages, entry] };
    }
    case "done": {
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
    }
    case "error": {
      const messages = prev.phase === "running" ? prev.messages : [];
      const repoPath = prev.phase !== "idle" ? prev.repoPath : "";
      return { phase: "error", repoPath, repoName, message: event.message, messages };
    }
  }
}

function reduceAnalyze(
  prev: AnalyzeState,
  event: AnalyzeEvent,
  repoName: string,
  nextId: () => number,
): AnalyzeState {
  switch (event.type) {
    case "started": {
      return {
        phase: "running",
        repoPath: event.repoPath,
        repoName: event.repoName,
        elapsedMs: 0,
        messages: [],
      };
    }
    case "progress": {
      if (prev.phase !== "running") return prev;
      return { ...prev, elapsedMs: event.durationMs };
    }
    case "sdk_message": {
      if (prev.phase !== "running") return prev;
      const entry: MessageEntry = {
        id: nextId(),
        subtype: event.subtype,
        summary: event.summary,
        ts: event.ts,
      };
      return { ...prev, messages: [...prev.messages, entry] };
    }
    case "done": {
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
    }
    case "error": {
      const messages = prev.phase === "running" ? prev.messages : [];
      const repoPath = prev.phase !== "idle" ? prev.repoPath : "";
      return { phase: "error", repoPath, repoName, message: event.message, messages };
    }
  }
}

function IterationBanner({
  iteration,
  thoroughness,
  kind,
}: {
  iteration: number;
  thoroughness: Thoroughness;
  kind: "analyze" | "plan";
}) {
  const mode = modeForIteration(iteration, thoroughness);
  if (mode === "normal") return null;
  const agent = kind === "analyze" ? "analyzer" : "planner";
  if (mode === "narrow") {
    return (
      <div className="iter-defaults-banner">
        <span>
          <strong>Narrowing mode active</strong> · iter {iteration} ({thoroughness})
        </span>
        <span>
          The {agent} has been told to stop re-asking questions you've already answered
          and stop inventing new angles on settled points. Only genuinely unresolved
          ambiguity should reach you in this round.
        </span>
      </div>
    );
  }
  return (
    <div className="iter-defaults-banner">
      <span>
        <strong>Defaults mode active</strong> · iter {iteration} ({thoroughness})
      </span>
      <span>
        The {agent} has been told to commit to <strong>RECOMMENDED defaults</strong>{" "}
        for any remaining ambiguity rather than keep probing. Read the proposal — if a
        default is wrong, submit notes to override it; otherwise click <strong>Approve
        as-is</strong> to accept the {agent}'s judgement and move on.
      </span>
    </div>
  );
}

function IterationControl({
  iteration,
  thoroughness,
  onThoroughnessChange,
  label,
}: {
  iteration: number;
  thoroughness: Thoroughness;
  onThoroughnessChange: (t: Thoroughness) => void;
  label: string;
}) {
  const mode = modeForIteration(iteration, thoroughness);
  const bounds = THOROUGHNESS_BOUNDS[thoroughness];
  const nextChange =
    mode === "normal"
      ? `narrows at iter ${bounds.narrow}`
      : mode === "narrow"
        ? `defaults at iter ${bounds.defaults}`
        : "converging — no more probing";
  return (
    <div className={`iter-control iter-control-${mode}`} title={`${label} loop pace`}>
      <span className="iter-control-label">
        iter <strong>{iteration}</strong>
      </span>
      <span
        className={`iter-control-mode iter-control-mode-${mode}`}
        title={
          mode === "normal"
            ? "The agent is free to ask clarifying questions and explore alternatives. Default behavior at the start of a refine loop."
            : mode === "narrow"
              ? "The agent has been told to stop re-asking questions you've already answered. Only genuinely unresolved ambiguity should reach you."
              : "The agent has been told to commit to RECOMMENDED defaults for any remaining ambiguity rather than keep probing. Read the proposal carefully."
        }
      >
        {mode}
      </span>
      <select
        className="iter-control-select"
        value={thoroughness}
        onChange={(e) => onThoroughnessChange(e.target.value as Thoroughness)}
        title={`loop pace · ${nextChange}`}
      >
        <option value="thorough">thorough</option>
        <option value="balanced">balanced</option>
        <option value="fast">fast</option>
      </select>
      <InfoBadge label="About thoroughness">
        <strong>Thoroughness</strong> controls how many refine iterations the{" "}
        {label} gets before being told to commit to defaults.
        <ul>
          <li>
            <code>thorough</code> — the agent stays in <code>normal</code> mode
            longest, narrowing late, converging late. Best when you want to
            explore the problem space.
          </li>
          <li>
            <code>balanced</code> — default. Narrows at iter 3, defaults at iter 5.
          </li>
          <li>
            <code>fast</code> — narrows at iter 2, defaults at iter 3. The agent
            commits to a proposal quickly with less back-and-forth.
          </li>
        </ul>
        The mode pill on the left (<code>{mode}</code>) shows where this loop
        is right now. Bumping thoroughness extends the runway; lowering it
        forces convergence sooner.
      </InfoBadge>
    </div>
  );
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diffMs = Date.now() - t;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

function SmokeStream({ smoke }: { smoke: SmokeState }) {
  if (smoke.phase === "idle") return null;

  const isStreaming = smoke.phase === "streaming";
  const isErr = smoke.phase === "error";

  return (
    <div className={`stream ${isStreaming ? "stream-live" : isErr ? "stream-err" : "stream-done"}`}>
      <div className="stream-head">
        <span className="stream-label">
          {isStreaming ? "live events" : isErr ? "stream error" : "completed events"}
        </span>
        {smoke.phase === "done" && (
          <span className="stream-meta">
            {smoke.messages.length} message{smoke.messages.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {smoke.messages.length === 0 && isStreaming && (
        <div className="stream-empty">waiting for first SDK message…</div>
      )}

      {smoke.messages.length > 0 && (
        <ul className="stream-log">
          {smoke.messages.map((m) => (
            <li key={m.id} className="stream-row">
              <span className={`stream-pill stream-pill-${m.subtype}`}>{m.subtype}</span>
              <span className="stream-summary">{m.summary || <em className="muted">·</em>}</span>
            </li>
          ))}
        </ul>
      )}

      {smoke.phase === "done" && smoke.response && (
        <div className="stream-final">
          <span className="stream-final-label">response</span>
          <pre className="stream-final-body">{smoke.response}</pre>
        </div>
      )}

      {smoke.phase === "error" && (
        <pre className="stream-final-body stream-err-body">{smoke.message}</pre>
      )}
    </div>
  );
}
