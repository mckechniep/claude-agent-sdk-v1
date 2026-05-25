import { describe, expect, it } from "vitest";
import { formatRepoLabel } from "../../../src/tui/select.js";

describe("formatRepoLabel", () => {
  it("includes name, stack tag, last-commit date, tests indicator, dirty flag", () => {
    const out = formatRepoLabel({
      path: "/x/foo",
      name: "foo",
      stack: "jsts",
      hasReadme: true,
      hasTests: true,
      lastCommitDate: "2026-05-01T00:00:00Z",
      isDirty: true,
    });
    expect(out).toContain("foo");
    expect(out).toContain("[jsts]");
    expect(out).toContain("last:2026-05-01");
    expect(out).toContain("✓tests");
    expect(out).toContain("(dirty)");
  });
});
