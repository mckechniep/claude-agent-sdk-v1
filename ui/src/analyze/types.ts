import type { Thoroughness } from "../api";

export interface MessageEntry {
  id: number;
  subtype: string;
  summary: string;
  ts: number;
}

export type AnalyzeState =
  | { phase: "idle" }
  | { phase: "running"; repoPath: string; repoName: string; elapsedMs: number; messages: MessageEntry[]; previousNotes?: string }
  | {
      phase: "done";
      repoPath: string;
      repoName: string;
      messages: MessageEntry[];
      proposalPath: string;
      proposalMarkdown: string;
      tokensUsed: number;
      durationMs: number;
      approvedAt: string | null;
      previousNotes?: string;
    }
  | { phase: "error"; repoPath: string; repoName: string; message: string; messages: MessageEntry[] };

export type PlanState =
  | { phase: "idle" }
  | { phase: "running"; repoPath: string; repoName: string; elapsedMs: number; messages: MessageEntry[]; previousNotes?: string }
  | {
      phase: "done";
      repoPath: string;
      repoName: string;
      messages: MessageEntry[];
      planPath: string;
      planMarkdown: string;
      taskCount: number;
      estimatedTokens: number;
      estimatedDurationMs: number;
      tokensUsed: number;
      durationMs: number;
      approvedAt: string | null;
      previousNotes?: string;
    }
  | { phase: "error"; repoPath: string; repoName: string; message: string; messages: MessageEntry[] };

/** Per-repo analyze+plan bundle. The unified surface keeps one of these per
 *  repoPath so analyzing repo B never discards repo A's proposal. */
export interface RepoFlow {
  analyze: AnalyzeState;
  plan: PlanState;
  analyzeIteration: number;
  planIteration: number;
  thoroughness: Thoroughness;
}

export function emptyRepoFlow(): RepoFlow {
  return { analyze: { phase: "idle" }, plan: { phase: "idle" }, analyzeIteration: 1, planIteration: 1, thoroughness: "balanced" };
}
