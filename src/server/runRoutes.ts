import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { ulid } from "ulid";
import { join } from "node:path";
import { step, switchRunAuthMode } from "../orchestrator/run.js";
import type { StepParams } from "../orchestrator/run.js";
import { defaultStateRoot, loadManifest, saveManifest } from "../state/runIndex.js";
import { appendLogEvent, readLogTailFromByte, runLogPath } from "../state/runLog.js";
import { readHeartbeat } from "../state/heartbeat.js";
import { recoverRun } from "./crashRecovery.js";
import {
  readPlan,
  readPlanApproval,
  readProposal,
  readProposalApproval,
} from "../state/repoState.js";
import { applyAuthMode } from "../auth/mode.js";
import { openSseStream } from "./sse.js";
import {
  AUTH_MODES,
  RunConfigSchema,
  ModelIdSchema,
  EffortLevelSchema,
  type AuthMode,
  type RunManifest,
  type StackId,
} from "../types.js";
import {
  startBackgroundLoop,
  isLoopActive,
  LoopAlreadyActiveError,
  requestStop,
  type StopMode,
} from "./runLoop.js";
import type { ServerDeps, RouteResponse } from "./routes.js";

const DiscoveredRepoSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  stack: z.string(),
  hasReadme: z.boolean(),
  hasTests: z.boolean(),
  lastCommitDate: z.string().nullable(),
  isDirty: z.boolean(),
  // Optional: UI sends these when it knows the prior approval state. Older UI
  // builds that don't include them still validate correctly (Zod strips them).
  hasApprovedProposal: z.boolean().optional(),
  hasApprovedPlan: z.boolean().optional(),
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
  configPatch: z
    .object({
      model: z
        .object({
          default: ModelIdSchema.optional(),
          analyze: ModelIdSchema.optional(),
          plan: ModelIdSchema.optional(),
          execute: ModelIdSchema.optional(),
        })
        .optional(),
      effort: z
        .object({
          default: EffortLevelSchema.optional(),
          analyze: EffortLevelSchema.optional(),
          plan: EffortLevelSchema.optional(),
          execute: EffortLevelSchema.optional(),
        })
        .optional(),
    })
    .optional(),
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

// Optional body for resume / retry-from-failure: switch how the run is billed
// for its remaining work.
const AuthSwitchBody = z.object({ authMode: z.enum(AUTH_MODES).optional() });

/**
 * Switch how a paused/failed run is billed before continuing it. Validates that
 * api mode has a key available, seeds the per-auth-mode spend tally under the
 * OLD mode (so spend already incurred stays attributed to the mode it was spent
 * under), flips manifest.authMode, and persists. Returns an error RouteResponse,
 * or null on success / no-op.
 */
async function applyAuthSwitch(
  manifest: RunManifest,
  runDir: string,
  requested: AuthMode | undefined,
  deps: ServerDeps,
): Promise<RouteResponse | null> {
  if (!requested || requested === manifest.authMode) return null;
  if (requested === "api" && !deps.originalApiKey) {
    return {
      status: 400,
      body: {
        error:
          "cannot switch to api mode: no ANTHROPIC_API_KEY available — set one in the auth card first",
      },
    };
  }
  // Shared seed-before-flip migration lives in run.ts so the CLI and server
  // can't drift on the attribution ordering.
  await switchRunAuthMode(manifest, runDir, requested);
  return null;
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
      selectedRepos: selectedRepos.map((r) => ({
        ...r,
        stack: r.stack as StackId,
        hasApprovedProposal: r.hasApprovedProposal ?? false,
        hasApprovedPlan: r.hasApprovedPlan ?? false,
      })),
      bootstrapOnly: true,
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
  deps: ServerDeps,
): Promise<RouteResponse> {
  if (!isValidUlid(runId)) {
    return { status: 400, body: { error: "invalid runId" } };
  }
  const parsed = StepDecisionsSchema.safeParse(payload);
  if (!parsed.success) {
    return { status: 400, body: { error: "invalid body", issues: parsed.error.issues } };
  }
  mergePendingDecisions(runId, parsed.data);

  // The background loop exits on awaiting-decision (see runLoop.ts). When a
  // decision arrives we need to restart it so the new state gets processed.
  // For manual autonomy there's no background loop at all — the UI is
  // expected to call /step explicitly.
  let loopRestarted = false;
  const stateRoot = defaultStateRoot();
  try {
    const manifest = await loadManifest(join(stateRoot, runId));
    const canRestart =
      manifest.config.autonomy !== "manual" && !isTerminal(manifest.status) && !isLoopActive(runId);
    if (canRestart) {
      const apiOk = manifest.authMode !== "api" || Boolean(deps.originalApiKey);
      if (apiOk) {
        const stepParams = makeStepFactory({
          runId,
          stateRoot,
          authMode: manifest.authMode,
          apiKey: deps.originalApiKey,
        });
        try {
          startBackgroundLoop({ runId, stateRoot, stepParams });
          loopRestarted = true;
        } catch (err) {
          if (!(err instanceof LoopAlreadyActiveError)) throw err;
          // Already active — that's fine, the running loop will see the
          // freshly-merged decisions on its next iteration.
        }
      }
    }
  } catch {
    // Manifest not on disk yet (early submit) — fall through with the
    // decision stored. step() will pick it up when the manifest exists.
  }

  return {
    status: 202,
    body: {
      ok: true,
      runId,
      pending: pendingDecisions.get(runId) ?? {},
      loopRestarted,
    },
  };
}

