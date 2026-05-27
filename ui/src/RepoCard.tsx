import { useEffect, useState } from "react";
import { api } from "./api";
import { navigate } from "./router";
import type {
  AutonomyMode,
  RepoEntry,
  RunStatus,
  RunViewModel,
  TaskState,
} from "./runTypes";

// Once the run is past preflight, per-repo plan-approval gates are stale —
// the orchestrator advanced manifest.status to awaiting-run-confirmation
// only after confirming every awaiting-plan-approval repo has a marker on
// disk, so showing the gate again would be re-asking a question the loop
// has already accepted an answer for.
const STATUSES_PAST_PREFLIGHT: ReadonlySet<RunStatus> = new Set([
  "awaiting-run-confirmation",
  "running",
  "paused",
  "completed",
  "failed",
]);

function isPlanGateStale(repo: RepoEntry, runStatus: RunStatus): boolean {
  return (
    repo.status === "awaiting-plan-approval" && STATUSES_PAST_PREFLIGHT.has(runStatus)
  );
}

interface Props {
  vm: RunViewModel;
  repo: RepoEntry;
  runId: string;
  autonomy: AutonomyMode;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string | null) => void;
  onDecision: (kind: "proposal" | "plan", action: "accept") => Promise<void>;
}

export function RepoCard({
  vm,
  repo,
  runId,
  autonomy,
  selectedTaskId,
  onSelectTask,
  onDecision,
}: Props) {
  const isCurrent = vm.currentRepoPath === repo.path;
  const staleGate = isPlanGateStale(repo, vm.manifest.status);
  // When the gate is stale we show a softer "plan approved" pill instead of
  // the misleading awaiting-plan-approval one.
  const statusLabel = staleGate ? "plan approved" : repo.status.replace(/-/g, " ");
  const statusClass = staleGate ? "pill-completed" : `pill-${repo.status}`;
  const showApprovalGate =
    (repo.status === "awaiting-proposal-approval" ||
      repo.status === "awaiting-plan-approval") &&
    !staleGate;

  return (
    <article className={`repo-card repo-card-${repo.status} ${isCurrent ? "is-current" : ""}`}>
      <header className="repo-card-head">
        <div className="repo-card-head-name">
          <span className="repo-card-name">{repo.name}</span>
          <span className={`repo-stack repo-stack-${repo.stack}`}>{repo.stack}</span>
        </div>
        <span className={`pill ${statusClass}`}>{statusLabel}</span>
      </header>

      <p className="repo-card-path" title={repo.path}>
        {repo.path}
      </p>

      <RefineLinks repoPath={repo.path} repoStatus={repo.status} />

      {showApprovalGate && (
        <ApprovalGate
          runId={runId}
          repoPath={repo.path}
          autonomy={autonomy}
          kind={repo.status === "awaiting-proposal-approval" ? "proposal" : "plan"}
          onAccept={() =>
            onDecision(
              repo.status === "awaiting-proposal-approval" ? "proposal" : "plan",
              "accept",
            )
          }
        />
      )}

      {repo.taskState && repo.taskState.length > 0 && (
        <TaskList
          tasks={repo.taskState}
          currentTaskId={vm.currentTaskId}
          selectedTaskId={selectedTaskId}
          onSelectTask={onSelectTask}
        />
      )}

      {repo.status === "failed" &&
        (() => {
          const failed = repo.taskState?.find((t) => t.status === "failed");
          if (!failed) return null;
          return (
            <div className="repo-card-failure">
              <span className="repo-card-failure-label">last failure</span>
              <pre className="repo-card-failure-body">
                {failed.failureReason ?? "no reason recorded"}
              </pre>
            </div>
          );
        })()}

      {repo.status === "completed" && repo.taskState && repo.taskState.length > 0 && (
        <p className="repo-card-completed-summary">
          {repo.taskState.filter((t) => t.status === "completed").length} of{" "}
          {repo.taskState.length} task
          {repo.taskState.length === 1 ? "" : "s"} committed
        </p>
      )}
    </article>
  );
}

