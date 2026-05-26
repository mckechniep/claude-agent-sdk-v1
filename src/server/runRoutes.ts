import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { ulid } from "ulid";
import { join } from "node:path";
import { step } from "../orchestrator/run.js";
import type { StepParams } from "../orchestrator/run.js";
import { defaultStateRoot, loadManifest } from "../state/runIndex.js";
import { readLogTailFromByte, runLogPath } from "../state/runLog.js";
import { applyAuthMode } from "../auth/mode.js";
import { openSseStream } from "./sse.js";
import {
  AUTH_MODES,
  RunConfigSchema,
  type AuthMode,
  type RunManifest,
  type StackId,
} from "../types.js";
import { startBackgroundLoop, isLoopActive, LoopAlreadyActiveError } from "./runLoop.js";
import type { ServerDeps, RouteResponse } from "./routes.js";

const DiscoveredRepoSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  stack: z.string(),
  hasReadme: z.boolean(),
  hasTests: z.boolean(),
  lastCommitDate: z.string().nullable(),
  isDirty: z.boolean(),
});

const StartRunBody = z.object({
  config: RunConfigSchema,
  authMode: z.enum(AUTH_MODES),
  selectedRepos: z.array(DiscoveredRepoSchema).min(1),
});

const StepDecisionsSchema = z.object({
  proposals: z.record(z.string(), z.enum(["accept", "reject", "reanalyze"])).optional(),
  plans: z.record(z.string(), z.enum(["accept", "reject", "replan"])).optional(),
  runConfirmed: z.boolean().optional(),
});

const StepBody = z
  .object({
    decisions: StepDecisionsSchema.optional(),
  })
  .partial();

// Module-scoped storage for in-flight decisions awaiting consumption by the
// background loop. v0.1 limitation: lost on server restart; user re-submits.
// v0.2: persist to disk (e.g. pending-decisions.json in the runDir).
const pendingDecisions = new Map<string, z.infer<typeof StepDecisionsSchema>>();