export async function handleGetManifest(runId: string): Promise<RouteResponse> {
  if (!isValidUlid(runId)) {
    return { status: 400, body: { error: "invalid runId" } };
  }
  const stateRoot = defaultStateRoot();
  const runDir = join(stateRoot, runId);
  try {
    const manifest = await loadManifest(runDir);
    const heartbeat = await readHeartbeat(runDir);
    return {
      status: 200,
      body: {
        manifest,
        loopActive: isLoopActive(runId),
        lastHeartbeatAt: heartbeat?.ts ?? null,
      },
    };
  } catch {
    return { status: 404, body: { error: `run ${runId} not found` } };
  }
}

export async function handleGetLog(runId: string, query: URLSearchParams): Promise<RouteResponse> {
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

export async function handleGetRepoArtifacts(
  runId: string,
  query: URLSearchParams,
): Promise<RouteResponse> {
  if (!isValidUlid(runId)) {
    return { status: 400, body: { error: "invalid runId" } };
  }
  const repoPath = query.get("repoPath");
  if (!repoPath) {
    return { status: 400, body: { error: "repoPath is required" } };
  }

  let manifest: RunManifest;
  try {
    manifest = await loadManifest(join(defaultStateRoot(), runId));
  } catch {
    return { status: 404, body: { error: `run ${runId} not found` } };
  }
  // Confirm the requested repoPath is part of this run before reading disk.
  // Defense-in-depth against path traversal via the query parameter.
  const inManifest = manifest.repos.some((r) => r.path === repoPath);
  if (!inManifest) {
    return { status: 404, body: { error: "repoPath not part of this run" } };
  }

  const [proposalMarkdown, planMarkdown, proposalApproval, planApproval] = await Promise.all([
    readProposal(repoPath),
    readPlan(repoPath),
    readProposalApproval(repoPath),
    readPlanApproval(repoPath),
  ]);

  return {
    status: 200,
    body: {
      proposalMarkdown,
      planMarkdown,
      proposalApproval,
      planApproval,
    },
  };
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
  let stopped = false;

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
      stopped = true;
      sse.close();
    }
  };

  // Initial replay before subscribing to deltas. If the first tick errored
  // and closed the stream, bail before starting the interval.
  await tick();
  if (stopped) return;

  const poll = setInterval(() => {
    void tick();
  }, LOG_STREAM_POLL_MS);

  // sse.close() (called from tick's catch or by the client disconnecting)
  // fires this handler — both paths converge here to clear the timer.
  sse.onClientClose(() => {
    stopped = true;
    clearInterval(poll);
  });
}

const StopBody = z.object({
  mode: z.enum(["soft", "force"]).default("soft"),
});

export async function handleStopRun(runId: string, payload: unknown): Promise<RouteResponse> {
  if (!isValidUlid(runId)) {
    return { status: 400, body: { error: "invalid runId" } };
  }
  const parsed = StopBody.safeParse(payload ?? {});
  if (!parsed.success) {
    return { status: 400, body: { error: "invalid body", issues: parsed.error.issues } };
  }
  const mode: StopMode = parsed.data.mode;

  const stateRoot = defaultStateRoot();
  const runDir = join(stateRoot, runId);
  let manifest: RunManifest;
  try {
    manifest = await loadManifest(runDir);
  } catch {
    return { status: 404, body: { error: `run ${runId} not found` } };
  }

  if (isTerminal(manifest.status)) {
    return {
      status: 409,
      body: { error: `run ${runId} is already in terminal status "${manifest.status}"` },
    };
  }

  const loopWasActive = isLoopActive(runId);
  // For manual-autonomy runs there's no background loop, so a stop request
  // is mostly a no-op — record it for the audit log, then return. Force
  // mode in manual is meaningless since /step requests run to completion.
  const stopped = requestStop(runId, mode);

  // Write the transient "stopping" status so the UI can show it immediately
  // rather than waiting for the loop's finally to fire. The loop's finally
  // will overwrite this with "paused" once the in-flight step settles.
  if (stopped && !isTerminal(manifest.status)) {
    manifest.status = "stopping";
    try {
      await saveManifest(runDir, manifest);
    } catch {
      // Status mutation is a UX nicety; the authoritative write happens in
      // the loop's finally. Don't fail the route on this.
    }
  }

  try {
    await appendLogEvent(runLogPath(stateRoot, runId), {
      ts: new Date().toISOString(),
      type: "run_loop_stop_requested",
      runId,
      mode,
    });
  } catch {
    // Same logic — best-effort logging.
  }

  return {
    status: 200,
    body: {
      runId,
      mode,
      loopWasActive,
      stopped,
    },
  };
}

