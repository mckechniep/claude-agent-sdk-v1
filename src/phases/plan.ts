import { runQuery, runQueryStream, type QueryEvent } from "../sdk/query.js";
import type { BudgetTracker } from "../orchestrator/budget.js";
import { renderPlanPrompt } from "../sdk/prompts/plan.js";
import type { Thoroughness } from "../sdk/prompts/iteration.js";
import { readPlan, writePlan } from "../state/repoState.js";
import { parsePlan } from "../lib/planParser.js";
import type { StackProfile } from "../stack/profiles/types.js";
import type { TaskState } from "../types.js";

const AVG_TOKENS_PER_EXECUTE = 30_000;
const AVG_DURATION_MS_PER_EXECUTE = 60_000;

export interface PlanParams {
  repoPath: string;
  repoName: string;
  stackProfile: StackProfile;
  proposalMarkdown: string;
  tracker: BudgetTracker;
  userNotes?: string;
  iteration?: number;
  thoroughness?: Thoroughness;
  model?: string;
  queryFn?: Parameters<typeof runQuery>[0]["queryFn"];
}

export interface PlanResult {
  planPath: string;
  planMarkdown: string;
  taskCount: number;
  tasks: TaskState[];
  estimatedTokens: number;
  estimatedDurationMs: number;
  tokensUsed: number;
  durationMs: number;
}

export async function* planStream(params: PlanParams): AsyncGenerator<QueryEvent, PlanResult> {
  // Pick up the prior plan if one exists — gives the model context for
  // refinement, lets it preserve task UUIDs across iterations, and avoids
  // the model getting confused by a same-named file in .agent/.
  const previousPlan = (await readPlan(params.repoPath)) ?? undefined;

  const prompt = renderPlanPrompt({
    repoPath: params.repoPath,
    repoName: params.repoName,
    stackProfile: params.stackProfile,
    proposalMarkdown: params.proposalMarkdown,
    userNotes: params.userNotes,
    previousPlan,
    iteration: params.iteration,
    thoroughness: params.thoroughness,
  });

  const gen = runQueryStream({
    prompt,
    allowedTools: ["Read"],
    cwd: params.repoPath,
    tracker: params.tracker,
    model: params.model,
    queryFn: params.queryFn,
  });

  let finalText = "";
  let tokensUsed = 0;
  let durationMs = 0;
  for (;;) {
    const next = await gen.next();
    if (next.done) {
      finalText = next.value.finalText;
      tokensUsed = next.value.tokensUsed;
      durationMs = next.value.durationMs;
      break;
    }
    yield next.value;
  }

  const planPath = await writePlan(params.repoPath, finalText);
  const tasks = parsePlan(finalText);
  return {
    planPath,
    planMarkdown: finalText,
    taskCount: tasks.length,
    tasks,
    estimatedTokens: tasks.length * AVG_TOKENS_PER_EXECUTE,
    estimatedDurationMs: tasks.length * AVG_DURATION_MS_PER_EXECUTE,
    tokensUsed,
    durationMs,
  };
}

export async function plan(params: PlanParams): Promise<PlanResult> {
  const gen = planStream(params);
  for (;;) {
    const next = await gen.next();
    if (next.done) return next.value;
  }
}
