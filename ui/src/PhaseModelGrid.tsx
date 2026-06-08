import {
  AGENT_PHASES,
  MODEL_OPTIONS,
  effortOptionsFor,
  type AgentPhase,
  type EffortChoice,
  type PhaseSelections,
} from "./modelConfig";
import type { ModelId } from "./runTypes";

/**
 * The per-phase (analyze / plan / execute) model + effort selector grid.
 * Controlled — the parent owns the selections. Shared by the start-run form's
 * Advanced section and the landing DefaultsPanel.
 */
export function PhaseModelGrid({
  selections,
  onModelChange,
  onEffortChange,
  onReset,
}: {
  selections: PhaseSelections;
  onModelChange: (phase: AgentPhase, model: ModelId) => void;
  onEffortChange: (phase: AgentPhase, effort: EffortChoice) => void;
  onReset?: () => void;
}) {
  return (
    <>
      {AGENT_PHASES.map((phase) => (
        <div key={phase} className="phase-model-row">
          <span className="phase-model-name">{phase}</span>
          <select
            className="field-input"
            value={selections[phase].model}
            onChange={(e) => onModelChange(phase, e.target.value as ModelId)}
            aria-label={`${phase} model`}
          >
            {MODEL_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label} — {opt.hint}
              </option>
            ))}
          </select>
          <select
            className="field-input"
            value={selections[phase].effort}
            onChange={(e) => onEffortChange(phase, e.target.value as EffortChoice)}
            aria-label={`${phase} effort`}
          >
            {effortOptionsFor(selections[phase].model).map((lvl) => (
              <option key={lvl} value={lvl}>
                {lvl === "default" ? "model default" : lvl}
              </option>
            ))}
          </select>
        </div>
      ))}
      {onReset && (
        <button className="btn btn-ghost btn-reset-models" onClick={onReset} type="button">
          ↺ Reset to recommended
        </button>
      )}
    </>
  );
}
