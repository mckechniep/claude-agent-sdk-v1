import type { AnalyzeEvent, PlanEvent } from "../api";
import { emptyRepoFlow, type AnalyzeState, type MessageEntry, type PlanState, type RepoFlow } from "./types";

export type FlowState = Record<string, RepoFlow>;

export type FlowAction =
  | { type: "analyze-start"; repoPath: string; repoName: string; iteration: number; userNotes?: string }
  | { type: "analyze-event"; repoPath: string; repoName: string; event: AnalyzeEvent }
  | { type: "approve-proposal"; repoPath: string; at: string }
  | { type: "plan-start"; repoPath: string; repoName: string; iteration: number; userNotes?: string }
  | { type: "plan-event"; repoPath: string; repoName: string; event: PlanEvent }
  | { type: "approve-plan"; repoPath: string; at: string }
  | { type: "close"; repoPath: string };

function msg(messages: MessageEntry[], subtype: string, summary: string, ts: number): MessageEntry[] {
  return [...messages, { id: messages.length, subtype, summary, ts }];
}

function reduceAnalyze(prev: AnalyzeState, event: AnalyzeEvent, repoName: string): AnalyzeState {
  switch (event.type) {
    case "started":
      return { phase: "running", repoPath: event.repoPath, repoName: event.repoName, elapsedMs: 0, messages: [] };
    case "progress":
      return prev.phase === "running" ? { ...prev, elapsedMs: event.durationMs } : prev;
    case "sdk_message":
      return prev.phase === "running" ? { ...prev, messages: msg(prev.messages, event.subtype, event.summary, event.ts) } : prev;
    case "done":
      if (prev.phase !== "running") return prev;
      return {
        phase: "done",
        repoPath: prev.repoPath,
        repoName: prev.repoName,
        messages: prev.messages,
        proposalPath: event.proposalPath,
        proposalMarkdown: event.proposalMarkdown,
        tokensUsed: event.tokensUsed,
        durationMs: event.durationMs,
        approvedAt: null,
        ...(prev.previousNotes ? { previousNotes: prev.previousNotes } : {}),
      };
    case "error": {
      const messages = prev.phase === "running" ? prev.messages : prev.phase === "done" ? prev.messages : [];
      const repoPath = prev.phase !== "idle" ? prev.repoPath : "";
      return { phase: "error", repoPath, repoName, message: event.message, messages };
    }
  }
}

function reducePlan(prev: PlanState, event: PlanEvent, repoName: string): PlanState {
  switch (event.type) {
    case "started":
      return { phase: "running", repoPath: event.repoPath, repoName: event.repoName, elapsedMs: 0, messages: [] };
    case "progress":
      return prev.phase === "running" ? { ...prev, elapsedMs: event.durationMs } : prev;
    case "sdk_message":
      return prev.phase === "running" ? { ...prev, messages: msg(prev.messages, event.subtype, event.summary, event.ts) } : prev;
    case "done":
      if (prev.phase !== "running") return prev;
      return {
        phase: "done",
        repoPath: prev.repoPath,
        repoName: prev.repoName,
        messages: prev.messages,
        planPath: event.planPath,
        planMarkdown: event.planMarkdown,
        taskCount: event.taskCount,
        estimatedTokens: event.estimatedTokens,
        estimatedDurationMs: event.estimatedDurationMs,
        tokensUsed: event.tokensUsed,
        durationMs: event.durationMs,
        approvedAt: null,
        ...(prev.previousNotes ? { previousNotes: prev.previousNotes } : {}),
      };
    case "error": {
      const messages = prev.phase === "running" ? prev.messages : prev.phase === "done" ? prev.messages : [];
      const repoPath = prev.phase !== "idle" ? prev.repoPath : "";
      return { phase: "error", repoPath, repoName, message: event.message, messages };
    }
  }
}

/** Reduce one action against the keyed flow state. Unknown repoPath keys are
 *  created lazily so the UI can dispatch before seeding. */
export function flowReducer(state: FlowState, action: FlowAction): FlowState {
  const cur = state[action.repoPath] ?? emptyRepoFlow();
  switch (action.type) {
    case "analyze-start":
      return {
        ...state,
        [action.repoPath]: {
          ...cur,
          analyzeIteration: action.iteration,
          planIteration: 1,
          analyze: {
            phase: "running",
            repoPath: action.repoPath,
            repoName: action.repoName,
            elapsedMs: 0,
            messages: [],
            ...(action.userNotes ? { previousNotes: action.userNotes } : {}),
          },
          plan: { phase: "idle" },
        },
      };
    case "analyze-event":
      return { ...state, [action.repoPath]: { ...cur, analyze: reduceAnalyze(cur.analyze, action.event, action.repoName) } };
    case "approve-proposal":
      return cur.analyze.phase === "done"
        ? { ...state, [action.repoPath]: { ...cur, analyze: { ...cur.analyze, approvedAt: action.at } } }
        : state;
    case "plan-start":
      return {
        ...state,
        [action.repoPath]: {
          ...cur,
          planIteration: action.iteration,
          plan: {
            phase: "running",
            repoPath: action.repoPath,
            repoName: action.repoName,
            elapsedMs: 0,
            messages: [],
            ...(action.userNotes ? { previousNotes: action.userNotes } : {}),
          },
        },
      };
    case "plan-event":
      return { ...state, [action.repoPath]: { ...cur, plan: reducePlan(cur.plan, action.event, action.repoName) } };
    case "approve-plan":
      return cur.plan.phase === "done"
        ? { ...state, [action.repoPath]: { ...cur, plan: { ...cur.plan, approvedAt: action.at } } }
        : state;
    case "close":
      return { ...state, [action.repoPath]: emptyRepoFlow() };
  }
}
