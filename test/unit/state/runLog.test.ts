import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLogEvent, readLogEvents } from "../../../src/state/runLog.js";
import type { LogEvent } from "../../../src/types.js";

describe("runLog", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "runlog-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("appends events as JSONL", async () => {
    const path = join(dir, "run-log.jsonl");
    const e1: LogEvent = {
      ts: "2026-05-04T00:00:00.000Z",
      type: "run_started",
      runId: "01HKQR3Z8MAAAAAAAAAAAAAAAA",
    };
    const e2: LogEvent = {
      ts: "2026-05-04T00:00:01.000Z",
      type: "phase_started",
      repoPath: "/r",
      phase: "analyze",
    };
    await appendLogEvent(path, e1);
    await appendLogEvent(path, e2);
    const raw = await readFile(path, "utf8");
    expect(raw.split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("reads back valid events and skips malformed lines", async () => {
    const path = join(dir, "run-log.jsonl");
    const e1: LogEvent = {
      ts: "2026-05-04T00:00:00.000Z",
      type: "run_started",
      runId: "01HKQR3Z8MAAAAAAAAAAAAAAAA",
    };
    await appendLogEvent(path, e1);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, (await readFile(path, "utf8")) + "{not json\n");
    const events = await readLogEvents(path);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("run_started");
  });

  it("returns [] when log file does not exist", async () => {
    const events = await readLogEvents(join(dir, "missing.jsonl"));
    expect(events).toEqual([]);
  });

  it("preserves event ordering on read", async () => {
    const path = join(dir, "ordered.jsonl");
    const events: LogEvent[] = [
      { ts: "2026-05-04T00:00:00.000Z", type: "run_started", runId: "01HKQR3Z8MAAAAAAAAAAAAAAAA" },
      { ts: "2026-05-04T00:00:01.000Z", type: "phase_started", repoPath: "/r1", phase: "analyze" },
      {
        ts: "2026-05-04T00:00:02.000Z",
        type: "phase_completed",
        repoPath: "/r1",
        phase: "analyze",
        tokensUsed: 100,
        durationMs: 50,
      },
    ];
    for (const event of events) {
      await appendLogEvent(path, event);
    }
    const readBack = await readLogEvents(path);
    expect(readBack.map((e) => e.type)).toEqual([
      "run_started",
      "phase_started",
      "phase_completed",
    ]);
    expect(readBack.map((e) => e.ts)).toEqual(events.map((e) => e.ts));
  });
});
