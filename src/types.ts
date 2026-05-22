import { z } from "zod";

export const SCHEMA_VERSION = 1;

export const AUTH_MODES = ["api", "subscription"] as const;
export const PHASE_NAMES = ["discover", "analyze", "plan", "execute"] as const;
export const RUN_STATUSES = [
  "discovering",
  "selecting",
  "preflight",
  "running",
  "paused",
  "completed",
  "failed",
] as const;
export const REPO_STATUSES = [
  "pending",
  "analyzing",
  "awaiting-proposal-approval",
  "planning",
  "awaiting-plan-approval",
  "executing",
  "completed",
  "failed",
  "skipped",
] as const;
export const TASK_STATUSES = ["pending", "in_progress", "completed", "failed", "skipped"] as const;
export const STACK_IDS = ["jsts", "python", "generic"] as const;
export const ON_FAILURE_VALUES = ["stop", "skip-task", "skip-repo", "retry"] as const;
export const TEST_GATE_VALUES = ["required", "skip", "per-repo"] as const;
export const AUTONOMY_MODES = ["manual", "batched", "yolo"] as const;
export const MODEL_TIERS = ["thorough", "balanced", "fast", "custom"] as const;
export const MODEL_IDS = [
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-7",
] as const;

export type AuthMode = (typeof AUTH_MODES)[number];

export type PhaseName = (typeof PHASE_NAMES)[number];

export type RunStatus = (typeof RUN_STATUSES)[number];

export type RepoStatus = (typeof REPO_STATUSES)[number];

export type TaskStatus = (typeof TASK_STATUSES)[number];

export type StackId = (typeof STACK_IDS)[number];

export type OnFailure = (typeof ON_FAILURE_VALUES)[number];

export type TestGate = (typeof TEST_GATE_VALUES)[number];

export type AutonomyMode = (typeof AUTONOMY_MODES)[number];

export type ModelTier = (typeof MODEL_TIERS)[number];

export type ModelId = (typeof MODEL_IDS)[number];

export const ModelIdSchema = z.enum(MODEL_IDS);

export const RunConfigSchema = z.object({
  targetDir: z.string(),
  autonomy: z.enum(AUTONOMY_MODES).default("batched"),
  tier: z.enum(MODEL_TIERS).default("balanced"),
  concurrency: z.number().int().positive(),
  checkpointEvery: z.number(),
  onFailure: z.enum(ON_FAILURE_VALUES),
  maxRetries: z.number().int().nonnegative(),
  maxTokens: z.number().int().positive().optional(),
  maxDurationMs: z.number().int().positive().optional(),
  testGate: z.enum(TEST_GATE_VALUES),
  testTimeoutMs: z.number().int().positive(),
  model: z.object({
    default: ModelIdSchema,
    analyze: ModelIdSchema.optional(),
    plan: ModelIdSchema.optional(),
    execute: ModelIdSchema.optional(),
  }),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
});
export type RunConfig = z.infer<typeof RunConfigSchema>;

export const TaskStateSchema = z.object({
  taskId: z.string().uuid(),
  title: z.string(),
  acceptanceCriteria: z.array(z.string()),
  status: z.enum(TASK_STATUSES),
  attempts: z.number().int().nonnegative(),
  commitSha: z.string().optional(),
  tokensUsed: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  testOutput: z.string().optional(),
  failureReason: z.string().optional(),
});
export type TaskState = z.infer<typeof TaskStateSchema>;

export const RepoEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  stack: z.enum(STACK_IDS),
  status: z.enum(REPO_STATUSES),
  proposalPath: z.string().optional(),
  planPath: z.string().optional(),
  taskState: z.array(TaskStateSchema).optional(),
  testGate: z.boolean(),
});
export type RepoEntry = z.infer<typeof RepoEntrySchema>;

export const BudgetStateSchema = z.object({
  tokensUsed: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  estimatedTotalTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});
export type BudgetState = z.infer<typeof BudgetStateSchema>;

export const RunManifestSchema = z.object({
  runId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "expected a ULID"),
  createdAt: z.string().datetime(),
  authMode: z.enum(AUTH_MODES),
  config: RunConfigSchema,
  repos: z.array(RepoEntrySchema),
  budget: BudgetStateSchema,
  status: z.enum(RUN_STATUSES),
  schemaVersion: z.number().int().positive(),
});
export type RunManifest = z.infer<typeof RunManifestSchema>;

export const LogEventSchema = z.discriminatedUnion("type", [
  z.object({
    ts: z.string().datetime(),
    type: z.literal("run_started"),
    runId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "expected a ULID"),
  }),
  z.object({
    ts: z.string().datetime(),
    type: z.literal("phase_started"),
    repoPath: z.string(),
    phase: z.enum(PHASE_NAMES),
  }),
  z.object({
    ts: z.string().datetime(),
    type: z.literal("phase_completed"),
    repoPath: z.string(),
    phase: z.enum(PHASE_NAMES),
    tokensUsed: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
  }),
  z.object({
    ts: z.string().datetime(),
    type: z.literal("task_started"),
    repoPath: z.string(),
    taskId: z.string(),
  }),
  z.object({
    ts: z.string().datetime(),
    type: z.literal("task_completed"),
    repoPath: z.string(),
    taskId: z.string(),
    commitSha: z.string(),
    tokensUsed: z.number().int().nonnegative(),
  }),
  z.object({
    ts: z.string().datetime(),
    type: z.literal("task_failed"),
    repoPath: z.string(),
    taskId: z.string(),
    reason: z.string(),
    willRetry: z.boolean(),
  }),
  z.object({
    ts: z.string().datetime(),
    type: z.literal("checkpoint_paused"),
    repoPath: z.string(),
    afterTaskId: z.string(),
  }),
  z.object({
    ts: z.string().datetime(),
    type: z.literal("checkpoint_resumed"),
    repoPath: z.string(),
    action: z.enum(["continue", "skip", "edit", "quit"]),
  }),
  z.object({
    ts: z.string().datetime(),
    type: z.literal("budget_warning"),
    reason: z.string(),
    tokensUsed: z.number().int().nonnegative(),
  }),
  z.object({ ts: z.string().datetime(), type: z.literal("budget_capped"), reason: z.string() }),
  z.object({
    ts: z.string().datetime(),
    type: z.literal("run_finalized"),
    status: z.enum(["completed", "failed"]),
    durationMs: z.number().int().nonnegative(),
  }),
]);
export type LogEvent = z.infer<typeof LogEventSchema>;

export class StateCorruption extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`State corruption at ${path}: ${message}`);
    this.name = "StateCorruption";
  }
}

export class BudgetCapped extends Error {
  constructor(public readonly reason: string) {
    super(`Budget cap hit: ${reason}`);
    this.name = "BudgetCapped";
  }
}

export class TaskAbandoned extends Error {
  constructor(
    public readonly taskId: string,
    public readonly reason: string,
  ) {
    super(`Task ${taskId} abandoned: ${reason}`);
    this.name = "TaskAbandoned";
  }
}
