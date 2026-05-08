import { BudgetCapped } from "../types.js";

export interface BudgetOptions {
  maxTokens?: number;
  maxDurationMs?: number;
}

export class BudgetTracker {
  public tokensUsed = 0;
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
