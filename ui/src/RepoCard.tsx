import { useEffect, useState } from "react";
import { api } from "./api";
import type { AutonomyMode, RepoEntry, RunViewModel, TaskState } from "./runTypes";

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
  return (
    <article className={`repo-card repo-card-${repo.status} ${isCurrent ? "is-current" : ""}`}>
      <header className="repo-card-head">
        <div className="repo-card-head-name">
          <span className="repo-card-name">{repo.name}</span>
          <span className={`repo-stack repo-stack-${repo.stack}`}>{repo.stack}</span>
        </div>
        <span className={`pill pill-${repo.status}`}>{repo.status.replace(/-/g, " ")}</span>
      </header>

      <p className="repo-card-path" title={repo.path}>
        {repo.path}
      </p>

      {(repo.status === "awaiting-proposal-approval" ||
        repo.status === "awaiting-plan-approval") && (
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
              Reject / refine flow is v0.2; for now pause the run and use the
              dedicated <strong>Analyze</strong> / <strong>Plan</strong> panel on
              the home page to refine, then come back here.
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
