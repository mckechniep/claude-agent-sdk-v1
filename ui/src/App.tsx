import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type AuthMode,
  type AuthStatus,
  type DiscoveredRepo,
  type DiscoverEvent,
  type RunsResponse,
  type SmokeEvent,
} from "./api";

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

export default function App() {
  const [authState, reloadAuth] = useAsync<AuthStatus>(() => api.authStatus(), []);
  const [runsState, reloadRuns] = useAsync<RunsResponse>(() => api.listRuns(), []);
  const [chosenMode, setChosenMode] = useState<AuthMode | null>(null);
  const [smoke, setSmoke] = useState<SmokeState>({ phase: "idle" });
  const [discover, setDiscover] = useState<DiscoverState>({ phase: "idle" });
  const [scanPath, setScanPath] = useState<string>("~/projects");
  const [scanDepth, setScanDepth] = useState<number>(2);
  const streamRef = useRef<{ close: () => void } | null>(null);
  const discoverStreamRef = useRef<{ close: () => void } | null>(null);
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
      discoverStreamRef.current?.close();
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

          <DiscoverReadout discover={discover} />
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

function DiscoverReadout({ discover }: { discover: DiscoverState }) {
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
        {!isErr && (
          <span className="scan-meta">
            depth {discover.phase === "scanning" ? discover.depth : discover.depth}
          </span>
        )}
      </div>

      {discover.repos.length === 0 && isScanning && (
        <div className="scan-empty-state">walking directory tree…</div>
      )}

      {discover.repos.length > 0 && (
        <ul className="repos">
          {discover.repos.map((repo) => (
            <RepoRow key={repo.path} repo={repo} />
          ))}
        </ul>
      )}

      {isErr && <pre className="scan-err-body">{discover.message}</pre>}

      {discover.repos.length === 0 && discover.phase === "done" && (
        <div className="scan-empty-state">no git repos found at this depth</div>
      )}
    </div>
  );
}

function RepoRow({ repo }: { repo: DiscoveredRepo }) {
  const date = repo.lastCommitDate ? formatRelative(repo.lastCommitDate) : "no commits";
  return (
    <li className="repo-row">
      <div className="repo-head">
        <span className="repo-name">{repo.name}</span>
        <span className={`repo-stack repo-stack-${repo.stack}`}>{repo.stack}</span>
        {repo.isDirty && <span className="repo-flag repo-flag-dirty">dirty</span>}
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
    </li>
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
