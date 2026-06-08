import { InfoBadge } from "./InfoBadge";
import { PhaseModelGrid } from "./PhaseModelGrid";
import {
  clampEffort,
  recommendedSelections,
  selectionSummary,
  type AgentPhase,
  type EffortChoice,
  type PhaseSelections,
} from "./modelConfig";
import type { ModelId } from "./runTypes";

/**
 * Landing-page editor for the global model/effort defaults. New runs inherit
 * these, and the preflight analyze/plan calls send them. Controlled — App owns
 * the state and persistence.
 */
export function DefaultsPanel({
  value,
  onChange,
}: {
  value: PhaseSelections;
  onChange: (next: PhaseSelections) => void;
}) {
  const setModel = (phase: AgentPhase, model: ModelId): void =>
    onChange({ ...value, [phase]: { model, effort: clampEffort(model, value[phase].effort) } });
  const setEffort = (phase: AgentPhase, effort: EffortChoice): void =>
    onChange({ ...value, [phase]: { ...value[phase], effort } });

  return (
    <section className="card card-defaults">
      <div className="card-head">
        <h2>Run defaults</h2>
        <span className="card-sub">{selectionSummary(value)}</span>
      </div>
      <p className="muted">
        New runs inherit these, and analysis you run below uses them.
        <InfoBadge label="About run defaults">
          These set the model + reasoning effort for each phase. A new run starts
          from them; you can still override per-decision at the dashboard gates
          (re-analyze / re-plan / run-confirmation).
        </InfoBadge>
      </p>
      <div className="field field-models">
        <PhaseModelGrid
          selections={value}
          onModelChange={setModel}
          onEffortChange={setEffort}
          onReset={() => onChange(recommendedSelections())}
        />
      </div>
    </section>
  );
}
