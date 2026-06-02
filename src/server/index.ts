import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  handleAnalyzeStream,
  handleApprovePlan,
  handleApproveProposal,
  handleAuthStatus,
  handleDiscoverStream,
  handleGetApproval,
  handleGetPlanApproval,
  handleListRuns,
  handlePlanStream,
  handleSetAuthMode,
  handleSetApiKey,
  handleClearApiKey,
  handleSmokeStream,
  type RouteResponse,
  type ServerDeps,
} from "./routes.js";
import {
  handleDeleteRun,
  handleGetLog,
  handleGetManifest,
  handleGetRepoArtifacts,
  handleRecoverRun,
  handleResumeRun,
  handleRetryFromFailure,
  handleStartRun,
  handleStepRun,
  handleStopRun,
  handleStreamLog,
  handleSubmitDecisions,
} from "./runRoutes.js";
import { sweepCrashedRuns } from "./crashRecovery.js";
import { readPersistedApiKeySync } from "../auth/keyStore.js";
import { defaultStateRoot } from "../state/runIndex.js";

const DEFAULT_PORT = 3737;
const ALLOWED_ORIGINS = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (typeof origin === "string" && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, payload: RouteResponse): void {
  res.statusCode = payload.status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload.body));
}

// Matches /api/run/:ulid — bare run-id path (no action suffix), used for
// DELETE /api/run/:id. Returns the runId or null.
function matchRunId(path: string): string | null {
  const m = path.match(/^\/api\/run\/([0-9A-HJKMNP-TV-Z]{26})$/);
  return m && m[1] ? m[1] : null;
}

// Matches /api/run/:ulid/:action where ulid is the Crockford-base-32 26-char
// form. Returns null if the path doesn't match.
function matchRunAction(path: string): { runId: string; action: string } | null {
  const m = path.match(/^\/api\/run\/([0-9A-HJKMNP-TV-Z]{26})\/([a-z][a-z-]*)$/);
  if (!m || !m[1] || !m[2]) return null;
  return { runId: m[1], action: m[2] };
}

// Matches /api/run/:ulid/log/stream — the only nested action; broken out
// rather than generalizing matchRunAction to keep that regex simple.
function matchRunLogStream(path: string): string | null {
  const m = path.match(/^\/api\/run\/([0-9A-HJKMNP-TV-Z]{26})\/log\/stream$/);
  return m && m[1] ? m[1] : null;
}

