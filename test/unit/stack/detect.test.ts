import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectStack } from "../../../src/stack/detect.js";

describe("detectStack", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "stack-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("detects jsts from package.json", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    expect(await detectStack(dir)).toBe("jsts");
  });

  it("detects python from pyproject.toml", async () => {
    await writeFile(join(dir, "pyproject.toml"), "[project]\nname='x'\n");
    expect(await detectStack(dir)).toBe("python");
  });

  it("detects python from requirements.txt", async () => {
    await writeFile(join(dir, "requirements.txt"), "requests==1.0\n");
    expect(await detectStack(dir)).toBe("python");
  });

  it("returns generic for unknown stacks", async () => {
    await mkdir(dir, { recursive: true });
    expect(await detectStack(dir)).toBe("generic");
  });

  it("prefers jsts when both package.json and pyproject.toml exist", async () => {
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, "pyproject.toml"), "");
    expect(await detectStack(dir)).toBe("jsts");
  });
});
