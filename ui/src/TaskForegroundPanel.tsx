import type { LogEvent, RepoEntry, RunViewModel, TaskState } from "./runTypes";
import { InfoBadge } from "./InfoBadge";

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
        <span
          className={`pill pill-${task.status}`}
          title={describeTaskStatusLong(task.status)}
        >
          {task.status}
        </span>
        <span
          className="task-foreground-meta-chip"
          title="How many times the executor agent has tried this task. Each attempt is a fresh SDK query; retries happen when the test gate fails or when the agent produces no changes."
        >
          attempt {task.attempts === 0 ? "—" : task.attempts}
        </span>
        <span
          className="task-foreground-meta-chip"
          title="Total Anthropic tokens used across all attempts on this task — input + output, including any cache reads/writes."
        >
          {task.tokensUsed.toLocaleString()} tok
        </span>
        <span
          className="task-foreground-meta-chip"
          title="Wall-clock time from task_started to terminal status. Includes SDK turn time, tool calls, and test-gate execution."
        >
          {(task.durationMs / 1000).toFixed(1)}s
        </span>
        {task.commitSha && (
          <span
            className="task-foreground-meta-chip task-foreground-sha"
            title={`Full commit SHA: ${task.commitSha}. The commit lives on branch agent/${task.taskId.slice(0, 8)} in the repo — cherry-pick or rebase it onto your main branch when you're ready to merge.`}
          >
            <code>{task.commitSha.slice(0, 7)}</code>
          </span>
        )}
      </div>

      <div className="task-foreground-section">
        <h4 className="task-foreground-section-head">
          Acceptance criteria
          <InfoBadge label="About acceptance criteria">
            <strong>Acceptance criteria</strong> are the planner&apos;s
            checklist for what counts as task-done. They&apos;re passed into
            the executor&apos;s system prompt so the agent knows what to
            satisfy. If a criterion isn&apos;t observable (e.g. &quot;don&apos;t
            break X&quot;), the test gate is what enforces it.
          </InfoBadge>
        </h4>
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
          <h4 className="task-foreground-section-head">
            Failure reason
            <InfoBadge label="About failure reasons">
              Recorded when the executor exhausts its retries. Common
              causes: test gate failed on every attempt, agent produced
              no file changes, or git operations failed. The exact text
              comes from whichever subsystem rejected the attempt.
            </InfoBadge>
          </h4>
          <pre className="task-foreground-fail">{task.failureReason}</pre>
        </div>
      )}

      {task.testOutput && (
        <details className="task-foreground-section">
          <summary className="task-foreground-section-head task-foreground-section-summary">
            Test output
            <InfoBadge label="About test output">
              Captured stdout+stderr from the last test command run during
              this task. Truncated to keep the manifest small — re-run the
              repo&apos;s test command locally for the full output.
            </InfoBadge>
          </summary>
          <pre className="task-foreground-test">{task.testOutput}</pre>
        </details>
      )}

      <div className="task-foreground-section">
        <h4 className="task-foreground-section-head">
          Lifecycle events <span className="muted">({events.length})</span>
          <InfoBadge label="About lifecycle events">
            <strong>Lifecycle events</strong> are the entries in{" "}
            <code>run-log.jsonl</code> tagged with this task&apos;s ID.
            They show the task&apos;s narrative arc — started, retries,
            phase boundaries, completed/failed. The per-SDK-message live
            cascade isn&apos;t plumbed yet (v0.2); for now these
            milestone events are the signal.
          </InfoBadge>
        </h4>
        {events.length === 0 ? (
          <p className="muted">no events yet — task hasn't started</p>
        ) : (
          <ul className="task-foreground-events">
            {events.map((e, i) => (
              <li key={i} className="task-foreground-event">
                <span
                  className="task-foreground-event-time"
                  title={`Full ISO timestamp: ${e.ts}`}
                >
                  {formatTs(e.ts)}
                </span>
                <span
                  className="stream-pill stream-pill-event"
                  title={describeEventType(e.type)}
                >
                  {e.type}
                </span>
                <span className="task-foreground-event-body">{describeEvent(e)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function describeTaskStatusLong(status: TaskState["status"]): string {
  switch (status) {
    case "pending":
      return "Not yet attempted — waiting for the executor to reach this task.";
    case "in_progress":
      return "The executor agent is actively working on this task right now.";
    case "completed":
      return "Edits made, tests passed (if the gate was enabled), and a commit was produced on the task's agent/ branch.";
    case "failed":
      return "The executor exhausted its retries without producing a passing commit. See Failure reason below.";
    case "skipped":
      return "Skipped — either by user decision or because the run was abandoned mid-task.";
  }
}

function describeEventType(type: LogEvent["type"]): string {
  // Keyed to event-type names so the same explanation surfaces wherever
  // the event chip appears — task panel here, raw events panel on the
  // dashboard. Add new cases when types.ts grows new event kinds.
  switch (type) {
    case "task_started":
      return "The executor began work on this task.";
    case "task_completed":
      return "The executor finished, tests passed, commit was made.";
    case "task_failed":
      return "The executor gave up after exhausting retries.";
    case "phase_started":
      return "A phase (analyze / plan / execute) began for this repo.";
    case "phase_completed":
      return "A phase finished — usually followed by a status transition.";
    case "run_loop_started":
      return "The background loop started driving this run.";
    case "run_loop_paused":
      return "The loop reached a manual gate or checkpoint and exited cleanly.";
    case "run_loop_aborted":
      return "The loop was soft-stopped after the current step finished.";
    case "run_loop_force_aborted":
      return "The loop was force-stopped mid-step; the in-flight SDK query was cancelled.";
    case "run_loop_stop_requested":
      return "You clicked Stop. The loop is winding down.";
    case "run_loop_completed":
      return "The loop exited because the run finished all work successfully.";
    case "run_loop_failed":
      return "The loop exited because the run hit a terminal failure.";
    case "run_loop_error":
      return "The loop crashed on an unexpected error — see message for details.";
    case "run_loop_awaiting_decision":
      return "The loop exited because a repo needs your approval; resumes when you decide.";
    case "run_recovered_from_crash":
      return "The crash-recovery sweep found this run stuck and settled it to paused.";
    case "run_retried_from_failure":
      return "You clicked Retry from failure — the failed tasks were reset to pending and the loop restarted.";
    case "checkpoint_paused":
      return "The loop paused after N completed tasks per the checkpoint-every setting.";
    case "checkpoint_resumed":
      return "You resumed from a checkpoint pause.";
    case "budget_warning":
      return "The token budget is getting close to the configured cap.";
    case "budget_capped":
      return "The token budget was exceeded — loop will stop.";
    case "run_started":
      return "The run was created.";
    case "run_finalized":
      return "The run reached a terminal status (completed or failed).";
  }
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
