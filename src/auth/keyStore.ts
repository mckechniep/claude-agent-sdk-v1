import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Machine-bound at-rest encryption for the Anthropic API key.
 *
 * Threat model (be honest about it): the encryption key is derived from this
 * machine's `/etc/machine-id`, so the persisted blob is useless if it leaks
 * OFF the machine — an accidental git commit, a backup, a paste into a gist.
 * It is NOT protection against something running as the same user on this box;
 * such a process can read both the file and the machine id, exactly as the
 * server does. This is a deliberate, modest improvement over plaintext for a
 * localhost personal tool, not a secrets vault. For real isolation you'd need
 * an OS keychain or a passphrase typed on every start.
 *
 * The crypto primitives (`encryptSecret`/`decryptSecret`) are pure functions of
 * (plaintext, machineId) so they're trivially testable; the persistence layer
 * wraps them with file IO and 0600 permissions.
 */

const ALG = "aes-256-gcm" as const;
const KEY_LEN = 32; // 256-bit key for AES-256
const IV_LEN = 12; // 96-bit nonce — the GCM-recommended size
const SALT_LEN = 16;
// Domain-separation salt mixed into key derivation. Not a secret; it only
// ensures a machine id reused by another app derives a different key here.
const APP_CONTEXT = "agent-orchestrator/api-key/v1";

export interface EncryptedBlob {
  v: 1;
  alg: typeof ALG;
  salt: string; // base64 — per-encryption scrypt salt
  iv: string; // base64 — per-encryption GCM nonce
  tag: string; // base64 — GCM authentication tag
  data: string; // base64 — ciphertext
}

export interface KeyStoreOptions {
  /** Override the on-disk location (tests). Defaults to {@link credentialsPath}. */
  filePath?: string;
  /** Override the machine id (tests). Defaults to {@link readMachineId}. */
  machineId?: string;
}

function deriveKey(machineId: string, salt: Buffer): Buffer {
  // scrypt is deliberately slow/memory-hard; the machine id is the "password".
  return scryptSync(`${APP_CONTEXT}:${machineId}`, salt, KEY_LEN);
}

export function encryptSecret(plaintext: string, machineId: string): EncryptedBlob {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(machineId, salt);
  const cipher = createCipheriv(ALG, key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: ALG,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: data.toString("base64"),
  };
}

export function decryptSecret(blob: EncryptedBlob, machineId: string): string {
  const salt = Buffer.from(blob.salt, "base64");
  const iv = Buffer.from(blob.iv, "base64");
  const tag = Buffer.from(blob.tag, "base64");
  const key = deriveKey(machineId, salt);
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  // .final() throws if the tag doesn't verify — i.e. tampering or a wrong
  // (different-machine) derived key. Callers translate that to "no usable key".
  const out = Buffer.concat([
    decipher.update(Buffer.from(blob.data, "base64")),
    decipher.final(),
  ]);
  return out.toString("utf8");
}

/**
 * Read this machine's stable identifier. `/etc/machine-id` is present on Linux
 * and WSL2; we fall back to the dbus copy, then to a HOME-derived constant so
 * the feature degrades to "still encrypted, just less machine-specific" rather
 * than throwing on exotic setups.
 */
export function readMachineId(): string {
  for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const id = readFileSync(path, "utf8").trim();
      if (id) return id;
    } catch {
      // try next source
    }
  }
  return `home:${process.env.HOME ?? process.env.USERPROFILE ?? "unknown"}`;
}

/**
 * Default credentials location: a sibling of the runs dir, OUTSIDE any repo,
 * so it can never be accidentally git-committed.
 * ~/.local/share/agent-orchestrator/credentials.enc.json
 */
export function credentialsPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return join(home, ".local", "share", "agent-orchestrator", "credentials.enc.json");
}

export async function persistApiKey(key: string, opts: KeyStoreOptions = {}): Promise<void> {
  const filePath = opts.filePath ?? credentialsPath();
  const machineId = opts.machineId ?? readMachineId();
  const blob = encryptSecret(key, machineId);
  await mkdir(dirname(filePath), { recursive: true });
  // mode 0600 in the open() call closes the brief window where a default-umask
  // file would be world/group-readable before a follow-up chmod.
  await writeFile(filePath, JSON.stringify(blob), { encoding: "utf8", mode: 0o600 });
}

export async function readPersistedApiKey(opts: KeyStoreOptions = {}): Promise<string | null> {
  const filePath = opts.filePath ?? credentialsPath();
  const machineId = opts.machineId ?? readMachineId();
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null; // no key persisted yet
  }
  try {
    const blob = JSON.parse(raw) as EncryptedBlob;
    return decryptSecret(blob, machineId);
  } catch {
    // Corrupt, tampered, or encrypted on a different machine: there is no
    // usable key here. Return null rather than throwing so startup/auth-status
    // degrade to "no API key detected" instead of crashing.
    return null;
  }
}

/**
 * Synchronous sibling of {@link readPersistedApiKey}, used at server startup so
 * the first `/api/auth/status` already reflects a stored key (no async race
 * where the UI briefly sees "no key" then "key" on refresh).
 */
export function readPersistedApiKeySync(opts: KeyStoreOptions = {}): string | null {
  const filePath = opts.filePath ?? credentialsPath();
  const machineId = opts.machineId ?? readMachineId();
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  try {
    const blob = JSON.parse(raw) as EncryptedBlob;
    return decryptSecret(blob, machineId);
  } catch {
    return null;
  }
}

export async function clearPersistedApiKey(opts: KeyStoreOptions = {}): Promise<void> {
  const filePath = opts.filePath ?? credentialsPath();
  await rm(filePath, { force: true });
}
