import { spawn } from "node:child_process";
import { runQuery, runQueryStream, type QueryEvent } from "../sdk/query.js";
import type { BudgetTracker } from "../orchestrator/budget.js";
import { renderExecutePromptParts } from "../sdk/prompts/execute.js";
import {
  commitWithMessage,
  ensureBranch,
  getDiff,
  hasChanges,
  listChangedFiles,
  stageAll,
} from "../lib/git.js";
import type { StackProfile } from "../stack/profiles/types.js";
import type { TaskState } from "../types.js";

// Executor needs Write to create new source files (Edit alone requires the
// file to already exist). Plan tasks often introduce new modules.
const EXECUTOR_TOOLS = ["Read", "Write", "Edit", "Bash"];

export interface ExecuteParams {
  repoPath: string;
  repoName: string;
  stackProfile: StackProfile;
  task: TaskState;
  tracker: BudgetTracker;
  maxRetries: number;
  testGateEnabled: boolean;
  testCommand: string;
  testTimeoutMs: number;
  model?: string;
  queryFn?: Parameters<typeof runQuery>[0]["queryFn"];
}

export interface ExecuteOutcome extends TaskState {
  filesChanged: string[];
  diff: string;
}

export async function* executeStream(
  params: ExecuteParams,
): AsyncGenerator<QueryEvent, ExecuteOutcome> {
  const branch = `agent/${params.task.taskId.slice(0, 8)}`;
  await ensureBranch(params.repoPath, branch);

  const startedAt = Date.now();
  let attempts = 0;
  let lastTestOutput = "";
  let lastFiles: string[] = [];
  let totalTokens = 0;
  const maxAttempts = params.maxRetries + 1;

  while (attempts < maxAttempts) {
    attempts += 1;
    const { systemPrompt, userPrompt } = renderExecutePromptParts({
      repoPath: params.repoPath,
      repoName: params.repoName,
      stackProfile: params.stackProfile,
      task: params.task,
      retryFeedback:
        attempts > 1
          ? {
              previousFiles: lastFiles,
              testCommand: params.testCommand,
              testOutput: lastTestOutput,
              attemptNumber: attempts - 1,
            }
          : undefined,
    });

    const gen = runQueryStream({
      prompt: userPrompt,
      systemPrompt,
      allowedTools: EXECUTOR_TOOLS,
      cwd: params.repoPath,
      tracker: params.tracker,
      model: params.model,
      queryFn: params.queryFn,
    });

    let tokensThisAttempt = 0;
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        tokensThisAttempt = next.value.tokensUsed;
        break;
      }
      yield next.value;
    }
    totalTokens += tokensThisAttempt;

    if (!(await hasChanges(params.repoPath))) {
      // Agent claimed done but produced no diff — fail this attempt.
      lastTestOutput = "Agent reported the task complete but made no file changes.";
      if (attempts >= maxAttempts) {
        return {
          ...params.task,
          status: "failed",
          attempts,
          tokensUsed: totalTokens,
          durationMs: Date.now() - startedAt,
          failureReason: lastTestOutput,
          filesChanged: [],
          diff: "",
        };
      }
      continue;
    }

    if (params.testGateEnabled && params.testCommand) {
      const testResult = await runTestCommand(
        params.repoPath,
        params.testCommand,
        params.testTimeoutMs,
      );
      lastTestOutput = testResult.output;
      lastFiles = await listChangedFiles(params.repoPath);
      if (!testResult.passed) {
        if (attempts < maxAttempts) {
          // Preserve the failed attempt as a WIP commit so the retry prompt
          // sees the prior diff on the branch and can reason from it.
          await stageAll(params.repoPath);
          await commitWithMessage(params.repoPath, `agent: WIP attempt ${attempts}`);
          continue;
        }
        return {
          ...params.task,
          status: "failed",
          attempts,
          tokensUsed: totalTokens,
          durationMs: Date.now() - startedAt,
          failureReason: `Tests failed: ${testResult.output.slice(0, 500)}`,
          testOutput: testResult.output,
          filesChanged: lastFiles,
          diff: await getDiff(params.repoPath),
        };
      }
    }

    const diffText = await getDiff(params.repoPath);
    const filesChanged = await listChangedFiles(params.repoPath);
    await stageAll(params.repoPath);
    const message = `agent(${params.task.taskId.slice(0, 8)}): ${params.task.title}`;
    const commitSha = await commitWithMessage(params.repoPath, message);

    return {
      ...params.task,
      status: "completed",
      attempts,
      tokensUsed: totalTokens,
      durationMs: Date.now() - startedAt,
      commitSha,
      ...(lastTestOutput ? { testOutput: lastTestOutput } : {}),
      filesChanged,
      diff: diffText,
    };
  }

  return {
    ...params.task,
    status: "failed",
    attempts,
    tokensUsed: totalTokens,
    durationMs: Date.now() - startedAt,
    failureReason: "Exhausted retry loop",
    filesChanged: [],
    diff: "",
  };
}

export async function execute(params: ExecuteParams): Promise<ExecuteOutcome> {
  const gen = executeStream(params);
  for (;;) {
    const next = await gen.next();
    if (next.done) return next.value;
  }
}

interface TestCommandResult {
  passed: boolean;
  output: string;
}

function runTestCommand(
  cwd: string,
  command: string,
  timeoutMs: number,
): Promise<TestCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ passed: false, output: stdout + stderr + "\n[timed out]" });
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ passed: code === 0, output: stdout + stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ passed: false, output: stdout + stderr + `\n[spawn error: ${err.message}]` });
    });
  });
}
