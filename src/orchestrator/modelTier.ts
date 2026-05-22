import type { ModelTier, RunConfig } from "../types.js";

type ModelConfig = RunConfig["model"];

const TIER_PRESETS: Record<Exclude<ModelTier, "custom">, ModelConfig> = {
  thorough: {
    default: "claude-sonnet-4-6",
  },
  balanced: {
    default: "claude-sonnet-4-6",
    execute: "claude-haiku-4-5-20251001",
  },
  fast: {
    default: "claude-haiku-4-5-20251001",
  },
};

export function resolveTierToModels(
  tier: ModelTier,
  overrides?: Partial<ModelConfig>,
): ModelConfig {
  if (tier === "custom") {
    if (!overrides?.default) {
      throw new Error("Custom tier requires an explicit model.default");
    }
    return {
      default: overrides.default,
      analyze: overrides.analyze,
      plan: overrides.plan,
      execute: overrides.execute,
    };
  }
  const preset = TIER_PRESETS[tier];
  return {
    default: overrides?.default ?? preset.default,
    analyze: overrides?.analyze ?? preset.analyze,
    plan: overrides?.plan ?? preset.plan,
    execute: overrides?.execute ?? preset.execute,
  };
}
