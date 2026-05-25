import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startBackgroundLoop,
  abortLoop,
  isLoopActive,
  activeLoopCount,
  LoopAlreadyActiveError,
} from "../../../src/server/runLoop.js";
import { readLogEvents } from "../../../src/state/runLog.js";
import { SCHEMA_VERSION } from "../../../src/types.js";
import type { RunManifest, RunStatus, RepoStatus } from "../../../src/types.js";

const RUN_ID = "01HKQR3Z8MAAAAAAAAAAAAAAAA";

function makeManifest(status: RunStatus, repoStatus: RepoStatus = "pending"): RunManifest {
  return {
    runId: RUN_ID,
    createdAt: "2026-05-24T00:00:00.000Z",
    authMode: "api",
    config: {
      targetDir: "/x",
      autonomy: "batched",
      tier: "balanced",
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
        status: repoStatus,
        testGate: false,
      },
    ],
    budget: { tokensUsed: 0, startedAt: "2026-05-24T00:00:00.000Z" },
    status,
    schemaVersion: SCHEMA_VERSION,
  };
}

describe("runLoop", () => {
  let stateRoot: string;

  beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), "runloop-"));
    await mkdir(join(stateRoot, RUN_ID), { recursive: true });
  });

  afterEach(async () => {
    if (isLoopActive(RUN_ID)) abortLoop(RUN_ID);
    await rm(stateRoot, { recursive: true, force: true });
  });

  it("runs to completion and emits started + completed events", async () => {
    const stepFn = vi
      .fn()
      .mockResolvedValueOnce(makeManifest("running"))
      .mockResolvedValueOnce(makeManifest("completed"));

    startBackgroundLoop({
      runId: RUN_ID,
      stateRoot,
      stepParams: () => ({ runId: RUN_ID, stateRoot }),
      stepFn,
    });

    await vi.waitFor(() => expect(isLoopActive(RUN_ID)).toBe(false), { timeout: 1000 });

    const events = await readLogEvents(join(stateRoot, RUN_ID, "run-log.jsonl"));
    const types = events.map((e) => e.type);
    expect(types).toEqual(["run_loop_started", "run_loop_completed"]);
    expect(stepFn).toHaveBeenCalledTimes(2);
  });

  it("pauses when a repo is awaiting decision and stops looping", async () => {
    const stepFn = vi
      .fn()
      .mockResolvedValueOnce(makeManifest("running"))
      .mockResolvedValueOnce(makeManifest("running", "awaiting-proposal-approval"));

    startBackgroundLoop({
      runId: RUN_ID,
      stateRoot,
      stepParams: () => ({ runId: RUN_ID, stateRoot }),
      stepFn,
    });

    await vi.waitFor(() => expect(isLoopActive(RUN_ID)).toBe(false), { timeout: 1000 });

    const events = await readLogEvents(join(stateRoot, RUN_ID, "run-log.jsonl"));
    const types = events.map((e) => e.type);
    expect(types).toEqual(["run_loop_started", "run_loop_awaiting_decision"]);
    expect(stepFn).toHaveBeenCalledTimes(2);
  });

  it("emits run_loop_paused when manifest status is paused", async () => {
    const stepFn = vi.fn().mockResolvedValueOnce(makeManifest("paused"));

    startBackgroundLoop({
      runId: RUN_ID,
      stateRoot,
      stepParams: () => ({ runId: RUN_ID, stateRoot }),
      stepFn,
    });

    await vi.waitFor(() => expect(isLoopActive(RUN_ID)).toBe(false), { timeout: 1000 });

    const events = await readLogEvents(join(stateRoot, RUN_ID, "run-log.jsonl"));
    expect(events.map((e) => e.type)).toEqual(["run_loop_started", "run_loop_paused"]);
  });

  it("emits run_loop_failed on failed status", async () => {
    const stepFn = vi.fn().mockResolvedValueOnce(makeManifest("failed"));

    startBackgroundLoop({
      runId: RUN_ID,
      stateRoot,
      stepParams: () => ({ runId: RUN_ID, stateRoot }),
      stepFn,
    });

    await vi.waitFor(() => expect(isLoopActive(RUN_ID)).toBe(false), { timeout: 1000 });

    const events = await readLogEvents(join(stateRoot, RUN_ID, "run-log.jsonl"));
    expect(events.map((e) => e.type)).toEqual(["run_loop_started", "run_loop_failed"]);
  });

  it("aborts cleanly when abortLoop is called mid-flight", async () => {
    // Pending promise so the loop is stuck inside step() when abort fires.
    let resolveStep: (m: RunManifest) => void = () => undefined;
    const pendingStep = new Promise<RunManifest>((res) => {
      resolveStep = res;
    });
    const stepFn = vi.fn().mockReturnValueOnce(pendingStep);

    startBackgroundLoop({
      runId: RUN_ID,
      stateRoot,
      stepParams: () => ({ runId: RUN_ID, stateRoot }),
      stepFn,
    });

    await vi.waitFor(() => expect(stepFn).toHaveBeenCalledTimes(1), { timeout: 1000 });
    expect(isLoopActive(RUN_ID)).toBe(true);

    const aborted = abortLoop(RUN_ID);
    expect(aborted).toBe(true);
    // Resolve the pending step() with a non-terminal status; the abort check
    // should fire on the next loop iteration.
    resolveStep(makeManifest("running"));

    await vi.waitFor(() => expect(isLoopActive(RUN_ID)).toBe(false), { timeout: 1000 });

    const events = await readLogEvents(join(stateRoot, RUN_ID, "run-log.jsonl"));
    expect(events.map((e) => e.type)).toContain("run_loop_aborted");
  });

  it("logs run_loop_error and cleans up when step() throws", async () => {
    const stepFn = vi.fn().mockRejectedValueOnce(new Error("step exploded"));

    startBackgroundLoop({
      runId: RUN_ID,
      stateRoot,
      stepParams: () => ({ runId: RUN_ID, stateRoot }),
      stepFn,
    });

    await vi.waitFor(() => expect(isLoopActive(RUN_ID)).toBe(false), { timeout: 1000 });

    const events = await readLogEvents(join(stateRoot, RUN_ID, "run-log.jsonl"));
    const errorEvent = events.find((e) => e.type === "run_loop_error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent && "message" in errorEvent ? errorEvent.message : "").toBe("step exploded");
  });

  it("rejects starting a second loop for the same runId", () => {
    const stepFn = vi
      .fn()
      .mockImplementation(() => new Promise<RunManifest>(() => undefined)); // never resolves

    startBackgroundLoop({
      runId: RUN_ID,
      stateRoot,
      stepParams: () => ({ runId: RUN_ID, stateRoot }),
      stepFn,
    });

    expect(() =>
      startBackgroundLoop({
        runId: RUN_ID,
        stateRoot,
        stepParams: () => ({ runId: RUN_ID, stateRoot }),
        stepFn,
      }),
    ).toThrow(LoopAlreadyActiveError);

    expect(activeLoopCount()).toBe(1);
  });

  it("abortLoop returns false for an unknown runId", () => {
    expect(abortLoop("01HKQR3Z8MAAAAAAAAAAAAAAAA")).toBe(false);
  });
});
