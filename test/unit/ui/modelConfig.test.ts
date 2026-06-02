import { describe, expect, it } from "vitest";
import {
  buildEffortMap,
  buildModelMap,
  clampEffort,
  effortOptionsFor,
  recommendedSelections,
  selectionSummary,
  shortLabel,
} from "../../../ui/src/modelConfig";

describe("recommendedSelections", () => {
  it("recommends sonnet for analyze/plan and haiku for execute, all at default effort", () => {
    const sel = recommendedSelections();
    expect(sel.analyze).toEqual({ model: "claude-sonnet-4-6", effort: "default" });
    expect(sel.plan).toEqual({ model: "claude-sonnet-4-6", effort: "default" });
    expect(sel.execute).toEqual({ model: "claude-haiku-4-5-20251001", effort: "default" });
  });
});

describe("buildModelMap", () => {
  it("emits an explicit model per phase plus a default", () => {
    const map = buildModelMap(recommendedSelections());
    expect(map).toEqual({
      default: "claude-sonnet-4-6",
      analyze: "claude-sonnet-4-6",
      plan: "claude-sonnet-4-6",
      execute: "claude-haiku-4-5-20251001",
    });
  });
});

describe("buildEffortMap", () => {
  it("returns undefined when every phase is at model-default effort", () => {
    expect(buildEffortMap(recommendedSelections())).toBeUndefined();
  });

  it("includes only the phases with explicit effort", () => {
    const sel = recommendedSelections();
    const withEffort = { ...sel, execute: { ...sel.execute, effort: "low" as const } };
    expect(buildEffortMap(withEffort)).toEqual({ execute: "low" });
  });
});

describe("effortOptionsFor", () => {
  it("offers xhigh/max only on opus models", () => {
    expect(effortOptionsFor("claude-opus-4-8")).toContain("xhigh");
    expect(effortOptionsFor("claude-opus-4-8")).toContain("max");
    expect(effortOptionsFor("claude-sonnet-4-6")).not.toContain("xhigh");
    expect(effortOptionsFor("claude-haiku-4-5-20251001")).not.toContain("max");
  });

  it("always offers the model-default sentinel first", () => {
    expect(effortOptionsFor("claude-sonnet-4-6")[0]).toBe("default");
    expect(effortOptionsFor("claude-opus-4-8")[0]).toBe("default");
  });
});

describe("clampEffort", () => {
  it("preserves effort levels the model supports", () => {
    expect(clampEffort("claude-haiku-4-5-20251001", "high")).toBe("high");
    expect(clampEffort("claude-opus-4-8", "max")).toBe("max");
  });

  it("clamps opus-only levels to default on non-opus models", () => {
    expect(clampEffort("claude-haiku-4-5-20251001", "max")).toBe("default");
    expect(clampEffort("claude-sonnet-4-6", "xhigh")).toBe("default");
  });
});

describe("shortLabel", () => {
  it("returns lowercase labels for known models", () => {
    expect(shortLabel("claude-opus-4-8")).toBe("opus 4.8");
    expect(shortLabel("claude-haiku-4-5-20251001")).toBe("haiku 4.5");
  });

  it("falls back to the raw id for unknown models", () => {
    expect(shortLabel("claude-future-9-9")).toBe("claude-future-9-9");
  });
});

describe("selectionSummary", () => {
  it("collapses to a single name when all phases use the same model", () => {
    const sel = recommendedSelections();
    const allSonnet = {
      ...sel,
      execute: { ...sel.execute, model: "claude-sonnet-4-6" as const },
    };
    expect(selectionSummary(allSonnet)).toBe("sonnet 4.6 · all phases");
  });

  it("shows the per-phase split when models differ", () => {
    expect(selectionSummary(recommendedSelections())).toBe(
      "sonnet 4.6 / sonnet 4.6 / haiku 4.5",
    );
  });

  it("appends effort markers for phases with explicit effort", () => {
    const sel = recommendedSelections();
    const withEffort = { ...sel, execute: { ...sel.execute, effort: "low" as const } };
    expect(selectionSummary(withEffort)).toBe("sonnet 4.6 / sonnet 4.6 / haiku 4.5 (low)");
  });
});
