import { describe, expect, it } from "vitest";
import { renderRunSummary, repoSymbol } from "../../../src/tui/render.js";
import type { RunManifest } from "../../../src/types.js";
import { SCHEMA_VERSION } from "../../../src/types.js";

describe("repoSymbol", () => {
  it("maps statuses to symbols", () => {
    expect(repoSymbol("completed")).toBe("✓");
    expect(repoSymbol("failed")).toBe("✗");
    expect(repoSymbol("skipped")).toBe("⊘");
    expect(repoSymbol("running")).toBe("•");
  });
});

describe("renderRunSummary", () => {
  it("renders run header and per-repo lines", () => {
    const m: RunManifest = {
      runId: "01HKQR3Z8M",
      createdAt: "2026-05-04T00:00:00Z",
      authMode: "api",
      config: {
        targetDir: "/x",
        concurrency: 1,
        checkpointEvery: 1,
        onFailure: "skip-repo",
        maxRetries: 1,
        testGate: "per-repo",
        testTimeoutMs: 300_000,
        model: { default: "claude-sonnet-4-6" },
      },
      repos: [
        {
          path: "/x/foo",
          name: "foo",
          stack: "jsts",
          status: "completed",
          taskState: [
            {
              taskId: "11111111-1111-1111-1111-111111111111",
              title: "t",
              acceptanceCriteria: [],
              status: "completed",
              attempts: 1,
              tokensUsed: 100,
              durationMs: 1000,
            },
          ],
          testGate: true,
        },
      ],
      budget: { tokensUsed: 100, startedAt: "2026-05-04T00:00:00Z" },
      status: "completed",
      schemaVersion: SCHEMA_VERSION,
    };
    const out = renderRunSummary(m);
    expect(out).toContain("01HKQR3Z8M");
    expect(out).toContain("✓ foo");
    expect(out).toContain("1/1 tasks");
    expect(out).toContain("Tokens: 100");
  });
});
