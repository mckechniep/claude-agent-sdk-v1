import { resolveAuthMode, applyAuthMode, authWarnings } from "../auth/mode.js";
import { runOrchestration } from "../orchestrator/run.js";
import { defaultStateRoot } from "../state/runIndex.js";
import { selectRepos as selectReposTui } from "../tui/select.js";
import { confirmPrompt, proposalGate, planGate } from "../tui/confirm.js";
import { ModelIdSchema, RunConfigSchema } from "../types.js";
import type { AuthMode, RunConfig } from "../types.js";

export interface RunCommandOpts {
  target: string;
  auth?: AuthMode;
  concurrency: string;
  checkpointEvery: string;
  yolo?: boolean;
  maxTokens?: string;
  maxDuration?: string;
  onFailure: RunConfig["onFailure"];
  maxRetries: string;
  testGate: RunConfig["testGate"];
  testTimeout: string;
  model: string;
  include?: string[];
  exclude?: string[];
  nonInteractive?: boolean;
  dryRun?: boolean;
}

export async function runCommand(opts: RunCommandOpts): Promise<void> {
  const interactive = !opts.nonInteractive && process.stdout.isTTY === true;

  const resolved = resolveAuthMode({
    flag: opts.auth,
    env: (process.env.AGENT_AUTH as AuthMode | undefined) ?? undefined,
    interactive,
  });
  if (!resolved) {
    console.error("--auth is required (api | subscription) when non-interactive");
    process.exit(4);
  }
  applyAuthMode(resolved.mode);

  const modelParse = ModelIdSchema.safeParse(opts.model);
  if (!modelParse.success) {
    console.error(
      `Invalid --model "${opts.model}". Allowed values: ${ModelIdSchema.options.join(", ")}`,
    );
    process.exit(4);
  }

  const configParse = RunConfigSchema.safeParse({
    targetDir: opts.target,
    concurrency: Number(opts.concurrency),
    checkpointEvery: opts.yolo ? Number.MAX_SAFE_INTEGER : Number(opts.checkpointEvery),
    onFailure: opts.onFailure,
    maxRetries: Number(opts.maxRetries),
    maxTokens: opts.maxTokens ? Number(opts.maxTokens) : undefined,
    maxDurationMs: opts.maxDuration ? parseDuration(opts.maxDuration) : undefined,
    testGate: opts.testGate,
    testTimeoutMs: parseDuration(opts.testTimeout),
    model: { default: modelParse.data },
    include: opts.include,
    exclude: opts.exclude,
  });
  if (!configParse.success) {
    console.error(
      `Invalid configuration: ${configParse.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
    process.exit(4);
  }
  const config: RunConfig = configParse.data;

  const warnings = authWarnings(resolved.mode, config.concurrency);
  for (const w of warnings) console.warn(`WARNING: ${w}`);

  const result = await runOrchestration({
    authMode: resolved.mode,
    config,
    stateRoot: defaultStateRoot(),
    selectRepos: async (repos) =>
      interactive ? selectReposTui({ repos }) : repos.map((r) => r.path),
    proposalGate: async () => (interactive ? proposalGate() : "accept"),
    planGate: async () => (interactive ? planGate() : "accept"),
    runConfirmation: async () =>
      interactive ? confirmPrompt("Proceed with execution across all selected repos?", true) : true,
    authConfirmation: async (warns) =>
      interactive ? confirmPrompt(warns.join("\n") + "\nContinue?", true) : true,
  });

  if (result.status === "completed") {
    process.exit(0);
  }
  if (result.status === "paused") {
    process.exit(2);
  }
  if (result.status === "failed") {
    process.exit(5);
  }
  process.exit(1);
}

function parseDuration(s: string): number {
  const m = s.match(/^(\d+)\s*(ms|s|m|h)$/);
  if (!m) return Number(s) || 0;
  const n = Number(m[1]);
  const unit = m[2];
  const mult = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return n * mult;
}
