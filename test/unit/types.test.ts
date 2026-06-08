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
  it("applies autonomy=supervised as the default", () => {
    const parsed = RunConfigSchema.parse(minimalInput);
    expect(parsed.autonomy).toBe("supervised");
  });

  it("preserves explicit autonomy choices", () => {
    const parsed = RunConfigSchema.parse({
      ...minimalInput,
      autonomy: "yolo",
    });
    expect(parsed.autonomy).toBe("yolo");
  });

  it("rejects invalid autonomy values", () => {
    expect(() => RunConfigSchema.parse({ ...minimalInput, autonomy: "auto" })).toThrow();
  });

  it("strips the legacy tier field from old configs instead of rejecting them", () => {
    // Pre-2026-06 manifests carry config.tier. Zod strip mode drops unknown
    // keys, so old runs stay loadable without a migration.
    const parsed = RunConfigSchema.parse({ ...minimalInput, tier: "balanced" });
    expect("tier" in parsed).toBe(false);
  });

  it("rejects unknown model IDs", () => {
    expect(() =>
      RunConfigSchema.parse({ ...minimalInput, model: { default: "claude-sonnet-3-5" } }),
    ).toThrow();
  });

  it("accepts all allowlisted model IDs as model.default", () => {
    for (const id of [
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-7",
      "claude-opus-4-8",
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

  it("leaves effort undefined when not provided", () => {
    const parsed = RunConfigSchema.parse(minimalInput);
    expect(parsed.effort).toBeUndefined();
  });

  it("accepts per-phase effort levels", () => {
    const parsed = RunConfigSchema.parse({
      ...minimalInput,
      effort: { default: "high", execute: "low" },
    });
    expect(parsed.effort?.default).toBe("high");
    expect(parsed.effort?.execute).toBe("low");
    expect(parsed.effort?.analyze).toBeUndefined();
  });

  it("accepts the full effort range including opus-only levels", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
      const parsed = RunConfigSchema.parse({ ...minimalInput, effort: { default: level } });
      expect(parsed.effort?.default).toBe(level);
    }
  });

  it("rejects unknown effort levels", () => {
    expect(() =>
      RunConfigSchema.parse({ ...minimalInput, effort: { default: "ultra" } }),
    ).toThrow();
  });
});
