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
  handleResumeRun,
  __clearPendingDecisionsForTests,
} from "../../../src/server/runRoutes.js";
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
      tier: "balanced",
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
});
