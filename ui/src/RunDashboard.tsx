import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { api, type AuthMode } from "./api";
import RepoCard from "./RepoCard";
import TaskForegroundPanel from "./TaskForegroundPanel";
import { navigate } from "./router";
import { Breadcrumbs } from "./Breadcrumbs";
import { initRunViewModel, runReducer } from "./runReducer";
import { InfoBadge } from "./InfoBadge";
import type {
  BudgetState,
  LogEvent,
  ModelCost,
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
  "run_loop_aborted",
  "run_loop_force_aborted",
  "run_loop_stop_requested",
  "run_recovered_from_crash",
  "run_retried_from_failure",
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

// How often to poll the manifest endpoint for fresh liveness signal. Chosen
// to be a bit faster than the server's 5 s heartbeat cadence so a stale
// indicator appears within one server-side miss rather than two.
const LIVENESS_POLL_MS = 3_000;

export interface LivenessSnapshot {
  loopActive: boolean;
  lastHeartbeatAt: string | null;
}

export function RunDashboard({ runId }: { runId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [submittingResume, setSubmittingResume] = useState(false);
  const [submittingDecision, setSubmittingDecision] = useState(false);
  const [submittingRunConfirm, setSubmittingRunConfirm] = useState(false);
  const [submittingStop, setSubmittingStop] = useState<"soft" | "force" | null>(null);
  const [forceConfirmOpen, setForceConfirmOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [vm, dispatch] = useReducer(dashReducer, null);
  const [liveness, setLiveness] = useState<LivenessSnapshot>({
    loopActive: false,
    lastHeartbeatAt: null,
  });
  const streamRef = useRef<{ close: () => void } | null>(null);

  const refreshManifest = useCallback(async (): Promise<void> => {
    try {
      const { manifest, loopActive, lastHeartbeatAt } = await api.getManifest(runId);
      dispatch({
        type: "update",
        update: { kind: "manifest", manifest, fetchedAt: new Date().toISOString() },
      });
      setLiveness({ loopActive, lastHeartbeatAt });
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
        const { manifest, loopActive, lastHeartbeatAt } = await api.getManifest(runId);
        if (cancelled) return;
        dispatch({
          type: "init",
          vm: initRunViewModel({ manifest, fetchedAt: new Date().toISOString() }),
        });
        setLiveness({ loopActive, lastHeartbeatAt });

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

  // Liveness polling: pings GET /manifest on a short interval so the
  // heartbeat indicator stays accurate even when no log events are firing
  // (e.g. the executor is mid-SDK-turn for 30s). Pauses for terminal
  // states since liveness no longer matters there. Skips while the tab is
  // hidden — no point burning network if the user isn't looking.
  const status = vm?.manifest.status;
  const shouldPoll =
    status !== undefined &&
    status !== "completed" &&
    status !== "failed";
  useEffect(() => {
    if (!shouldPoll) return;
    const tick = (): void => {
      if (document.visibilityState !== "visible") return;
      void refreshManifest();
    };
    const handle = window.setInterval(tick, LIVENESS_POLL_MS);
    return () => window.clearInterval(handle);
  }, [shouldPoll, refreshManifest]);

  // Billing-mode switch for paused/failed runs. null = keep the run's current
  // mode. apiKeyAvailable gates the "API key" option (you can't bill to a key
  // the server doesn't have).
  const [billingMode, setBillingMode] = useState<AuthMode | null>(null);
  const [apiKeyAvailable, setApiKeyAvailable] = useState(false);
  useEffect(() => {
    void api
      .authStatus()
      .then((s) => setApiKeyAvailable(s.apiKeyDetected))
      .catch(() => setApiKeyAvailable(false));
  }, []);

  const onResume = async (): Promise<void> => {
    if (submittingResume) return;
    setSubmittingResume(true);
    setError(null);
    try {
      await api.resumeRun(runId, billingMode ?? undefined);
      await refreshManifest();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmittingResume(false);
    }
  };

  const onSoftStop = async (): Promise<void> => {
    if (submittingStop) return;
    setSubmittingStop("soft");
    setError(null);
    try {
      await api.stopRun(runId, "soft");
      await refreshManifest();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmittingStop(null);
    }
  };

  const onForceStop = async (): Promise<void> => {
    if (submittingStop === "force") return;
    setSubmittingStop("force");
    setError(null);
    try {
      await api.stopRun(runId, "force");
      await refreshManifest();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmittingStop(null);
      setForceConfirmOpen(false);
    }
  };

  const [submittingRecover, setSubmittingRecover] = useState(false);
  const onRecover = async (): Promise<void> => {
    if (submittingRecover) return;
    setSubmittingRecover(true);
    setError(null);
    try {
      await api.recoverRun(runId);
      await refreshManifest();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmittingRecover(false);
    }
  };

  const [submittingRetry, setSubmittingRetry] = useState(false);
  const onRetryFromFailure = async (): Promise<void> => {
    if (submittingRetry) return;
    setSubmittingRetry(true);
    setError(null);
    try {
      await api.retryFromFailure(runId, billingMode ?? undefined);
      await refreshManifest();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmittingRetry(false);
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
      <DashboardHeader
        vm={vm}
        onResume={onResume}
        submittingResume={submittingResume}
        onSoftStop={onSoftStop}
        onRequestForceStop={() => setForceConfirmOpen(true)}
        submittingStop={submittingStop}
        liveness={liveness}
        onRecover={onRecover}
        submittingRecover={submittingRecover}
      />
      {forceConfirmOpen && (
        <ForceStopConfirm
          onConfirm={onForceStop}
          onCancel={() => setForceConfirmOpen(false)}
          submitting={submittingStop === "force"}
        />
      )}
      {(vm.manifest.status === "paused" || vm.manifest.status === "failed") && (
        <BillingSwitch
          current={vm.manifest.authMode}
          selected={billingMode}
          onChange={setBillingMode}
          apiKeyAvailable={apiKeyAvailable}
        />
      )}
      {vm.manifest.status === "failed" && (
        <FailedRunBanner
          vm={vm}
          onRetryFromFailure={onRetryFromFailure}
          submittingRetry={submittingRetry}
        />
      )}
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
  onSoftStop,
  onRequestForceStop,
  submittingStop,
  liveness,
  onRecover,
  submittingRecover,
}: {
  vm: RunViewModel;
  onResume: () => Promise<void>;
  submittingResume: boolean;
  onSoftStop: () => Promise<void>;
  onRequestForceStop: () => void;
  submittingStop: "soft" | "force" | null;
  liveness: LivenessSnapshot;
  onRecover: () => Promise<void>;
  submittingRecover: boolean;
}) {
  const m: RunManifest = vm.manifest;
  const isPaused = m.status === "paused";
  const isStopping = m.status === "stopping" || vm.loopState === "stopping";
  // Show Recover when liveness has gone fully offline AND the manifest still
  // claims a non-terminal status. Mirrors the LivenessIndicator's
  // classification logic — kept local rather than threaded so the dashboard
  // doesn't have to share derived state across components.
  const livenessKind = classifyLiveness({
    loopActive: liveness.loopActive,
    lastHeartbeatAt: liveness.lastHeartbeatAt,
    status: m.status,
    nowMs: Date.now(),
  }).kind;
  const canRecover = livenessKind === "offline";
  // Stoppable while the run is doing real work, including the transient
  // "stopping" state — clicking a second time during stopping promotes to
  // force-stop. Terminal/paused/preflight-confirmation states aren't.
  const STOPPABLE_STATUSES: ReadonlySet<RunManifest["status"]> = new Set([
    "running",
    "discovering",
    "selecting",
    "preflight",
    "stopping",
  ]);
  const canStop = STOPPABLE_STATUSES.has(m.status);
  return (
    <section className="card card-run-header">
      <div className="card-head">
        <h2>
          <code className="run-id">{m.runId}</code>
        </h2>
        <div className="run-header-meta">
          <MetaRow label="status">
            <span className={`pill pill-${m.status}`} title={describeStatus(m.status)}>
              {m.status}
            </span>
            <InfoBadge label="Run status legend" placement="bottom">
              <strong>Run status</strong> tracks what the orchestrator is doing.
              <ul>
                <li><code>discovering</code> — scanning the target directory for repos</li>
                <li><code>selecting</code> — waiting for you to pick which repos to include</li>
                <li><code>preflight</code> — running analyze + plan on each repo before execution</li>
                <li><code>awaiting-run-confirmation</code> — preflight done, waiting for you to confirm</li>
                <li><code>running</code> — executor is making changes</li>
                <li><code>stopping</code> — stop was requested; loop will exit after current task</li>
                <li><code>paused</code> — loop is stopped but the run can be resumed</li>
                <li><code>completed</code> / <code>failed</code> — terminal</li>
              </ul>
            </InfoBadge>
          </MetaRow>

          <MetaRow label="loop">
            <span
              className={`pill pill-loop-${vm.loopState}`}
              title="Derived from log events. Reflects what the background loop is doing right now — independent of the manifest's persisted status."
            >
              {vm.loopState}
            </span>
          </MetaRow>

          <MetaRow label="liveness">
            <LivenessIndicator
              loopActive={liveness.loopActive}
              lastHeartbeatAt={liveness.lastHeartbeatAt}
              status={m.status}
            />
          </MetaRow>

          <MetaRow label="budget">
            <span
              className="run-header-budget"
              title="Total Anthropic tokens consumed by this run so far — sum of input + output across all SDK queries. Includes cache reads/writes when prompt caching is active."
            >
              {m.budget.tokensUsed.toLocaleString()} tok
            </span>
            <SpendReadout budget={m.budget} authMode={m.authMode} />
          </MetaRow>

          <MetaRow label="autonomy">
            <span className="run-header-meta-pill" title={describeAutonomy(m.config.autonomy)}>
              {m.config.autonomy}
            </span>
            <InfoBadge label="Autonomy mode legend" placement="bottom">
              <strong>Autonomy</strong> controls how the loop runs and which
              gates stop it. All three modes still gate at proposal + plan +
              run-start <em>unless</em> the mode auto-approves them.
              <ul>
                <li>
                  <code>manual</code> — no background loop. You POST{" "}
                  <code>/step</code> yourself to advance each phase. Analyze
                  runs one repo at a time. Every approval gate is a manual
                  click. Best when you want full control or are debugging.
                </li>
                <li>
                  <code>supervised</code> — background loop runs
                  automatically between gates. <strong>Still stops at every
                  approval gate</strong> (proposal, plan, run-start); the
                  loop auto-resumes when you submit a decision. Preflight
                  runs repos in parallel up to the concurrency limit. Best
                  when you want hands-off scheduling but still want to
                  review each artifact.
                </li>
                <li>
                  <code>yolo</code> — background loop runs end-to-end with{" "}
                  <strong>no gates at all</strong>. Proposals, plans, and
                  run-start are auto-approved as they appear. Best when you
                  trust the plan and want zero-touch execution.
                </li>
              </ul>
            </InfoBadge>
          </MetaRow>

          <MetaRow label="models">
            <span className="run-header-meta-pill" title="Models used per phase">
              {modelSummary(m.config.model)}
            </span>
            <InfoBadge label="Per-phase models" placement="bottom">
              Each phase spawns its own agent with its own model:
              <ul>
                <li>analyze — <code>{m.config.model.analyze ?? m.config.model.default}</code></li>
                <li>plan — <code>{m.config.model.plan ?? m.config.model.default}</code></li>
                <li>execute — <code>{m.config.model.execute ?? m.config.model.default}</code></li>
              </ul>
              {m.config.effort && (
                <>
                  Effort overrides:
                  <ul>
                    {m.config.effort.default && (
                      <li>default — <code>{m.config.effort.default}</code></li>
                    )}
                    {m.config.effort.analyze && (
                      <li>analyze — <code>{m.config.effort.analyze}</code></li>
                    )}
                    {m.config.effort.plan && (
                      <li>plan — <code>{m.config.effort.plan}</code></li>
                    )}
                    {m.config.effort.execute && (
                      <li>execute — <code>{m.config.effort.execute}</code></li>
                    )}
                  </ul>
                </>
              )}
            </InfoBadge>
          </MetaRow>
        </div>

        <div className="run-header-actions">
          {isPaused && (
            <button
              className="btn btn-primary btn-tight"
              onClick={() => void onResume()}
              disabled={submittingResume}
              title="Restart the background loop from where it stopped. Tasks already completed are skipped; the next pending task picks up."
            >
              {submittingResume ? "resuming…" : "Resume"}
            </button>
          )}
          {canRecover && (
            <button
              className="btn btn-primary btn-tight"
              onClick={() => void onRecover()}
              disabled={submittingRecover}
              title="The background loop appears dead (no heartbeat in over a minute) but the run is still marked as active. Recover marks it as paused so you can Resume it cleanly."
            >
              {submittingRecover ? "recovering…" : "Recover this run"}
            </button>
          )}
          {canStop && !isStopping && (
            <button
              className="btn btn-ghost btn-tight"
              onClick={() => void onSoftStop()}
              disabled={submittingStop !== null}
              title="Stop after the current task completes"
            >
              {submittingStop === "soft" ? "stopping…" : "Stop"}
            </button>
          )}
          {isStopping && (
            <>
              <span className="muted run-header-stopping-hint" title="The current step will finish, then the loop will exit cleanly.">
                stopping after current task…
              </span>
              <button
                className="btn btn-danger btn-tight"
                onClick={onRequestForceStop}
                disabled={submittingStop === "force"}
                title="Cancel the in-flight task immediately. May leave a task in a half-done state."
              >
                {submittingStop === "force" ? "forcing…" : "Force stop"}
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

// Liveness thresholds. Server writes heartbeat every 5 s; if we haven't
// seen one in 15 s the loop is probably mid-step (slow indicator), beyond
// 60 s the process is presumed dead (offline indicator).
const LIVENESS_SLOW_AFTER_MS = 15_000;
const LIVENESS_OFFLINE_AFTER_MS = 60_000;

type LivenessKind = "live" | "slow" | "offline" | "idle";

function classifyLiveness(args: {
  loopActive: boolean;
  lastHeartbeatAt: string | null;
  status: RunManifest["status"];
  nowMs: number;
}): { kind: LivenessKind; ageMs: number | null } {
  // Terminal & paused states don't have a meaningful liveness — the loop
  // is supposed to be gone. Render as idle (gray dot, no age).
  if (
    args.status === "completed" ||
    args.status === "failed" ||
    args.status === "paused"
  ) {
    return { kind: "idle", ageMs: null };
  }
  if (!args.lastHeartbeatAt) {
    // Non-terminal status but no heartbeat ever — pre-heartbeat run, or
    // a manual-autonomy run that never started a loop. Treat as idle.
    return { kind: "idle", ageMs: null };
  }
  const beatMs = Date.parse(args.lastHeartbeatAt);
  if (!Number.isFinite(beatMs)) return { kind: "idle", ageMs: null };
  const ageMs = args.nowMs - beatMs;
  if (ageMs > LIVENESS_OFFLINE_AFTER_MS) return { kind: "offline", ageMs };
  if (!args.loopActive) {
    // Fresh heartbeat but loop reports inactive — probably the moment
    // between a stop and the next manifest poll. Treat as slow rather
    // than offline; will settle to idle within one poll cycle.
    return { kind: "slow", ageMs };
  }
  if (ageMs > LIVENESS_SLOW_AFTER_MS) return { kind: "slow", ageMs };
  return { kind: "live", ageMs };
}

function formatAge(ageMs: number): string {
  const seconds = Math.max(0, Math.floor(ageMs / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function LivenessIndicator({
  loopActive,
  lastHeartbeatAt,
  status,
}: {
  loopActive: boolean;
  lastHeartbeatAt: string | null;
  status: RunManifest["status"];
}) {
  // Self-ticking "X ago" — the manifest poll updates lastHeartbeatAt every
  // 3 s, but between polls we still want the label to count up so the user
  // sees motion. Ticks once per second.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const handle = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, []);

  const { kind, ageMs } = classifyLiveness({
    loopActive,
    lastHeartbeatAt,
    status,
    nowMs,
  });

  const label =
    kind === "live"
      ? "live"
      : kind === "slow"
        ? "slow"
        : kind === "offline"
          ? "offline"
          : "idle";
  const ageLabel = ageMs !== null ? ` · ${formatAge(ageMs)}` : "";
  const title =
    kind === "live"
      ? "Background loop is alive and the SDK is responsive."
      : kind === "slow"
        ? "Loop hasn't sent a heartbeat in a while — usually a long-running step. If this persists, click Force stop."
        : kind === "offline"
          ? "No heartbeat in over a minute. The loop is likely dead — Resume to restart."
          : "No active loop. This is normal for manual-autonomy runs and for paused / completed runs.";

  return (
    <span
      className={`pill pill-liveness pill-liveness-${kind}`}
      title={title}
      aria-label={`Loop liveness: ${title}`}
    >
      <span className="pill-liveness-dot" aria-hidden />
      <span className="pill-liveness-label">
        {label}
        {ageLabel}
      </span>
    </span>
  );
}

/**
 * Banner shown above the repo grid when manifest.status === "failed".
 *
 * Surfaces what failed (per-repo summary with the failed-task reasons)
 * and offers two recovery paths:
 *   - Retry from failure → reuses this run, resets failed tasks to
 *     pending, restarts the loop. Completed work is preserved.
 *   - Start a new run → navigates home for a fresh runId + config.
 *
 * Designed to be the most prominent thing on the page when the user
 * lands on a failed dashboard so they're never left wondering "now what?"
 */
function FailedRunBanner({
  vm,
  onRetryFromFailure,
  submittingRetry,
}: {
  vm: RunViewModel;
  onRetryFromFailure: () => Promise<void>;
  submittingRetry: boolean;
}) {
  const repos = vm.manifest.repos;
  // "Interrupted" covers both shapes of failure: explicit repo.status=failed
  // (clean skip-repo case) AND repo.status=executing with the run aborted
  // mid-step (thrown-exception case — e.g. onFailure="stop" or SDK error).
  // Pre-execution states are excluded because retry can't help them.
  const interruptedRepos = repos.filter(isInterruptedRepoForBanner);
  const totalRepos = repos.filter((r) => r.status !== "skipped").length;

  const summaries = interruptedRepos.map((r) => {
    const failedTask = r.taskState?.find((t) => t.status === "failed");
    const inProgressTask = r.taskState?.find((t) => t.status === "in_progress");
    const completedCount = r.taskState?.filter((t) => t.status === "completed").length ?? 0;
    const totalTasks = r.taskState?.length ?? 0;
    const unreachedCount =
      r.taskState?.filter((t) => t.status === "pending" || t.status === "in_progress").length ?? 0;

    // Build the "why this repo is in the banner" message. Prefer the failed
    // task's reason; fall back to "interrupted mid-execution" when the repo
    // got here via an exception that didn't mark any task failed.
    let taskTitle: string | null = null;
    let reason: string;
    if (failedTask) {
      taskTitle = failedTask.title;
      const raw = failedTask.failureReason?.split("\n")[0]?.trim() ?? "no reason recorded";
      reason = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
    } else if (inProgressTask) {
      taskTitle = inProgressTask.title;
      reason = `interrupted mid-execution (${completedCount}/${totalTasks} tasks done)`;
    } else {
      reason = `interrupted before task ${completedCount + 1}/${totalTasks} could start`;
    }

    return {
      name: r.name,
      repoStatus: r.status,
      taskTitle,
      reason,
      unreachedCount,
    };
  });

  // Total retryable tasks across all interrupted repos. The retry endpoint
  // will reset failed/in_progress → pending and pick all of these up.
  const retryableTaskCount = interruptedRepos.reduce(
    (n, r) =>
      n +
      (r.taskState?.filter(
        (t) => t.status !== "completed" && t.status !== "skipped",
      ).length ?? 0),
    0,
  );

  // Title copy depends on the failure shape: if any repo is explicitly failed,
  // the user wants accusatory phrasing ("hit an unrecoverable failure"). If
  // none are explicitly failed, the run was killed by an exception escape and
  // "interrupted" is the more accurate word.
  const anyExplicitlyFailed = interruptedRepos.some((r) => r.status === "failed");
  const titleText = anyExplicitlyFailed
    ? `${interruptedRepos.length} of ${totalRepos} repo${totalRepos === 1 ? "" : "s"} hit an unrecoverable failure`
    : `${interruptedRepos.length} of ${totalRepos} repo${totalRepos === 1 ? "" : "s"} interrupted mid-execution`;

  return (
    <section className="card card-failed-banner" role="alert" aria-labelledby="failed-run-title">
      <div className="failed-banner-head">
        <span className="failed-banner-eyebrow">Run failed</span>
        <h2 className="failed-banner-title" id="failed-run-title">
          {titleText}
        </h2>
      </div>

      {summaries.length > 0 && (
        <ul className="failed-banner-list">
          {summaries.map((s) => (
            <li key={s.name} className="failed-banner-row">
              <code className="failed-banner-name">{s.name}</code>
              <span
                className={`pill pill-${s.repoStatus} failed-banner-repo-status`}
                title={
                  s.repoStatus === "failed"
                    ? "This repo was explicitly marked failed — a task hit its retry ceiling or the on-failure policy stopped further work."
                    : `This repo is in '${s.repoStatus}' but the run was killed by an exception before it could be settled. Retry will pick up the unfinished tasks.`
                }
              >
                {s.repoStatus}
              </span>
              {s.taskTitle && (
                <span className="failed-banner-task" title={s.taskTitle}>
                  {s.taskTitle}
                </span>
              )}
              <span
                className="failed-banner-reason"
                title="First failure reason — full output is in the repo card below."
              >
                {s.reason}
              </span>
              {s.unreachedCount > 0 && (
                <span
                  className="failed-banner-unreached"
                  title={`${s.unreachedCount} task${s.unreachedCount === 1 ? "" : "s"} in this repo never got to run. They'll be re-attempted on retry.`}
                >
                  +{s.unreachedCount} unreached
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="failed-banner-actions">
        <button
          className="btn btn-primary"
          onClick={() => void onRetryFromFailure()}
          disabled={submittingRetry || retryableTaskCount === 0}
          title={
            retryableTaskCount === 0
              ? "No failed tasks to retry. Every task is in a terminal state — start a new run instead."
              : `Resets ${retryableTaskCount} failed task${retryableTaskCount === 1 ? "" : "s"} back to pending and restarts the loop. Completed tasks are preserved.`
          }
        >
          {submittingRetry ? "retrying…" : `Retry from failure (${retryableTaskCount} task${retryableTaskCount === 1 ? "" : "s"})`}
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => navigate("/")}
          title="Discard this run and start fresh from the home page."
        >
          Start a new run
        </button>
        <InfoBadge label="About retry vs new run" placement="bottom">
          <strong>Retry from failure</strong> reuses this runId. Failed
          tasks get a clean slate (<code>attempts</code> reset to 0,
          failure reason cleared); tasks that never ran (because
          <code>onFailure=&quot;skip-repo&quot;</code> bailed the loop)
          get picked up on the next pass. The executor re-attempts them
          on the existing <code>agent/&lt;id&gt;</code> git branches. Any
          task that previously completed stays completed — its commit is
          preserved.
          <br /><br />
          <strong>Start a new run</strong> gives you a fresh runId. Use it
          when you want to change the config (models, autonomy, on-failure
          policy) or when the failure suggests the plan itself is wrong
          and needs re-planning, not just re-execution.
        </InfoBadge>
      </div>
    </section>
  );
}

// Renders one "label: value [?]" row in the vertically-stacked header.
// Layout: fixed-width label column on the left, content on the right.
// Keeps every row aligned regardless of how long the pill text is.
function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="run-header-row">
      <span className="run-header-row-label">{label}</span>
      <div className="run-header-row-value">{children}</div>
    </div>
  );
}

function ForceStopConfirm({
  onConfirm,
  onCancel,
  submitting,
}: {
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  submitting: boolean;
}) {
  return (
    <section className="card card-form" role="dialog" aria-modal="true" aria-labelledby="force-stop-title">
      <div className="run-gate-head">
        <span className="run-gate-eyebrow">Confirm force stop</span>
        <h2 className="run-gate-title" id="force-stop-title">
          Cancel the in-flight task now?
        </h2>
      </div>
      <p className="run-gate-summary">
        The executor agent is currently running a task. <strong>Force stop</strong> cancels
        the SDK query immediately — partial file edits, half-written commits, or the
        in-progress task row may be left in an inconsistent state.
      </p>
      <p className="run-gate-detail">
        Prefer the regular <strong>Stop</strong> button if you can wait for the current
        task to finish. Use force stop only if the task is stuck or you need to abandon
        the work in progress.
      </p>
      <div className="run-gate-actions">
        <button
          className="btn btn-ghost"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </button>
        <button
          className="btn btn-danger"
          onClick={() => void onConfirm()}
          disabled={submitting}
        >
          {submitting ? "forcing…" : "Yes, force stop now"}
        </button>
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
  // Count by task status, not plan length. A task that's already completed or
  // skipped will NOT be re-run by the executor (run.ts execute loop), so the
  // honest "what will happen" number is the remaining count, not the total.
  let done = 0;
  let remaining = 0;
  for (const r of repos) {
    for (const t of r.taskState ?? []) {
      if (t.status === "completed" || t.status === "skipped") done += 1;
      else remaining += 1;
    }
  }
  const total = done + remaining;
  // Prior progress means this is a resume, not a fresh start — make that
  // unmistakable so a reflexive click can't read as "start over".
  const isResume = done > 0;

  return (
    <section className={`card card-run-gate${isResume ? " card-run-gate-resume" : ""}`}>
      <div className="run-gate-head">
        <span className="run-gate-eyebrow">
          {isResume ? "⟳ Resuming — partial progress detected" : "Run preflight complete"}
        </span>
        <h2 className="run-gate-title">{isResume ? "Resume run" : "Ready to execute"}</h2>
      </div>

      {isResume ? (
        <p className="run-gate-summary">
          <strong>{repos.length}</strong> repo{repos.length === 1 ? "" : "s"} ·{" "}
          <strong>{done}</strong> of {total} task{total === 1 ? "" : "s"} done ·{" "}
          <strong>{remaining}</strong> remaining will run
          <br />
          <span className="run-gate-skip-note">
            {done} completed task{done === 1 ? "" : "s"} {done === 1 ? "is" : "are"} skipped — not
            re-run or overwritten
          </span>
        </p>
      ) : (
        <p className="run-gate-summary">
          <strong>{repos.length}</strong> repo{repos.length === 1 ? "" : "s"} have approved plans ·{" "}
          <strong>{remaining}</strong> task{remaining === 1 ? "" : "s"} will be executed
        </p>
      )}

      <p className="run-gate-detail">
        {isResume ? (
          <>
            Clicking <strong>Confirm &amp; resume</strong> continues from where this run stopped —
            it skips the finished tasks and picks up the remaining {remaining} with the configured
            models ({modelSummary(vm.manifest.config.model)}).
          </>
        ) : (
          <>
            Clicking <strong>Confirm &amp; start execution</strong> hands control to the executor.
            Each task runs against its repo with the configured execute model (
            {shortModelName(vm.manifest.config.model.execute ?? vm.manifest.config.model.default)}
            ), commits to a per-task branch when tests pass, and reports progress live below.
          </>
        )}
      </p>

      <div className="run-gate-actions">
        <button className="btn btn-primary" onClick={() => void onConfirm()} disabled={submitting}>
          {submitting
            ? isResume
              ? "resuming…"
              : "starting…"
            : isResume
              ? `Confirm & resume (${remaining} task${remaining === 1 ? "" : "s"})`
              : "Confirm & start execution"}
        </button>
      </div>
    </section>
  );
}

/**
 * Lets a paused/failed run be billed differently for its remaining work. The
 * already-spent tokens stay attributed to the original mode (server seeds the
 * per-auth tally before switching); this only changes billing going forward.
 */
function BillingSwitch({
  current,
  selected,
  onChange,
  apiKeyAvailable,
}: {
  current: AuthMode;
  selected: AuthMode | null;
  onChange: (m: AuthMode | null) => void;
  apiKeyAvailable: boolean;
}) {
  const effective = selected ?? current;
  const modes: { id: AuthMode; label: string }[] = [
    { id: "subscription", label: "subscription" },
    { id: "api", label: "API key" },
  ];
  return (
    <section className="card card-billing-switch">
      <div className="billing-switch-head">
        <span className="billing-switch-eyebrow">Billing for remaining work</span>
        <InfoBadge label="About switching billing" placement="bottom">
          Changes how <strong>future</strong> tokens are billed when you resume or retry. Work
          already done stays attributed to the mode it ran under — the run header shows the split.
          Switching to <code>API key</code> requires a key set in the auth card.
        </InfoBadge>
      </div>
      <div className="billing-switch-options">
        {modes.map((m) => {
          const isCurrent = m.id === current;
          const isSelected = m.id === effective;
          const disabled = m.id === "api" && !apiKeyAvailable && current !== "api";
          return (
            <button
              key={m.id}
              className={`billing-opt${isSelected ? " billing-opt-on" : ""}`}
              aria-pressed={isSelected}
              disabled={disabled}
              title={
                disabled ? "No API key available — set one in the auth card first" : undefined
              }
              // Re-selecting the run's current mode means "no switch" (null).
              onClick={() => onChange(m.id === current ? null : m.id)}
            >
              {m.label}
              {isCurrent && <span className="billing-opt-tag">current</span>}
              {isSelected && !isCurrent && <span className="billing-opt-tag">→ switch</span>}
            </button>
          );
        })}
      </div>
      {selected && selected !== current && (
        <p className="billing-switch-note">
          Resume/retry will bill remaining work to <strong>{selected}</strong>. Already-spent tokens
          stay on <strong>{current}</strong>.
        </p>
      )}
    </section>
  );
}

function formatUsd(n: number): string {
  if (n === 0) return "$0.00";
  // Sub-cent runs would all read "$0.00" at 2dp, so widen precision below a cent.
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function ModelBreakdown({ models, showCost }: { models: [string, ModelCost][]; showCost: boolean }) {
  return (
    <ul className="spend-breakdown">
      {models.map(([id, mc]) => (
        <li key={id}>
          <code>{id}</code> — {(mc.inputTokens + mc.outputTokens).toLocaleString()} tok
          {showCost ? ` · ${formatUsd(mc.costUsd)}` : ""}
        </li>
      ))}
    </ul>
  );
}

/** Shown when a run was billed under more than one auth mode (i.e. switched). */
function AuthBreakdown({ byAuthMode }: { byAuthMode: Record<string, { tokensUsed: number; costUsd: number }> }) {
  const rows = Object.entries(byAuthMode).sort((a, b) => b[1].tokensUsed - a[1].tokensUsed);
  return (
    <ul className="spend-breakdown">
      {rows.map(([mode, s]) => (
        <li key={mode}>
          <strong>{mode}</strong> — {s.tokensUsed.toLocaleString()} tok ·{" "}
          {mode === "api" ? `${formatUsd(s.costUsd)} billed` : "no per-run charge"}
        </li>
      ))}
    </ul>
  );
}

/**
 * Run spend. Cost comes from the SDK (priced per model), so it is exact, not an
 * estimate. The label is honest about what the number means per auth mode:
 *   - api:          "billed" — real money charged to the API key.
 *   - subscription: "≈ equivalent" — notional API price (a flat monthly plan is
 *                   not billed per run); or "no per-run charge" if the SDK
 *                   reported $0 for the run.
 */
function SpendReadout({ budget, authMode }: { budget: BudgetState; authMode: AuthMode }) {
  const cost = budget.costUsd ?? 0;
  const isApi = authMode === "api";
  const models = Object.entries(budget.byModel ?? {}).sort((a, b) => b[1].costUsd - a[1].costUsd);
  const byAuthMode = budget.byAuthMode ?? {};
  const switched = Object.keys(byAuthMode).length > 1;

  // Shared breakdown body: auth split first (only when the run was billed under
  // more than one mode), then the per-model split.
  const breakdown = (showModelCost: boolean) => (
    <>
      {switched && <AuthBreakdown byAuthMode={byAuthMode} />}
      {models.length > 0 && <ModelBreakdown models={models} showCost={showModelCost} />}
    </>
  );
  const hasBreakdown = switched || models.length > 0;

  if (!isApi && cost === 0) {
    return (
      <span
        className="run-header-spend run-header-spend-sub"
        title="Subscription bills a flat monthly fee, not per run. The SDK reported no per-run dollar cost."
      >
        subscription · no per-run charge
        {hasBreakdown && (
          <InfoBadge label="Spend breakdown" placement="bottom">
            {breakdown(false)}
          </InfoBadge>
        )}
      </span>
    );
  }

  return (
    <span
      className={`run-header-spend${isApi ? "" : " run-header-spend-sub"}`}
      title={
        isApi
          ? "Dollar cost reported by the SDK, priced per model. This is what you're billed via the API key."
          : "Notional API-equivalent cost reported by the SDK. Subscription bills a flat monthly fee, not per run — a gauge, not a charge."
      }
    >
      {formatUsd(cost)} <span className="run-header-spend-label">{isApi ? "billed" : "≈ equiv"}</span>
      {hasBreakdown && (
        <InfoBadge label="Spend breakdown" placement="bottom">
          {breakdown(true)}
        </InfoBadge>
      )}
    </span>
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
          title="Append-only JSONL event stream the orchestrator writes during a run. Used by the dashboard to drive live state; safe to ignore unless debugging."
        >
          {open ? "▾" : "▸"} Raw events ({vm.recentEvents.length})
        </button>
        <span
          className="card-sub"
          title="Byte offset of the next unread position in run-log.jsonl. The dashboard's SSE stream uses this as a resumable cursor — reconnecting from byte N replays only the events past that point."
        >
          log cursor: byte {vm.byteCursor.toLocaleString()}
        </span>
        <InfoBadge label="About the event log">
          <strong>Raw events</strong> shows the recent entries in{" "}
          <code>run-log.jsonl</code>, the durable record of what happened
          during this run. Each line is a JSON event with a timestamp and a
          type (<code>phase_started</code>, <code>task_completed</code>,
          <code>run_loop_aborted</code>, etc.). The dashboard&apos;s live UI
          is derived from these events; this panel is mostly useful when
          something looks wrong and you want to see the raw signal.
        </InfoBadge>
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

// Plain-language descriptions used by title= tooltips. Keeping them as
// pure functions (rather than inline strings) makes them easy to reuse
// from other components, tweak in one spot, and test if we ever want to.
function describeStatus(status: RunManifest["status"]): string {
  switch (status) {
    case "discovering":
      return "Scanning the target directory for git repos.";
    case "selecting":
      return "Waiting for you to pick which discovered repos to include in the run.";
    case "preflight":
      return "Running analyze + plan on each selected repo. No file changes yet.";
    case "awaiting-run-confirmation":
      return "Plans are approved. Waiting for you to click Confirm & start execution.";
    case "running":
      return "The executor agent is making changes to repos — files, commits, tests.";
    case "stopping":
      return "Stop was requested. The current task is allowed to finish; the loop will exit after.";
    case "paused":
      return "The loop has exited. Click Resume to pick up where it left off.";
    case "completed":
      return "All tasks across all repos finished successfully.";
    case "failed":
      return "The run ended with one or more unrecoverable failures. Check the log for details.";
  }
}

function describeAutonomy(autonomy: string): string {
  switch (autonomy) {
    case "manual":
      return "No background loop — you advance the run yourself by POST-ing /step between phases. Analyze runs one repo at a time. Every approval gate is stop-and-click.";
    case "supervised":
      return "Background loop drives the run automatically — but still stops at every approval gate (proposal, plan, run-start). The loop auto-resumes when you submit decisions. Preflight runs repos in parallel.";
    case "yolo":
      return "Background loop runs end-to-end with no approval gates. Proposals, plans, and run-start are all auto-approved. Use when you trust the plan and want a hands-off run.";
    default:
      return autonomy;
  }
}

// Mirror of server-side isInterruptedRepo in runRoutes.ts. Kept in sync by
// hand — both decide which repos surface in the failed-run banner. Excludes
// terminal states (completed/skipped) and pre-execution states (the latter
// need different recovery: re-run analyze/plan or approve an artifact).
function isInterruptedRepoForBanner(repo: RepoEntry): boolean {
  if (repo.status === "completed" || repo.status === "skipped") return false;
  if (
    repo.status === "pending" ||
    repo.status === "analyzing" ||
    repo.status === "awaiting-proposal-approval" ||
    repo.status === "planning" ||
    repo.status === "awaiting-plan-approval"
  ) {
    return false;
  }
  if (!repo.taskState || repo.taskState.length === 0) return false;
  return repo.taskState.some(
    (t) => t.status !== "completed" && t.status !== "skipped",
  );
}

function shortModelName(id: string): string {
  if (id.startsWith("claude-opus-4-8")) return "opus 4.8";
  if (id.startsWith("claude-opus-4-7")) return "opus 4.7";
  if (id.startsWith("claude-opus")) return "opus";
  if (id.startsWith("claude-sonnet")) return "sonnet 4.6";
  if (id.startsWith("claude-haiku")) return "haiku 4.5";
  return id;
}

function modelSummary(model: {
  default: string;
  analyze?: string;
  plan?: string;
  execute?: string;
}): string {
  const a = shortModelName(model.analyze ?? model.default);
  const p = shortModelName(model.plan ?? model.default);
  const e = shortModelName(model.execute ?? model.default);
  if (a === p && p === e) return a;
  return `${a} / ${p} / ${e}`;
}

function summarize(e: LogEvent): string {
  if ("repoPath" in e && "taskId" in e) return `${e.repoPath} · ${e.taskId}`;
  if ("repoPath" in e) return e.repoPath;
  if ("runId" in e) return e.runId;
  if ("reason" in e) return e.reason;
  return "";
}

export default RunDashboard;
