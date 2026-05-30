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
import { appendTranscript, ensureTranscriptDir } from "../state/transcript.js";
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
  abortSignal?: AbortSignal;
  // When set, every SDK message (plus per-attempt boundaries) is appended here
  // as JSONL. The run loop points this at runs/<id>/transcripts/<taskId>.jsonl
  // so a failed task is debuggable post-hoc. Optional: CLI/tests can omit it.
  transcriptPath?: string;
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

  // Best-effort per-task transcript writer. Transcript IO must never fail the
  // task — it's a debug artifact, not part of the work — so every write is
  // guarded and a failure degrades to "no transcript", never a failed run.
  const txPath = params.transcriptPath;
  if (txPath) {
    try {
      await ensureTranscriptDir(txPath);
    } catch {
      // dir unwritable → transcript silently disabled; the run is unaffected.
    }
  }
  const writeTx = async (entry: unknown): Promise<void> => {
    if (!txPath) return;
    try {
      await appendTranscript(txPath, entry);
    } catch {
      // non-fatal observability loss; do not abort the task on a bad append.
    }
  };

  const startedAt = Date.now();
  let attempts = 0;
  let lastTestOutput = "";
  let lastFinalText = "";
  let lastFailureKind: "no-changes" | "test-failure" | null = null;
  let lastFiles: string[] = [];
  let totalTokens = 0;
  const maxAttempts = params.maxRetries + 1;

  while (attempts < maxAttempts) {
    attempts += 1;
    await writeTx({ ts: Date.now(), type: "attempt_started", attempt: attempts });
    const { systemPrompt, userPrompt } = renderExecutePromptParts({
      repoPath: params.repoPath,
      repoName: params.repoName,
      stackProfile: params.stackProfile,
      task: params.task,
      retryFeedback:
        attempts > 1
          ? {
              kind: lastFailureKind ?? "test-failure",
              previousFiles: lastFiles,
              testCommand: params.testCommand,
              testOutput: lastTestOutput,
              previousFinalText: lastFinalText,
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
      abortSignal: params.abortSignal,
    });

    let tokensThisAttempt = 0;
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        tokensThisAttempt = next.value.tokensUsed;
        lastFinalText = next.value.finalText;
        break;
      }
      await writeTx(next.value);
      yield next.value;
    }
    totalTokens += tokensThisAttempt;
    await writeTx({
      ts: Date.now(),
      type: "attempt_finished",
      attempt: attempts,
      tokensUsed: tokensThisAttempt,
      finalText: lastFinalText,
    });

    if (!(await hasChanges(params.repoPath))) {
      // Agent claimed done but produced no diff — fail this attempt. Capture the
      // failure kind (so the retry gets a Write-it-this-time nudge instead of
      // test-failure prose) and fold the agent's final message into the recorded
      // reason. The #1 cause is a hallucinated completion: the agent narrates the
      // work but never calls Write/Edit — and without this, that's invisible
      // post-hoc because per-task SDK messages aren't otherwise retained.
      lastFailureKind = "no-changes";
      lastTestOutput = "Agent reported the task complete but made no file changes.";
      if (attempts >= maxAttempts) {
        return {
          ...params.task,
          status: "failed",
          attempts,
          tokensUsed: totalTokens,
          durationMs: Date.now() - startedAt,
          failureReason: withAgentMessage(lastTestOutput, lastFinalText),
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
        lastFailureKind = "test-failure";
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
          failureReason: withAgentMessage(
            `Tests failed: ${testResult.output.slice(0, 500)}`,
            lastFinalText,
          ),
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

// Append the agent's final message to a failure reason so failures are
// debuggable without a separate transcript. Trimmed + clipped to keep the
// manifest/run-log compact (the full text lives in the per-task transcript).
function withAgentMessage(reason: string, finalText: string): string {
  const said = finalText.trim();
  if (!said) return reason;
  const clipped = said.length > 1000 ? `${said.slice(0, 1000)}…` : said;
  return `${reason}\n\nAgent's final message:\n${clipped}`;
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
