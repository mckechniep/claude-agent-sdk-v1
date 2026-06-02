import { describe, expect, it } from "vitest";
import {
  buildEffortMap,
  buildModelMap,
  effortOptionsFor,
  recommendedSelections,
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
    sel.execute = { ...sel.execute, effort: "low" };
    expect(buildEffortMap(sel)).toEqual({ execute: "low" });
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
