import { describe, expect, it } from "vitest";
import { loadPanelSize, savePanelSize, type StorageLike } from "../../../ui/src/ui/panelSize";

function fakeStorage(initial: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

describe("panelSize", () => {
  it("round-trips a saved size", () => {
    const s = fakeStorage();
    savePanelSize("proposal", { width: 500, height: 320 }, s);
    expect(loadPanelSize("proposal", s)).toEqual({ width: 500, height: 320 });
  });

  it("returns null for a missing key", () => {
    expect(loadPanelSize("nope", fakeStorage())).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(loadPanelSize("x", fakeStorage({ "agent-orch:panel:x": "{not json" }))).toBeNull();
  });

  it("keeps only positive numeric dimensions", () => {
    const s = fakeStorage({ "agent-orch:panel:p": JSON.stringify({ width: 0, height: 200 }) });
    expect(loadPanelSize("p", s)).toEqual({ height: 200 });
  });
});
