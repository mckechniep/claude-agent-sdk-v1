import type { EffortLevel, EffortMap, ModelId, ModelMap } from "./runTypes";

// Mirrors src/orchestrator/phaseAgents.ts RECOMMENDED_MODELS (the UI cannot
// import server code — see the header comment in runTypes.ts). Drift here is
// cosmetic, not behavioral: the dropdowns always show exactly which models
// will run.

export type AgentPhase = "analyze" | "plan" | "execute";
export const AGENT_PHASES: AgentPhase[] = ["analyze", "plan", "execute"];

export interface ModelOption {
  id: ModelId;
  label: string;
  hint: string;
}

export const MODEL_OPTIONS: ModelOption[] = [
  { id: "claude-opus-4-8", label: "Opus 4.8", hint: "deepest reasoning · highest cost" },
  { id: "claude-opus-4-7", label: "Opus 4.7", hint: "deep reasoning · high cost" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", hint: "strong default · moderate cost" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", hint: "fastest · cheapest" },
];

export const RECOMMENDED_MODELS: ModelMap = {
  default: "claude-sonnet-4-6",
  execute: "claude-haiku-4-5-20251001",
};

// "default" sentinel = let the SDK/model decide; the effort key is omitted
// from the run config entirely for that phase.
export type EffortChoice = "default" | EffortLevel;

const BASE_EFFORT_OPTIONS: EffortChoice[] = ["default", "low", "medium", "high"];
const OPUS_EFFORT_OPTIONS: EffortChoice[] = ["default", "low", "medium", "high", "xhigh", "max"];

/** xhigh/max are Opus-only at the API level — hide them for other models. */
export function effortOptionsFor(model: ModelId): EffortChoice[] {
  return model.startsWith("claude-opus") ? OPUS_EFFORT_OPTIONS : BASE_EFFORT_OPTIONS;
}

export interface PhaseSelection {
  model: ModelId;
  effort: EffortChoice;
}

export type PhaseSelections = Record<AgentPhase, PhaseSelection>;

export function recommendedSelections(): PhaseSelections {
  return {
    analyze: { model: RECOMMENDED_MODELS.default, effort: "default" },
    plan: { model: RECOMMENDED_MODELS.default, effort: "default" },
    execute: {
      model: RECOMMENDED_MODELS.execute ?? RECOMMENDED_MODELS.default,
      effort: "default",
    },
  };
}

/** Clamp an effort choice to what the given model supports (xhigh/max are
 * Opus-only). Returns "default" when the current choice isn't available. */
export function clampEffort(model: ModelId, effort: EffortChoice): EffortChoice {
  return effortOptionsFor(model).includes(effort) ? effort : "default";
}

/** Lowercase short name for inline prose (e.g. "opus 4.8"). Derived from
 * MODEL_OPTIONS so model display names live in exactly one module. */
export function shortLabel(id: string): string {
  const opt = MODEL_OPTIONS.find((o) => o.id === id);
  return opt ? opt.label.toLowerCase() : id;
}

/** Collapse per-phase selections into the RunConfig.model map. Every phase is
 * explicit; `default` is kept as a fallback (analyze's model, arbitrarily).
 * Note: because all three phases are always emitted explicitly, the `default`
 * key is never consulted at runtime — it exists to satisfy the schema shape. */
export function buildModelMap(sel: PhaseSelections): ModelMap {
  return {
    default: sel.analyze.model,
    analyze: sel.analyze.model,
    plan: sel.plan.model,
    execute: sel.execute.model,
  };
}

/** Collapse per-phase effort into the RunConfig.effort map. Phases left at
 * "default" are omitted; returns undefined when nothing is overridden. */
export function buildEffortMap(sel: PhaseSelections): EffortMap | undefined {
  const map: EffortMap = {};
  if (sel.analyze.effort !== "default") map.analyze = sel.analyze.effort;
  if (sel.plan.effort !== "default") map.plan = sel.plan.effort;
  if (sel.execute.effort !== "default") map.execute = sel.execute.effort;
  return Object.keys(map).length > 0 ? map : undefined;
}
