import {
  AGENT_PHASES,
  clampEffort,
  MODEL_OPTIONS,
  recommendedSelections,
  type PhaseSelection,
  type PhaseSelections,
} from "./modelConfig";
import type { EffortLevel, ModelId } from "./runTypes";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = "agent-orch:model-defaults";

function isValidModel(id: unknown): id is ModelId {
  return typeof id === "string" && MODEL_OPTIONS.some((o) => o.id === id);
}

/** Validate/repair a raw value into PhaseSelections, falling back per-phase. */
export function defaultsOrFallback(raw: unknown): PhaseSelections {
  const fallback = recommendedSelections();
  if (typeof raw !== "object" || raw === null) return fallback;
  const obj = raw as Record<string, unknown>;
  const out = {} as PhaseSelections;
  for (const phase of AGENT_PHASES) {
    const entry = obj[phase];
    if (typeof entry !== "object" || entry === null) {
      out[phase] = fallback[phase];
      continue;
    }
    const { model, effort } = entry as Record<string, unknown>;
    const validModel: ModelId = isValidModel(model) ? model : fallback[phase].model;
    const sel: PhaseSelection = {
      model: validModel,
      effort: clampEffort(
        validModel,
        typeof effort === "string" ? (effort as PhaseSelection["effort"]) : "default",
      ),
    };
    out[phase] = sel;
  }
  return out;
}

export function loadDefaults(storage: StorageLike): PhaseSelections {
  const raw = storage.getItem(KEY);
  if (!raw) return recommendedSelections();
  try {
    return defaultsOrFallback(JSON.parse(raw));
  } catch {
    return recommendedSelections();
  }
}

export function saveDefaults(sel: PhaseSelections, storage: StorageLike): void {
  storage.setItem(KEY, JSON.stringify(sel));
}

/** Map a phase selection to the analyze/plan request override, dropping the
 *  "default" effort sentinel (which means "let the model decide"). */
export function buildPhaseOverride(sel: PhaseSelection): { model: ModelId; effort?: EffortLevel } {
  return sel.effort === "default"
    ? { model: sel.model }
    : { model: sel.model, effort: sel.effort };
}
