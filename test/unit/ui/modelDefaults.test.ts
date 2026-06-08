import { describe, expect, it } from "vitest";
import {
  loadDefaults,
  saveDefaults,
  defaultsOrFallback,
  type StorageLike,
} from "../../../ui/src/modelDefaults";
import { recommendedSelections } from "../../../ui/src/modelConfig";

function fakeStorage(initial: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

describe("modelDefaults", () => {
  it("returns recommended selections when storage is empty", () => {
    expect(loadDefaults(fakeStorage())).toEqual(recommendedSelections());
  });

  it("round-trips valid selections", () => {
    const s = fakeStorage();
    const sel = recommendedSelections();
    sel.analyze = { model: "claude-opus-4-8", effort: "high" };
    saveDefaults(sel, s);
    expect(loadDefaults(s)).toEqual(sel);
  });

  it("falls back per-phase for an unknown model id", () => {
    const out = defaultsOrFallback({
      analyze: { model: "made-up-model", effort: "high" },
      plan: { model: "claude-sonnet-4-6", effort: "default" },
      execute: { model: "claude-haiku-4-5-20251001", effort: "default" },
    });
    expect(out.analyze.model).toBe(recommendedSelections().analyze.model);
  });

  it("clamps an effort the model does not support", () => {
    // xhigh is Opus-only; on Sonnet it must clamp to "default".
    const out = defaultsOrFallback({
      analyze: { model: "claude-sonnet-4-6", effort: "xhigh" },
      plan: { model: "claude-sonnet-4-6", effort: "default" },
      execute: { model: "claude-haiku-4-5-20251001", effort: "default" },
    });
    expect(out.analyze.effort).toBe("default");
  });

  it("returns recommended selections on malformed JSON", () => {
    expect(loadDefaults(fakeStorage({ "agent-orch:model-defaults": "{oops" }))).toEqual(
      recommendedSelections(),
    );
  });
});
