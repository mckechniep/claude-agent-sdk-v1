import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { simpleGit } from "simple-git";
import { applyAuthMode } from "../src/auth/mode.js";
import { BudgetTracker } from "../src/orchestrator/budget.js";
import { renderExecutePromptParts } from "../src/sdk/prompts/execute.js";
import { runQuery } from "../src/sdk/query.js";
import { jstsProfile } from "../src/stack/profiles/jsts.js";

const authMode: "api" | "subscription" = process.env.ANTHROPIC_API_KEY ? "api" : "subscription";
console.log(`Auth mode: ${authMode}`);
applyAuthMode(authMode);

const cwd = await mkdtemp(join(tmpdir(), "cache-smoke-"));
console.log(`Workspace: ${cwd}`);
const g = simpleGit(cwd);
await g.init();
await g.addConfig("user.email", "smoke@local");
await g.addConfig("user.name", "smoke");
await writeFile(
  join(cwd, "package.json"),
  JSON.stringify({ name: "smoke", version: "1.0.0" }, null, 2),
);
await writeFile(join(cwd, "README.md"), "# Smoke\n\nMinimal jsts repo for cache smoke test.\n");
await g.add(".").commit("init");

const tracker = new BudgetTracker({
  maxTokens: 50_000,
  maxDurationMs: 5 * 60_000,
});

async function runOne(title: string): Promise<{
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  tokensUsed: number;
  durationMs: number;
  finalText: string;
  systemPromptTotalChars: number;
}> {
  const { systemPrompt, userPrompt } = renderExecutePromptParts({
    repoPath: cwd,
    repoName: "smoke",
    stackProfile: jstsProfile,
    task: {
      taskId: randomUUID(),
      title,
      acceptanceCriteria: [
        "Use the Read tool to read README.md.",
        "Then use the Read tool to read package.json.",
        "Then reply with a one-line summary of what the repo is. Do not edit any files.",
      ],
      status: "pending",
      attempts: 0,
      tokensUsed: 0,
      durationMs: 0,
    },
  });
  const systemPromptTotalChars = systemPrompt.join("\n").length;

  const result = await runQuery({
    prompt: userPrompt,
    systemPrompt,
    allowedTools: ["Read", "Write", "Edit", "Bash"],
    cwd,
    tracker,
    model: "claude-haiku-4-5-20251001",
  });

  return {
    cacheCreationInputTokens: result.cacheCreationInputTokens,
    cacheReadInputTokens: result.cacheReadInputTokens,
    tokensUsed: result.tokensUsed,
    durationMs: result.durationMs,
    finalText: result.finalText,
    systemPromptTotalChars,
  };
}

function report(label: string, r: Awaited<ReturnType<typeof runOne>>): void {
  console.log(`\n=== ${label} ===`);
  console.log(`  systemPrompt chars:        ${r.systemPromptTotalChars}`);
  console.log(`  cacheCreationInputTokens:  ${r.cacheCreationInputTokens}`);
  console.log(`  cacheReadInputTokens:      ${r.cacheReadInputTokens}`);
  console.log(`  tokensUsed (in+out):       ${r.tokensUsed}`);
  console.log(`  durationMs:                ${r.durationMs}ms`);
  console.log(`  finalText:                 ${JSON.stringify(r.finalText.slice(0, 200))}`);
}

const a = await runOne("Task A: smoke verify");
report("First call", a);

const b = await runOne("Task B: smoke verify");
report("Second call (same systemPrompt prefix)", b);

console.log("\n=== Verdict ===");
if (b.cacheReadInputTokens > 0) {
  console.log("PASS — caching is working. Second call hit the cache.");
  console.log(`Saved ~${b.cacheReadInputTokens} input tokens on the second call (billed at 10%).`);
} else if (a.cacheCreationInputTokens === 0 && b.cacheCreationInputTokens === 0) {
  console.log("FAIL — cache was never created.");
  console.log("  Likely below the minimum cacheable size:");
  console.log("    Haiku 4.5 requires ~2048+ tokens of stable prefix");
  console.log("    Sonnet 4.6 requires ~1024+ tokens of stable prefix");
  console.log("  Our universal+repo blocks may be too short.");
} else {
  console.log("PARTIAL — cache was created but not read on second call.");
  console.log("  Possible byte-drift in systemPrompt between calls, or TTL expired.");
}
