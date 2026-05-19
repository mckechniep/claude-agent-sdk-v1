import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  handleAnalyzeStream,
  handleApproveProposal,
  handleAuthStatus,
  handleDiscoverStream,
  handleGetApproval,
  handleListRuns,
  handleSetAuthMode,
  handleSmokeStream,
  type RouteResponse,
  type ServerDeps,
} from "./routes.js";

const DEFAULT_PORT = 3737;
const ALLOWED_ORIGINS = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (typeof origin === "string" && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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
    send(res, { status: 404, body: { error: "not found", path } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send(res, { status: 500, body: { error: message } });
  }
}

export function startServer(port = DEFAULT_PORT): { close: () => Promise<void>; port: number } {
  const deps: ServerDeps = {
    originalApiKey: process.env.ANTHROPIC_API_KEY,
  };

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
