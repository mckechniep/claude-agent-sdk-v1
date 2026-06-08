import { useReducer, useRef } from "react";
import { api, type AuthMode, type DiscoveredRepo, type Thoroughness } from "../api";
import { buildPhaseOverride } from "../modelDefaults";
import type { PhaseSelections } from "../modelConfig";
import { flowReducer, type FlowState } from "./reducer";
import { emptyRepoFlow, type RepoFlow } from "./types";

interface Args {
  mode: AuthMode | null;
  defaults: PhaseSelections;
}

export interface AnalyzeFlow {
  get: (repoPath: string) => RepoFlow;
  analyze: (repo: DiscoveredRepo, userNotes?: string) => void;
  proceedWithAnswers: (repo: DiscoveredRepo, userNotes: string) => void;
  approve: (repo: DiscoveredRepo) => void;
  plan: (repo: DiscoveredRepo, userNotes?: string) => void;
  approvePlan: (repo: DiscoveredRepo, taskCount: number) => void;
  close: (repoPath: string) => void;
  setThoroughness: (repoPath: string, t: Thoroughness) => void;
}

export function useAnalyzeFlow({ mode, defaults }: Args): AnalyzeFlow {
  const [state, dispatch] = useReducer(flowReducer, {} as FlowState);
  // One stream per repoPath so concurrent-repo guards are explicit.
  const streams = useRef<Map<string, { close: () => void }>>(new Map());
  const thoroughness = useRef<Map<string, Thoroughness>>(new Map());
  const autoApprove = useRef<Set<string>>(new Set());

  const startAnalyze = (repo: DiscoveredRepo, userNotes: string | undefined, finalize: boolean, iteration: number) => {
    if (!mode) return;
    streams.current.get(repo.path)?.close();
    dispatch({ type: "analyze-start", repoPath: repo.path, repoName: repo.name, iteration, ...(userNotes ? { userNotes } : {}) });
    if (finalize) autoApprove.current.add(repo.path);
    else autoApprove.current.delete(repo.path);
    const handle = api.streamAnalyze(
      {
        repoPath: repo.path,
        mode,
        userNotes,
        iteration,
        thoroughness: thoroughness.current.get(repo.path) ?? "balanced",
        ...buildPhaseOverride(defaults.analyze),
        ...(finalize ? { finalize: true } : {}),
      },
      (event) => {
        dispatch({ type: "analyze-event", repoPath: repo.path, repoName: repo.name, event });
        if (event.type === "done" && autoApprove.current.has(repo.path)) {
          autoApprove.current.delete(repo.path);
          void api
            .approveProposal({ repoPath: repo.path, proposalPath: event.proposalPath })
            .then(() => dispatch({ type: "approve-proposal", repoPath: repo.path, at: new Date().toISOString() }));
        }
      },
    );
    streams.current.set(repo.path, handle);
  };

  return {
    get: (repoPath) => state[repoPath] ?? emptyRepoFlow(),
    analyze: (repo, userNotes) =>
      startAnalyze(repo, userNotes, false, userNotes ? (state[repo.path]?.analyzeIteration ?? 1) + 1 : 1),
    proceedWithAnswers: (repo, userNotes) =>
      startAnalyze(repo, userNotes, true, (state[repo.path]?.analyzeIteration ?? 1) + 1),
    approve: (repo) => {
      const f = state[repo.path];
      if (f?.analyze.phase !== "done") return;
      void api
        .approveProposal({ repoPath: repo.path, proposalPath: f.analyze.proposalPath })
        .then(() => dispatch({ type: "approve-proposal", repoPath: repo.path, at: new Date().toISOString() }));
    },
    plan: (repo, userNotes) => {
      if (!mode) return;
      const iter = userNotes ? (state[repo.path]?.planIteration ?? 1) + 1 : 1;
      dispatch({ type: "plan-start", repoPath: repo.path, repoName: repo.name, iteration: iter, ...(userNotes ? { userNotes } : {}) });
      const handle = api.streamPlan(
        {
          repoPath: repo.path,
          mode,
          userNotes,
          iteration: iter,
          thoroughness: thoroughness.current.get(repo.path) ?? "balanced",
          ...buildPhaseOverride(defaults.plan),
        },
        (event) => dispatch({ type: "plan-event", repoPath: repo.path, repoName: repo.name, event }),
      );
      streams.current.set(repo.path + "#plan", handle);
    },
    approvePlan: (repo, taskCount) => {
      const f = state[repo.path];
      if (f?.plan.phase !== "done") return;
      void api
        .approvePlan({ repoPath: repo.path, planPath: f.plan.planPath, taskCount })
        .then(() => dispatch({ type: "approve-plan", repoPath: repo.path, at: new Date().toISOString() }));
    },
    close: (repoPath) => {
      streams.current.get(repoPath)?.close();
      streams.current.get(repoPath + "#plan")?.close();
      dispatch({ type: "close", repoPath });
    },
    setThoroughness: (repoPath, t) => thoroughness.current.set(repoPath, t),
  };
}
