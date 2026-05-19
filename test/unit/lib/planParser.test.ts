import { describe, expect, it } from "vitest";
import { parsePlan } from "../../../src/lib/planParser.js";

const SAMPLE = `# Plan — foo

## Summary

Implement v1.

## Tasks

### task: 11111111-1111-1111-1111-111111111111
**Title:** Add the discovery module

**Acceptance criteria:**
- Discovers git repos under target dir
- Returns DiscoveredRepo[]

**Dependencies:** none
**Estimated effort:** small

---

### task: 22222222-2222-2222-2222-222222222222
**Title:** Add selection TUI

**Acceptance criteria:**
- Renders multi-select with stack badges
- Returns selected paths

**Dependencies:** 11111111-1111-1111-1111-111111111111
**Estimated effort:** small
`;

describe("parsePlan", () => {
  it("parses tasks with id, title, criteria, and dependencies", () => {
    const tasks = parsePlan(SAMPLE);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].taskId).toBe("11111111-1111-1111-1111-111111111111");
    expect(tasks[0].title).toBe("Add the discovery module");
    expect(tasks[0].acceptanceCriteria).toEqual([
      "Discovers git repos under target dir",
      "Returns DiscoveredRepo[]",
    ]);
    expect(tasks[0].status).toBe("pending");
    expect(tasks[0].attempts).toBe(0);
    expect(tasks[1].taskId).toBe("22222222-2222-2222-2222-222222222222");
    expect(tasks[1].title).toBe("Add selection TUI");
  });

  it("returns [] when no tasks present", () => {
    expect(parsePlan("# Plan\n\nempty")).toEqual([]);
  });

  it("rejects malformed UUIDs (skips that task with warning)", () => {
    const bad = `# Plan\n\n## Tasks\n\n### task: not-a-uuid\n**Title:** x\n**Acceptance criteria:**\n- y\n`;
    expect(parsePlan(bad)).toEqual([]);
  });

  it("tolerates a task block with missing acceptance criteria", () => {
    const partial = `# Plan\n\n## Tasks\n\n### task: 33333333-3333-3333-3333-333333333333\n**Title:** Bare task\n\n**Dependencies:** none\n`;
    const tasks = parsePlan(partial);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Bare task");
    expect(tasks[0].acceptanceCriteria).toEqual([]);
  });
});