async function route(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  try {
    if (method === "GET" && path === "/api/health") {
      return send(res, { status: 200, body: { ok: true } });
    }
    if (method === "GET" && path === "/api/auth/status") {
      return send(res, await handleAuthStatus(deps));
    }
    if (method === "POST" && path === "/api/auth/mode") {
      const body = await readJsonBody(req);
      return send(res, await handleSetAuthMode(body));
    }
    if (method === "POST" && path === "/api/auth/key") {
      const body = await readJsonBody(req);
      return send(res, await handleSetApiKey(body, deps));
    }
    if (method === "DELETE" && path === "/api/auth/key") {
      return send(res, await handleClearApiKey(deps));
    }
    if (method === "GET" && path === "/api/runs") {
      return send(res, await handleListRuns());
    }
    if (method === "GET" && path === "/api/smoke/stream") {
      return handleSmokeStream(req, res, deps, url.searchParams);
    }
    if (method === "GET" && path === "/api/discover/stream") {
      return handleDiscoverStream(req, res, url.searchParams);
    }
    if (method === "GET" && path === "/api/analyze/stream") {
      return handleAnalyzeStream(req, res, deps, url.searchParams);
    }
    if (method === "POST" && path === "/api/analyze/approve") {
      const body = await readJsonBody(req);
      return send(res, await handleApproveProposal(body));
    }
    if (method === "GET" && path === "/api/analyze/approval") {
      return send(res, await handleGetApproval(url.searchParams));
    }
    if (method === "GET" && path === "/api/plan/stream") {
      return handlePlanStream(req, res, deps, url.searchParams);
    }
    if (method === "POST" && path === "/api/plan/approve") {
      const body = await readJsonBody(req);
      return send(res, await handleApprovePlan(body));
    }
    if (method === "GET" && path === "/api/plan/approval") {
      return send(res, await handleGetPlanApproval(url.searchParams));
    }

    if (method === "POST" && path === "/api/run/start") {
      const body = await readJsonBody(req);
      return send(res, await handleStartRun(body, deps));
    }
    const deleteRunId = matchRunId(path);
    if (method === "DELETE" && deleteRunId) {
      return send(res, await handleDeleteRun(deleteRunId));
    }
    const logStreamRunId = matchRunLogStream(path);
    if (method === "GET" && logStreamRunId) {
      return handleStreamLog(req, res, logStreamRunId, url.searchParams);
    }
    const runAction = matchRunAction(path);
    if (runAction) {
      const { runId, action } = runAction;
      if (method === "POST" && action === "step") {
        const body = await readJsonBody(req);
        return send(res, await handleStepRun(runId, body, deps));
      }
      if (method === "POST" && action === "decisions") {
        const body = await readJsonBody(req);
        return send(res, await handleSubmitDecisions(runId, body, deps));
      }
      if (method === "GET" && action === "manifest") {
        return send(res, await handleGetManifest(runId));
      }
      if (method === "GET" && action === "log") {
        return send(res, await handleGetLog(runId, url.searchParams));
      }
      if (method === "GET" && action === "repo-artifacts") {
        return send(res, await handleGetRepoArtifacts(runId, url.searchParams));
      }
      if (method === "POST" && action === "resume") {
        const body = await readJsonBody(req);
        return send(res, await handleResumeRun(runId, deps, body));
      }
      if (method === "POST" && action === "stop") {
        const body = await readJsonBody(req);
        return send(res, await handleStopRun(runId, body));
      }
      if (method === "POST" && action === "recover") {
        return send(res, await handleRecoverRun(runId));
      }
      if (method === "POST" && action === "retry-from-failure") {
        const body = await readJsonBody(req);
        return send(res, await handleRetryFromFailure(runId, deps, body));
      }
    }

    send(res, { status: 404, body: { error: "not found", path } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send(res, { status: 500, body: { error: message } });
  }
}

export function startServer(port = DEFAULT_PORT): { close: () => Promise<void>; port: number } {
  // Seed the API key: an explicit env var wins (matches CLI behavior and lets a
  // shell override the stored key); otherwise fall back to the encrypted store
  // so a key saved via the UI survives restarts. Read synchronously so the very
  // first /api/auth/status already reflects a stored key.
  const envKey = process.env.ANTHROPIC_API_KEY;
  const storedKey = envKey ? null : readPersistedApiKeySync();
  if (storedKey) process.env.ANTHROPIC_API_KEY = storedKey;
  const deps: ServerDeps = {
    originalApiKey: envKey ?? storedKey ?? undefined,
    apiKeyPersisted: !envKey && storedKey !== null,
  };

  // Fire-and-forget recovery sweep — runs concurrently with `listen()`. The
  // dashboard's first manifest fetch can be served from the recovered state
  // because file writes are atomic; if the user lands on the dashboard
  // mid-sweep they may see "running" once then "paused" on the next refresh,
  // which is fine. Awaiting the sweep would delay server readiness.
  void sweepCrashedRuns(defaultStateRoot())
    .then((report) => {
      if (report.recovered.length > 0) {
        console.warn(
          `[agent-orchestrator] recovered ${report.recovered.length} crashed run(s) on startup`,
        );
      }
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[agent-orchestrator] crash recovery sweep failed: ${message}`);
    });

  const server = createServer((req, res) => {
    applyCors(req, res);
    void route(req, res, deps);
  });

  server.listen(port, () => {
    // Server boot log is the one acceptable console.warn — it's lifecycle, not debug.
    console.warn(`[agent-orchestrator] UI server listening on http://localhost:${port}`);
  });

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

const isEntry = import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  const portArg = process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT;
  startServer(Number.isFinite(portArg) ? portArg : DEFAULT_PORT);
}
