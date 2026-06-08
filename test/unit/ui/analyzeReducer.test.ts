import { describe, expect, it } from "vitest";
import { flowReducer, type FlowState } from "../../../ui/src/analyze/reducer";
import { emptyRepoFlow } from "../../../ui/src/analyze/types";

const A = "/r/a";
const B = "/r/b";

function withRepo(path: string): FlowState {
  return { [path]: emptyRepoFlow() };
}

describe("flowReducer", () => {
  it("starts analyze for a repo, stamping notes + bumping iteration", () => {
    const next = flowReducer(withRepo(A), {
      type: "analyze-start",
      repoPath: A,
      repoName: "a",
      iteration: 2,
      userNotes: "use webhooks",
    });
    expect(next[A].analyze).toMatchObject({ phase: "running", repoPath: A, previousNotes: "use webhooks" });
    expect(next[A].analyzeIteration).toBe(2);
    expect(next[A].plan).toEqual({ phase: "idle" }); // re-analyze invalidates plan
  });

  it("keeps repos isolated — analyzing B does not touch A's state", () => {
    let s: FlowState = { [A]: emptyRepoFlow(), [B]: emptyRepoFlow() };
    s = flowReducer(s, { type: "analyze-start", repoPath: A, repoName: "a", iteration: 1 });
    s = flowReducer(s, {
      type: "analyze-event",
      repoPath: A,
      repoName: "a",
      event: { type: "done", ok: true, proposalPath: "/p", proposalMarkdown: "# prop", tokensUsed: 5, durationMs: 9 },
    });
    s = flowReducer(s, { type: "analyze-start", repoPath: B, repoName: "b", iteration: 1 });
    expect(s[A].analyze.phase).toBe("done"); // A preserved
    expect(s[B].analyze.phase).toBe("running");
  });

  it("appends sdk messages with incrementing ids during a run", () => {
    let s = flowReducer(withRepo(A), { type: "analyze-start", repoPath: A, repoName: "a", iteration: 1 });
    s = flowReducer(s, { type: "analyze-event", repoPath: A, repoName: "a", event: { type: "sdk_message", subtype: "tool", summary: "read", ts: 1 } });
    s = flowReducer(s, { type: "analyze-event", repoPath: A, repoName: "a", event: { type: "sdk_message", subtype: "tool", summary: "grep", ts: 2 } });
    const a = s[A].analyze;
    expect(a.phase).toBe("running");
    if (a.phase === "running") {
      expect(a.messages.map((m) => m.id)).toEqual([0, 1]);
      expect(a.messages.map((m) => m.summary)).toEqual(["read", "grep"]);
    }
  });

  it("marks the proposal approved", () => {
    let s = flowReducer(withRepo(A), { type: "analyze-start", repoPath: A, repoName: "a", iteration: 1 });
    s = flowReducer(s, { type: "analyze-event", repoPath: A, repoName: "a", event: { type: "done", ok: true, proposalPath: "/p", proposalMarkdown: "x", tokensUsed: 1, durationMs: 1 } });
    s = flowReducer(s, { type: "approve-proposal", repoPath: A, at: "2026-06-08T00:00:00Z" });
    const a = s[A].analyze;
    expect(a.phase === "done" && a.approvedAt).toBe("2026-06-08T00:00:00Z");
  });
});
