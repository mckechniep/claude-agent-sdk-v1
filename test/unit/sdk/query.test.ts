import { describe, expect, it, vi } from "vitest";
import { runQuery } from "../../../src/sdk/query.js";
import { BudgetTracker } from "../../../src/orchestrator/budget.js";

describe("runQuery", () => {
  it("invokes the underlying query and accumulates tokens into the tracker", async () => {
    const fakeQuery = vi.fn(async function* () {
      yield { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } };
      yield {
        type: "result",
        result: "hi",
        usage: { input_tokens: 100, output_tokens: 200 },
      };
    });
    const tracker = new BudgetTracker({});
    const result = await runQuery({
      prompt: "test",
      allowedTools: ["Read"],
      cwd: "/tmp",
      tracker,
      queryFn: fakeQuery as never,
    });
    expect(result.tokensUsed).toBe(300);
    expect(result.finalText).toBe("hi");
    expect(tracker.tokensUsed).toBe(300);
    expect(fakeQuery).toHaveBeenCalledTimes(1);
  });

  it("captures SDK-reported cost and per-model usage into the result and tracker", async () => {
    const fakeQuery = vi.fn(async function* () {
      yield { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } };
      yield {
        type: "result",
        result: "hi",
        usage: { input_tokens: 100, output_tokens: 200 },
        total_cost_usd: 0.0123,
        modelUsage: {
          "claude-opus-4-8": { inputTokens: 100, outputTokens: 200, costUSD: 0.0123 },
        },
      };
    });
    const tracker = new BudgetTracker({});
    const result = await runQuery({
      prompt: "test",
      allowedTools: ["Read"],
      cwd: "/tmp",
      tracker,
      queryFn: fakeQuery as never,
    });
    expect(result.costUsd).toBeCloseTo(0.0123, 10);
    expect(tracker.costUsd).toBeCloseTo(0.0123, 10);
    expect(tracker.byModel["claude-opus-4-8"]?.costUsd).toBeCloseTo(0.0123, 10);
    expect(tracker.byModel["claude-opus-4-8"]?.inputTokens).toBe(100);
  });

  it("defaults cost to 0 and modelUsage to empty when the SDK omits them (e.g. subscription)", async () => {
    const fakeQuery = vi.fn(async function* () {
      yield { type: "result", result: "ok", usage: { input_tokens: 10, output_tokens: 10 } };
    });
    const tracker = new BudgetTracker({});
    const result = await runQuery({
      prompt: "p",
      allowedTools: ["Read"],
      cwd: "/tmp",
      tracker,
      queryFn: fakeQuery as never,
    });
    expect(result.costUsd).toBe(0);
    expect(result.modelUsage).toEqual({});
    expect(tracker.costUsd).toBe(0);
  });

  it("normalizes the result shape with messages and durationMs", async () => {
    const fakeQuery = vi.fn(async function* () {
      yield { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } };
      yield { type: "result", result: "ok", usage: { input_tokens: 50, output_tokens: 50 } };
    });
    const tracker = new BudgetTracker({});
    const result = await runQuery({
      prompt: "p",
      allowedTools: ["Read"],
      cwd: "/tmp",
      tracker,
      queryFn: fakeQuery as never,
    });
    expect(result.messages).toHaveLength(2);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
