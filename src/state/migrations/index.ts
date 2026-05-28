import { SCHEMA_VERSION } from "../../types.js";

/**
 * Pre-validation migration pipeline for run manifests on disk.
 *
 * As the schema evolves, older on-disk manifests need their shape
 * rewritten before they can pass Zod validation. Each migration is a
 * pure function that takes a manifest at version N-1 and returns one
 * at version N. They're keyed by their target version so loadManifest
 * can walk forward from whatever the file claims to be.
 *
 * Why pre-validation: a renamed enum value or removed field would
 * cause `RunManifestSchema.safeParse` to fail before we got a chance
 * to fix the shape. Migrating against the raw parsed JSON gives us
 * the latitude to rewrite anything.
 *
 * Why "target version" keys: a migration registered under key N means
 * "applies when going from N-1 to N." Adding v3 in the future is just
 * a new entry under key 3; the walk loop picks it up automatically.
 */
type Migration = (manifest: Record<string, unknown>) => Record<string, unknown>;

const MIGRATIONS: Record<number, Migration> = {
  2: migrateV1ToV2,
};

/**
 * v1 → v2: rename autonomy="batched" → "supervised".
 *
 * Rationale: "batched" implied batch-approval which the mode never did
 * — it just lets the background loop run between approval gates. The
 * new name "supervised" describes the user's actual role.
 */
function migrateV1ToV2(manifest: Record<string, unknown>): Record<string, unknown> {
  const config = manifest.config;
  if (typeof config !== "object" || config === null) return manifest;
  const cfg = config as Record<string, unknown>;
  if (cfg.autonomy === "batched") {
    return {
      ...manifest,
      config: { ...cfg, autonomy: "supervised" },
    };
  }
  return manifest;
}

/**
 * Walks `parsed` from its declared schemaVersion up to SCHEMA_VERSION,
 * applying every registered migration along the way. Returns the
 * migrated manifest with `schemaVersion` stamped to the current value.
 *
 * - Pre-versioned manifests (no schemaVersion field) are treated as v1.
 * - Forward-incompatible manifests (declared version > SCHEMA_VERSION)
 *   are returned unchanged so the caller's schema check surfaces the
 *   real error rather than this code silently downgrading.
 */
export function migrate(parsed: unknown): unknown {
  if (typeof parsed !== "object" || parsed === null) return parsed;
  let m = { ...(parsed as Record<string, unknown>) };
  const fromVersion =
    typeof m.schemaVersion === "number" && Number.isFinite(m.schemaVersion) ? m.schemaVersion : 1;
  if (fromVersion > SCHEMA_VERSION) return m;
  for (let v = fromVersion + 1; v <= SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (step) m = step(m);
  }
  if (m.schemaVersion !== SCHEMA_VERSION) {
    m = { ...m, schemaVersion: SCHEMA_VERSION };
  }
  return m;
}
