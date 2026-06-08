import { describe, expect, it } from "vitest";
import { renderAnalyzePrompt } from "../../src/sdk/prompts/analyze.js";
import { jstsProfile } from "../../src/stack/profiles/jsts.js";

describe("renderAnalyzePrompt finalize", () => {
  it("injects the convergence (defaults) guidance when finalize is true", () => {
    const out = renderAnalyzePrompt({
      repoPath: "/x/foo",
      repoName: "foo",
      stackProfile: jstsProfile,
      hasReadme: true,
      hasTests: true,
      lastCommitDate: null,
      userNotes: "use webhooks too; pin the SDK",
      iteration: 1,
      finalize: true,
    });
    expect(out).toContain("Recommended defaults");
    expect(out).toContain("User notes for this iteration");
  });
});
