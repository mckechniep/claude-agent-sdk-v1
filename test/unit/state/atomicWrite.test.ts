import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAtomic, cleanStaleTmpFiles } from "../../../src/state/atomicWrite.js";

describe("writeAtomic", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes content atomically and the final file is readable", async () => {
    const path = join(dir, "state.json");
    await writeAtomic(path, '{"ok":true}');
    expect(await readFile(path, "utf8")).toBe('{"ok":true}');
  });

  it("does not leave .tmp files in the directory after a successful write", async () => {
    const path = join(dir, "state.json");
    await writeAtomic(path, "abc");
    const entries = await readdir(dir);
    expect(entries.filter((e) => e.includes(".tmp"))).toHaveLength(0);
    expect(entries).toContain("state.json");
  });

  it("preserves the previous file if writeAtomic is called with new content", async () => {
    const path = join(dir, "state.json");
    await writeAtomic(path, "v1");
    await writeAtomic(path, "v2");
    expect(await readFile(path, "utf8")).toBe("v2");
  });
});

describe("cleanStaleTmpFiles", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-clean-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("removes files matching the .tmp.<pid>.<ts> pattern", async () => {
    await writeFile(join(dir, "state.json.tmp.123.456"), "garbage");
    await writeFile(join(dir, "state.json"), "good");
    await cleanStaleTmpFiles(dir);
    const entries = await readdir(dir);
    expect(entries).toEqual(["state.json"]);
  });

  it("does not touch non-matching files", async () => {
    await writeFile(join(dir, "state.json"), "good");
    await writeFile(join(dir, "notes.md"), "keep");
    await cleanStaleTmpFiles(dir);
    const entries = await readdir(dir);
    expect(entries.sort()).toEqual(["notes.md", "state.json"]);
  });

  it("returns 0 when the directory does not exist (ENOENT is benign)", async () => {
    const missing = join(dir, "nope-does-not-exist");
    await expect(cleanStaleTmpFiles(missing)).resolves.toBe(0);
  });
});
