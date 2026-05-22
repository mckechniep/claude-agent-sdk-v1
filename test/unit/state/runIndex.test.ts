import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunDir, loadManifest, saveManifest, listRuns } from "../../../src/state/runIndex.js";
import type { RunManifest } from "../../../src/types.js";
import { SCHEMA_VERSION } from "../../../src/types.js";

const baseManifest = (runId: string): RunManifest => ({
  runId,
  createdAt: "2026-05-04T00:00:00.000Z",
  authMode: "api",
  config: {
    targetDir: "/tmp/x",
    autonomy: "batched",
    tier: "balanced",
    concurrency: 1,
    checkpointEvery: 1,
    onFailure: "skip-repo",
    maxRetries: 1,
    testGate: "per-repo",
    testTimeoutMs: 300_000,
    model: { default: "claude-sonnet-4-6" },
  },
  repos: [],
  budget: { tokensUsed: 0, startedAt: "2026-05-04T00:00:00.000Z" },
  status: "discovering",
  schemaVersion: SCHEMA_VERSION,
});

const ULID_A = "01HKMR7B2CAAAAAAAAAAAAAAAA";
const ULID_B = "01HKQR3Z8MAAAAAAAAAAAAAAAA";

describe("runIndex", () => {
  let stateRoot: string;
  beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), "runindex-"));
  });
  afterEach(async () => {
    await rm(stateRoot, { recursive: true, force: true });
  });

  it("creates a run directory under the configured root", async () => {
    const dir = await createRunDir(stateRoot, ULID_B);
    expect(dir.endsWith(ULID_B)).toBe(true);
  });

  it("round-trips a manifest", async () => {
    const dir = await createRunDir(stateRoot, ULID_B);
    const m = baseManifest(ULID_B);
    await saveManifest(dir, m);
    const loaded = await loadManifest(dir);
    expect(loaded).toEqual(m);
  });

  it("lists runs sorted newest-first by runId", async () => {
    await createRunDir(stateRoot, ULID_A);
    await createRunDir(stateRoot, ULID_B);
    await saveManifest(join(stateRoot, ULID_A), baseManifest(ULID_A));
    await saveManifest(join(stateRoot, ULID_B), baseManifest(ULID_B));
    const runs = await listRuns(stateRoot);
    // ULIDs sort lexicographically by time-component; ULID_B > ULID_A
    expect(runs.map((r) => r.runId)).toEqual([ULID_B, ULID_A]);
  });

  it("throws StateCorruption when manifest fails schema", async () => {
    const dir = await createRunDir(stateRoot, ULID_B);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "manifest.json"), '{"runId":"x"}');
    await expect(loadManifest(dir)).rejects.toThrow(/State corruption/);
  });

  it("throws StateCorruption with 'JSON parse failed' on malformed JSON", async () => {
    const dir = await createRunDir(stateRoot, ULID_B);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "manifest.json"), "{not valid json");
    await expect(loadManifest(dir)).rejects.toThrow(/JSON parse failed/);
  });

  it("listRuns skips a corrupt run and returns the rest", async () => {
    await createRunDir(stateRoot, ULID_A);
    await createRunDir(stateRoot, ULID_B);
    await saveManifest(join(stateRoot, ULID_A), baseManifest(ULID_A));
    // ULID_B has a corrupted manifest
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(stateRoot, ULID_B, "manifest.json"), "{not valid json");
    const runs = await listRuns(stateRoot);
    expect(runs.map((r) => r.runId)).toEqual([ULID_A]);
  });
});
