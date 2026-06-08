import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encryptSecret,
  decryptSecret,
  persistApiKey,
  readPersistedApiKey,
  clearPersistedApiKey,
} from "../../../src/auth/keyStore.js";

const MACHINE_A = "52a71ab4aaaaaaaaaaaaaaaaaaaaaaaa";
const MACHINE_B = "ffffffffffffffffffffffffffffffff";
// A stand-in secret shaped like an API key but deliberately not matching any
// real provider prefix, so secret scanners don't flag the test fixture.
const SAMPLE_KEY = "test-secret-EXAMPLE-not-a-real-key-0123456789";

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a secret with the same machine id", () => {
    const blob = encryptSecret(SAMPLE_KEY, MACHINE_A);
    expect(decryptSecret(blob, MACHINE_A)).toBe(SAMPLE_KEY);
  });

  it("never stores the plaintext in the blob", () => {
    const blob = encryptSecret(SAMPLE_KEY, MACHINE_A);
    const serialized = JSON.stringify(blob);
    expect(serialized).not.toContain(SAMPLE_KEY);
    expect(serialized).not.toContain("test-secret");
  });

  it("produces different ciphertext each call (random iv + salt)", () => {
    const a = encryptSecret(SAMPLE_KEY, MACHINE_A);
    const b = encryptSecret(SAMPLE_KEY, MACHINE_A);
    expect(a.data).not.toBe(b.data);
    expect(a.iv).not.toBe(b.iv);
    expect(a.salt).not.toBe(b.salt);
  });

  it("fails to decrypt with a different machine id (machine-bound)", () => {
    const blob = encryptSecret(SAMPLE_KEY, MACHINE_A);
    expect(() => decryptSecret(blob, MACHINE_B)).toThrow();
  });

  it("detects tampering via the GCM auth tag", () => {
    const blob = encryptSecret(SAMPLE_KEY, MACHINE_A);
    // Flip a byte in the ciphertext.
    const raw = Buffer.from(blob.data, "base64");
    raw[0] = raw[0]! ^ 0xff;
    const tampered = { ...blob, data: raw.toString("base64") };
    expect(() => decryptSecret(tampered, MACHINE_A)).toThrow();
  });
});

describe("persistApiKey / readPersistedApiKey / clearPersistedApiKey", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "keystore-test-"));
    filePath = join(dir, "credentials.enc.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null when no key has been persisted", async () => {
    expect(await readPersistedApiKey({ filePath, machineId: MACHINE_A })).toBeNull();
  });

  it("persists and reads back a key", async () => {
    await persistApiKey(SAMPLE_KEY, { filePath, machineId: MACHINE_A });
    expect(await readPersistedApiKey({ filePath, machineId: MACHINE_A })).toBe(SAMPLE_KEY);
  });

  it("writes the file with owner-only permissions (0600)", async () => {
    await persistApiKey(SAMPLE_KEY, { filePath, machineId: MACHINE_A });
    const mode = (await stat(filePath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("does not write plaintext to disk", async () => {
    await persistApiKey(SAMPLE_KEY, { filePath, machineId: MACHINE_A });
    const onDisk = await readFile(filePath, "utf8");
    expect(onDisk).not.toContain(SAMPLE_KEY);
  });

  it("returns null (does not throw) when the persisted file cannot be decrypted on this machine", async () => {
    await persistApiKey(SAMPLE_KEY, { filePath, machineId: MACHINE_A });
    // Different machine id simulates the file being copied to another box.
    expect(await readPersistedApiKey({ filePath, machineId: MACHINE_B })).toBeNull();
  });

  it("clears a persisted key", async () => {
    await persistApiKey(SAMPLE_KEY, { filePath, machineId: MACHINE_A });
    await clearPersistedApiKey({ filePath });
    expect(await readPersistedApiKey({ filePath, machineId: MACHINE_A })).toBeNull();
  });

  it("clear is idempotent when no file exists", async () => {
    await expect(clearPersistedApiKey({ filePath })).resolves.toBeUndefined();
  });
});