export async function handleRetryFromFailure(
  runId: string,
  deps: ServerDeps,
  payload?: unknown,
): Promise<RouteResponse> {
  if (!isValidUlid(runId)) {
    return { status: 400, body: { error: "invalid runId" } };
  }
  const switchParse = AuthSwitchBody.safeParse(payload ?? {});
  if (!switchParse.success) {
    return { status: 400, body: { error: "invalid body", issues: switchParse.error.issues } };
  }

  const stateRoot = defaultStateRoot();
  const runDir = join(stateRoot, runId);
  let manifest: RunManifest;
  try {
    manifest = await loadManifest(runDir);
  } catch {
    return { status: 404, body: { error: `run ${runId} not found` } };
  }

  if (manifest.status !== "failed") {
    return {
      status: 409,
      body: {
        error: `run ${runId} is in status "${manifest.status}", not "failed" — retry-from-failure only applies to failed runs`,
      },
    };
  }

  const switchErr = await applyAuthSwitch(manifest, runDir, switchParse.data.authMode, deps);
  if (switchErr) return switchErr;

  if (manifest.authMode === "api" && !deps.originalApiKey) {
    return {
      status: 400,
      body: { error: "run was started in api mode but ANTHROPIC_API_KEY is not available" },
    };
  }

  // Reset interrupted repos back to retryable. "Interrupted" covers two
  // distinct failure shapes:
  //   1. Clean failure — onFailure="skip-repo" tripped, repo.status="failed",
  //      remaining tasks at "pending".
  //   2. Thrown failure — an exception escaped step() (onFailure="stop", a
  //      git error, an SDK error). The outer catch slaps manifest="failed"
  //      but the repo is left at "executing" with the in-flight task at
  //      "in_progress" or "pending".
  // Both cases need the same fix: any non-terminal task in a repo that
  // isn't in a terminal/preflight state is retryable.
  let repoCount = 0;
  let taskCount = 0;
  for (const repo of manifest.repos) {
    if (!isInterruptedRepo(repo)) continue;
    repoCount += 1;
    let retryableInThisRepo = 0;
    for (const task of repo.taskState ?? []) {
      if (task.status === "completed" || task.status === "skipped") continue;
      if (task.status === "failed" || task.status === "in_progress") {
        task.status = "pending";
        task.attempts = 0;
        delete task.failureReason;
        delete task.testOutput;
      }
      // "pending" tasks need no mutation but are retryable — the executor's
      // existing for-loop will pick them up once the repo is back in
      // "executing" status.
      retryableInThisRepo += 1;
      taskCount += 1;
    }
    if (retryableInThisRepo > 0) {
      // Flip to (or leave at) "executing" so advanceRunning's runnable
      // filter picks it up. If repo was already "executing" this is a no-op.
      repo.status = "executing";
    }
  }

  manifest.status = "paused";
  await saveManifest(runDir, manifest);

  await appendLogEvent(runLogPath(stateRoot, runId), {
    ts: new Date().toISOString(),
    type: "run_retried_from_failure",
    runId,
    repoCount,
    taskCount,
  });

  // Auto-restart the loop. The endpoint's contract is "retry now" — we
  // don't want the user to have to click Resume separately after a click
  // they already made on "Retry from failure".
  const stepParams = makeStepFactory({
    runId,
    stateRoot,
    authMode: manifest.authMode,
    apiKey: deps.originalApiKey,
  });
  let loopStarted = false;
  try {
    startBackgroundLoop({ runId, stateRoot, stepParams });
    loopStarted = true;
  } catch (err) {
    if (!(err instanceof LoopAlreadyActiveError)) throw err;
    // Another loop already running for this runId — rare but possible if
    // the user double-clicked. Not an error; the loop will see the reset
    // state on its next iteration.
  }

  return {
    status: 200,
    body: {
      runId,
      manifest,
      repoCount,
      taskCount,
      loopStarted,
    },
  };
}

