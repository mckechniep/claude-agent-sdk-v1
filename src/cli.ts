#!/usr/bin/env node
import { Command } from "commander";
import { runCommand } from "./commands/run.js";
import { resumeCommand } from "./commands/resume.js";
import { statusCommand } from "./commands/status.js";
import { runsListCommand, runsShowCommand } from "./commands/runs.js";
import { doctorCommand } from "./commands/doctor.js";
import { initCommand } from "./commands/init.js";

const program = new Command();
program
  .name("agent")
  .description("Agent Orchestrator — run an agentic workflow against local git repos")
  .version("0.1.0");

program
  .command("run")
  .description("Start a new orchestration run")
  .option("--target <dir>", "directory to scan for repos", process.cwd())
  .option("--auth <mode>", "auth mode: api | subscription")
  .option("--concurrency <n>", "parallel repos", "1")
  .option("--checkpoint-every <n>", "pause every N tasks", "1")
  .option("--yolo", "skip checkpoints (equivalent to --checkpoint-every=∞)")
  .option("--max-tokens <n>", "hard cap on total tokens")
  .option("--max-duration <dur>", "hard cap on wall-clock (e.g. 2h, 90m)")
  .option("--on-failure <mode>", "stop|skip-task|skip-repo|retry", "skip-repo")
  .option("--max-retries <n>", "retry attempts before failure handling", "1")
  .option("--test-gate <mode>", "required|skip|per-repo", "per-repo")
  .option("--test-timeout <dur>", "max time per test run", "5m")
  .option("--model <id>", "default model", "claude-sonnet-4-6")
  .option("--include <glob...>", "whitelist patterns")
  .option("--exclude <glob...>", "blacklist patterns")
  .option("--non-interactive", "force non-interactive mode")
  .option("--dry-run", "skip execution; analyze + plan only")
  .action(runCommand);

program
  .command("resume [runId]")
  .description("Resume a paused run")
  .action((runId: string | undefined) => resumeCommand({ runId }));

program.command("status").description("Show status (in-repo or global)").action(statusCommand);

const runsCmd = program.command("runs").description("Manage runs");
runsCmd.command("list").action(runsListCommand);
runsCmd.command("show <runId>").action(runsShowCommand);

program
  .command("doctor [runId]")
  .description("Inspect / repair state")
  .option("--repair", "interactive repair (currently scan-only)")
  .action((runId: string | undefined, opts: { repair?: boolean }) =>
    doctorCommand({ runId, repair: opts.repair }),
  );

program
  .command("init [dir]")
  .description("Bootstrap config + .agentignore")
  .action((dir: string | undefined) => initCommand({ dir }));

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("Error:", message);
  process.exit(1);
});
