import { describe, expect, it } from "vitest";
import { RunConfigSchema } from "../../src/types.js";

const minimalInput = {
  targetDir: "/tmp/example",
  concurrency: 1,
  checkpointEvery: 5,
  onFailure: "skip-repo" as const,
  maxRetries: 1,
  testGate: "skip" as const,
  testTimeoutMs: 30_000,
  model: { default: "claude-sonnet-4-6" as const },
};

describe("RunConfigSchema", () => {
  it("applies autonomy=supervised and tier=balanced as defaults", () => {
    const parsed = RunConfigSchema.parse(minimalInput);
    expect(parsed.autonomy).toBe("supervised");
    expect(parsed.tier).toBe("balanced");
  });

  it("preserves explicit autonomy and tier choices", () => {
    const parsed = RunConfigSchema.parse({
      ...minimalInput,
      autonomy: "yolo",
      tier: "fast",
    });
    expect(parsed.autonomy).toBe("yolo");
    expect(parsed.tier).toBe("fast");
  });

  it("rejects invalid autonomy values", () => {
    expect(() => RunConfigSchema.parse({ ...minimalInput, autonomy: "auto" })).toThrow();
  });

  it("rejects invalid tier values", () => {
    expect(() => RunConfigSchema.parse({ ...minimalInput, tier: "ludicrous" })).toThrow();
  });

  it("rejects unknown model IDs", () => {
    expect(() =>
      RunConfigSchema.parse({ ...minimalInput, model: { default: "claude-sonnet-3-5" } }),
    ).toThrow();
  });

  it("accepts all v0.1 allowlisted model IDs as model.default", () => {
    for (const id of [
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-7",
    ] as const) {
      const parsed = RunConfigSchema.parse({ ...minimalInput, model: { default: id } });
      expect(parsed.model.default).toBe(id);
    }
  });

  it("rejects unknown model IDs in per-phase overrides", () => {
    expect(() =>
      RunConfigSchema.parse({
        ...minimalInput,
        model: { default: "claude-sonnet-4-6", execute: "claude-opus-3" },
      }),
    ).toThrow();
  });
});
