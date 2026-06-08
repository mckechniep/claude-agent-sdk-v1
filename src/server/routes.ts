import type { IncomingMessage, ServerResponse } from "node:http";
import { stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { z } from "zod";
import { AUTH_MODES, type AuthMode } from "../types.js";
import { applyAuthMode } from "../auth/mode.js";
import { BudgetTracker } from "../orchestrator/budget.js";
import { runQueryStream } from "../sdk/query.js";
import { listRuns, defaultStateRoot } from "../state/runIndex.js";
import { describeRepo, discoverReposStream } from "../phases/discover.js";
import { analyzeStream } from "../phases/analyze.js";
import { planStream } from "../phases/plan.js";
import { getStackProfile } from "../stack/detect.js";
import {
  readPlanApproval,
  readProposal,
  readProposalApproval,
  writePlanApproval,
  writeProposalApproval,
} from "../state/repoState.js";
import { detectAuth } from "./authDetect.js";
import { loadUiConfig, setPreferredAuthMode } from "./config.js";
import { persistApiKey, clearPersistedApiKey } from "../auth/keyStore.js";
import { openSseStream } from "./sse.js";

const SetModeBody = z.object({ mode: z.enum(AUTH_MODES).nullable() });
const SetKeyBody = z.object({
  // Trim incidental whitespace from copy/paste; require a plausibly-real key
  // length rather than locking to a provider prefix that could change.
  key: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(20)),
  // Default true: the user explicitly asked to persist+encrypt. Pass false to
  // set the key for this server lifetime only (in-memory).
  persist: z.boolean().default(true),
});
const StreamQuery = z.object({ mode: z.enum(AUTH_MODES) });
const DiscoverQuery = z.object({
  path: z.string().min(1),
  depth: z.number().int().min(0).max(8).default(2),
  exclude: z.array(z.string()).optional(),
});

const ThoroughnessSchema = z.enum(["thorough", "balanced", "fast"]);

const AnalyzeQuery = z.object({
  repoPath: z.string().min(1),
  mode: z.enum(AUTH_MODES),
  userNotes: z.string().max(20_000).optional(),
  iteration: z.number().int().min(1).max(100).optional(),
  thoroughness: ThoroughnessSchema.optional(),
  finalize: z.boolean().optional(),
});

const ApproveBody = z.object({
  repoPath: z.string().min(1),
  proposalPath: z.string().min(1),
});

const PlanQuery = z.object({
  repoPath: z.string().min(1),
  mode: z.enum(AUTH_MODES),
  userNotes: z.string().max(20_000).optional(),
  iteration: z.number().int().min(1).max(100).optional(),
  thoroughness: ThoroughnessSchema.optional(),
});

const ApprovePlanBody = z.object({
  repoPath: z.string().min(1),
  planPath: z.string().min(1),
  taskCount: z.number().int().nonnegative(),
});

const HEARTBEAT_MS = 750;

