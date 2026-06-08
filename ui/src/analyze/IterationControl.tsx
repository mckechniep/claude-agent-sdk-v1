import type { Thoroughness } from "../api";
import { InfoBadge } from "../InfoBadge";

const THOROUGHNESS_BOUNDS: Record<Thoroughness, { narrow: number; defaults: number }> = {
  thorough: { narrow: 4, defaults: 6 },
  balanced: { narrow: 3, defaults: 5 },
  fast: { narrow: 2, defaults: 3 },
};

function modeForIteration(
  iteration: number,
  thoroughness: Thoroughness,
): "normal" | "narrow" | "defaults" {
  const t = THOROUGHNESS_BOUNDS[thoroughness];
  if (iteration >= t.defaults) return "defaults";
  if (iteration >= t.narrow) return "narrow";
  return "normal";
}

export function IterationBanner({
  iteration,
  thoroughness,
  kind,
}: {
  iteration: number;
  thoroughness: Thoroughness;
  kind: "analyze" | "plan";
}) {
  const mode = modeForIteration(iteration, thoroughness);
  if (mode === "normal") return null;
  const agent = kind === "analyze" ? "analyzer" : "planner";
  if (mode === "narrow") {
    return (
      <div className="iter-defaults-banner">
        <span>
          <strong>Narrowing mode active</strong> · iter {iteration} ({thoroughness})
        </span>
        <span>
          The {agent} has been told to stop re-asking questions you've already answered
          and stop inventing new angles on settled points. Only genuinely unresolved
          ambiguity should reach you in this round.
        </span>
      </div>
    );
  }
  return (
    <div className="iter-defaults-banner">
      <span>
        <strong>Defaults mode active</strong> · iter {iteration} ({thoroughness})
      </span>
      <span>
        The {agent} has been told to commit to <strong>RECOMMENDED defaults</strong>{" "}
        for any remaining ambiguity rather than keep probing. Read the proposal — if a
        default is wrong, submit notes to override it; otherwise click <strong>Approve
        as-is</strong> to accept the {agent}'s judgement and move on.
      </span>
    </div>
  );
}

export function IterationControl({
  iteration,
  thoroughness,
  onThoroughnessChange,
  label,
}: {
  iteration: number;
  thoroughness: Thoroughness;
  onThoroughnessChange: (t: Thoroughness) => void;
  label: string;
}) {
  const mode = modeForIteration(iteration, thoroughness);
  const bounds = THOROUGHNESS_BOUNDS[thoroughness];
  const nextChange =
    mode === "normal"
      ? `narrows at iter ${bounds.narrow}`
      : mode === "narrow"
        ? `defaults at iter ${bounds.defaults}`
        : "converging — no more probing";
  return (
    <div className={`iter-control iter-control-${mode}`} title={`${label} loop pace`}>
      <span className="iter-control-label">
        iter <strong>{iteration}</strong>
      </span>
      <span
        className={`iter-control-mode iter-control-mode-${mode}`}
        title={
          mode === "normal"
            ? "The agent is free to ask clarifying questions and explore alternatives. Default behavior at the start of a refine loop."
            : mode === "narrow"
              ? "The agent has been told to stop re-asking questions you've already answered. Only genuinely unresolved ambiguity should reach you."
              : "The agent has been told to commit to RECOMMENDED defaults for any remaining ambiguity rather than keep probing. Read the proposal carefully."
        }
      >
        {mode}
      </span>
      <select
        className="iter-control-select"
        value={thoroughness}
        onChange={(e) => onThoroughnessChange(e.target.value as Thoroughness)}
        title={`loop pace · ${nextChange}`}
      >
        <option value="thorough">thorough</option>
        <option value="balanced">balanced</option>
        <option value="fast">fast</option>
      </select>
      <InfoBadge label="About thoroughness">
        <strong>Thoroughness</strong> controls how many refine iterations the{" "}
        {label} gets before being told to commit to defaults.
        <ul>
          <li>
            <code>thorough</code> — the agent stays in <code>normal</code> mode
            longest, narrowing late, converging late. Best when you want to
            explore the problem space.
          </li>
          <li>
            <code>balanced</code> — default. Narrows at iter 3, defaults at iter 5.
          </li>
          <li>
            <code>fast</code> — narrows at iter 2, defaults at iter 3. The agent
            commits to a proposal quickly with less back-and-forth.
          </li>
        </ul>
        The mode pill on the left (<code>{mode}</code>) shows where this loop
        is right now. Bumping thoroughness extends the runway; lowering it
        forces convergence sooner.
      </InfoBadge>
    </div>
  );
}
