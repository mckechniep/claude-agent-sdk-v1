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

  it("counts cumulative tokens from modelUsage, not the final-turn top-level usage", async () => {
    // Simulates a multi-turn agentic task: the result message's top-level
    // `usage` reports only the final turn (small), while modelUsage is the
    // cumulative session total (large). tokensUsed must reflect the cumulative
    // figure so it reconciles with cost / the per-model breakdown.
    const fakeQuery = vi.fn(async function* () {
      yield {
        type: "result",
        result: "done",
        usage: { input_tokens: 311, output_tokens: 2000 }, // final turn only
        total_cost_usd: 5.62,
        modelUsage: {
          "claude-haiku-4-5-20251001": {
            inputTokens: 700_000,
            outputTokens: 25_504,
            costUSD: 5.62,
          },
        },
      };
    });
    const tracker = new BudgetTracker({});
    tracker.authMode = "api";
    const result = await runQuery({
      prompt: "p",
      allowedTools: ["Read"],
      cwd: "/tmp",
      tracker,
      queryFn: fakeQuery as never,
    });
    // 700000 + 25504 = 725504 — the per-model total, not 311 + 2000.
    expect(result.tokensUsed).toBe(725_504);
    expect(tracker.tokensUsed).toBe(725_504);
    // The per-auth tally now matches the per-model total (both ~725k), and cost
    // matches too — no more 10x divergence.
    expect(tracker.byAuthMode["api"]!.tokensUsed).toBe(725_504);
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

describe("runQuery effort passthrough", () => {
  it("forwards effort to the SDK options when set", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const fakeQuery = vi.fn(async function* (args: unknown) {
      capturedOptions = (args as { options: Record<string, unknown> }).options;
      yield {
        type: "result",
        result: "ok",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    });
    const tracker = new BudgetTracker({});
    await runQuery({
      prompt: "test",
      allowedTools: ["Read"],
      cwd: "/tmp",
      tracker,
      model: "claude-sonnet-4-6",
      effort: "low",
      queryFn: fakeQuery as never,
    });
    expect(capturedOptions?.effort).toBe("low");
    expect(capturedOptions?.model).toBe("claude-sonnet-4-6");
  });

  it("omits the effort key entirely when unset so the SDK default applies", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const fakeQuery = vi.fn(async function* (args: unknown) {
      capturedOptions = (args as { options: Record<string, unknown> }).options;
      yield {
        type: "result",
        result: "ok",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    });
    const tracker = new BudgetTracker({});
    await runQuery({
      prompt: "test",
      allowedTools: ["Read"],
      cwd: "/tmp",
      tracker,
      queryFn: fakeQuery as never,
    });
    expect(capturedOptions).toBeDefined();
    expect("effort" in (capturedOptions ?? {})).toBe(false);
  });
});