// Cross-link from the dashboard back to the home-page Analyze / Plan
// panels. Useful when the user wants to refine a proposal or plan that
// the orchestrator generated rather than approve-as-is. The home page
// reads ?refine=... and pre-fills its scan path.
function RefineLinks({
  repoPath,
  repoStatus,
}: {
  repoPath: string;
  repoStatus: RepoEntry["status"];
}) {
  // Only show during phases where refinement makes sense. Completed /
  // failed / skipped repos have already shipped past the point where
  // refining the analysis or plan would do anything.
  const refinable =
    repoStatus === "pending" ||
    repoStatus === "analyzing" ||
    repoStatus === "awaiting-proposal-approval" ||
    repoStatus === "planning" ||
    repoStatus === "awaiting-plan-approval";
  if (!refinable) return null;
  const enc = encodeURIComponent(repoPath);
  return (
    <div className="repo-card-refine">
      <span className="repo-card-refine-label">Refine on home page:</span>
      <button
        className="repo-card-refine-link"
        onClick={() => navigate(`/?refine=analyze&repoPath=${enc}`)}
        title="open the Analyze panel for this repo"
      >
        analyze →
      </button>
      <button
        className="repo-card-refine-link"
        onClick={() => navigate(`/?refine=plan&repoPath=${enc}`)}
        title="open the Plan panel for this repo"
      >
        plan →
      </button>
    </div>
  );
}

// Embedded approval flow — fetches the markdown lazily on expand to keep
// the dashboard's initial render cheap.
function ApprovalGate({
  runId,
  repoPath,
  autonomy,
  kind,
  onAccept,
}: {
  runId: string;
  repoPath: string;
  autonomy: AutonomyMode;
  kind: "proposal" | "plan";
  onAccept: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open || markdown !== null || loading) return;
    setLoading(true);
    void api
      .getRepoArtifacts(runId, repoPath)
      .then((res) => {
        const text = kind === "proposal" ? res.proposalMarkdown : res.planMarkdown;
        setMarkdown(text ?? "(empty — file may not have been written yet)");
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }, [open, markdown, loading, runId, repoPath, kind]);

  const onClickAccept = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      await onAccept();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="repo-card-gate">
      <div className="repo-card-gate-head">
        <span className="repo-card-gate-label">
          {kind === "proposal" ? "Proposal awaiting review" : "Plan awaiting review"}
        </span>
        <button
          className="btn btn-ghost btn-tight"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? "▾ Hide" : "▸ Review"}
        </button>
      </div>

      {autonomy === "yolo" && (
        <p className="muted">
          (autonomy=yolo — gates shouldn't surface; this row may be transient)
        </p>
      )}

      {open && (
        <>
          {loading && <p className="muted">loading {kind}…</p>}
          {error && <pre className="scan-err-body">{error}</pre>}
          {markdown !== null && <pre className="proposal-body">{markdown}</pre>}
          <div className="proposal-actions">
            <button
              className="btn btn-primary btn-tight"
              onClick={() => void onClickAccept()}
              disabled={submitting}
            >
              {submitting ? "submitting…" : `Approve ${kind}`}
            </button>
            <p className="proposal-hint">
              Approve to confirm this {kind} and continue. To refine first,
              open the <strong>{kind === "proposal" ? "Analyze" : "Plan"}</strong>{" "}
              panel on the home page — your edits write back to disk and this
              gate will pick them up.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function TaskList({
  tasks,
  currentTaskId,
  selectedTaskId,
  onSelectTask,
}: {
  tasks: TaskState[];
  currentTaskId: string | null;
  selectedTaskId: string | null;
  onSelectTask: (id: string | null) => void;
}) {
  return (
    <ul className="repo-card-tasks">
      {tasks.map((t) => {
        const isCurrent = t.taskId === currentTaskId;
        const isSelected = t.taskId === selectedTaskId;
        return (
          <li
            key={t.taskId}
            className={`repo-card-task repo-card-task-${t.status} ${
              isCurrent ? "is-current" : ""
            } ${isSelected ? "is-selected" : ""}`}
          >
            <button
              className="repo-card-task-btn"
              onClick={() =>
                onSelectTask(selectedTaskId === t.taskId ? null : t.taskId)
              }
            >
              <span className={`repo-card-task-dot dot-${t.status}`} aria-hidden />
              <span className="repo-card-task-title">{t.title}</span>
              <span className="repo-card-task-meta">
                {t.tokensUsed > 0 && (
                  <span className="repo-card-task-meta-chip">
                    {t.tokensUsed.toLocaleString()}t
                  </span>
                )}
                {t.commitSha && (
                  <code className="repo-card-task-sha">{t.commitSha.slice(0, 7)}</code>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export default RepoCard;
