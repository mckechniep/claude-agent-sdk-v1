import { describe, expect, it } from "vitest";
import { BudgetTracker } from "../../../src/orchestrator/budget.js";
import { BudgetCapped } from "../../../src/types.js";

describe("BudgetTracker", () => {
  it("accumulates tokens across calls", () => {
    const t = new BudgetTracker({});
    t.add(1000);
    t.add(2500);
    expect(t.tokensUsed).toBe(3500);
  });

  it("throws BudgetCapped when token cap exceeded", () => {
    const t = new BudgetTracker({ maxTokens: 5000 });
    t.add(2000);
    expect(() => t.add(4000)).toThrow(BudgetCapped);
  });

  it("throws BudgetCapped on duration overrun via check()", () => {
    const t = new BudgetTracker({ maxDurationMs: 1 });
    return new Promise((resolve) => {
      setTimeout(() => {
        expect(() => t.check()).toThrow(BudgetCapped);
        resolve(undefined);
      }, 5);
    });
  });

  it("does not throw when caps are unset", () => {
    const t = new BudgetTracker({});
    t.add(10_000_000);
    expect(t.tokensUsed).toBe(10_000_000);
  });
});