export interface ServerDeps {
  // The current usable API key. Named "original" historically (it was the
  // startup env snapshot), but it is now the single source of truth that every
  // auth gate reads live: seeded from env or the encrypted store at startup,
  // and reassigned by POST/DELETE /api/auth/key at runtime.
  originalApiKey: string | undefined;
  // Whether a key is saved to the encrypted on-disk store (vs only in env/memory).
  // Drives the UI's "saved — forget key" affordance. Optional so call sites that
  // don't exercise persistence (most route tests) need not set it.
  apiKeyPersisted?: boolean;
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
      apiKeyPersisted: deps.apiKeyPersisted ?? false,
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

/**
 * Accept an API key from the UI: apply it to the live environment, update the
 * shared deps so every auth gate sees it immediately, and (by default) encrypt
 * it to the machine-bound store so it survives a server restart. The key is
 * never echoed back or logged.
 */
export async function handleSetApiKey(payload: unknown, deps: ServerDeps): Promise<RouteResponse> {
  const parsed = SetKeyBody.safeParse(payload);
  if (!parsed.success) {
    return { status: 400, body: { error: "invalid api key", issues: parsed.error.issues } };
  }
  const { key, persist } = parsed.data;
  if (persist) {
    await persistApiKey(key);
  }
  process.env.ANTHROPIC_API_KEY = key;
  deps.originalApiKey = key;
  deps.apiKeyPersisted = persist;
  return { status: 200, body: { apiKeyDetected: true, apiKeyPersisted: persist } };
}

/**
 * Forget the API key: remove it from the encrypted store, the environment, and
 * the shared deps. Idempotent — clearing when nothing is set is a no-op 200.
 */
export async function handleClearApiKey(deps: ServerDeps): Promise<RouteResponse> {
  await clearPersistedApiKey();
  delete process.env.ANTHROPIC_API_KEY;
  deps.originalApiKey = undefined;
  deps.apiKeyPersisted = false;
  return { status: 200, body: { apiKeyDetected: false, apiKeyPersisted: false } };
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

    // Subscription auth can have 15-30s first-token latency under load;
    // 60s cap leaves headroom while still bounding a stuck request.
    const tracker = new BudgetTracker({ maxTokens: 500, maxDurationMs: 60_000 });
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

export async function handleAnalyzeStream(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  query: URLSearchParams,
): Promise<void> {
  const rawPath = query.get("repoPath") ?? "";
  const expandedPath = rawPath.startsWith("~/")
    ? resolvePath(process.env.HOME ?? "", rawPath.slice(2))
    : resolvePath(rawPath);

  const notesRaw = query.get("userNotes");
  const iterRaw = query.get("iteration");
  const parsed = AnalyzeQuery.safeParse({
    repoPath: expandedPath,
    mode: query.get("mode"),
    userNotes: notesRaw && notesRaw.length > 0 ? notesRaw : undefined,
    iteration: iterRaw ? Number(iterRaw) : undefined,
    thoroughness: query.get("thoroughness") ?? undefined,
    finalize: query.get("finalize") === "true",
  });

  if (!parsed.success) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "invalid query", issues: parsed.error.issues }));
    return;
  }

  const mode = parsed.data.mode;
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

  try {
    const s = await stat(parsed.data.repoPath);
    if (!s.isDirectory()) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: `path is not a directory: ${parsed.data.repoPath}` }));
      return;
    }
  } catch {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: `path not found: ${parsed.data.repoPath}` }));
    return;
  }

  const sse = openSseStream(req, res);
  const startedAt = Date.now();
  let heartbeat: NodeJS.Timeout | undefined;

  try {
    if (mode === "api") process.env.ANTHROPIC_API_KEY = deps.originalApiKey;
    applyAuthMode(mode);

    const repo = await describeRepo(parsed.data.repoPath);

    sse.send("started", {
      repoPath: repo.path,
      repoName: repo.name,
      stack: repo.stack,
      mode,
      ts: startedAt,
    });

    heartbeat = setInterval(() => {
      sse.send("progress", { durationMs: Date.now() - startedAt });
    }, HEARTBEAT_MS);

    const tracker = new BudgetTracker({
      maxTokens: 200_000,
      maxDurationMs: 10 * 60 * 1000,
    });

    const gen = analyzeStream({
      repoPath: repo.path,
      repoName: repo.name,
      stackProfile: getStackProfile(repo.stack),
      hasReadme: repo.hasReadme,
      hasTests: repo.hasTests,
      lastCommitDate: repo.lastCommitDate,
      tracker,
      ...(parsed.data.userNotes ? { userNotes: parsed.data.userNotes } : {}),
      ...(parsed.data.iteration ? { iteration: parsed.data.iteration } : {}),
      ...(parsed.data.thoroughness ? { thoroughness: parsed.data.thoroughness } : {}),
      ...(parsed.data.finalize ? { finalize: true } : {}),
    });

    let final: {
      proposalPath: string;
      proposalMarkdown: string;
      tokensUsed: number;
      durationMs: number;
    } | null = null;

    for (;;) {
      const next = await gen.next();
      if (sse.closed()) break;
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
        proposalPath: final.proposalPath,
        proposalMarkdown: final.proposalMarkdown,
        tokensUsed: final.tokensUsed,
        durationMs: final.durationMs,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!sse.closed()) sse.send("error", { ok: false, message });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    restoreEnv(deps.originalApiKey);
    sse.close();
  }
}

export async function handleApproveProposal(payload: unknown): Promise<RouteResponse> {
  const parsed = ApproveBody.safeParse(payload);
  if (!parsed.success) {
    return { status: 400, body: { error: "invalid body", issues: parsed.error.issues } };
  }
  try {
    const markerPath = await writeProposalApproval(parsed.data.repoPath, parsed.data.proposalPath);
    return { status: 200, body: { ok: true, markerPath } };
  } catch (err) {
    return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
  }
}

export async function handleGetApproval(query: URLSearchParams): Promise<RouteResponse> {
  const repoPath = query.get("repoPath");
  if (!repoPath) {
    return { status: 400, body: { error: "repoPath is required" } };
  }
  const approval = await readProposalApproval(repoPath);
  return { status: 200, body: { approval } };
}

