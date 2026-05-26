import { useEffect, useReducer, useRef, useState } from "react";
import { api } from "./api";
import { navigate } from "./router";
import { initRunViewModel, runReducer } from "./runReducer";
import type { LogEvent, RunManifest, RunViewModel } from "./runTypes";

// D3 lands the full dashboard with repo grid + foreground panel. This stub
// fetches the manifest + opens the log stream so the wiring is exercised
// end-to-end; D3+D4+D5 commits replace the rendered output with the real
// repo grid and task panels.
export function RunDashboard({ runId }: { runId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [vm, dispatch] = useReducer(
    (s: RunViewModel | null, action: { type: "init" | "update"; payload: unknown }) => {
      if (action.type === "init") return action.payload as RunViewModel;
      if (s === null) return null;
      return runReducer(s, action.payload as Parameters<typeof runReducer>[1]);
    },
    null,
  );
  const streamRef = useRef<{ close: () => void } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { manifest } = await api.getManifest(runId);
        if (cancelled) return;
        dispatch({
          type: "init",
          payload: initRunViewModel({ manifest, fetchedAt: new Date().toISOString() }),
        });

        streamRef.current = api.streamRunLog(runId, 0, {
          onTail: ({ events, nextByte }) => {
            for (const e of events as LogEvent[]) {
              dispatch({ type: "update", payload: { kind: "event", event: e } });
            }
            dispatch({ type: "update", payload: { kind: "bookmark", byteCursor: nextByte } });
          },
          onIdle: ({ nextByte }) => {
            dispatch({ type: "update", payload: { kind: "bookmark", byteCursor: nextByte } });
          },
          onError: (msg) => setError(msg),
        });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.close();
    };
  }, [runId]);

  if (error) {
    return (
      <PageShell>
        <pre className="scan-err-body">{error}</pre>
        <button className="btn btn-ghost" onClick={() => navigate("/")}>
          Back to home
        </button>
      </PageShell>
    );
  }

  if (!vm) {
    return (
      <PageShell>
        <p className="muted">loading run…</p>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <DashboardHeader vm={vm} />
      <section className="card card-form">
        <div className="card-head">
          <h2>Repos</h2>
          <span className="card-sub">
            full repo grid + task foreground arrive in the next commit
          </span>
        </div>
        <ul className="run-repo-stub-list">
          {vm.manifest.repos.map((r) => (
            <li key={r.path} className="run-repo-stub">
              <span className="repo-name">{r.name}</span>
              <span className={`pill pill-${r.status}`}>{r.status}</span>
              <span className="repo-path" title={r.path}>
                {r.path}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <LogTail vm={vm} />
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="page">
      <header className="hdr">
        <div className="hdr-mark">
          <button
            className="hdr-back"
            onClick={() => navigate("/")}
            aria-label="back to home"
          >
            ◂
          </button>
          <span className="hdr-glyph">◆</span>
          <span className="hdr-name">run dashboard</span>
        </div>
        <div className="hdr-meta">
          <span className="hdr-meta-label">local dev</span>
          <span className="hdr-meta-dot" />
          <span className="hdr-meta-value">:3737 ⇄ :5173</span>
        </div>
      </header>
      <main className="grid">{children}</main>
      <footer className="ftr">
        <span>v0.1 · dashboard</span>
      </footer>
    </div>
  );
}

function DashboardHeader({ vm }: { vm: RunViewModel }) {
  const m: RunManifest = vm.manifest;
  return (
    <section className="card card-run-header">
      <div className="card-head">
        <h2>
          <code className="run-id">{m.runId}</code>
        </h2>
        <div className="run-header-meta">
          <span className={`pill pill-${m.status}`}>{m.status}</span>
          <span className={`pill pill-loop-${vm.loopState}`}>{vm.loopState}</span>
          <span className="run-header-budget">
            {m.budget.tokensUsed.toLocaleString()} tok
          </span>
          <span className="run-header-meta-pill">{m.config.autonomy}</span>
          <span className="run-header-meta-pill">{m.config.tier}</span>
        </div>
      </div>
    </section>
  );
}

function LogTail({ vm }: { vm: RunViewModel }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="card card-log-tail">
      <div className="card-head">
        <button
          className="btn btn-ghost btn-disclosure"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "▾" : "▸"} Raw events ({vm.recentEvents.length})
        </button>
        <span className="card-sub">byte {vm.byteCursor}</span>
      </div>
      {open && (
        <ul className="stream-log">
          {vm.recentEvents.slice(-50).map((e, i) => (
            <li key={i} className="stream-row">
              <span className="stream-pill stream-pill-event">{e.type}</span>
              <span className="stream-summary">{summarize(e)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function summarize(e: LogEvent): string {
  if ("repoPath" in e && "taskId" in e) return `${e.repoPath} · ${e.taskId}`;
  if ("repoPath" in e) return e.repoPath;
  if ("runId" in e) return e.runId;
  if ("reason" in e) return e.reason;
  return "";
}

export default RunDashboard;