export async function handleRecoverRun(runId: string): Promise<RouteResponse> {
  if (!isValidUlid(runId)) {
    return { status: 400, body: { error: "invalid runId" } };
  }
  const outcome = await recoverRun(defaultStateRoot(), runId);

  if (outcome.kind === "recovered") {
    return {
      status: 200,
      body: {
        runId,
        previousStatus: outcome.previousStatus,
        lastHeartbeatAt: outcome.lastHeartbeatAt,
      },
    };
  }
  if (outcome.reason === "not-found") {
    return { status: 404, body: { error: `run ${runId} not found` } };
  }
  if (outcome.reason === "terminal-status") {
    return {
      status: 409,
      body: {
        error: `run ${runId} is in status "${outcome.detail}" — recovery only applies to non-terminal runs`,
      },
    };
  }
  if (outcome.reason === "fresh-heartbeat") {
    return {
      status: 409,
      body: {
        error: `run ${runId} has a fresh heartbeat — the loop appears to still be alive. Use stop instead.`,
      },
    };
  }
  // write-failed
  return { status: 500, body: { error: outcome.detail ?? "recovery failed" } };
}

export async function handleResumeRun(
  runId: string,
  deps: ServerDeps,
  payload?: unknown,
): Promise<RouteResponse> {
  if (!isValidUlid(runId)) {
    return { status: 400, body: { error: "invalid runId" } };
  }
  const switchParse = AuthSwitchBody.safeParse(payload ?? {});
  if (!switchParse.success) {
    return { status: 400, body: { error: "invalid body", issues: switchParse.error.issues } };
  }

  const stateRoot = defaultStateRoot();
  const runDir = join(stateRoot, runId);
  let manifest: RunManifest;
  try {
    manifest = await loadManifest(runDir);
  } catch {
    return { status: 404, body: { error: `run ${runId} not found` } };
  }

  if (manifest.status !== "paused") {
    return {
      status: 409,
      body: { error: `run ${runId} is in status "${manifest.status}", not "paused"` },
    };
  }

  const switchErr = await applyAuthSwitch(manifest, runDir, switchParse.data.authMode, deps);
  if (switchErr) return switchErr;

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

/**
 * A repo is "interrupted" — eligible for retry-from-failure — when:
 *   - It's past preflight (has a planned taskState)
 *   - It's not in a terminal state (completed/skipped)
 *   - It still has non-terminal tasks the executor can re-attempt
 *
 * Pre-execution states (pending, analyzing, awaiting-proposal-approval,
 * planning, awaiting-plan-approval) are excluded because they need a
 * different recovery path: re-running analyze/plan or approving the
 * existing artifact. The retry button can't help those.
 */
function isInterruptedRepo(repo: RunManifest["repos"][number]): boolean {
  if (repo.status === "completed" || repo.status === "skipped") return false;
  if (
    repo.status === "pending" ||
    repo.status === "analyzing" ||
    repo.status === "awaiting-proposal-approval" ||
    repo.status === "planning" ||
    repo.status === "awaiting-plan-approval"
  ) {
    return false;
  }
  // Retryable states: "executing" (mid-work when the run failed) and "failed".
  if (!repo.taskState || repo.taskState.length === 0) return false;
  return repo.taskState.some((t) => t.status !== "completed" && t.status !== "skipped");
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "paused";
}

function mergePendingDecisions(runId: string, next: z.infer<typeof StepDecisionsSchema>): void {
  const existing = pendingDecisions.get(runId) ?? {};

  const mergedModel = { ...existing.configPatch?.model, ...next.configPatch?.model };
  const mergedEffort = { ...existing.configPatch?.effort, ...next.configPatch?.effort };
  const hasConfigPatch =
    Object.keys(mergedModel).length > 0 || Object.keys(mergedEffort).length > 0;

  pendingDecisions.set(runId, {
    proposals: { ...existing.proposals, ...next.proposals },
    plans: { ...existing.plans, ...next.plans },
    runConfirmed: next.runConfirmed ?? existing.runConfirmed,
    ...(hasConfigPatch
      ? {
          configPatch: {
            ...(Object.keys(mergedModel).length > 0 ? { model: mergedModel } : {}),
            ...(Object.keys(mergedEffort).length > 0 ? { effort: mergedEffort } : {}),
          },
        }
      : {}),
  });
}

// Test-only escape hatch for clearing decisions between cases.
export function __clearPendingDecisionsForTests(): void {
  pendingDecisions.clear();
}
