import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepCrashedRuns } from "../../../src/server/crashRecovery.js";
import { saveManifest, loadManifest } from "../../../src/state/runIndex.js";
import { writeHeartbeat } from "../../../src/state/heartbeat.js";
import { readLogEvents } from "../../../src/state/runLog.js";
import { SCHEMA_VERSION, type RunManifest, type RunStatus } from "../../../src/types.js";

const RUN_ID = "01HKQR3Z8MAAAAAAAAAAAAAAAA";

function makeManifest(status: RunStatus): RunManifest {
  return {
    runId: RUN_ID,
    createdAt: "2026-05-24T00:00:00.000Z",
    authMode: "subscription",
    config: {
      targetDir: "/x",
      autonomy: "yolo",
      concurrency: 1,
      checkpointEvery: 1,
      onFailure: "skip-repo",
      maxRetries: 1,
      testGate: "skip",
      testTimeoutMs: 300_000,
      model: { default: "claude-sonnet-4-6" },
    },
    repos: [],
    budget: { tokensUsed: 0, startedAt: "2026-05-24T00:00:00.000Z" },
    status,
    schemaVersion: SCHEMA_VERSION,
  };
}

describe("sweepCrashedRuns", () => {
  let stateRoot: string;

  beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), "crash-recovery-"));
  });

  afterEach(async () => {
    await rm(stateRoot, { recursive: true, force: true });
  });

  async function seedRun(status: RunStatus, heartbeatAgeMs: number | null): Promise<void> {
    const runDir = join(stateRoot, RUN_ID);
    await mkdir(runDir, { recursive: true });
    await saveManifest(runDir, makeManifest(status));
    if (heartbeatAgeMs !== null) {
      // Write a heartbeat then back-date it by mutating the file directly —
      // the helper always uses Date.now(), so we override after the fact.
      await writeHeartbeat(runDir, RUN_ID);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(
        join(runDir, ".heartbeat"),
        JSON.stringify({
          ts: new Date(Date.now() - heartbeatAgeMs).toISOString(),
          runId: RUN_ID,
        }),
      );
    }
  }

  it("settles a run with no heartbeat and non-terminal status to paused", async () => {
    await seedRun("running", null);

    const report = await sweepCrashedRuns(stateRoot);

    expect(report.recovered).toHaveLength(1);
    expect(report.recovered[0]?.runId).toBe(RUN_ID);
    expect(report.recovered[0]?.previousStatus).toBe("running");
    expect(report.recovered[0]?.lastHeartbeatAt).toBeNull();

    const settled = await loadManifest(join(stateRoot, RUN_ID));
    expect(settled.status).toBe("paused");

    const events = await readLogEvents(join(stateRoot, RUN_ID, "run-log.jsonl"));
    const recoveryEvent = events.find((e) => e.type === "run_recovered_from_crash");
    expect(recoveryEvent).toBeDefined();
  });

  it("settles a run with an old heartbeat to paused", async () => {
    await seedRun("running", 5 * 60_000); // 5 minutes old — well past CRASH_THRESHOLD_MS

    const report = await sweepCrashedRuns(stateRoot);
    expect(report.recovered).toHaveLength(1);
    expect(report.recovered[0]?.lastHeartbeatAt).not.toBeNull();

    const settled = await loadManifest(join(stateRoot, RUN_ID));
    expect(settled.status).toBe("paused");
  });

  it("skips a run with a fresh heartbeat (likely actively running)", async () => {
    await seedRun("running", 2_000); // 2 seconds old — well within threshold

    const report = await sweepCrashedRuns(stateRoot);

    expect(report.recovered).toHaveLength(0);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]?.reason).toBe("fresh heartbeat");

    const untouched = await loadManifest(join(stateRoot, RUN_ID));
    expect(untouched.status).toBe("running");
  });

  it("ignores runs in terminal states (completed, failed, paused)", async () => {
    // Multiple runs at once to verify each terminal state is skipped.
    for (const status of ["completed", "failed", "paused"] as const) {
      const subDir = join(stateRoot, `01HKQR3Z8MAAAAAAAAAAAAAAA${status[0]?.toUpperCase()}`);
      await mkdir(subDir, { recursive: true });
      const m = makeManifest(status);
      m.runId = subDir.split("/").pop() ?? RUN_ID;
      await saveManifest(subDir, m);
    }

    const report = await sweepCrashedRuns(stateRoot);
    expect(report.recovered).toHaveLength(0);
    expect(report.skipped).toHaveLength(0); // not even visited — filter is "non-terminal only"
  });

  it("is idempotent — running twice produces no double-recovery", async () => {
    await seedRun("running", null);

    const first = await sweepCrashedRuns(stateRoot);
    expect(first.recovered).toHaveLength(1);

    const second = await sweepCrashedRuns(stateRoot);
    expect(second.recovered).toHaveLength(0);

    const events = await readLogEvents(join(stateRoot, RUN_ID, "run-log.jsonl"));
    const recoveryEvents = events.filter((e) => e.type === "run_recovered_from_crash");
    expect(recoveryEvents).toHaveLength(1);
  });

  it("returns an empty report when the stateRoot does not exist", async () => {
    const ghostRoot = join(tmpdir(), "nonexistent-" + Date.now());
    const report = await sweepCrashedRuns(ghostRoot);
    expect(report.recovered).toEqual([]);
    expect(report.skipped).toEqual([]);
  });
});