// Auth-applying step factory: re-applies auth before each step() call AND
// consumes any pending decisions submitted via POST /api/run/:id/decisions.
function makeStepFactory(args: {
  runId: string;
  stateRoot: string;
  authMode: AuthMode;
  apiKey: string | undefined;
}): () => StepParams {
  return () => {
    if (args.authMode === "api") {
      process.env.ANTHROPIC_API_KEY = args.apiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    applyAuthMode(args.authMode);

    const decisions = pendingDecisions.get(args.runId);
    pendingDecisions.delete(args.runId);

    return {
      runId: args.runId,
      stateRoot: args.stateRoot,
      decisions,
    };
  };
}

export async function handleStartRun(payload: unknown, deps: ServerDeps): Promise<RouteResponse> {
  const parsed = StartRunBody.safeParse(payload);
  if (!parsed.success) {
    return { status: 400, body: { error: "invalid body", issues: parsed.error.issues } };
  }
  const { config, authMode, selectedRepos } = parsed.data;

  if (authMode === "api" && !deps.originalApiKey) {
    return {
      status: 400,
      body: {
        error: "api mode selected but ANTHROPIC_API_KEY was not set when the server started",
      },
    };
  }

  const runId = ulid();
  const stateRoot = defaultStateRoot();

  // The factory captures auth + state; we call it once for the bootstrap step,
  // then reuse the same factory for the background loop if applicable.
  const stepParams = makeStepFactory({ runId, stateRoot, authMode, apiKey: deps.originalApiKey });

  let manifest: RunManifest;
  try {
    manifest = await step({
      ...stepParams(),
      authMode,
      config,
      selectedRepos: selectedRepos.map((r) => ({ ...r, stack: r.stack as StackId })),
    });
  } catch (err) {
    return {
      status: 500,
      body: { error: err instanceof Error ? err.message : String(err) },
    };
  }

  if (config.autonomy !== "manual" && !isTerminal(manifest.status)) {
    try {
      startBackgroundLoop({ runId, stateRoot, stepParams });
    } catch (err) {
      if (err instanceof LoopAlreadyActiveError) {
        return { status: 409, body: { error: err.message } };
      }
      throw err;
    }
  }

  return { status: 201, body: { runId, manifest } };
}

export async function handleStepRun(
  runId: string,
  payload: unknown,
  deps: ServerDeps,
): Promise<RouteResponse> {
  if (!isValidUlid(runId)) {
    return { status: 400, body: { error: "invalid runId" } };
  }
  const parsed = StepBody.safeParse(payload);
  if (!parsed.success) {
    return { status: 400, body: { error: "invalid body", issues: parsed.error.issues } };
  }

  const stateRoot = defaultStateRoot();
  let existing: RunManifest;
  try {
    existing = await loadManifest(join(stateRoot, runId));
  } catch {
    return { status: 404, body: { error: `run ${runId} not found` } };
  }

  if (existing.authMode === "api" && !deps.originalApiKey) {
    return {
      status: 400,
      body: { error: "run was started in api mode but ANTHROPIC_API_KEY is not available" },
    };
  }

  if (parsed.data.decisions) {
    mergePendingDecisions(runId, parsed.data.decisions);
  }

  const stepParams = makeStepFactory({
    runId,
    stateRoot,
    authMode: existing.authMode,
    apiKey: deps.originalApiKey,
  });

  try {
    const manifest = await step(stepParams());
    return { status: 200, body: { manifest } };
  } catch (err) {
    return {
      status: 500,
      body: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

export async function handleSubmitDecisions(
  runId: string,
  payload: unknown,
): Promise<RouteResponse> {
  if (!isValidUlid(runId)) {
    return { status: 400, body: { error: "invalid runId" } };
  }
  const parsed = StepDecisionsSchema.safeParse(payload);
  if (!parsed.success) {
    return { status: 400, body: { error: "invalid body", issues: parsed.error.issues } };
  }
  mergePendingDecisions(runId, parsed.data);
  return {
    status: 202,
    body: {
      ok: true,
      runId,
      pending: pendingDecisions.get(runId) ?? {},
    },
  };
}

export async function handleGetManifest(runId: string): Promise<RouteResponse> {
  if (!isValidUlid(runId)) {
    return { status: 400, body: { error: "invalid runId" } };
  }
  const stateRoot = defaultStateRoot();
  try {
    const manifest = await loadManifest(join(stateRoot, runId));
    return { status: 200, body: { manifest, loopActive: isLoopActive(runId) } };
  } catch {
    return { status: 404, body: { error: `run ${runId} not found` } };
  }
}

export async function handleGetLog(
  runId: string,
  query: URLSearchParams,
): Promise<RouteResponse> {
  if (!isValidUlid(runId)) {
    return { status: 400, body: { error: "invalid runId" } };
  }
  const fromByteRaw = query.get("fromByte");
  const fromByte = fromByteRaw === null ? 0 : Number(fromByteRaw);
  if (!Number.isFinite(fromByte) || fromByte < 0 || !Number.isInteger(fromByte)) {
    return { status: 400, body: { error: "fromByte must be a non-negative integer" } };
  }

  const stateRoot = defaultStateRoot();
  const path = runLogPath(stateRoot, runId);
  const tail = await readLogTailFromByte(path, fromByte);
  if (!tail.fileExists) {
    return { status: 404, body: { error: `log not found for run ${runId}` } };
  }
  return { status: 200, body: { events: tail.events, nextByte: tail.nextByte } };
}

// Tunables for the log SSE stream. Polling cadence is a soft-realtime
// compromise: 250ms catches new lines fast enough for human perception
// while staying friendly on WSL2 cross-FS where fs.watch is unreliable.
const LOG_STREAM_POLL_MS = 250;
const LOG_STREAM_HEARTBEAT_MS = 1500;

export async function handleStreamLog(
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
  query: URLSearchParams,
): Promise<void> {
  if (!isValidUlid(runId)) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "invalid runId" }));
    return;
  }
  const fromByteRaw = query.get("fromByte");
  const fromByte = fromByteRaw === null ? 0 : Number(fromByteRaw);
  if (!Number.isFinite(fromByte) || fromByte < 0 || !Number.isInteger(fromByte)) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "fromByte must be a non-negative integer" }));
    return;
  }

  const path = runLogPath(defaultStateRoot(), runId);
  const sse = openSseStream(req, res);
  let cursor = fromByte;
  let lastHeartbeat = Date.now();
  let poll: NodeJS.Timeout | undefined;
  let stopped = false;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (poll) clearInterval(poll);
    sse.close();
  };

  sse.onClientClose(stop);

  const tick = async (): Promise<void> => {
    if (sse.closed() || stopped) return;
    try {
      const tail = await readLogTailFromByte(path, cursor);
      if (tail.events.length > 0) {
        sse.send("tail", { events: tail.events, nextByte: tail.nextByte });
        cursor = tail.nextByte;
        lastHeartbeat = Date.now();
        return;
      }
      if (Date.now() - lastHeartbeat >= LOG_STREAM_HEARTBEAT_MS) {
        sse.send("idle", { nextByte: cursor, fileExists: tail.fileExists });
        lastHeartbeat = Date.now();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!sse.closed()) sse.send("error", { message });
      stop();
    }
  };

  // Initial replay before subscribing to deltas.
  await tick();
  if (stopped) return;
  poll = setInterval(() => {
    void tick();
  }, LOG_STREAM_POLL_MS);
}

export async function handleResumeRun(runId: string, deps: ServerDeps): Promise<RouteResponse> {
  if (!isValidUlid(runId)) {
    return { status: 400, body: { error: "invalid runId" } };
  }

  const stateRoot = defaultStateRoot();
  let manifest: RunManifest;
  try {
    manifest = await loadManifest(join(stateRoot, runId));
  } catch {
    return { status: 404, body: { error: `run ${runId} not found` } };
  }

  if (manifest.status !== "paused") {
    return {
      status: 409,
      body: { error: `run ${runId} is in status "${manifest.status}", not "paused"` },
    };
  }

  if (manifest.authMode === "api" && !deps.originalApiKey) {
    return {
      status: 400,
      body: { error: "run was started in api mode but ANTHROPIC_API_KEY is not available" },
    };
  }

  const stepParams = makeStepFactory({
    runId,
    stateRoot,
    authMode: manifest.authMode,
    apiKey: deps.originalApiKey,
  });

  try {
    startBackgroundLoop({ runId, stateRoot, stepParams });
  } catch (err) {
    if (err instanceof LoopAlreadyActiveError) {
      return { status: 409, body: { error: err.message } };
    }
    throw err;
  }

  return { status: 200, body: { runId, manifest } };
}

function isValidUlid(id: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id);
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "paused";
}

function mergePendingDecisions(runId: string, next: z.infer<typeof StepDecisionsSchema>): void {
  const existing = pendingDecisions.get(runId) ?? {};
  pendingDecisions.set(runId, {
    proposals: { ...existing.proposals, ...next.proposals },
    plans: { ...existing.plans, ...next.plans },
    runConfirmed: next.runConfirmed ?? existing.runConfirmed,
  });
}

// Test-only escape hatch for clearing decisions between cases.
export function __clearPendingDecisionsForTests(): void {
  pendingDecisions.clear();
}
