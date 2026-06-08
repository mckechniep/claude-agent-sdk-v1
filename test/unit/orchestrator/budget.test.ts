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

  it("accumulates SDK-reported cost, ignoring zero/negative/non-finite", () => {
    const t = new BudgetTracker({});
    t.addCost(0.25);
    t.addCost(0.1);
    t.addCost(0); // subscription may report 0 — ignored
    t.addCost(-1); // defensive
    t.addCost(Number.NaN); // defensive
    expect(t.costUsd).toBeCloseTo(0.35, 10);
  });

  it("merges per-model usage across calls and keeps models separate", () => {
    const t = new BudgetTracker({});
    t.addModelUsage({
      "claude-haiku-4-5": { inputTokens: 100, outputTokens: 50, costUSD: 0.01 },
    });
    t.addModelUsage({
      "claude-haiku-4-5": { inputTokens: 200, outputTokens: 40, costUSD: 0.02 },
      "claude-opus-4-8": {
        inputTokens: 1000,
        outputTokens: 800,
        cacheReadInputTokens: 5000,
        costUSD: 0.9,
      },
    });

    expect(t.byModel["claude-haiku-4-5"]).toEqual({
      inputTokens: 300,
      outputTokens: 90,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0.03,
    });
    expect(t.byModel["claude-opus-4-8"]).toEqual({
      inputTokens: 1000,
      outputTokens: 800,
      cacheReadInputTokens: 5000,
      cacheCreationInputTokens: 0,
      costUsd: 0.9,
    });
  });

  it("attributes tokens and cost to the auth mode in effect", () => {
    const t = new BudgetTracker({});
    // First leg billed to subscription (cost typically 0 / not charged).
    t.authMode = "subscription";
    t.add(295_214);
    t.addCost(0);
    // Switch to api for the remainder.
    t.authMode = "api";
    t.add(120_000);
    t.addCost(1.4);

    expect(t.tokensUsed).toBe(415_214);
    expect(t.costUsd).toBeCloseTo(1.4, 10);
    expect(t.byAuthMode["subscription"]).toEqual({ tokensUsed: 295_214, costUsd: 0 });
    expect(t.byAuthMode["api"]).toEqual({ tokensUsed: 120_000, costUsd: 1.4 });
  });

  it("does not bucket by auth mode until one is set", () => {
    const t = new BudgetTracker({});
    t.add(500);
    t.addCost(0.05);
    expect(t.byAuthMode).toEqual({});
    expect(t.tokensUsed).toBe(500);
  });
});
