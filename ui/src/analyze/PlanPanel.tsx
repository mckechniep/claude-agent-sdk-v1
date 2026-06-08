import { useState } from "react";
import type { Thoroughness } from "../api";
import { formatRelative } from "../format";
import { ResizablePanel } from "../ui/ResizablePanel";
import { IterationBanner, IterationControl } from "./IterationControl";
import type { PlanState } from "./types";

interface PlanPanelProps {
  plan: PlanState | null;
  onPlan: (userNotes?: string) => void;
  onApprovePlan: (taskCount: number) => void;
  thoroughness: Thoroughness;
  onThoroughnessChange: (t: Thoroughness) => void;
  planIteration: number;
}

export function PlanPanel({
  plan,
  onPlan,
  onApprovePlan,
  thoroughness,
  onThoroughnessChange,
  planIteration,
}: PlanPanelProps) {
  const [notes, setNotes] = useState<string>("");
  const isRunning = plan?.phase === "running";
  const isErr = plan?.phase === "error";
  const isDone = plan?.phase === "done";
  const isApproved = isDone && plan.approvedAt !== null;
  const isIdle = !plan || plan.phase === "idle";
  const submittedNotes =
    plan && (plan.phase === "running" || plan.phase === "done") ? plan.previousNotes : undefined;
  const isRefinement = Boolean(submittedNotes);

  const headerLabel = isIdle ? (
    "planner — break the proposal into committable tasks"
  ) : isApproved ? (
    "plan approved"
  ) : isRunning ? (
    <>
      <span className="pulse" />
      {isRefinement ? "refining plan with your notes" : "planning"} ·{" "}
      {(plan.elapsedMs / 1000).toFixed(1)}s
    </>
  ) : isErr ? (
    "plan failed"
  ) : isDone ? (
    <>
      plan · {plan.taskCount} task{plan.taskCount === 1 ? "" : "s"} ·{" "}
      {(plan.durationMs / 1000).toFixed(1)}s · {plan.tokensUsed.toLocaleString()} tok
    </>
  ) : null;

  const panelClass = isApproved
    ? "plan plan-approved"
    : isRunning
      ? "plan plan-live"
      : isErr
        ? "plan plan-err"
        : isDone
          ? "plan plan-done"
          : "plan plan-idle";

  return (
    <div className={panelClass}>
      <div className="plan-head">
        <span className="plan-label">{headerLabel}</span>
        <div className="analyze-head-actions">
          {!isIdle && (
            <IterationControl
              iteration={planIteration}
              thoroughness={thoroughness}
              onThoroughnessChange={onThoroughnessChange}
              label="plan"
            />
          )}
          {isIdle && (
            <button className="btn btn-primary btn-tight" onClick={() => onPlan()}>
              Generate plan
            </button>
          )}
        </div>
      </div>

      {plan && plan.phase !== "idle" && plan.messages.length > 0 && (
        <ul className="stream-log analyze-log">
          {plan.messages.map((m) => (
            <li key={m.id} className="stream-row">
              <span className={`stream-pill stream-pill-${m.subtype}`}>{m.subtype}</span>
              <span className="stream-summary">{m.summary || <em className="muted">·</em>}</span>
            </li>
          ))}
        </ul>
      )}

      {isRunning && plan.messages.length === 0 && (
        <div className="stream-empty">waiting for first SDK message…</div>
      )}

      {isDone && (
        <div className="proposal">
          <div className="proposal-head">
            <span className="proposal-label">
              plan.md
              {isRefinement && <span className="iter-badge">refined</span>}
            </span>
            <span className="proposal-path" title={plan.planPath}>
              {plan.planPath}
            </span>
          </div>

          {isRefinement && submittedNotes && (
            <div className="iter-notes">
              <span className="iter-notes-label">you asked for</span>
              <p className="iter-notes-body">{submittedNotes}</p>
              <span className="iter-notes-hint">
                read the plan below to see how it was incorporated
              </span>
            </div>
          )}

          <ResizablePanel storageKey="plan" title="plan.md">
            <pre className="proposal-body">{plan.planMarkdown}</pre>
          </ResizablePanel>

          {!isApproved && (
            <div className="proposal-feedback">
              <IterationBanner
                iteration={planIteration}
                thoroughness={thoroughness}
                kind="plan"
              />
              <label className="field">
                <span className="field-label">your reply to the planner</span>
                <textarea
                  className="field-input field-textarea"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="re-shape the task list — split, merge, reorder, add acceptance criteria. The planner will refine the plan and preserve unchanged task IDs."
                  rows={4}
                  spellCheck
                />
              </label>
              <div className="proposal-actions">
                <button
                  className="btn btn-primary"
                  onClick={() => onPlan(notes.trim() || undefined)}
                  disabled={notes.trim().length === 0}
                  title={
                    notes.trim().length === 0
                      ? "type a reply above to submit it to the planner"
                      : "send your reply back to the planner to refine the task list"
                  }
                >
                  Submit notes / answers
                </button>
                <button
                  className="btn btn-ghost btn-approve"
                  onClick={() => onApprovePlan(plan.taskCount)}
                  title={
                    notes.trim().length > 0
                      ? `proceeds with the current plan — your ${notes.trim().length} chars of notes will NOT be sent to the planner or saved`
                      : "lock in the current plan, ready for the executor phase"
                  }
                >
                  Approve plan
                </button>
              </div>
              {notes.trim().length > 0 && (
                <p className="proposal-hint">
                  Heads up: <strong>Approve plan</strong> will discard the {notes.trim().length}{" "}
                  characters in the box above.
                </p>
              )}
            </div>
          )}

          {isApproved && plan.approvedAt && (
            <div className="approved-banner">
              <span className="approved-mark">✓</span>
              <span>
                plan approved {formatRelative(plan.approvedAt)} · {plan.taskCount} task
                {plan.taskCount === 1 ? "" : "s"} queued for executor phase
              </span>
            </div>
          )}
        </div>
      )}

      {isErr && plan && <pre className="scan-err-body">{plan.message}</pre>}
    </div>
  );
}
