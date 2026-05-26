import type { LogEvent, RepoEntry, RunViewModel, TaskState } from "./runTypes";

// D5: shows everything we know about a single task — its acceptance
// criteria, current status, attempts/tokens/duration/commit, plus the
// JSONL events keyed to its taskId. Per-SDK-message live cascade for the
// execute phase is a v0.2 feature (no execute SSE endpoint yet); for now
// the lifecycle events themselves are the signal.

interface Props {
  vm: RunViewModel;
  repo: RepoEntry;
  task: TaskState;
  onClose: () => void;
}

export function TaskForegroundPanel({ vm, repo, task, onClose }: Props) {
  const events = vm.eventsByTask[task.taskId] ?? [];
  return (
    <div className="task-foreground">
      <div className="task-foreground-head">
        <div className="task-foreground-title">
          <span className="task-foreground-eyebrow">{repo.name}</span>
          <span className="task-foreground-heading">{task.title}</span>
        </div>
        <button className="btn btn-ghost btn-tight" onClick={onClose} aria-label="close task">
          close
        </button>
      </div>

      <div className="task-foreground-meta">
        <span className={`pill pill-${task.status}`}>{task.status}</span>
        <span className="task-foreground-meta-chip">
          attempt {task.attempts === 0 ? "—" : task.attempts}
        </span>
        <span className="task-foreground-meta-chip">
          {task.tokensUsed.toLocaleString()} tok
        </span>
        <span className="task-foreground-meta-chip">
          {(task.durationMs / 1000).toFixed(1)}s
        </span>
        {task.commitSha && (
          <span className="task-foreground-meta-chip task-foreground-sha">
            <code>{task.commitSha.slice(0, 7)}</code>
          </span>
        )}
      </div>

      <div className="task-foreground-section">
        <h4 className="task-foreground-section-head">Acceptance criteria</h4>
        {task.acceptanceCriteria.length === 0 ? (
          <p className="muted">no acceptance criteria recorded</p>
        ) : (
          <ul className="task-foreground-criteria">
            {task.acceptanceCriteria.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        )}
      </div>

      {task.failureReason && (
        <div className="task-foreground-section task-foreground-section-fail">
          <h4 className="task-foreground-section-head">Failure reason</h4>
          <pre className="task-foreground-fail">{task.failureReason}</pre>
        </div>
      )}

      {task.testOutput && (
        <details className="task-foreground-section">
          <summary className="task-foreground-section-head task-foreground-section-summary">
            Test output
          </summary>
          <pre className="task-foreground-test">{task.testOutput}</pre>
        </details>
      )}

      <div className="task-foreground-section">
        <h4 className="task-foreground-section-head">
          Lifecycle events <span className="muted">({events.length})</span>
        </h4>
        {events.length === 0 ? (
          <p className="muted">no events yet — task hasn't started</p>
        ) : (
          <ul className="task-foreground-events">
            {events.map((e, i) => (
              <li key={i} className="task-foreground-event">
                <span className="task-foreground-event-time">{formatTs(e.ts)}</span>
                <span className="stream-pill stream-pill-event">{e.type}</span>
                <span className="task-foreground-event-body">{describeEvent(e)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function describeEvent(e: LogEvent): string {
  switch (e.type) {
    case "task_started":
      return "starting";
    case "task_completed":
      return `committed ${e.commitSha.slice(0, 7)} · ${e.tokensUsed.toLocaleString()} tok`;
    case "task_failed":
      return `${e.reason}${e.willRetry ? " (will retry)" : ""}`;
    case "phase_completed":
      return `phase ${e.phase} done · ${(e.durationMs / 1000).toFixed(1)}s`;
    default:
      return "";
  }
}

function formatTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(11, 19);
}

export default TaskForegroundPanel;
