import { z } from "zod";
import { AUTH_MODES, type AuthMode } from "../types.js";
import { applyAuthMode } from "../auth/mode.js";
import { BudgetTracker } from "../orchestrator/budget.js";
import { runQuery } from "../sdk/query.js";
import { listRuns, defaultStateRoot } from "../state/runIndex.js";
import { detectAuth } from "./authDetect.js";
import { loadUiConfig, setPreferredAuthMode } from "./config.js";

const SetModeBody = z.object({ mode: z.enum(AUTH_MODES).nullable() });
const SmokeBody = z.object({ mode: z.enum(AUTH_MODES) });

export interface ServerDeps {
  originalApiKey: string | undefined;
}

export interface RouteResponse {
  status: number;
  body: unknown;
}

function restoreEnv(originalApiKey: string | undefined): void {
  if (typeof originalApiKey === "string") {
    process.env.ANTHROPIC_API_KEY = originalApiKey;
  } else {
    delete process.env.ANTHROPIC_API_KEY;
  }
}

export async function handleAuthStatus(deps: ServerDeps): Promise<RouteResponse> {
  const detection = await detectAuth(deps.originalApiKey);
  const config = await loadUiConfig();
  return {
    status: 200,
    body: {
      ...detection,
      preferredAuthMode: config.preferredAuthMode,
    },
  };
}

export async function handleSetAuthMode(payload: unknown): Promise<RouteResponse> {
  const parsed = SetModeBody.safeParse(payload);
  if (!parsed.success) {
    return { status: 400, body: { error: "invalid body", issues: parsed.error.issues } };
  }
  const config = await setPreferredAuthMode(parsed.data.mode);
  return { status: 200, body: config };
}

export async function handleListRuns(): Promise<RouteResponse> {
  const runs = await listRuns(defaultStateRoot());
  return {
    status: 200,
    body: {
      stateRoot: defaultStateRoot(),
      runs: runs.map((r) => ({
        runId: r.runId,
        createdAt: r.manifest.createdAt,
        status: r.manifest.status,
        authMode: r.manifest.authMode,
        repoCount: r.manifest.repos.length,
        tokensUsed: r.manifest.budget.tokensUsed,
      })),
    },
  };
}

export async function handleSmokeTest(payload: unknown, deps: ServerDeps): Promise<RouteResponse> {
  const parsed = SmokeBody.safeParse(payload);
  if (!parsed.success) {
    return { status: 400, body: { error: "invalid body", issues: parsed.error.issues } };
  }
  const mode: AuthMode = parsed.data.mode;

  if (mode === "api") {
    if (!deps.originalApiKey) {
      return {
        status: 400,
        body: {
          error: "api mode selected but ANTHROPIC_API_KEY was not set when the server started",
        },
      };
    }
    process.env.ANTHROPIC_API_KEY = deps.originalApiKey;
  }

  try {
    applyAuthMode(mode);
    const tracker = new BudgetTracker({ maxTokens: 500, maxDurationMs: 30_000 });
    const started = Date.now();
    const result = await runQuery({
      prompt: "Reply with exactly: 'wrapper online'. No other words.",
      allowedTools: [],
      cwd: process.cwd(),
      tracker,
    });
    return {
      status: 200,
      body: {
        ok: true,
        mode,
        response: result.finalText.trim(),
        tokensUsed: result.tokensUsed,
        durationMs: Date.now() - started,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 500,
      body: { ok: false, mode, error: message },
    };
  } finally {
    restoreEnv(deps.originalApiKey);
  }
}
