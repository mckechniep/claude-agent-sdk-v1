import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import {
  handleStartRun,
  handleStepRun,
  handleSubmitDecisions,
  handleGetManifest,
  handleGetLog,
  handleGetRepoArtifacts,
  handleStreamLog,
  handleRecoverRun,
  handleResumeRun,
  handleRetryFromFailure,
  handleStopRun,
  __clearPendingDecisionsForTests,
} from "../../../src/server/runRoutes.js";
import { abortLoop, isLoopActive } from "../../../src/server/runLoop.js";
import { runLogPath } from "../../../src/state/runLog.js";
import { SCHEMA_VERSION, type RunManifest, type RunStatus } from "../../../src/types.js";
import { defaultStateRoot } from "../../../src/state/runIndex.js";

const VALID_RUN_ID = "01HKQR3Z8MAAAAAAAAAAAAAAAA";
const BAD_RUN_ID = "not-a-ulid";
const ORIGINAL_HOME = process.env.HOME;

function makeManifest(status: RunStatus): RunManifest {
  return {
    runId: VALID_RUN_ID,
    createdAt: "2026-05-24T00:00:00.000Z",
    authMode: "subscription",
    config: {
      targetDir: "/x",
      autonomy: "manual",
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

describe("runRoutes", () => {
  let tmpHome: string;

  beforeEach(async () => {
    __clearPendingDecisionsForTests();
    // Redirect defaultStateRoot() to a temp dir for each test via HOME.
    tmpHome = await mkdtemp(join(tmpdir(), "runroutes-"));
    process.env.HOME = tmpHome;
  });

  afterEach(async () => {
    process.env.HOME = ORIGINAL_HOME;
    await rm(tmpHome, { recursive: true, force: true });
  });

  describe("handleStartRun", () => {
    it("rejects invalid body shape", async () => {
      const res = await handleStartRun({ nope: true }, { originalApiKey: undefined });
      expect(res.status).toBe(400);
      const body = res.body as { error: string };
      expect(body.error).toBe("invalid body");
    });

    it("rejects api auth when no key was set at server boot", async () => {
      const res = await handleStartRun(
        {
          authMode: "api",
          config: {
            targetDir: "/x",
            concurrency: 1,
            checkpointEvery: 1,
            onFailure: "skip-repo",
            maxRetries: 1,
            testGate: "skip",
            testTimeoutMs: 300_000,
            model: { default: "claude-sonnet-4-6" },
          },
          selectedRepos: [
            {
              path: "/x/foo",
              name: "foo",
              stack: "jsts",
              hasReadme: true,
              hasTests: false,
              lastCommitDate: null,
              isDirty: false,
            },
          ],
        },
        { originalApiKey: undefined },
      );
      expect(res.status).toBe(400);
      const body = res.body as { error: string };
      expect(body.error).toContain("api mode selected");
    });
  });

  describe("handleStepRun", () => {
    it("rejects invalid runId", async () => {
      const res = await handleStepRun(BAD_RUN_ID, {}, { originalApiKey: undefined });
      expect(res.status).toBe(400);
      const body = res.body as { error: string };
      expect(body.error).toBe("invalid runId");
    });

    it("returns 404 when manifest does not exist", async () => {
      const res = await handleStepRun(VALID_RUN_ID, {}, { originalApiKey: undefined });
      expect(res.status).toBe(404);
    });

    it("rejects invalid body when runId is valid", async () => {
      // Even with no manifest on disk, body parsing happens first; here we
      // send a malformed decisions block to confirm 400 fires before 404.
      const res = await handleStepRun(
        VALID_RUN_ID,
        { decisions: { proposals: { "/p": "not-a-valid-action" } } },
        { originalApiKey: undefined },
      );
      expect(res.status).toBe(400);
    });
  });

  describe("handleSubmitDecisions", () => {
    it("rejects invalid runId", async () => {
      const res = await handleSubmitDecisions(BAD_RUN_ID, {}, { originalApiKey: undefined });
      expect(res.status).toBe(400);
    });

    it("rejects invalid decision shape", async () => {
      const res = await handleSubmitDecisions(
        VALID_RUN_ID,
        { plans: { "/p": "not-a-valid-action" } },
        { originalApiKey: undefined },
      );
      expect(res.status).toBe(400);
    });

    it("accepts valid decisions and returns 202", async () => {
      const res = await handleSubmitDecisions(
        VALID_RUN_ID,
        { runConfirmed: true, proposals: { "/x/foo": "accept" } },
        { originalApiKey: undefined },
      );
      expect(res.status).toBe(202);
      const body = res.body as { ok: boolean; runId: string; pending: unknown };
      expect(body.ok).toBe(true);
      expect(body.runId).toBe(VALID_RUN_ID);
    });

    it("merges subsequent decision submissions", async () => {
      await handleSubmitDecisions(
        VALID_RUN_ID,
        { proposals: { "/x/a": "accept" } },
        { originalApiKey: undefined },
      );
      const res = await handleSubmitDecisions(
        VALID_RUN_ID,
        { proposals: { "/x/b": "reject" } },
        { originalApiKey: undefined },
      );
      expect(res.status).toBe(202);
      const body = res.body as {
        pending: { proposals?: Record<string, string> };
      };
      expect(body.pending.proposals).toEqual({ "/x/a": "accept", "/x/b": "reject" });
    });
  });

  describe("handleGetManifest", () => {
    it("rejects invalid runId", async () => {
      const res = await handleGetManifest(BAD_RUN_ID);
      expect(res.status).toBe(400);
    });

    it("returns 404 when manifest does not exist", async () => {
      const res = await handleGetManifest(VALID_RUN_ID);
      expect(res.status).toBe(404);
    });

    it("returns 200 + manifest + loopActive when manifest exists", async () => {
      const stateRoot = defaultStateRoot();
      const runDir = join(stateRoot, VALID_RUN_ID);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "manifest.json"), JSON.stringify(makeManifest("running")));

      const res = await handleGetManifest(VALID_RUN_ID);
      expect(res.status).toBe(200);
      const body = res.body as { manifest: RunManifest; loopActive: boolean };
      expect(body.manifest.runId).toBe(VALID_RUN_ID);
      expect(body.loopActive).toBe(false);
    });
  });

  describe("handleGetLog", () => {
    it("rejects invalid runId", async () => {
      const res = await handleGetLog(BAD_RUN_ID, new URLSearchParams());
      expect(res.status).toBe(400);
    });

    it("rejects negative fromByte", async () => {
      const res = await handleGetLog(VALID_RUN_ID, new URLSearchParams({ fromByte: "-1" }));
      expect(res.status).toBe(400);
    });

    it("rejects non-numeric fromByte", async () => {
      const res = await handleGetLog(VALID_RUN_ID, new URLSearchParams({ fromByte: "nope" }));
      expect(res.status).toBe(400);
    });

    it("returns 404 when log file does not exist", async () => {
      const res = await handleGetLog(VALID_RUN_ID, new URLSearchParams());
      expect(res.status).toBe(404);
    });

    it("returns events + nextByte when log exists", async () => {
      const stateRoot = defaultStateRoot();
      const runDir = join(stateRoot, VALID_RUN_ID);
      await mkdir(runDir, { recursive: true });
      const events = [
        { ts: "2026-05-24T00:00:00.000Z", type: "run_started", runId: VALID_RUN_ID },
        {
          ts: "2026-05-24T00:00:01.000Z",
          type: "phase_started",
          repoPath: "/x/foo",
          phase: "discover",
        },
      ];
      const content = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
      await writeFile(runLogPath(stateRoot, VALID_RUN_ID), content);

      const res = await handleGetLog(VALID_RUN_ID, new URLSearchParams({ fromByte: "0" }));
      expect(res.status).toBe(200);
      const body = res.body as { events: unknown[]; nextByte: number };
      expect(body.events).toHaveLength(2);
      expect(body.nextByte).toBe(Buffer.byteLength(content));
    });

    it("replays only events past fromByte cursor", async () => {
      const stateRoot = defaultStateRoot();
      const runDir = join(stateRoot, VALID_RUN_ID);
      await mkdir(runDir, { recursive: true });
      const event1 = JSON.stringify({
        ts: "2026-05-24T00:00:00.000Z",
        type: "run_started",
        runId: VALID_RUN_ID,
      });
      const event2 = JSON.stringify({
        ts: "2026-05-24T00:00:01.000Z",
        type: "phase_started",
        repoPath: "/x/foo",
        phase: "discover",
      });
      const content = event1 + "\n" + event2 + "\n";
      await writeFile(runLogPath(stateRoot, VALID_RUN_ID), content);
      const splitByte = Buffer.byteLength(event1 + "\n");

      const res = await handleGetLog(
        VALID_RUN_ID,
        new URLSearchParams({ fromByte: String(splitByte) }),
      );
      expect(res.status).toBe(200);
      const body = res.body as { events: { type: string }[]; nextByte: number };
      expect(body.events).toHaveLength(1);
      expect(body.events[0]?.type).toBe("phase_started");
      expect(body.nextByte).toBe(Buffer.byteLength(content));
    });

    it("returns nextByte === fromByte when fromByte is past EOF", async () => {
      const stateRoot = defaultStateRoot();
      const runDir = join(stateRoot, VALID_RUN_ID);
      await mkdir(runDir, { recursive: true });
      const content = JSON.stringify({
        ts: "2026-05-24T00:00:00.000Z",
        type: "run_started",
        runId: VALID_RUN_ID,
      });
      await writeFile(runLogPath(stateRoot, VALID_RUN_ID), content + "\n");

      const past = Buffer.byteLength(content) + 100;
      const res = await handleGetLog(VALID_RUN_ID, new URLSearchParams({ fromByte: String(past) }));
      expect(res.status).toBe(200);
      const body = res.body as { events: unknown[]; nextByte: number };
      expect(body.events).toEqual([]);
      expect(body.nextByte).toBe(past);
    });

    it("stops at last complete newline (partial trailing line is unread)", async () => {
      const stateRoot = defaultStateRoot();
      const runDir = join(stateRoot, VALID_RUN_ID);
      await mkdir(runDir, { recursive: true });
      const complete = JSON.stringify({
        ts: "2026-05-24T00:00:00.000Z",
        type: "run_started",
        runId: VALID_RUN_ID,
      });
      // Trailing partial line with no terminating newline — must be excluded.
      const content = complete + "\n" + '{"ts":"2026-05-24T00:00:01';
      await writeFile(runLogPath(stateRoot, VALID_RUN_ID), content);

      const res = await handleGetLog(VALID_RUN_ID, new URLSearchParams());
      expect(res.status).toBe(200);
      const body = res.body as { events: unknown[]; nextByte: number };
      expect(body.events).toHaveLength(1);
      expect(body.nextByte).toBe(Buffer.byteLength(complete) + 1);
    });
  });

  describe("handleGetRepoArtifacts", () => {
    function manifestWithRepo(repoPath: string): RunManifest {
      return {
        ...makeManifest("running"),
        repos: [
          {
            path: repoPath,
            name: "foo",
            stack: "jsts",
            status: "awaiting-proposal-approval",
            testGate: false,
          },
        ],
      };
    }

    it("rejects invalid runId", async () => {
      const res = await handleGetRepoArtifacts(BAD_RUN_ID, new URLSearchParams());
      expect(res.status).toBe(400);
    });

    it("rejects missing repoPath", async () => {
      const res = await handleGetRepoArtifacts(VALID_RUN_ID, new URLSearchParams());
      expect(res.status).toBe(400);
    });

    it("returns 404 when run manifest does not exist", async () => {
      const res = await handleGetRepoArtifacts(
        VALID_RUN_ID,
        new URLSearchParams({ repoPath: "/x/foo" }),
      );
      expect(res.status).toBe(404);
    });

    it("returns 404 when repoPath is not part of the run", async () => {
      const stateRoot = defaultStateRoot();
      const runDir = join(stateRoot, VALID_RUN_ID);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "manifest.json"), JSON.stringify(manifestWithRepo("/x/foo")));

      const res = await handleGetRepoArtifacts(
        VALID_RUN_ID,
        new URLSearchParams({ repoPath: "/etc/passwd" }), // not in manifest
      );
      expect(res.status).toBe(404);
      const body = res.body as { error: string };
      expect(body.error).toContain("not part of this run");
    });

    it("returns nulls when repo is in manifest but artifacts don't exist on disk", async () => {
      const stateRoot = defaultStateRoot();
      const runDir = join(stateRoot, VALID_RUN_ID);
      await mkdir(runDir, { recursive: true });
      const repoDir = join(tmpHome, "fixture-repo");
      await mkdir(repoDir, { recursive: true });
      await writeFile(join(runDir, "manifest.json"), JSON.stringify(manifestWithRepo(repoDir)));

      const res = await handleGetRepoArtifacts(
        VALID_RUN_ID,
        new URLSearchParams({ repoPath: repoDir }),
      );
      expect(res.status).toBe(200);
      const body = res.body as {
        proposalMarkdown: string | null;
        planMarkdown: string | null;
      };
      expect(body.proposalMarkdown).toBeNull();
      expect(body.planMarkdown).toBeNull();
    });
  });

  describe("handleStreamLog", () => {
    // Minimal req/res doubles — enough to drive the validation-failure paths
    // without spinning up a real http server. Full streaming behavior is
    // covered by readLogTailFromByte's unit tests and manual smoke (F1).
    function makeMocks(): {
      req: IncomingMessage;
      res: ServerResponse & { _status: number; _body: string };
    } {
      const req = new EventEmitter() as IncomingMessage;
      const writes: string[] = [];
      const res = Object.assign(new EventEmitter(), {
        statusCode: 200,
        writableEnded: false,
        _body: "",
        _status: 200,
        setHeader() {},
        flushHeaders() {},
        write(chunk: string) {
          writes.push(chunk);
          return true;
        },
        end(payload?: string) {
          this.writableEnded = true;
          this._body = (writes.join("") + (payload ?? "")).trim();
          this._status = this.statusCode;
        },
      }) as unknown as ServerResponse & { _status: number; _body: string };
      return { req, res };
    }

    it("rejects invalid runId with 400", async () => {
      const { req, res } = makeMocks();
      await handleStreamLog(req, res, "not-a-ulid", new URLSearchParams());
      expect(res._status).toBe(400);
      expect(res._body).toContain("invalid runId");
    });

    it("rejects negative fromByte with 400", async () => {
      const { req, res } = makeMocks();
      await handleStreamLog(req, res, VALID_RUN_ID, new URLSearchParams({ fromByte: "-1" }));
      expect(res._status).toBe(400);
      expect(res._body).toContain("fromByte");
    });

    it("rejects non-integer fromByte with 400", async () => {
      const { req, res } = makeMocks();
      await handleStreamLog(req, res, VALID_RUN_ID, new URLSearchParams({ fromByte: "1.5" }));
      expect(res._status).toBe(400);
    });
  });

  describe("handleResumeRun", () => {
    it("rejects invalid runId", async () => {
      const res = await handleResumeRun(BAD_RUN_ID, { originalApiKey: undefined });
      expect(res.status).toBe(400);
    });

    it("returns 404 when manifest does not exist", async () => {
      const res = await handleResumeRun(VALID_RUN_ID, { originalApiKey: undefined });
      expect(res.status).toBe(404);
    });

    it("returns 409 when manifest is not in paused state", async () => {
      const stateRoot = defaultStateRoot();
      const runDir = join(stateRoot, VALID_RUN_ID);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "manifest.json"), JSON.stringify(makeManifest("running")));

      const res = await handleResumeRun(VALID_RUN_ID, { originalApiKey: undefined });
      expect(res.status).toBe(409);
      const body = res.body as { error: string };
      expect(body.error).toContain("not");
      expect(body.error).toContain("paused");
    });
  });

  describe("handleStopRun", () => {
    it("rejects invalid runId", async () => {
      const res = await handleStopRun(BAD_RUN_ID, { mode: "soft" });
      expect(res.status).toBe(400);
    });

    it("rejects invalid mode", async () => {
      const res = await handleStopRun(VALID_RUN_ID, { mode: "explode" });
      expect(res.status).toBe(400);
      const body = res.body as { error: string };
      expect(body.error).toBe("invalid body");
    });

    it("defaults mode to 'soft' when body is empty", async () => {
      const stateRoot = defaultStateRoot();
      const runDir = join(stateRoot, VALID_RUN_ID);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "manifest.json"), JSON.stringify(makeManifest("running")));

      const res = await handleStopRun(VALID_RUN_ID, {});
      expect(res.status).toBe(200);
      const body = res.body as { mode: string };
      expect(body.mode).toBe("soft");
    });

    it("returns 404 when manifest does not exist", async () => {
      const res = await handleStopRun(VALID_RUN_ID, { mode: "soft" });
      expect(res.status).toBe(404);
    });

    it("returns 409 when run is already in terminal status", async () => {
      const stateRoot = defaultStateRoot();
      const runDir = join(stateRoot, VALID_RUN_ID);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "manifest.json"), JSON.stringify(makeManifest("completed")));

      const res = await handleStopRun(VALID_RUN_ID, { mode: "soft" });
      expect(res.status).toBe(409);
      const body = res.body as { error: string };
      expect(body.error).toContain("terminal");
    });

    it("includes lastHeartbeatAt in the manifest response", async () => {
      const stateRoot = defaultStateRoot();
      const runDir = join(stateRoot, VALID_RUN_ID);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "manifest.json"), JSON.stringify(makeManifest("running")));

      // No heartbeat yet → field is null.
      const before = await handleGetManifest(VALID_RUN_ID);
      expect(before.status).toBe(200);
      expect((before.body as { lastHeartbeatAt: string | null }).lastHeartbeatAt).toBeNull();

      // Write a heartbeat and re-fetch.
      const { writeHeartbeat } = await import("../../../src/state/heartbeat.js");
      await writeHeartbeat(runDir, VALID_RUN_ID);
      const after = await handleGetManifest(VALID_RUN_ID);
      const body = after.body as { lastHeartbeatAt: string | null; loopActive: boolean };
      expect(body.lastHeartbeatAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(body.loopActive).toBe(false);
    });

    it("returns 200 with stopped: false when no loop is active for a running run", async () => {
      // Manual-autonomy runs don't have a background loop, so a stop request
      // succeeds but reports stopped=false (nothing to abort). The "stopping"
      // status still gets written so the UI shows the user's intent.
      const stateRoot = defaultStateRoot();
      const runDir = join(stateRoot, VALID_RUN_ID);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "manifest.json"), JSON.stringify(makeManifest("running")));

      const res = await handleStopRun(VALID_RUN_ID, { mode: "soft" });
      expect(res.status).toBe(200);
      const body = res.body as {
        runId: string;
        mode: string;
        loopWasActive: boolean;
        stopped: boolean;
      };
      expect(body.runId).toBe(VALID_RUN_ID);
      expect(body.mode).toBe("soft");
      expect(body.loopWasActive).toBe(false);
      expect(body.stopped).toBe(false);
    });
  });

  describe("handleRecoverRun", () => {
    it("rejects invalid runId", async () => {
      const res = await handleRecoverRun(BAD_RUN_ID);
      expect(res.status).toBe(400);
    });

    it("returns 404 when manifest does not exist", async () => {
      const res = await handleRecoverRun(VALID_RUN_ID);
      expect(res.status).toBe(404);
    });

    it("returns 409 when status is terminal (completed)", async () => {
      const stateRoot = defaultStateRoot();
      const runDir = join(stateRoot, VALID_RUN_ID);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "manifest.json"), JSON.stringify(makeManifest("completed")));

      const res = await handleRecoverRun(VALID_RUN_ID);
      expect(res.status).toBe(409);
      const body = res.body as { error: string };
      expect(body.error).toContain("completed");
    });

    it("returns 409 when status is paused (already settled)", async () => {
      const stateRoot = defaultStateRoot();
      const runDir = join(stateRoot, VALID_RUN_ID);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "manifest.json"), JSON.stringify(makeManifest("paused")));

      const res = await handleRecoverRun(VALID_RUN_ID);
      expect(res.status).toBe(409);
    });

    it("returns 409 when heartbeat is fresh (loop likely alive)", async () => {
      const stateRoot = defaultStateRoot();
      const runDir = join(stateRoot, VALID_RUN_ID);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "manifest.json"), JSON.stringify(makeManifest("running")));
      const { writeHeartbeat } = await import("../../../src/state/heartbeat.js");
      await writeHeartbeat(runDir, VALID_RUN_ID); // just-written → fresh

      const res = await handleRecoverRun(VALID_RUN_ID);
      expect(res.status).toBe(409);
      const body = res.body as { error: string };
      expect(body.error).toContain("fresh heartbeat");
    });

    it("returns 200 and settles to paused when heartbeat is stale", async () => {
      const stateRoot = defaultStateRoot();
      const runDir = join(stateRoot, VALID_RUN_ID);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "manifest.json"), JSON.stringify(makeManifest("running")));
      // Stale heartbeat: back-date it past the 60s crash threshold.
      const { writeFile: wf } = await import("node:fs/promises");
      await wf(
        join(runDir, ".heartbeat"),
        JSON.stringify({
          ts: new Date(Date.now() - 5 * 60_000).toISOString(),
          runId: VALID_RUN_ID,
        }),
      );

      const res = await handleRecoverRun(VALID_RUN_ID);
      expect(res.status).toBe(200);
      const body = res.body as { previousStatus: string; lastHeartbeatAt: string };
      expect(body.previousStatus).toBe("running");
      expect(body.lastHeartbeatAt).toMatch(/^\d{4}/);

      // Verify side effects: manifest moved to paused, recovery event logged.
      const { readLogEvents } = await import("../../../src/state/runLog.js");
      const { loadManifest } = await import("../../../src/state/runIndex.js");
      const settled = await loadManifest(runDir);
      expect(settled.status).toBe("paused");
      const events = await readLogEvents(join(runDir, "run-log.jsonl"));
      expect(events.some((e) => e.type === "run_recovered_from_crash")).toBe(true);
    });

    it("returns 200 and settles to paused when no heartbeat exists", async () => {
      const stateRoot = defaultStateRoot();
      const runDir = join(stateRoot, VALID_RUN_ID);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "manifest.json"), JSON.stringify(makeManifest("running")));

      const res = await handleRecoverRun(VALID_RUN_ID);
      expect(res.status).toBe(200);
      const body = res.body as { lastHeartbeatAt: string | null };
      expect(body.lastHeartbeatAt).toBeNull();
    });
  });

  describe("handleRetryFromFailure", () => {
    // Helper that builds a manifest with a failed repo + failed task so the
    // retry endpoint has something concrete to reset. The repo has one
    // completed task and one failed task to verify the partial-reset
    // behavior — only failed work should be retried.
    function makeFailedManifest(): RunManifest {
      const base = makeManifest("failed");
      base.repos = [
        {
          path: "/x/foo",
          name: "foo",
          stack: "jsts",
          status: "failed",
          testGate: false,
          taskState: [
            {
              taskId: "11111111-1111-4111-8111-111111111111",
              title: "first task",
              acceptanceCriteria: [],
              status: "completed",
              attempts: 1,
              tokensUsed: 5000,
              durationMs: 30_000,
              commitSha: "abc1234",
            },
            {
              taskId: "22222222-2222-4222-8222-222222222222",
              title: "second task",
              acceptanceCriteria: [],
              status: "failed",
              attempts: 2,
              tokensUsed: 3000,
              durationMs: 20_000,
              failureReason: "test gate failed on every attempt",
              testOutput: "1 failing test\n",
            },
          ],
        },
      ];
      return base;
    }

    afterEach(() => {
      // Ensure the auto-restarted loop from a previous test doesn't leak.
      if (isLoopActive(VALID_RUN_ID)) abortLoop(VALID_RUN_ID);
    });

    it("rejects invalid runId", async () => {
      const res = await handleRetryFromFailure(BAD_RUN_ID, { originalApiKey: undefined });
      expect(res.status).toBe(400);
    });

    it("returns 404 when manifest does not exist", async () => {
      const res = await handleRetryFromFailure(VALID_RUN_ID, { originalApiKey: undefined });
      expect(res.status).toBe(404);
    });

    it("returns 409 when status is not failed", async () => {
      const stateRoot = defaultStateRoot();
      const runDir = join(stateRoot, VALID_RUN_ID);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "manifest.json"), JSON.stringify(makeManifest("running")));

      const res = await handleRetryFromFailure(VALID_RUN_ID, { originalApiKey: undefined });
      expect(res.status).toBe(409);
      const body = res.body as { error: string };
      expect(body.error).toContain("failed");
    });

    it("resets failed tasks to pending and preserves completed ones", async () => {
      const stateRoot = defaultStateRoot();
      const runDir = join(stateRoot, VALID_RUN_ID);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "manifest.json"), JSON.stringify(makeFailedManifest()));

      const res = await handleRetryFromFailure(VALID_RUN_ID, { originalApiKey: undefined });
      expect(res.status).toBe(200);

      const body = res.body as {
        repoCount: number;
        taskCount: number;
        loopStarted: boolean;
        manifest: RunManifest;
      };
      expect(body.repoCount).toBe(1);
      expect(body.taskCount).toBe(1);
      expect(body.loopStarted).toBe(true);

      // Disk should match the returned manifest.
      const { loadManifest } = await import("../../../src/state/runIndex.js");
      const settled = await loadManifest(runDir);
      expect(settled.status).toBe("paused");
      const repo = settled.repos[0]!;
      expect(repo.status).toBe("executing");

      const completed = repo.taskState!.find(
        (t) => t.taskId === "11111111-1111-4111-8111-111111111111",
      )!;
      const retried = repo.taskState!.find(
        (t) => t.taskId === "22222222-2222-4222-8222-222222222222",
      )!;
      expect(completed.status).toBe("completed");
      expect(completed.attempts).toBe(1); // untouched
      expect(retried.status).toBe("pending");
      expect(retried.attempts).toBe(0);
      expect(retried.failureReason).toBeUndefined();
      expect(retried.testOutput).toBeUndefined();
    });

    it("logs a run_retried_from_failure event", async () => {
      const stateRoot = defaultStateRoot();
      const runDir = join(stateRoot, VALID_RUN_ID);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "manifest.json"), JSON.stringify(makeFailedManifest()));

      await handleRetryFromFailure(VALID_RUN_ID, { originalApiKey: undefined });

      const { readLogEvents } = await import("../../../src/state/runLog.js");
      const events = await readLogEvents(join(runDir, "run-log.jsonl"));
      const retryEvent = events.find((e) => e.type === "run_retried_from_failure");
      expect(retryEvent).toBeDefined();
      if (retryEvent && "repoCount" in retryEvent) {
        expect(retryEvent.repoCount).toBe(1);
        expect(retryEvent.taskCount).toBe(1);
      }
    });

    it("resets in_progress + counts pending tasks in failed repos (skip-repo case)", async () => {
      // This is the byf-backend case: onFailure="skip-repo" bailed the loop
      // after the first task failed, leaving later tasks at "pending" and
      // (potentially) one at "in_progress" if it was mid-step. Retry should
      // reset the failed + in_progress ones AND count the pending ones as
      // retryable so the user sees the real number that'll re-run.
      const m = makeManifest("failed");
      m.repos = [
        {
          path: "/x/byf-backend",
          name: "byf-backend",
          stack: "jsts",
          status: "failed",
          testGate: false,
          taskState: [
            {
              taskId: "11111111-1111-4111-8111-111111111111",
              title: "logout",
              acceptanceCriteria: [],
              status: "failed",
              attempts: 2,
              tokensUsed: 8000,
              durationMs: 45_000,
              failureReason: "session model missing user_id",
            },
            {
              taskId: "22222222-2222-4222-8222-222222222222",
              title: "logout-all",
              acceptanceCriteria: [],
              status: "pending",
              attempts: 0,
              tokensUsed: 0,
              durationMs: 0,
            },
            {
              taskId: "33333333-3333-4333-8333-333333333333",
              title: "session listing endpoints",
              acceptanceCriteria: [],
              status: "pending",
              attempts: 0,
              tokensUsed: 0,
              durationMs: 0,
            },
          ],
        },
      ];

      const stateRoot = defaultStateRoot();
      const runDir = join(stateRoot, VALID_RUN_ID);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "manifest.json"), JSON.stringify(m));

      const res = await handleRetryFromFailure(VALID_RUN_ID, { originalApiKey: undefined });
      expect(res.status).toBe(200);
      const body = res.body as { repoCount: number; taskCount: number };
      expect(body.repoCount).toBe(1);
      // 3 retryable: 1 failed (reset) + 2 pending (counted, unchanged).
      expect(body.taskCount).toBe(3);

      const { loadManifest } = await import("../../../src/state/runIndex.js");
      const settled = await loadManifest(runDir);
      const repo = settled.repos[0]!;
      expect(repo.status).toBe("executing");
      const tasks = repo.taskState!;
      // The previously-failed task is now pending with cleared failure reason.
      expect(tasks[0]!.status).toBe("pending");
      expect(tasks[0]!.attempts).toBe(0);
      expect(tasks[0]!.failureReason).toBeUndefined();
      // The pending tasks stay pending — but they'll be picked up because
      // the repo is now executing.
      expect(tasks[1]!.status).toBe("pending");
      expect(tasks[2]!.status).toBe("pending");
    });

    it("retries an interrupted repo whose status is 'executing' (thrown-failure case)", async () => {
      // This is the case the user hit on byf-backend: an exception escaped
      // step() → outer catch slapped manifest='failed' but repo was never
      // settled. Repo is still 'executing' even though manifest says failed.
      // Retry must handle this — not just repos with status=='failed'.
      const m = makeManifest("failed");
      m.repos = [
        {
          path: "/x/svc",
          name: "svc",
          stack: "jsts",
          status: "executing",
          testGate: false,
          taskState: [
            {
              taskId: "11111111-1111-4111-8111-111111111111",
              title: "task 1 (done)",
              acceptanceCriteria: [],
              status: "completed",
              attempts: 1,
              tokensUsed: 5000,
              durationMs: 30_000,
              commitSha: "abc1234",
            },
            {
              taskId: "22222222-2222-4222-8222-222222222222",
              title: "task 2 (in progress when killed)",
              acceptanceCriteria: [],
              status: "in_progress",
              attempts: 1,
              tokensUsed: 2000,
              durationMs: 15_000,
            },
            {
              taskId: "33333333-3333-4333-8333-333333333333",
              title: "task 3 (never reached)",
              acceptanceCriteria: [],
              status: "pending",
              attempts: 0,
              tokensUsed: 0,
              durationMs: 0,
            },
          ],
        },
      ];

      const stateRoot = defaultStateRoot();
      const runDir = join(stateRoot, VALID_RUN_ID);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "manifest.json"), JSON.stringify(m));

      const res = await handleRetryFromFailure(VALID_RUN_ID, { originalApiKey: undefined });
      expect(res.status).toBe(200);
      const body = res.body as { repoCount: number; taskCount: number };
      expect(body.repoCount).toBe(1);
      // 2 retryable: in_progress (reset) + pending (counted, unchanged).
      // Completed task is untouched.
      expect(body.taskCount).toBe(2);

      const { loadManifest } = await import("../../../src/state/runIndex.js");
      const settled = await loadManifest(runDir);
      const repo = settled.repos[0]!;
      expect(repo.status).toBe("executing"); // stays/flipped to executing
      const tasks = repo.taskState!;
      expect(tasks[0]!.status).toBe("completed"); // preserved
      expect(tasks[1]!.status).toBe("pending"); // in_progress → pending
      expect(tasks[1]!.attempts).toBe(0);
      expect(tasks[2]!.status).toBe("pending"); // already pending
    });

    it("rejects when api auth was used at run start but key is missing now", async () => {
      const stateRoot = defaultStateRoot();
      const runDir = join(stateRoot, VALID_RUN_ID);
      await mkdir(runDir, { recursive: true });
      const m = makeFailedManifest();
      m.authMode = "api";
      await writeFile(join(runDir, "manifest.json"), JSON.stringify(m));

      const res = await handleRetryFromFailure(VALID_RUN_ID, { originalApiKey: undefined });
      expect(res.status).toBe(400);
    });
  });
});
