import { describe, expect, it } from "vitest";
import { initRunViewModel, runReducer } from "../../../ui/src/runReducer";
import type { LogEvent, RunManifest, RunUpdate } from "../../../ui/src/runTypes";

const RUN_ID = "01HKQR3Z8MAAAAAAAAAAAAAAAA";
const FETCHED_AT = "2026-05-26T00:00:00.000Z";

function makeManifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: RUN_ID,
    createdAt: "2026-05-26T00:00:00.000Z",
    authMode: "subscription",
    config: {
      targetDir: "/x",
      autonomy: "supervised",
      concurrency: 1,
      checkpointEvery: 1,
      onFailure: "skip-repo",
      maxRetries: 1,
      testGate: "skip",
      testTimeoutMs: 300_000,
      model: { default: "claude-sonnet-4-6" },
    },
    repos: [
      {
        path: "/x/foo",
        name: "foo",
        stack: "jsts",
        status: "pending",
        testGate: false,
      },
    ],
    budget: { tokensUsed: 0, startedAt: "2026-05-26T00:00:00.000Z" },
    status: "running",
    schemaVersion: 1,
    ...overrides,
  };
}

function event(partial: LogEvent): LogEvent {
  return partial;
}

describe("runReducer", () => {
  describe("initRunViewModel", () => {
    it("derives loopState from manifest status", () => {
      const vm = initRunViewModel({
        manifest: makeManifest({ status: "running" }),
        fetchedAt: FETCHED_AT,
      });
      expect(vm.loopState).toBe("active");
      expect(vm.runId).toBe(RUN_ID);
      expect(vm.manifestFetchedAt).toBe(FETCHED_AT);
      expect(vm.byteCursor).toBe(0);
    });

    it("defaults loopState to idle for non-running manifests", () => {
      const vm = initRunViewModel({
        manifest: makeManifest({ status: "discovering" }),
        fetchedAt: FETCHED_AT,
      });
      expect(vm.loopState).toBe("idle");
    });

    it("respects explicit byteCursor", () => {
      const vm = initRunViewModel({
        manifest: makeManifest(),
        fetchedAt: FETCHED_AT,
        byteCursor: 42,
      });
      expect(vm.byteCursor).toBe(42);
    });
  });

  describe("manifest update", () => {
    it("replaces the snapshot but preserves event overlays", () => {
      const initial = initRunViewModel({
        manifest: makeManifest(),
        fetchedAt: FETCHED_AT,
      });
      const withEvent = runReducer(initial, {
        kind: "event",
        event: event({
          ts: "2026-05-26T00:00:01.000Z",
          type: "phase_started",
          repoPath: "/x/foo",
          phase: "analyze",
        }),
      });
      const refreshed = runReducer(withEvent, {
        kind: "manifest",
        manifest: makeManifest({
          budget: { tokensUsed: 1000, startedAt: "2026-05-26T00:00:00.000Z" },
        }),
        fetchedAt: "2026-05-26T00:00:02.000Z",
      });
      expect(refreshed.manifest.budget.tokensUsed).toBe(1000);
      expect(refreshed.currentRepoPath).toBe("/x/foo"); // preserved from event
      expect(refreshed.manifestFetchedAt).toBe("2026-05-26T00:00:02.000Z");
    });
  });

  describe("bookmark update", () => {
    it("advances cursor", () => {
      const initial = initRunViewModel({
        manifest: makeManifest(),
        fetchedAt: FETCHED_AT,
        byteCursor: 100,
      });
      const next = runReducer(initial, { kind: "bookmark", byteCursor: 250 });
      expect(next.byteCursor).toBe(250);
    });

    it("ignores stale cursors (no-op)", () => {
      const initial = initRunViewModel({
        manifest: makeManifest(),
        fetchedAt: FETCHED_AT,
        byteCursor: 250,
      });
      const next = runReducer(initial, { kind: "bookmark", byteCursor: 100 });
      expect(next).toBe(initial);
    });
  });

  describe("event update — overlays", () => {
    it("phase_started sets currentRepoPath and clears task", () => {
      const initial = initRunViewModel({
        manifest: makeManifest(),
        fetchedAt: FETCHED_AT,
      });
      const next = runReducer(initial, {
        kind: "event",
        event: event({
          ts: "2026-05-26T00:00:01.000Z",
          type: "phase_started",
          repoPath: "/x/foo",
          phase: "analyze",
        }),
      });
      expect(next.currentRepoPath).toBe("/x/foo");
      expect(next.currentTaskId).toBeNull();
      expect(next.lastEventTs).toBe("2026-05-26T00:00:01.000Z");
    });

    it("task_started sets currentTaskId", () => {
      const initial = initRunViewModel({
        manifest: makeManifest(),
        fetchedAt: FETCHED_AT,
      });
      const next = runReducer(initial, {
        kind: "event",
        event: event({
          ts: "2026-05-26T00:00:02.000Z",
          type: "task_started",
          repoPath: "/x/foo",
          taskId: "task-1",
        }),
      });
      expect(next.currentTaskId).toBe("task-1");
      expect(next.currentRepoPath).toBe("/x/foo");
    });

    it("task_completed clears matching currentTaskId", () => {
      const initial = runReducer(
        initRunViewModel({ manifest: makeManifest(), fetchedAt: FETCHED_AT }),
        {
          kind: "event",
          event: event({
            ts: "2026-05-26T00:00:02.000Z",
            type: "task_started",
            repoPath: "/x/foo",
            taskId: "task-1",
          }),
        },
      );
      const next = runReducer(initial, {
        kind: "event",
        event: event({
          ts: "2026-05-26T00:00:03.000Z",
          type: "task_completed",
          repoPath: "/x/foo",
          taskId: "task-1",
          commitSha: "abc123",
          tokensUsed: 500,
        }),
      });
      expect(next.currentTaskId).toBeNull();
    });

    it("task_completed for a non-current task leaves currentTaskId alone", () => {
      const initial = runReducer(
        initRunViewModel({ manifest: makeManifest(), fetchedAt: FETCHED_AT }),
        {
          kind: "event",
          event: event({
            ts: "2026-05-26T00:00:02.000Z",
            type: "task_started",
            repoPath: "/x/foo",
            taskId: "task-1",
          }),
        },
      );
      const next = runReducer(initial, {
        kind: "event",
        event: event({
          ts: "2026-05-26T00:00:03.000Z",
          type: "task_completed",
          repoPath: "/x/foo",
          taskId: "task-2",
          commitSha: "abc123",
          tokensUsed: 500,
        }),
      });
      expect(next.currentTaskId).toBe("task-1");
    });

    it("run_loop_paused sets loopState to paused", () => {
      const initial = initRunViewModel({
        manifest: makeManifest({ status: "running" }),
        fetchedAt: FETCHED_AT,
      });
      const next = runReducer(initial, {
        kind: "event",
        event: event({
          ts: "2026-05-26T00:00:04.000Z",
          type: "run_loop_paused",
          runId: RUN_ID,
        }),
      });
      expect(next.loopState).toBe("paused");
    });

    it("run_loop_completed → completed", () => {
      const next = runReducer(
        initRunViewModel({ manifest: makeManifest(), fetchedAt: FETCHED_AT }),
        {
          kind: "event",
          event: event({
            ts: "2026-05-26T00:00:05.000Z",
            type: "run_loop_completed",
            runId: RUN_ID,
          }),
        },
      );
      expect(next.loopState).toBe("completed");
    });

    it("run_finalized clears overlays and updates loopState", () => {
      const initial = runReducer(
        initRunViewModel({ manifest: makeManifest(), fetchedAt: FETCHED_AT }),
        {
          kind: "event",
          event: event({
            ts: "2026-05-26T00:00:02.000Z",
            type: "task_started",
            repoPath: "/x/foo",
            taskId: "task-1",
          }),
        },
      );
      const next = runReducer(initial, {
        kind: "event",
        event: event({
          ts: "2026-05-26T00:00:09.000Z",
          type: "run_finalized",
          status: "completed",
          durationMs: 60_000,
        }),
      });
      expect(next.currentRepoPath).toBeNull();
      expect(next.currentTaskId).toBeNull();
      expect(next.loopState).toBe("completed");
    });
  });

  describe("event update — histories", () => {
    it("appends to recentEvents (bounded)", () => {
      let state = initRunViewModel({
        manifest: makeManifest(),
        fetchedAt: FETCHED_AT,
      });
      const updates: RunUpdate[] = Array.from({ length: 250 }, (_, i) => ({
        kind: "event" as const,
        event: event({
          ts: `2026-05-26T00:00:${String(i).padStart(2, "0")}.000Z`,
          type: "phase_started",
          repoPath: `/x/repo-${i}`,
          phase: "analyze",
        }),
      }));
      for (const u of updates) state = runReducer(state, u);
      // Cap is 200 — we sent 250, so should keep the last 200.
      expect(state.recentEvents).toHaveLength(200);
      const last = state.recentEvents[state.recentEvents.length - 1];
      expect(last).toBeDefined();
      expect(last && "repoPath" in last ? last.repoPath : "").toBe("/x/repo-249");
    });

    it("groups events by repoPath", () => {
      let state = initRunViewModel({
        manifest: makeManifest(),
        fetchedAt: FETCHED_AT,
      });
      state = runReducer(state, {
        kind: "event",
        event: event({
          ts: "2026-05-26T00:00:01.000Z",
          type: "phase_started",
          repoPath: "/x/foo",
          phase: "analyze",
        }),
      });
      state = runReducer(state, {
        kind: "event",
        event: event({
          ts: "2026-05-26T00:00:02.000Z",
          type: "phase_started",
          repoPath: "/x/bar",
          phase: "analyze",
        }),
      });
      state = runReducer(state, {
        kind: "event",
        event: event({
          ts: "2026-05-26T00:00:03.000Z",
          type: "phase_completed",
          repoPath: "/x/foo",
          phase: "analyze",
          tokensUsed: 100,
          durationMs: 1000,
        }),
      });
      expect(state.eventsByRepo["/x/foo"]).toHaveLength(2);
      expect(state.eventsByRepo["/x/bar"]).toHaveLength(1);
    });

    it("groups events by taskId", () => {
      let state = initRunViewModel({
        manifest: makeManifest(),
        fetchedAt: FETCHED_AT,
      });
      state = runReducer(state, {
        kind: "event",
        event: event({
          ts: "2026-05-26T00:00:01.000Z",
          type: "task_started",
          repoPath: "/x/foo",
          taskId: "task-1",
        }),
      });
      state = runReducer(state, {
        kind: "event",
        event: event({
          ts: "2026-05-26T00:00:02.000Z",
          type: "task_completed",
          repoPath: "/x/foo",
          taskId: "task-1",
          commitSha: "abc123",
          tokensUsed: 500,
        }),
      });
      expect(state.eventsByTask["task-1"]).toHaveLength(2);
    });

    it("events without repoPath/taskId don't pollute the bucket maps", () => {
      const initial = initRunViewModel({
        manifest: makeManifest(),
        fetchedAt: FETCHED_AT,
      });
      const next = runReducer(initial, {
        kind: "event",
        event: event({
          ts: "2026-05-26T00:00:01.000Z",
          type: "budget_warning",
          reason: "approaching cap",
          tokensUsed: 10_000,
        }),
      });
      expect(Object.keys(next.eventsByRepo)).toHaveLength(0);
      expect(Object.keys(next.eventsByTask)).toHaveLength(0);
      expect(next.recentEvents).toHaveLength(1);
    });
  });

  describe("purity", () => {
    it("does not mutate the input state", () => {
      const initial = initRunViewModel({
        manifest: makeManifest(),
        fetchedAt: FETCHED_AT,
      });
      const snapshot = JSON.stringify(initial);
      runReducer(initial, {
        kind: "event",
        event: event({
          ts: "2026-05-26T00:00:01.000Z",
          type: "phase_started",
          repoPath: "/x/foo",
          phase: "analyze",
        }),
      });
      expect(JSON.stringify(initial)).toBe(snapshot);
    });
  });
});
