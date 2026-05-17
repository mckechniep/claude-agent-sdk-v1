import type { IncomingMessage, ServerResponse } from "node:http";
import { stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { z } from "zod";
import { AUTH_MODES, type AuthMode } from "../types.js";
import { applyAuthMode } from "../auth/mode.js";
import { BudgetTracker } from "../orchestrator/budget.js";
import { runQueryStream } from "../sdk/query.js";
import { listRuns, defaultStateRoot } from "../state/runIndex.js";
import { discoverReposStream } from "../phases/discover.js";
import { detectAuth } from "./authDetect.js";
import { loadUiConfig, setPreferredAuthMode } from "./config.js";
import { openSseStream } from "./sse.js";

const SetModeBody = z.object({ mode: z.enum(AUTH_MODES).nullable() });
const StreamQuery = z.object({ mode: z.enum(AUTH_MODES) });
const DiscoverQuery = z.object({
  path: z.string().min(1),
  depth: z.number().int().min(0).max(8).default(2),
  exclude: z.array(z.string()).optional(),
});

const HEARTBEAT_MS = 750;

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

export async function handleSmokeStream(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  query: URLSearchParams,
): Promise<void> {
  const parsed = StreamQuery.safeParse({ mode: query.get("mode") });
  if (!parsed.success) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "invalid query", issues: parsed.error.issues }));
    return;
  }
  const mode: AuthMode = parsed.data.mode;

  if (mode === "api" && !deps.originalApiKey) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: "api mode selected but ANTHROPIC_API_KEY was not set when the server started",
      }),
    );
    return;
  }

  const sse = openSseStream(req, res);
  const startedAt = Date.now();
  let heartbeat: NodeJS.Timeout | undefined;

  try {
    if (mode === "api") process.env.ANTHROPIC_API_KEY = deps.originalApiKey;
    applyAuthMode(mode);

    sse.send("started", { mode, ts: startedAt });

    heartbeat = setInterval(() => {
      sse.send("progress", { durationMs: Date.now() - startedAt });
    }, HEARTBEAT_MS);

    const tracker = new BudgetTracker({ maxTokens: 500, maxDurationMs: 30_000 });
    const gen = runQueryStream({
      prompt: "Reply with exactly: 'wrapper online'. No other words.",
      allowedTools: [],
      cwd: process.cwd(),
      tracker,
    });

    let final: {
      messages: unknown[];
      finalText: string;
      tokensUsed: number;
      durationMs: number;
    } | null = null;
    for (;;) {
      const next = await gen.next();
      if (sse.closed()) {
        // Client gave up; stop forwarding. Generator finishes on its own.
        break;
      }
      if (next.done) {
        final = next.value;
        break;
      }
      const event = next.value;
      if (event.type === "sdk_message") {
        sse.send("sdk_message", {
          subtype: event.message.type,
          summary: summarizeMessage(event.message),
          ts: event.ts,
        });
      }
    }

    if (final && !sse.closed()) {
      sse.send("done", {
        ok: true,
        mode,
        response: final.finalText.trim(),
        tokensUsed: final.tokensUsed,
        durationMs: final.durationMs,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!sse.closed()) {
      sse.send("error", { ok: false, mode, message });
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    restoreEnv(deps.originalApiKey);
    sse.close();
  }
}

export async function handleDiscoverStream(
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
): Promise<void> {
  const rawPath = query.get("path") ?? "";
  const expandedPath = rawPath.startsWith("~/")
    ? resolvePath(process.env.HOME ?? "", rawPath.slice(2))
    : resolvePath(rawPath);

  const excludeRaw = query.get("exclude");
  const parsed = DiscoverQuery.safeParse({
    path: expandedPath,
    depth: query.has("depth") ? Number(query.get("depth")) : undefined,
    exclude: excludeRaw
      ? excludeRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
  });

  if (!parsed.success) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "invalid query", issues: parsed.error.issues }));
    return;
  }

  try {
    const s = await stat(parsed.data.path);
    if (!s.isDirectory()) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: `path is not a directory: ${parsed.data.path}` }));
      return;
    }
  } catch {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: `path not found: ${parsed.data.path}` }));
    return;
  }

  const sse = openSseStream(req, res);
  const startedAt = Date.now();
  let heartbeat: NodeJS.Timeout | undefined;

  try {
    sse.send("started", {
      path: parsed.data.path,
      depth: parsed.data.depth,
      ts: startedAt,
    });

    heartbeat = setInterval(() => {
      sse.send("progress", { durationMs: Date.now() - startedAt });
    }, HEARTBEAT_MS);

    const gen = discoverReposStream({
      targetDir: parsed.data.path,
      depth: parsed.data.depth,
      exclude: parsed.data.exclude,
    });

    let count = 0;
    for (;;) {
      const next = await gen.next();
      if (sse.closed()) break;
      if (next.done) {
        count = next.value.count;
        break;
      }
      sse.send("repo", next.value);
    }

    if (!sse.closed()) {
      sse.send("done", { count, durationMs: Date.now() - startedAt });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!sse.closed()) sse.send("error", { message });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    sse.close();
  }
}

function summarizeMessage(msg: {
  type: string;
  message?: { content: Array<{ type: string; text?: string }> };
  result?: string;
}): string {
  if (msg.type === "result" && typeof msg.result === "string") {
    return msg.result.slice(0, 160);
  }
  if (msg.message?.content) {
    const text = msg.message.content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text ?? "")
      .join(" ");
    if (text.length > 0) return text.slice(0, 160);
  }
  return msg.type;
}
