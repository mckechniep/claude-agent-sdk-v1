import type {
  LogEvent,
  LoopState,
  RunManifest,
  RunUpdate,
  RunViewModel,
} from "./runTypes";

// Recent-events buffer cap. Protects long runs from unbounded memory growth
// while leaving enough history for the raw-event tail panel (200 lines ≈
// 2-3 minutes of activity at typical event cadence).
const RECENT_EVENTS_CAP = 200;

export function initRunViewModel(args: {
  manifest: RunManifest;
  fetchedAt: string;
  byteCursor?: number;
}): RunViewModel {
  return {
    runId: args.manifest.runId,
    manifest: args.manifest,
    loopState: deriveLoopStateFromStatus(args.manifest.status),
    currentRepoPath: null,
    currentTaskId: null,
    recentEvents: [],
    eventsByRepo: {},
    eventsByTask: {},
    lastEventTs: null,
    byteCursor: args.byteCursor ?? 0,
    manifestFetchedAt: args.fetchedAt,
  };
}

// Pure reducer: (state, update) → new state. All cases return a new object;
// never mutate the input.
export function runReducer(state: RunViewModel, update: RunUpdate): RunViewModel {
  switch (update.kind) {
    case "manifest":
      return applyManifest(state, update.manifest, update.fetchedAt);
    case "event":
      return applyEvent(state, update.event);
    case "bookmark":
      // Cursor only moves forward; an older byte means stale callback.
      if (update.byteCursor <= state.byteCursor) return state;
      return { ...state, byteCursor: update.byteCursor };
  }
}

function applyManifest(
  state: RunViewModel,
  manifest: RunManifest,
  fetchedAt: string,
): RunViewModel {
  // Manifest refresh doesn't disturb event-derived overlays — those decay
  // organically as new events arrive. We do re-derive loopState because the
  // manifest's `status` is the most authoritative signal we have.
  return {
    ...state,
    manifest,
    manifestFetchedAt: fetchedAt,
    loopState: deriveLoopStateFromStatus(manifest.status, state.loopState),
  };
}

function applyEvent(state: RunViewModel, event: LogEvent): RunViewModel {
  const recent = appendCapped(state.recentEvents, event, RECENT_EVENTS_CAP);
  const lastEventTs = event.ts;

  // Per-repo history, when event carries a repoPath.
  const eventsByRepo = "repoPath" in event ? appendToBucket(state.eventsByRepo, event.repoPath, event) : state.eventsByRepo;

  // Per-task history, when event carries a taskId.
  const eventsByTask = "taskId" in event ? appendToBucket(state.eventsByTask, event.taskId, event) : state.eventsByTask;

  let currentRepoPath = state.currentRepoPath;
  let currentTaskId = state.currentTaskId;
  let loopState = state.loopState;

  switch (event.type) {
    case "run_loop_started":
      loopState = "active";
      break;
    case "run_loop_paused":
    case "run_loop_awaiting_decision":
      loopState = "paused";
      break;
    case "run_loop_completed":
      loopState = "completed";
      break;
    case "run_loop_failed":
    case "run_loop_error":
      loopState = "failed";
      break;
    case "run_loop_aborted":
      loopState = "aborted";
      break;
    case "phase_started":
      currentRepoPath = event.repoPath;
      currentTaskId = null;
      break;
    case "phase_completed":
      // Only clear if this is the repo we were tracking; another phase may
      // have started on a different repo concurrently.
      if (state.currentRepoPath === event.repoPath) {
        currentTaskId = null;
      }
      break;
    case "task_started":
      currentRepoPath = event.repoPath;
      currentTaskId = event.taskId;
      break;
    case "task_completed":
    case "task_failed":
      if (state.currentTaskId === event.taskId) {
        currentTaskId = null;
      }
      break;
    case "run_finalized":
      currentRepoPath = null;
      currentTaskId = null;
      loopState = event.status === "completed" ? "completed" : "failed";
      break;
    default:
      // Other event types contribute to history but don't change overlays.
      break;
  }

  return {
    ...state,
    recentEvents: recent,
    eventsByRepo,
    eventsByTask,
    lastEventTs,
    currentRepoPath,
    currentTaskId,
    loopState,
  };
}

function appendCapped<T>(arr: T[], item: T, cap: number): T[] {
  const next = arr.length >= cap ? arr.slice(arr.length - cap + 1) : arr.slice();
  next.push(item);
  return next;
}

function appendToBucket(
  buckets: Record<string, LogEvent[]>,
  key: string,
  event: LogEvent,
): Record<string, LogEvent[]> {
  const existing = buckets[key] ?? [];
  return { ...buckets, [key]: [...existing, event] };
}

// loopState mapping. The manifest's `status` is the primary signal; event
// types refine it (e.g., a "running" manifest with a recent run_loop_paused
// should show "paused" until the next manifest refresh).
function deriveLoopStateFromStatus(
  status: RunManifest["status"],
  prior?: LoopState,
): LoopState {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "paused":
      return "paused";
    case "running":
      // Don't overwrite a more-recent aborted/paused signal from events.
      if (prior === "aborted" || prior === "paused") return prior;
      return "active";
    default:
      return prior ?? "idle";
  }
}
