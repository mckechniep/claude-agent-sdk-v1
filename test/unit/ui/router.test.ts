import { describe, expect, it } from "vitest";
import { parseHash } from "../../../ui/src/router";

describe("parseHash", () => {
  it("returns home for empty hash", () => {
    expect(parseHash("")).toEqual({ kind: "home" });
  });

  it("returns home for #/", () => {
    expect(parseHash("#/")).toEqual({ kind: "home" });
  });

  it("returns home for unknown routes", () => {
    expect(parseHash("#/unknown")).toEqual({ kind: "home" });
    expect(parseHash("#/runs")).toEqual({ kind: "home" });
  });

  it("returns new-run for #/runs/new", () => {
    expect(parseHash("#/runs/new")).toEqual({ kind: "new-run" });
  });

  it("returns run-dashboard for valid ulid", () => {
    expect(parseHash("#/runs/01HKQR3Z8MAAAAAAAAAAAAAAAA")).toEqual({
      kind: "run-dashboard",
      runId: "01HKQR3Z8MAAAAAAAAAAAAAAAA",
    });
  });

  it("falls back to home for invalid run id", () => {
    expect(parseHash("#/runs/not-a-ulid")).toEqual({ kind: "home" });
    expect(parseHash("#/runs/01HKQR3Z8MAAAAAAAAAAAAA")).toEqual({ kind: "home" }); // too short
  });
});
