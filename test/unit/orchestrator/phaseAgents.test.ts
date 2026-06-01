import { describe, expect, it } from "vitest";
import {
  PHASE_AGENTS,
  RECOMMENDED_MODELS,
  effortFor,
  modelFor,
} from "../../../src/orchestrator/phaseAgents.js";
import type { RunConfig } from "../../../src/types.js";

const baseConfig: RunConfig = {
  targetDir: "/tmp/x",
  autonomy: "supervised",
  concurrency: 1,
  checkpointEvery: 1,
  onFailure: "skip-repo",
  maxRetries: 1,
  testGate: "skip",
  testTimeoutMs: 30_000,
  model: { default: "claude-sonnet-4-6" },
};

describe("PHASE_AGENTS", () => {
  it("locks the per-phase tool allowlists (the safety envelope)", () => {
    expect(PHASE_AGENTS.analyze.tools).toEqual(["Read", "Bash"]);
    expect(PHASE_AGENTS.plan.tools).toEqual(["Read"]);
    expect(PHASE_AGENTS.execute.tools).toEqual(["Read", "Write", "Edit", "Bash"]);
  });
});

describe("modelFor", () => {
  it("falls back to model.default when no per-phase override exists", () => {
    expect(modelFor("analyze", baseConfig)).toBe("claude-sonnet-4-6");
    expect(modelFor("execute", baseConfig)).toBe("claude-sonnet-4-6");
  });

  it("prefers the per-phase override", () => {
    const config: RunConfig = {
      ...baseConfig,
      model: { default: "claude-sonnet-4-6", execute: "claude-haiku-4-5-20251001" },
    };
    expect(modelFor("execute", config)).toBe("claude-haiku-4-5-20251001");
    expect(modelFor("plan", config)).toBe("claude-sonnet-4-6");
  });
});

describe("effortFor", () => {
  it("returns undefined when effort is not configured at all", () => {
    expect(effortFor("analyze", baseConfig)).toBeUndefined();
  });

  it("returns undefined when effort is an empty object", () => {
    const config: RunConfig = { ...baseConfig, effort: {} };
    expect(effortFor("analyze", config)).toBeUndefined();
  });

  it("falls back to effort.default for phases without an override", () => {
    const config: RunConfig = { ...baseConfig, effort: { default: "high" } };
    expect(effortFor("plan", config)).toBe("high");
  });

  it("prefers the per-phase effort override", () => {
    const config: RunConfig = {
      ...baseConfig,
      effort: { default: "high", execute: "low" },
    };
    expect(effortFor("execute", config)).toBe("low");
    expect(effortFor("analyze", config)).toBe("high");
  });
});

describe("RECOMMENDED_MODELS", () => {
  it("recommends sonnet by default and haiku for execute", () => {
    expect(RECOMMENDED_MODELS.default).toBe("claude-sonnet-4-6");
    expect(RECOMMENDED_MODELS.execute).toBe("claude-haiku-4-5-20251001");
  });
});
