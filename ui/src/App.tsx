import { useCallback, useEffect, useState } from "react";
import { api, type AuthMode, type AuthStatus, type RunsResponse, type SmokeResult } from "./api";

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

export default function App() {
  const [authState, reloadAuth] = useAsync<AuthStatus>(() => api.authStatus(), []);
  const [runsState, reloadRuns] = useAsync<RunsResponse>(() => api.listRuns(), []);
  const [chosenMode, setChosenMode] = useState<AuthMode | null>(null);
  const [smoke, setSmoke] = useState<{ phase: "idle" } | { phase: "running" } | { phase: "done"; result: SmokeResult }>({ phase: "idle" });

  useEffect(() => {
    if (authState.phase === "ok" && chosenMode === null) {
      const detected = authState.data.preferredAuthMode
        ?? (authState.data.subscriptionDetected ? "subscription" : authState.data.apiKeyDetected ? "api" : null);
      if (detected) setChosenMode(detected);
    }
  }, [authState, chosenMode]);

  const onSelectMode = async (mode: AuthMode) => {
    setChosenMode(mode);
    await api.setAuthMode(mode);
    reloadAuth();
  };

  const onSmoke = async () => {
    if (!chosenMode) return;
    setSmoke({ phase: "running" });
    try {
      const result = await api.smoke(chosenMode);
      setSmoke({ phase: "done", result });
    } catch (err) {
      setSmoke({
        phase: "done",
        result: { ok: false, mode: chosenMode, error: err instanceof Error ? err.message : String(err) },
      });
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
                unavailableHint="add ANTHROPIC_API_KEY to .env or your shell and restart the server"
                selected={chosenMode === "api"}
                onSelect={onSelectMode}
              />
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
                    smoke.phase === "running" ||
                    (chosenMode === "api" && !authState.data.apiKeyDetected) ||
                    (chosenMode === "subscription" && !authState.data.subscriptionDetected)
                  }
                >
                  {smoke.phase === "running" ? "testing…" : "Test connection"}
                </button>
                <span className="action-hint">
                  sends one short prompt and reports back tokens + latency
                </span>
              </div>

              {smoke.phase === "done" && <SmokeReadout result={smoke.result} />}
            </>
          )}
        </section>

        <section className="card card-runs">
          <div className="card-head">
            <h2>Runs</h2>
            <button className="btn btn-ghost" onClick={reloadRuns} aria-label="refresh runs">
              refresh
            </button>
          </div>
          {runsState.phase === "loading" && <p className="muted">loading…</p>}
          {runsState.phase === "err" && <p className="err">failed: {runsState.error}</p>}
          {runsState.phase === "ok" && (
            <>
              <p className="muted state-root">{runsState.data.stateRoot}</p>
              {runsState.data.runs.length === 0 ? (
                <div className="empty">
                  <p className="empty-title">no runs yet</p>
                  <p className="empty-body">
                    Once Phase 3+ lands, runs created by <code>agent run</code> will appear here.
                  </p>
                </div>
              ) : (
                <ul className="runs">
                  {runsState.data.runs.map((r) => (
                    <li key={r.runId} className="run">
                      <code className="run-id">{r.runId}</code>
                      <span className={`pill pill-${r.status}`}>{r.status}</span>
                      <span className="run-meta">
                        {r.repoCount} repo{r.repoCount === 1 ? "" : "s"} · {r.tokensUsed.toLocaleString()} tok · {r.authMode}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>

        <section className="card card-placeholder">
          <div className="card-head">
            <h2>Discover & run</h2>
            <span className="card-sub">Phase 3+ — not built yet</span>
          </div>
          <p className="muted">
            Repo discovery, multi-select, analyze → plan → execute will surface here once those
            phases ship. The wiring exists; the UI will mount onto your existing state files.
          </p>
        </section>
      </main>

      <footer className="ftr">
        <span>v0.1 · auth + smoke test only</span>
      </footer>
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

function SmokeReadout({ result }: { result: SmokeResult }) {
  return (
    <div className={`smoke ${result.ok ? "smoke-ok" : "smoke-fail"}`}>
      <div className="smoke-head">
        <span className="smoke-status">{result.ok ? "connection ok" : "connection failed"}</span>
        {result.ok && (
          <span className="smoke-meta">
            {result.tokensUsed} tok · {result.durationMs} ms
          </span>
        )}
      </div>
      {result.ok && result.response && <pre className="smoke-body">{result.response}</pre>}
      {!result.ok && result.error && <pre className="smoke-body smoke-err">{result.error}</pre>}
    </div>
  );
}
