// Mirror of the server-side type declarations in `src/types.ts`. Kept here
// (rather than cross-imported) because src/types.ts depends on zod and we
// don't want the validator in the UI bundle. When the server schema changes,
// update this file by hand. v0.2 candidate: extract the zod-free type half
// into a shared package and import from both sides.

export type AutonomyMode = "manual" | "supervised" | "yolo";
export type ModelTier = "thorough" | "balanced" | "fast" | "custom";
export type ModelId =
  | "claude-sonnet-4-6"
  | "claude-haiku-4-5-20251001"
  | "claude-opus-4-7";

export type AuthMode = "api" | "subscription";
export type StackId = "jsts" | "python" | "generic";
export type OnFailure = "stop" | "skip-task" | "skip-repo" | "retry";
export type TestGate = "required" | "skip" | "per-repo";

export type RunStatus =
  | "discovering"
  | "selecting"
  | "preflight"
  | "awaiting-run-confirmation"
  | "running"
  | "stopping"
  | "paused"
  | "completed"
  | "failed";

export type RepoStatus =
  | "pending"
  | "analyzing"
  | "awaiting-proposal-approval"
  | "planning"
  | "awaiting-plan-approval"
  | "executing"
  | "completed"
  | "failed"
  | "skipped";

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";

export type PhaseName = "discover" | "analyze" | "plan" | "execute";

export interface ModelMap {
  default: ModelId;
  analyze?: ModelId;
  plan?: ModelId;
  execute?: ModelId;
}

export interface RunConfig {
  targetDir: string;
  autonomy: AutonomyMode;
  tier: ModelTier;
  concurrency: number;
  checkpointEvery: number;
  onFailure: OnFailure;
  maxRetries: number;
  maxTokens?: number;
  maxDurationMs?: number;
  testGate: TestGate;
  testTimeoutMs: number;
  model: ModelMap;
  include?: string[];
  exclude?: string[];
}

export interface TaskState {
  taskId: string;
  title: string;
  acceptanceCriteria: string[];
  status: TaskStatus;
  attempts: number;
  commitSha?: string;
  tokensUsed: number;
  durationMs: number;
  testOutput?: string;
  failureReason?: string;
}

export interface RepoEntry {
  path: string;
  name: string;
  stack: StackId;
  hasReadme?: boolean;
  hasTests?: boolean;
  lastCommitDate?: string;
  status: RepoStatus;
  proposalPath?: string;
  planPath?: string;
  taskState?: TaskState[];
  testGate: boolean;
}

export interface BudgetState {
  tokensUsed: number;
  startedAt: string;
  estimatedTotalTokens?: number;
  costUsd?: number;
}

export interface RunManifest {
  runId: string;
  createdAt: string;
  authMode: AuthMode;
  config: RunConfig;
  repos: RepoEntry[];
  budget: BudgetState;
  status: RunStatus;
  schemaVersion: number;
}

// Discriminated union mirror of LogEventSchema. Field order matches the
// server schema for ease of comparison.
export type LogEvent =
  | { ts: string; type: "run_started"; runId: string }
  | { ts: string; type: "phase_started"; repoPath: string; phase: PhaseName }
  | {
      ts: string;
      type: "phase_completed";
      repoPath: string;
      phase: PhaseName;
      tokensUsed: number;
      durationMs: number;
    }
  | { ts: string; type: "task_started"; repoPath: string; taskId: string }
  | {
      ts: string;
      type: "task_completed";
      repoPath: string;
      taskId: string;
      commitSha: string;
      tokensUsed: number;
    }
  | {
      ts: string;
      type: "task_failed";
      repoPath: string;
      taskId: string;
      reason: string;
      willRetry: boolean;
    }
  | { ts: string; type: "checkpoint_paused"; repoPath: string; afterTaskId: string }
  | {
      ts: string;
      type: "checkpoint_resumed";
      repoPath: string;
      action: "continue" | "skip" | "edit" | "quit";
    }
  | { ts: string; type: "budget_warning"; reason: string; tokensUsed: number }
  | { ts: string; type: "budget_capped"; reason: string }
  | {
      ts: string;
      type: "run_finalized";
      status: "completed" | "failed";
      durationMs: number;
    }
  | { ts: string; type: "run_loop_started"; runId: string }
  | { ts: string; type: "run_loop_paused"; runId: string }
  | { ts: string; type: "run_loop_completed"; runId: string }
  | { ts: string; type: "run_loop_failed"; runId: string }
  | { ts: string; type: "run_loop_aborted"; runId: string }
  | { ts: string; type: "run_loop_stop_requested"; runId: string; mode: "soft" | "force" }
  | { ts: string; type: "run_loop_force_aborted"; runId: string; duringStep: boolean }
  | {
      ts: string;
      type: "run_recovered_from_crash";
      runId: string;
      previousStatus: RunStatus;
      lastHeartbeatAt: string | null;
    }
  | {
      ts: string;
      type: "run_retried_from_failure";
      runId: string;
      repoCount: number;
      taskCount: number;
    }
  | { ts: string; type: "run_loop_awaiting_decision"; runId: string; status: RunStatus }
  | { ts: string; type: "run_loop_error"; runId: string; message: string };

export type LoopState =
  | "idle"
  | "active"
  | "stopping"
  | "paused"
  | "completed"
  | "failed"
  | "aborted";

export interface RunViewModel {
  runId: string;
  manifest: RunManifest;
  loopState: LoopState;
  currentRepoPath: string | null;
  currentTaskId: string | null;
  recentEvents: LogEvent[];
  eventsByRepo: Record<string, LogEvent[]>;
  eventsByTask: Record<string, LogEvent[]>;
  lastEventTs: string | null;
  byteCursor: number;
  manifestFetchedAt: string | null;
}

export type RunUpdate =
  | { kind: "event"; event: LogEvent }
  | { kind: "manifest"; manifest: RunManifest; fetchedAt: string }
  | { kind: "bookmark"; byteCursor: number };
