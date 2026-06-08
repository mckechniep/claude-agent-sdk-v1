import { runQuery, runQueryStream, type QueryEvent } from "../sdk/query.js";
import type { BudgetTracker } from "../orchestrator/budget.js";
import { renderAnalyzePrompt } from "../sdk/prompts/analyze.js";
import type { Thoroughness } from "../sdk/prompts/iteration.js";
import { readProposal, writeProposal } from "../state/repoState.js";
import type { StackProfile } from "../stack/profiles/types.js";
import { PHASE_AGENTS } from "../orchestrator/phaseAgents.js";

export interface AnalyzeParams {
  repoPath: string;
  repoName: string;
  stackProfile: StackProfile;
  hasReadme: boolean;
  hasTests: boolean;
  lastCommitDate: string | null;
  tracker: BudgetTracker;
  userNotes?: string;
  iteration?: number;
  thoroughness?: Thoroughness;
  model?: string;
  effort?: string;
  finalize?: boolean;
  queryFn?: Parameters<typeof runQuery>[0]["queryFn"];
  abortSignal?: AbortSignal;
}

export interface AnalyzeResult {
  proposalPath: string;
  proposalMarkdown: string;
  tokensUsed: number;
  durationMs: number;
}

export async function* analyzeStream(
  params: AnalyzeParams,
): AsyncGenerator<QueryEvent, AnalyzeResult> {
  // Pick up the prior proposal if one exists — gives the model context
  // for refinement instead of re-deriving from scratch, and avoids the
  // model getting confused by a file with the same name in .agent/.
  const previousProposal = (await readProposal(params.repoPath)) ?? undefined;

  const prompt = renderAnalyzePrompt({
    repoPath: params.repoPath,
    repoName: params.repoName,
    stackProfile: params.stackProfile,
    hasReadme: params.hasReadme,
    hasTests: params.hasTests,
    lastCommitDate: params.lastCommitDate,
    userNotes: params.userNotes,
    previousProposal,
    iteration: params.iteration,
    thoroughness: params.thoroughness,
    finalize: params.finalize,
  });

  const gen = runQueryStream({
    prompt,
    allowedTools: PHASE_AGENTS.analyze.tools,
    cwd: params.repoPath,
    tracker: params.tracker,
    model: params.model,
    effort: params.effort,
    queryFn: params.queryFn,
    abortSignal: params.abortSignal,
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

  const proposalPath = await writeProposal(params.repoPath, finalText);
  return { proposalPath, proposalMarkdown: finalText, tokensUsed, durationMs };
}

export async function analyze(params: AnalyzeParams): Promise<AnalyzeResult> {
  const gen = analyzeStream(params);
  for (;;) {
    const next = await gen.next();
    if (next.done) return next.value;
  }
}
