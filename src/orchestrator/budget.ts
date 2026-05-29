import { BudgetCapped, type ModelCost } from "../types.js";

export interface BudgetOptions {
  maxTokens?: number;
  maxDurationMs?: number;
}

/** Subset of the SDK's per-model usage we accumulate (field names as the SDK emits them). */
export interface ModelUsageInput {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
}

export class BudgetTracker {
  public tokensUsed = 0;
  // SDK-reported dollar cost, accumulated across every phase/SDK call.
  public costUsd = 0;
  // Per-model token + cost tally, keyed by model id (e.g. "claude-opus-4-8").
  public readonly byModel: Record<string, ModelCost> = {};
  public readonly startedAt = Date.now();
  constructor(private readonly options: BudgetOptions) {}

  add(tokens: number): void {
    this.tokensUsed += tokens;
    if (this.options.maxTokens !== undefined && this.tokensUsed > this.options.maxTokens) {
      throw new BudgetCapped(
        `token cap exceeded: used ${this.tokensUsed} > cap ${this.options.maxTokens}`,
      );
    }
  }

  /** Accumulate the SDK-reported dollar cost for one phase/SDK call. */
  addCost(usd: number): void {
    if (Number.isFinite(usd) && usd > 0) this.costUsd += usd;
  }

  /**
   * Merge the SDK's per-model usage breakdown (result message `modelUsage`) into
   * the running per-model tally. Cost comes from the SDK, never estimated locally.
   */
  addModelUsage(modelUsage: Record<string, ModelUsageInput>): void {
    for (const [model, u] of Object.entries(modelUsage)) {
      const prev = this.byModel[model] ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUsd: 0,
      };
      this.byModel[model] = {
        inputTokens: prev.inputTokens + (u.inputTokens ?? 0),
        outputTokens: prev.outputTokens + (u.outputTokens ?? 0),
        cacheReadInputTokens: prev.cacheReadInputTokens + (u.cacheReadInputTokens ?? 0),
        cacheCreationInputTokens: prev.cacheCreationInputTokens + (u.cacheCreationInputTokens ?? 0),
        costUsd: prev.costUsd + (u.costUSD ?? 0),
      };
    }
  }

  check(): void {
    if (this.options.maxDurationMs !== undefined) {
      const elapsed = Date.now() - this.startedAt;
      if (elapsed > this.options.maxDurationMs) {
        throw new BudgetCapped(
          `duration cap exceeded: elapsed ${elapsed}ms > cap ${this.options.maxDurationMs}ms`,
        );
      }
    }
  }
}
