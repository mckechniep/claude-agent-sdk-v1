import { useState } from "react";
import type { DiscoveredRepo, Thoroughness } from "../api";
import { formatRelative } from "../format";
import { ResizablePanel } from "../ui/ResizablePanel";
import { IterationBanner, IterationControl } from "./IterationControl";
import { PlanPanel } from "./PlanPanel";
import type { RepoFlow } from "./types";

interface AnalyzePanelProps {
  repo: DiscoveredRepo;
  flow: RepoFlow;
  onAnalyze: (userNotes?: string) => void;
  onProceed: (userNotes: string) => void;
  onApprove: () => void;
  onPlan: (userNotes?: string) => void;
  onApprovePlan: (taskCount: number) => void;
  onClose: () => void;
  onThoroughnessChange: (t: Thoroughness) => void;
}

export function AnalyzePanel({
  repo,
  flow,
  onAnalyze,
  onProceed,
  onApprove,
  onPlan,
  onApprovePlan,
  onClose,
  onThoroughnessChange,
}: AnalyzePanelProps) {
  const { analyze, plan, analyzeIteration, planIteration } = flow;
  const [notes, setNotes] = useState<string>("");
  // The hook stores thoroughness in a ref (not reducer state), so seed a local
  // copy for display and propagate every change up to the ref the hook reads.
  const [thoroughness, setThoroughnessLocal] = useState<Thoroughness>(flow.thoroughness);
  const changeThoroughness = (t: Thoroughness) => {
    setThoroughnessLocal(t);
    onThoroughnessChange(t);
  };

  // Idle: the inline surface owns the "start analysis" entry point (the old
  // home-scanner RepoRow used to own this trigger button).
  if (analyze.phase === "idle") {
    return (
      <div className="analyze analyze-idle">
        <div className="analyze-head">
          <span className="analyze-label">analyze · {repo.name}</span>
          <div className="analyze-head-actions">
            <IterationControl
              iteration={1}
              thoroughness={thoroughness}
              onThoroughnessChange={changeThoroughness}
              label="analyze"
            />
            <button className="btn btn-ghost btn-tight" onClick={onClose}>
              close
            </button>
          </div>
        </div>
        <label className="field">
          <span className="field-label">optional notes for the analyzer</span>
          <textarea
            className="field-input field-textarea"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="steer the analysis — point at the goal, constraints, or the files that matter. Leave blank to let the analyzer explore on its own."
            rows={3}
            spellCheck
          />
        </label>
        <div className="proposal-actions">
          <button className="btn btn-primary" onClick={() => onAnalyze(notes.trim() || undefined)}>
            Run analysis
          </button>
        </div>
      </div>
    );
  }

  const isRunning = analyze.phase === "running";
  const isErr = analyze.phase === "error";
  const isDone = analyze.phase === "done";
  const isApproved = isDone && analyze.approvedAt !== null;
  const submittedNotes = isRunning || isDone ? analyze.previousNotes : undefined;
  const isRefinement = Boolean(submittedNotes);

  const headerLabel = isApproved ? (
    "approved"
  ) : isRunning ? (
    <>
      <span className="pulse" />
      {isRefinement ? "refining with your notes" : "analyzing"} ·{" "}
      {(analyze.elapsedMs / 1000).toFixed(1)}s
    </>
  ) : isErr ? (
    "analyze failed"
  ) : (
    <>
      proposal · {(analyze.durationMs / 1000).toFixed(1)}s · {analyze.tokensUsed.toLocaleString()} tok
    </>
  );

  return (
    <div
      className={`analyze ${
        isApproved
          ? "analyze-approved"
          : isRunning
            ? "analyze-live"
            : isErr
              ? "analyze-err"
              : "analyze-done"
      }`}
    >
      <div className="analyze-head">
        <span className="analyze-label">{headerLabel}</span>
        <div className="analyze-head-actions">
          <IterationControl
            iteration={analyzeIteration}
            thoroughness={thoroughness}
            onThoroughnessChange={changeThoroughness}
            label="analyze"
          />
          <button className="btn btn-ghost btn-tight" onClick={onClose}>
            close
          </button>
        </div>
      </div>

      {analyze.messages.length > 0 && (
        <ul className="stream-log analyze-log">
          {analyze.messages.map((m) => (
            <li key={m.id} className="stream-row">
              <span className={`stream-pill stream-pill-${m.subtype}`}>{m.subtype}</span>
              <span className="stream-summary">{m.summary || <em className="muted">·</em>}</span>
            </li>
          ))}
        </ul>
      )}

      {isRunning && analyze.messages.length === 0 && (
        <div className="stream-empty">waiting for first SDK message…</div>
      )}

      {isDone && (
        <div className="proposal">
          <div className="proposal-head">
            <span className="proposal-label">
              completion-proposal.md
              {isRefinement && <span className="iter-badge">refined</span>}
            </span>
            <span className="proposal-path" title={analyze.proposalPath}>
              {analyze.proposalPath}
            </span>
          </div>

          {isRefinement && submittedNotes && (
            <div className="iter-notes">
              <span className="iter-notes-label">you asked for</span>
              <p className="iter-notes-body">{submittedNotes}</p>
              <span className="iter-notes-hint">
                read the proposal below to see how it was incorporated
              </span>
            </div>
          )}

          <ResizablePanel storageKey="proposal" title="completion-proposal.md">
            <pre className="proposal-body">{analyze.proposalMarkdown}</pre>
          </ResizablePanel>

          {!isApproved && (
            <div className="proposal-feedback">
              <IterationBanner
                iteration={analyzeIteration}
                thoroughness={thoroughness}
                kind="analyze"
              />
              <label className="field">
                <span className="field-label">your reply to the analyzer</span>
                <textarea
                  className="field-input field-textarea"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="answer the open questions, correct misunderstandings, narrow scope — the analyzer will refine the proposal using these"
                  rows={4}
                  spellCheck
                />
              </label>
              <div className="proposal-actions">
                <button
                  className="btn btn-primary"
                  onClick={() => onAnalyze(notes.trim() || undefined)}
                  disabled={notes.trim().length === 0}
                  title={
                    notes.trim().length === 0
                      ? "type a reply above to submit it to the analyzer"
                      : "send your reply back to the analyzer to refine the proposal"
                  }
                >
                  Submit notes / answers
                </button>
                <button
                  className="btn btn-proceed"
                  onClick={() => onProceed(notes.trim())}
                  disabled={notes.trim().length === 0}
                  title="Fold your answers into the proposal and move straight to planning — no more questions."
                >
                  → Submit answers &amp; proceed
                </button>
                <button
                  className="btn btn-ghost btn-approve"
                  onClick={onApprove}
                  title={
                    notes.trim().length > 0
                      ? `proceeds with the current proposal — your ${notes.trim().length} chars of notes will NOT be sent to the analyzer or saved`
                      : "lock in the current proposal as-is, move on to the planner phase"
                  }
                >
                  Approve as-is
                </button>
              </div>
              {notes.trim().length > 0 && (
                <p className="proposal-hint">
                  Heads up: <strong>Approve as-is</strong> discards the {notes.trim().length}{" "}
                  characters above. <strong>→ Submit answers &amp; proceed</strong> folds them
                  into the proposal and skips straight to planning;{" "}
                  <strong>Submit notes / answers</strong> sends them back for another analyze round.
                </p>
              )}
            </div>
          )}

          {isApproved && analyze.approvedAt && (
            <div className="approved-banner">
              <span className="approved-mark">✓</span>
              <span>proposal approved {formatRelative(analyze.approvedAt)}</span>
            </div>
          )}
        </div>
      )}

      {isApproved && (
        <PlanPanel
          plan={plan}
          onPlan={onPlan}
          onApprovePlan={onApprovePlan}
          thoroughness={thoroughness}
          onThoroughnessChange={changeThoroughness}
          planIteration={planIteration}
        />
      )}

      {isErr && <pre className="scan-err-body">{analyze.message}</pre>}
    </div>
  );
}
