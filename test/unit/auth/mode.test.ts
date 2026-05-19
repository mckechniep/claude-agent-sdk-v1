import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { resolveAuthMode, applyAuthMode, authWarnings } from "../../../src/auth/mode.js";

describe("resolveAuthMode", () => {
  it("returns explicit value when provided", () => {
    expect(resolveAuthMode({ flag: "api" })).toEqual({ mode: "api", source: "flag" });
    expect(resolveAuthMode({ flag: "subscription" })).toEqual({
      mode: "subscription",
      source: "flag",
    });
  });

  it("falls back to env var when flag is undefined", () => {
    expect(resolveAuthMode({ env: "subscription" })).toEqual({
      mode: "subscription",
      source: "env",
    });
  });

  it("returns null when neither flag nor env nor TTY available", () => {
    expect(resolveAuthMode({ interactive: false })).toBeNull();
  });
});

describe("applyAuthMode", () => {
  const original = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = original;
  });

  it("keeps API key in env when api mode chosen", () => {
    applyAuthMode("api");
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-test");
  });

  it("removes API key from env when subscription mode chosen", () => {
    applyAuthMode("subscription");
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("throws when api mode is chosen but no key is set", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => applyAuthMode("api")).toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe("authWarnings", () => {
  it("warns when subscription mode runs with concurrency > 1", () => {
    const warnings = authWarnings("subscription", 4);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Subscription mode/);
    expect(warnings[0]).toMatch(/4 parallel runs/);
  });

  it("returns no warnings when subscription mode runs with concurrency 1", () => {
    expect(authWarnings("subscription", 1)).toEqual([]);
  });

  it("returns no warnings for api mode regardless of concurrency", () => {
    expect(authWarnings("api", 1)).toEqual([]);
    expect(authWarnings("api", 8)).toEqual([]);
  });
});
