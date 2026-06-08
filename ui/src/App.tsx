import { useCallback, useEffect, useRef, useState } from "react";
import { api, type AuthMode, type AuthStatus, type RunsResponse, type SmokeEvent } from "./api";
import { navigate } from "./router";
import { Breadcrumbs } from "./Breadcrumbs";
import { DefaultsPanel } from "./DefaultsPanel";
import { loadDefaults, saveDefaults } from "./modelDefaults";
import type { PhaseSelections } from "./modelConfig";

type LoadState<T> =
  | { phase: "loading" }
  | { phase: "ok"; data: T }
  | { phase: "err"; error: string };

function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): [LoadState<T>, () => void] {
  const [state, setState] = useState<LoadState<T>>({ phase: "loading" });
  const reload = useCallback(() => {
    setState({ phase: "loading" });
    fn()
      .then((data) => setState({ phase: "ok", data }))
      .catch((err: unknown) =>
        setState({ phase: "err", error: err instanceof Error ? err.message : String(err) }),
      );
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

export default function App() {
  const [authState, reloadAuth] = useAsync<AuthStatus>(() => api.authStatus(), []);
  const [runsState, reloadRuns] = useAsync<RunsResponse>(() => api.listRuns(), []);
  const [chosenMode, setChosenMode] = useState<AuthMode | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const [smoke, setSmoke] = useState<SmokeState>({ phase: "idle" });
  const [defaults, setDefaults] = useState<PhaseSelections>(() =>
    loadDefaults(window.localStorage),
  );
  const updateDefaults = (next: PhaseSelections): void => {
    setDefaults(next);
    saveDefaults(next, window.localStorage);
  };
  const streamRef = useRef<{ close: () => void } | null>(null);
  const messageIdRef = useRef(0);

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

  useEffect(
    () => () => {
      streamRef.current?.close();
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
              {runsState.phase === "ok" &&
                (() => {
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
                                setClearError(
                                  `${failed} of ${finished.length} could not be deleted`,
                                );
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
              <button className="btn btn-ghost" onClick={reloadRuns} aria-label="refresh runs">
                refresh
              </button>
            </div>
          </div>
          {clearError && (
            <p className="err" style={{ marginTop: 0 }}>
              {clearError}
            </p>
          )}
          {runsState.phase === "loading" && <p className="muted">loading…</p>}
          {runsState.phase === "err" && <p className="err">failed: {runsState.error}</p>}
          {runsState.phase === "ok" && (
            <>
              <p className="muted state-root">{runsState.data.stateRoot}</p>
              {runsState.data.runs.length === 0 ? (
                <div className="empty">
                  <p className="empty-title">no runs yet</p>
                  <p className="empty-body">
                    Click <strong>Start new run</strong> above to launch an orchestration run; it'll
                    appear here once it's underway.
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
                                api
                                  .deleteRun(r.runId)
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
              {deleteError && (
                <p className="err" style={{ marginTop: 0 }}>
                  {deleteError}
                </p>
              )}
            </>
          )}
        </section>

        <DefaultsPanel value={defaults} onChange={updateDefaults} />
      </main>

      <footer className="ftr">
        <span>v0.1 · auth · smoke · runs · defaults</span>
      </footer>
    </div>
  );
}

function reduceSmoke(prev: SmokeState, event: SmokeEvent, nextId: () => number): SmokeState {
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
      <span className="mode-state">
        {props.available ? (props.selected ? "active" : "available") : "unset"}
      </span>
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
