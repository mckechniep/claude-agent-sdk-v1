import { describe, expect, it } from "vitest";
import { computeIterationMode, renderAnalyzeModeBlock } from "../../src/sdk/prompts/iteration.js";

describe("computeIterationMode", () => {
  it("returns normal/narrow/defaults by iteration for balanced", () => {
    expect(computeIterationMode(1, "balanced")).toBe("normal");
    expect(computeIterationMode(3, "balanced")).toBe("narrow");
    expect(computeIterationMode(5, "balanced")).toBe("defaults");
  });

  it("forces 'defaults' when finalize is true, even at iteration 1", () => {
    expect(computeIterationMode(1, "balanced", true)).toBe("defaults");
    expect(computeIterationMode(1, "thorough", true)).toBe("defaults");
  });
});

describe("renderAnalyzeModeBlock", () => {
  it("emits the convergence block when finalize is true at iteration 1", () => {
    const block = renderAnalyzeModeBlock(1, "balanced", true);
    expect(block).toContain("Recommended defaults");
    expect(block).toContain("Do NOT ask further open questions");
  });
});