export async function handlePlanStream(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  query: URLSearchParams,
): Promise<void> {
  const rawPath = query.get("repoPath") ?? "";
  const expandedPath = rawPath.startsWith("~/")
    ? resolvePath(process.env.HOME ?? "", rawPath.slice(2))
    : resolvePath(rawPath);

  const notesRaw = query.get("userNotes");
  const iterRaw = query.get("iteration");
  const parsed = PlanQuery.safeParse({
    repoPath: expandedPath,
    mode: query.get("mode"),
    userNotes: notesRaw && notesRaw.length > 0 ? notesRaw : undefined,
    iteration: iterRaw ? Number(iterRaw) : undefined,
    thoroughness: query.get("thoroughness") ?? undefined,
  });

  if (!parsed.success) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "invalid query", issues: parsed.error.issues }));
    return;
  }

  const mode = parsed.data.mode;
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

  try {
    const s = await stat(parsed.data.repoPath);
    if (!s.isDirectory()) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: `path is not a directory: ${parsed.data.repoPath}` }));
      return;
    }
  } catch {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: `path not found: ${parsed.data.repoPath}` }));
    return;
  }

  // Gate the planner on a prior proposal approval. The marker is the
  // contract; we read the approved proposal from disk as the planner's
  // input so the UI never has to send the proposal back to the server.
  const approval = await readProposalApproval(parsed.data.repoPath);
  if (!approval) {
    res.statusCode = 409;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "proposal has not been approved for this repo" }));
    return;
  }
  const proposalMarkdown = await readProposal(parsed.data.repoPath);
  if (!proposalMarkdown) {
    res.statusCode = 409;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: "proposal approval marker exists but completion-proposal.md is missing",
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

    const repo = await describeRepo(parsed.data.repoPath);

    sse.send("started", {
      repoPath: repo.path,
      repoName: repo.name,
      stack: repo.stack,
      mode,
      ts: startedAt,
    });

    heartbeat = setInterval(() => {
      sse.send("progress", { durationMs: Date.now() - startedAt });
    }, HEARTBEAT_MS);

    const tracker = new BudgetTracker({
      maxTokens: 200_000,
      // Planner runs deeper than analyze — give it 15 min headroom.
      maxDurationMs: 15 * 60 * 1000,
    });

    const gen = planStream({
      repoPath: repo.path,
      repoName: repo.name,
      stackProfile: getStackProfile(repo.stack),
      proposalMarkdown,
      tracker,
      ...(parsed.data.userNotes ? { userNotes: parsed.data.userNotes } : {}),
      ...(parsed.data.iteration ? { iteration: parsed.data.iteration } : {}),
      ...(parsed.data.thoroughness ? { thoroughness: parsed.data.thoroughness } : {}),
    });

    let final: {
      planPath: string;
      planMarkdown: string;
      taskCount: number;
      estimatedTokens: number;
      estimatedDurationMs: number;
      tokensUsed: number;
      durationMs: number;
    } | null = null;

    for (;;) {
      const next = await gen.next();
      if (sse.closed()) break;
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
        planPath: final.planPath,
        planMarkdown: final.planMarkdown,
        taskCount: final.taskCount,
        estimatedTokens: final.estimatedTokens,
        estimatedDurationMs: final.estimatedDurationMs,
        tokensUsed: final.tokensUsed,
        durationMs: final.durationMs,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!sse.closed()) sse.send("error", { ok: false, message });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    restoreEnv(deps.originalApiKey);
    sse.close();
  }
}

export async function handleApprovePlan(payload: unknown): Promise<RouteResponse> {
  const parsed = ApprovePlanBody.safeParse(payload);
  if (!parsed.success) {
    return { status: 400, body: { error: "invalid body", issues: parsed.error.issues } };
  }
  try {
    const markerPath = await writePlanApproval(
      parsed.data.repoPath,
      parsed.data.planPath,
      parsed.data.taskCount,
    );
    return { status: 200, body: { ok: true, markerPath } };
  } catch (err) {
    return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
  }
}

export async function handleGetPlanApproval(query: URLSearchParams): Promise<RouteResponse> {
  const repoPath = query.get("repoPath");
  if (!repoPath) {
    return { status: 400, body: { error: "repoPath is required" } };
  }
  const approval = await readPlanApproval(repoPath);
  return { status: 200, body: { approval } };
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
  // No human-readable content (system setup events, etc.) — let the UI
  // render the pill alone with its dot fallback.
  return "";
}
