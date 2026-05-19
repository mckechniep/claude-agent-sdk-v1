import type { AuthMode } from "../types.js";

export interface ResolveInput {
  flag?: AuthMode;
  env?: AuthMode;
  interactive?: boolean;
}

export interface ResolvedAuth {
  mode: AuthMode;
  source: "flag" | "env" | "prompt";
}

export function resolveAuthMode(input: ResolveInput): ResolvedAuth | null {
  if (input.flag) return { mode: input.flag, source: "flag" };
  if (input.env) return { mode: input.env, source: "env" };
  return null;
}

export function applyAuthMode(mode: AuthMode): void {
  if (mode === "api") {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("auth=api requires ANTHROPIC_API_KEY in env (or use --auth=subscription)");
    }
    return;
  }
  delete process.env.ANTHROPIC_API_KEY;
}

export function authWarnings(mode: AuthMode, concurrency: number): string[] {
  const warnings: string[] = [];
  if (mode === "subscription" && concurrency > 1) {
    warnings.push(
      `Subscription mode shares one quota window across all ${concurrency} parallel runs. ` +
        `Hitting the rate-limit ceiling is much more likely than at concurrency=1.`,
    );
  }
  return warnings;
}
