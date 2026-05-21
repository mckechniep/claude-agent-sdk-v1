import { describe, expect, it } from "vitest";
import { runWithConcurrency } from "../../../src/orchestrator/concurrency.js";

describe("runWithConcurrency", () => {
  it("processes all items with concurrency=1 sequentially", async () => {
    const order: number[] = [];
    const results = await runWithConcurrency([1, 2, 3], 1, async (n) => {
      order.push(n);
      return n * 2;
    });
    expect(order).toEqual([1, 2, 3]);
    expect(results).toEqual([2, 4, 6]);
  });

  it("limits in-flight count to concurrency cap", async () => {
    let inflight = 0;
    let maxObserved = 0;
    await runWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      inflight += 1;
      maxObserved = Math.max(maxObserved, inflight);
      await new Promise((r) => setTimeout(r, 10));
      inflight -= 1;
      return n;
    });
    expect(maxObserved).toBeLessThanOrEqual(2);
  });

  it("preserves input order in results array", async () => {
    const results = await runWithConcurrency([1, 2, 3, 4], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n * 5));
      return n;
    });
    expect(results).toEqual([1, 2, 3, 4]);
  });
});
