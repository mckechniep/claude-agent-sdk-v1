import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { api } from "./api";
import RepoCard from "./RepoCard";
import TaskForegroundPanel from "./TaskForegroundPanel";
import { navigate } from "./router";
import { Breadcrumbs } from "./Breadcrumbs";
import { initRunViewModel, runReducer } from "./runReducer";
import type {
  LogEvent,
  RepoEntry,
  RunManifest,
  RunUpdate,
  RunViewModel,
  TaskState,
} from "./runTypes";

// Event types that signal the manifest may have changed on disk; on these
// we re-fetch the manifest so the repo grid reflects fresh state.
const MANIFEST_REFRESH_TYPES: ReadonlySet<LogEvent["type"]> = new Set([
  "phase_completed",
  "task_completed",
  "task_failed",
  "checkpoint_paused",
  "run_loop_paused",
  "run_loop_completed",
  "run_loop_failed",
  "run_loop_awaiting_decision",
  "run_finalized",
]);

type DashAction =
  | { type: "init"; vm: RunViewModel }
  | { type: "update"; update: RunUpdate };

function dashReducer(state: RunViewModel | null, action: DashAction): RunViewModel | null {
  if (action.type === "init") return action.vm;
  if (state === null) return null;
  return runReducer(state, action.update);
}

