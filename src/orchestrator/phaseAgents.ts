import type { EffortLevel, ModelId, RunConfig } from "../types.js";

/**
 * Phase agent registry — the single home for each phase's harness shape.
 *
 * Each orchestration phase spawns a fresh, single-purpose SDK agent. This
 * registry declares what that agent gets: its tool allowlist and how its
 * model + reasoning effort are resolved from the run config. Phases import
 * their tools from here; the orchestrator resolves model/effort through here.
 *
 * v0.2 note: this shape is deliberately AgentDefinition-compatible (the
 * SDK's subagent declaration type) so a future foreman architecture can
 * pass these specs into query()'s `agents:` option with minimal change.
 */
export type AgentPhase = "analyze" | "plan" | "execute";

export interface PhaseAgentSpec {
  /** Tool allowlist for this phase's harness. */
  tools: string[];
}

export const PHASE_AGENTS: Record<AgentPhase, PhaseAgentSpec> = {
  // Read-only investigation: may run tests/git via Bash but never edits.
  analyze: { tools: ["Read", "Bash"] },
  // Document writer: reads the repo + proposal; the orchestrator persists
  // its output, so it needs no write access of its own.
  plan: { tools: ["Read"] },
  // The only phase allowed to change files.
  execute: { tools: ["Read", "Write", "Edit", "Bash"] },
};

/** Resolve the model for a phase: per-phase override, else the run default. */
export function modelFor(phase: AgentPhase, config: RunConfig): ModelId {
  return config.model[phase] ?? config.model.default;
}

/**
 * Resolve the reasoning effort for a phase: per-phase override, else the
 * run-level default, else undefined (= omit from the SDK call so the
 * SDK/model default applies).
 */
export function effortFor(phase: AgentPhase, config: RunConfig): EffortLevel | undefined {
  return config.effort?.[phase] ?? config.effort?.default;
}

/**
 * Recommended per-phase models: Sonnet for the reasoning phases; Haiku for
 * execute, where 80%+ of a run's tokens are spent and Haiku delivers ~90%
 * of the capability at roughly a third of the cost.
 *
 * The UI mirrors these values in ui/src/modelConfig.ts (it cannot import
 * server code — see the header comment in ui/src/runTypes.ts). Drift there
 * is cosmetic: the dropdowns show exactly which models will run, unlike the
 * old hidden tier→model mapping this registry replaces.
 */
export const RECOMMENDED_MODELS: RunConfig["model"] = {
  default: "claude-sonnet-4-6",
  execute: "claude-haiku-4-5-20251001",
};
