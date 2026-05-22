import { describe, expect, it } from "vitest";
import { resolveTierToModels } from "../../../src/orchestrator/modelTier.js";

describe("resolveTierToModels", () => {
  it("thorough preset resolves to all-sonnet via default fallthrough", () => {
    const result = resolveTierToModels("thorough");
    expect(result.default).toBe("claude-sonnet-4-6");
    expect(result.analyze).toBeUndefined();
    expect(result.plan).toBeUndefined();
    expect(result.execute).toBeUndefined();
  });

  it("balanced preset sets execute to Haiku and leaves others to default fallthrough", () => {
    const result = resolveTierToModels("balanced");
    expect(result.default).toBe("claude-sonnet-4-6");
    expect(result.execute).toBe("claude-haiku-4-5-20251001");
    expect(result.analyze).toBeUndefined();
    expect(result.plan).toBeUndefined();
  });

  it("fast preset resolves to all-haiku via default fallthrough", () => {
    const result = resolveTierToModels("fast");
    expect(result.default).toBe("claude-haiku-4-5-20251001");
    expect(result.execute).toBeUndefined();
  });

  it("custom tier throws when no default override provided", () => {
    expect(() => resolveTierToModels("custom")).toThrow(/Custom tier/);
    expect(() => resolveTierToModels("custom", {})).toThrow(/Custom tier/);
    expect(() => resolveTierToModels("custom", { analyze: "claude-opus-4-7" })).toThrow(
      /Custom tier/,
    );
  });

  it("custom tier accepts user-provided model fields verbatim", () => {
    const result = resolveTierToModels("custom", {
      default: "claude-opus-4-7",
      execute: "claude-haiku-4-5-20251001",
    });
    expect(result.default).toBe("claude-opus-4-7");
    expect(result.execute).toBe("claude-haiku-4-5-20251001");
    expect(result.analyze).toBeUndefined();
    expect(result.plan).toBeUndefined();
  });

  it("per-phase override wins over tier preset", () => {
    const result = resolveTierToModels("balanced", {
      analyze: "claude-opus-4-7",
    });
    expect(result.default).toBe("claude-sonnet-4-6");
    expect(result.analyze).toBe("claude-opus-4-7");
    expect(result.execute).toBe("claude-haiku-4-5-20251001");
  });

  it("default override replaces preset default while preserving execute slot", () => {
    const result = resolveTierToModels("balanced", {
      default: "claude-opus-4-7",
    });
    expect(result.default).toBe("claude-opus-4-7");
    expect(result.execute).toBe("claude-haiku-4-5-20251001");
  });
});