export function RunDashboard({ runId }: { runId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [submittingResume, setSubmittingResume] = useState(false);
  const [submittingDecision, setSubmittingDecision] = useState(false);
  const [submittingRunConfirm, setSubmittingRunConfirm] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [vm, dispatch] = useReducer(dashReducer, null);
  const streamRef = useRef<{ close: () => void } | null>(null);

  const refreshManifest = useCallback(async (): Promise<void> => {
    try {
      const { manifest } = await api.getManifest(runId);
      dispatch({
        type: "update",
        update: { kind: "manifest", manifest, fetchedAt: new Date().toISOString() },
      });
    } catch (err) {
      // Don't blow up the whole dashboard on a single manifest refresh failure;
      // the log stream will keep ticking and the next refresh trigger will retry.
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [runId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { manifest } = await api.getManifest(runId);
        if (cancelled) return;
        dispatch({
          type: "init",
          vm: initRunViewModel({ manifest, fetchedAt: new Date().toISOString() }),
        });

        streamRef.current = api.streamRunLog(runId, 0, {
          onTail: ({ events, nextByte }) => {
            for (const e of events as LogEvent[]) {
              dispatch({ type: "update", update: { kind: "event", event: e } });
              if (MANIFEST_REFRESH_TYPES.has(e.type)) {
                void refreshManifest();
              }
            }
            dispatch({ type: "update", update: { kind: "bookmark", byteCursor: nextByte } });
          },
          onIdle: ({ nextByte }) => {
            dispatch({ type: "update", update: { kind: "bookmark", byteCursor: nextByte } });
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
  }, [runId, refreshManifest]);

  const onResume = async (): Promise<void> => {
    if (submittingResume) return;
    setSubmittingResume(true);
    setError(null);
    try {
      await api.resumeRun(runId);
      await refreshManifest();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmittingResume(false);
    }
  };

  const onApproveDecision = useCallback(
    async (repoPath: string, kind: "proposal" | "plan"): Promise<void> => {
      if (submittingDecision) return;
      setSubmittingDecision(true);
      try {
        await api.submitDecisions(runId, {
          [kind === "proposal" ? "proposals" : "plans"]: { [repoPath]: "accept" },
        });
        // The background loop reads this on its next tick; manifest will
        // refresh on the next state-changing event.
        await refreshManifest();
      } finally {
        setSubmittingDecision(false);
      }
    },
    [runId, refreshManifest, submittingDecision],
  );

  const onConfirmRun = async (): Promise<void> => {
    if (submittingRunConfirm) return;
    setSubmittingRunConfirm(true);
    setError(null);
    try {
      await api.submitDecisions(runId, { runConfirmed: true });
      // Manifest will refresh on the next state-changing log event
      // (the orchestrator emits phase/task events as execution begins).
      await refreshManifest();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmittingRunConfirm(false);
    }
  };

  if (error && !vm) {
    return (
      <PageShell runId={runId}>
        <pre className="scan-err-body">{error}</pre>
        <button className="btn btn-ghost" onClick={() => navigate("/")}>
          Back to home
        </button>
      </PageShell>
    );
  }

  if (!vm) {
    return (
      <PageShell runId={runId}>
        <p className="muted">loading run…</p>
      </PageShell>
    );
  }

  const selected = findSelected(vm, selectedTaskId);

  return (
    <PageShell runId={runId}>
      <DashboardHeader vm={vm} onResume={onResume} submittingResume={submittingResume} />
      {vm.manifest.status === "awaiting-run-confirmation" && (
        <RunConfirmationGate
          vm={vm}
          onConfirm={onConfirmRun}
          submitting={submittingRunConfirm}
        />
      )}
      {error && <pre className="scan-err-body card-form">{error}</pre>}
      <section className="card card-form">
        <div className="card-head">
          <h2>Repos ({vm.manifest.repos.length})</h2>
          {vm.currentRepoPath && (
            <span className="card-sub">
              current: <code>{labelOf(vm.manifest.repos, vm.currentRepoPath)}</code>
            </span>
          )}
        </div>
        <div className="repo-grid">
          {vm.manifest.repos.map((repo) => (
            <RepoCard
              key={repo.path}
              vm={vm}
              repo={repo}
              runId={vm.runId}
              autonomy={vm.manifest.config.autonomy}
              selectedTaskId={selectedTaskId}
              onSelectTask={setSelectedTaskId}
              onDecision={(kind) => onApproveDecision(repo.path, kind)}
            />
          ))}
        </div>
      </section>

      {selected && (
        <TaskForegroundPanel
          vm={vm}
          repo={selected.repo}
          task={selected.task}
          onClose={() => setSelectedTaskId(null)}
        />
      )}

      <LogTail vm={vm} />
    </PageShell>
  );
}

function findSelected(
  vm: RunViewModel,
  selectedTaskId: string | null,
): { repo: RepoEntry; task: TaskState } | null {
  if (!selectedTaskId) return null;
  for (const repo of vm.manifest.repos) {
    const task = repo.taskState?.find((t) => t.taskId === selectedTaskId);
    if (task) return { repo, task };
  }
  return null;
}

function labelOf(repos: RepoEntry[], path: string): string {
  return repos.find((r) => r.path === path)?.name ?? path;
}

function PageShell({
  children,
  runId,
}: {
  children: React.ReactNode;
  runId?: string;
}) {
  const crumbs = runId
    ? [
        { label: "Home", href: "/" },
        { label: "Runs", href: "/" },
        { label: runId.slice(0, 8) + "…", title: runId },
      ]
    : [{ label: "Home", href: "/" }, { label: "Run dashboard" }];
  return (
    <div className="page">
      <header className="hdr">
        <div className="hdr-mark">
          <span className="hdr-glyph">◆</span>
          <span className="hdr-name">run dashboard</span>
        </div>
        <div className="hdr-meta">
          <span className="hdr-meta-label">local dev</span>
          <span className="hdr-meta-dot" />
          <span className="hdr-meta-value">:3737 ⇄ :5173</span>
        </div>
      </header>
      <Breadcrumbs crumbs={crumbs} />
      <main className="grid">{children}</main>
      <footer className="ftr">
        <span>v0.1 · dashboard</span>
      </footer>
    </div>
  );
}

function DashboardHeader({
  vm,
  onResume,
  submittingResume,
}: {
  vm: RunViewModel;
  onResume: () => Promise<void>;
  submittingResume: boolean;
}) {
  const m: RunManifest = vm.manifest;
  const isPaused = m.status === "paused";
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
          {isPaused && (
            <button
              className="btn btn-primary btn-tight"
              onClick={() => void onResume()}
              disabled={submittingResume}
            >
              {submittingResume ? "resuming…" : "Resume"}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function RunConfirmationGate({
  vm,
  onConfirm,
  submitting,
}: {
  vm: RunViewModel;
  onConfirm: () => Promise<void>;
  submitting: boolean;
}) {
  const repos = vm.manifest.repos.filter(
    (r) => r.status !== "skipped" && r.status !== "failed",
  );
  const totalTasks = repos.reduce(
    (n, r) => n + (r.taskState?.length ?? 0),
    0,
  );
  return (
    <section className="card card-run-gate">
      <div className="run-gate-head">
        <span className="run-gate-eyebrow">Run preflight complete</span>
        <h2 className="run-gate-title">Ready to execute</h2>
      </div>
      <p className="run-gate-summary">
        <strong>{repos.length}</strong> repo{repos.length === 1 ? "" : "s"} have
        approved plans · <strong>{totalTasks}</strong> task
        {totalTasks === 1 ? "" : "s"} will be executed
      </p>
      <p className="run-gate-detail">
        Clicking <strong>Confirm &amp; start execution</strong> hands control to the
        executor. Each task runs against its repo with the configured model tier
        ({vm.manifest.config.tier}), commits to a per-task branch when tests pass,
        and reports progress live below.
      </p>
      <div className="run-gate-actions">
        <button
          className="btn btn-primary"
          onClick={() => void onConfirm()}
          disabled={submitting}
        >
          {submitting ? "starting…" : "Confirm & start execution"}
        </button>
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
