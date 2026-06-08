import { describe, expect, it } from "vitest";
import { migrate } from "../../../src/state/migrations/index.js";
import { SCHEMA_VERSION } from "../../../src/types.js";

describe("migrate", () => {
  it("returns non-object input unchanged", () => {
    expect(migrate(null)).toBeNull();
    expect(migrate("oops")).toBe("oops");
    expect(migrate(42)).toBe(42);
  });

  it("rewrites autonomy=batched → supervised when going from v1 to v2", () => {
    const v1Manifest = {
      runId: "01HKQR3Z8MAAAAAAAAAAAAAAAA",
      schemaVersion: 1,
      config: {
        autonomy: "batched",
        tier: "balanced",
        targetDir: "/x",
      },
      repos: [],
    };
    const migrated = migrate(v1Manifest) as Record<string, unknown>;
    const cfg = migrated.config as Record<string, unknown>;
    expect(cfg.autonomy).toBe("supervised");
    expect(cfg.tier).toBe("balanced"); // unchanged
    expect(cfg.targetDir).toBe("/x"); // unchanged
    expect(migrated.runId).toBe("01HKQR3Z8MAAAAAAAAAAAAAAAA"); // unchanged
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION); // stamped to current
  });

  it("leaves non-batched autonomy values alone (yolo, manual)", () => {
    for (const autonomy of ["yolo", "manual", "supervised"]) {
      const m = migrate({
        schemaVersion: 1,
        config: { autonomy },
      }) as Record<string, unknown>;
      const cfg = m.config as Record<string, unknown>;
      expect(cfg.autonomy).toBe(autonomy);
    }
  });

  it("treats a missing schemaVersion as v1 (pre-versioned manifest)", () => {
    const m = migrate({
      config: { autonomy: "batched" },
    }) as Record<string, unknown>;
    const cfg = m.config as Record<string, unknown>;
    expect(cfg.autonomy).toBe("supervised");
    expect(m.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("is a no-op when already at the current schemaVersion", () => {
    const current = {
      schemaVersion: SCHEMA_VERSION,
      config: { autonomy: "supervised" },
    };
    const migrated = migrate(current) as Record<string, unknown>;
    expect(migrated).toEqual(current);
  });

  it("doesn't downgrade or mangle a forward-incompatible manifest", () => {
    // A manifest from a future version is left intact (schemaVersion stays
    // high) — the caller's schema check will surface the real error.
    const future = {
      schemaVersion: SCHEMA_VERSION + 10,
      config: { autonomy: "something-new" },
    };
    const migrated = migrate(future) as Record<string, unknown>;
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION + 10);
  });

  it("handles a manifest with no config field gracefully", () => {
    const m = migrate({ schemaVersion: 1 }) as Record<string, unknown>;
    expect(m.schemaVersion).toBe(SCHEMA_VERSION);
  });
});
