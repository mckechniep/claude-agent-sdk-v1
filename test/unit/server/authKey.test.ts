import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSetApiKey, handleClearApiKey, type ServerDeps } from "../../../src/server/routes.js";
import { readPersistedApiKey, credentialsPath } from "../../../src/auth/keyStore.js";

// Shaped like a key but not matching a real provider prefix (keeps secret
// scanners quiet) and >= 20 chars to pass validation.
const KEY = "test-secret-abcdefghijklmnop";

describe("handleSetApiKey / handleClearApiKey", () => {
  let homeDir: string;
  let prevHome: string | undefined;
  let prevKey: string | undefined;

  beforeEach(async () => {
    // Redirect HOME so credentialsPath() resolves into a throwaway dir — never
    // touch the developer's real ~/.local/share credentials during tests.
    homeDir = await mkdtemp(join(tmpdir(), "authkey-home-"));
    prevHome = process.env.HOME;
    prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.HOME = homeDir;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    await rm(homeDir, { recursive: true, force: true });
  });

  it("rejects a too-short key with 400", async () => {
    const deps: ServerDeps = { originalApiKey: undefined };
    const res = await handleSetApiKey({ key: "short" }, deps);
    expect(res.status).toBe(400);
    expect(deps.originalApiKey).toBeUndefined();
  });

  it("rejects a missing key with 400", async () => {
    const deps: ServerDeps = { originalApiKey: undefined };
    const res = await handleSetApiKey({}, deps);
    expect(res.status).toBe(400);
  });

  it("applies a valid key to env + deps and persists it by default", async () => {
    const deps: ServerDeps = { originalApiKey: undefined };
    const res = await handleSetApiKey({ key: KEY }, deps);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ apiKeyDetected: true, apiKeyPersisted: true });
    expect(process.env.ANTHROPIC_API_KEY).toBe(KEY);
    expect(deps.originalApiKey).toBe(KEY);
    expect(deps.apiKeyPersisted).toBe(true);
    // Round-trips through the encrypted store.
    expect(await readPersistedApiKey()).toBe(KEY);
  });

  it("trims surrounding whitespace from the key", async () => {
    const deps: ServerDeps = { originalApiKey: undefined };
    await handleSetApiKey({ key: `  ${KEY}\n` }, deps);
    expect(deps.originalApiKey).toBe(KEY);
  });

  it("does not write to disk when persist is false", async () => {
    const deps: ServerDeps = { originalApiKey: undefined };
    const res = await handleSetApiKey({ key: KEY, persist: false }, deps);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ apiKeyDetected: true, apiKeyPersisted: false });
    expect(deps.originalApiKey).toBe(KEY);
    expect(deps.apiKeyPersisted).toBe(false);
    expect(await readPersistedApiKey()).toBeNull();
  });

  it("clears the key from env, deps, and the store", async () => {
    const deps: ServerDeps = { originalApiKey: undefined };
    await handleSetApiKey({ key: KEY }, deps);
    expect(await readPersistedApiKey()).toBe(KEY);

    const res = await handleClearApiKey(deps);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ apiKeyDetected: false, apiKeyPersisted: false });
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(deps.originalApiKey).toBeUndefined();
    expect(deps.apiKeyPersisted).toBe(false);
    expect(await readPersistedApiKey()).toBeNull();
    expect(credentialsPath().startsWith(homeDir)).toBe(true);
  });

  it("clear is idempotent when nothing is set", async () => {
    const deps: ServerDeps = { originalApiKey: undefined };
    const res = await handleClearApiKey(deps);
    expect(res.status).toBe(200);
  });
});
