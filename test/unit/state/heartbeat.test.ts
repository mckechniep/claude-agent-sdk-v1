import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeHeartbeat,
  readHeartbeat,
  isHeartbeatStale,
  heartbeatPath,
} from "../../../src/state/heartbeat.js";

describe("heartbeat", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), "heartbeat-"));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it("writeHeartbeat round-trips through readHeartbeat", async () => {
    await writeHeartbeat(runDir, "01HKQR3Z8MAAAAAAAAAAAAAAAA");
    const beat = await readHeartbeat(runDir);
    expect(beat).not.toBeNull();
    expect(beat?.runId).toBe("01HKQR3Z8MAAAAAAAAAAAAAAAA");
    expect(beat?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("readHeartbeat returns null when no heartbeat has been written", async () => {
    const beat = await readHeartbeat(runDir);
    expect(beat).toBeNull();
  });

  it("readHeartbeat returns null on malformed file rather than throwing", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(heartbeatPath(runDir), "not-json-at-all");
    const beat = await readHeartbeat(runDir);
    expect(beat).toBeNull();
  });

  it("isHeartbeatStale: null heartbeat is always stale", () => {
    expect(isHeartbeatStale(null, 10_000)).toBe(true);
  });

  it("isHeartbeatStale: fresh heartbeat is not stale", () => {
    const now = Date.now();
    const beat = { ts: new Date(now - 1_000).toISOString(), runId: "r" };
    expect(isHeartbeatStale(beat, 10_000, now)).toBe(false);
  });

  it("isHeartbeatStale: old heartbeat is stale", () => {
    const now = Date.now();
    const beat = { ts: new Date(now - 30_000).toISOString(), runId: "r" };
    expect(isHeartbeatStale(beat, 10_000, now)).toBe(true);
  });

  it("isHeartbeatStale: malformed timestamp is stale", () => {
    const beat = { ts: "garbage", runId: "r" };
    expect(isHeartbeatStale(beat, 10_000)).toBe(true);
  });
});
