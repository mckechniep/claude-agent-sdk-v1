import type { LogEvent, RunConfig, RunManifest } from "./runTypes";

export type AuthMode = "api" | "subscription";
export type Thoroughness = "thorough" | "balanced" | "fast";

export interface AuthStatus {
  apiKeyDetected: boolean;
  subscriptionDetected: boolean;
  preferredAuthMode: AuthMode | null;
  apiKeyPersisted?: boolean;
}

export interface RunSummary {
  runId: string;
  createdAt: string;
  status: string;
  authMode: AuthMode;
  repoCount: number;
  tokensUsed: number;
}

export interface RunsResponse {
  stateRoot: string;
  runs: RunSummary[];
}

export type SmokeEvent =
  | { type: "started"; mode: AuthMode; ts: number }
  | { type: "progress"; durationMs: number }
  | { type: "sdk_message"; subtype: string; summary: string; ts: number }
  | {
      type: "done";
      ok: true;
      mode: AuthMode;
      response: string;
      tokensUsed: number;
      durationMs: number;
    }
  | { type: "error"; ok: false; mode: AuthMode; message: string };

export interface StreamHandle {
  close: () => void;
}

export type StackId = "jsts" | "python" | "generic";

export interface DiscoveredRepo {
  path: string;
  name: string;
  stack: StackId;
  hasReadme: boolean;
  hasTests: boolean;
  lastCommitDate: string | null;
  isDirty: boolean;
}

export type DiscoverEvent =
  | { type: "started"; path: string; depth: number; ts: number }
  | { type: "progress"; durationMs: number }
  | { type: "repo"; repo: DiscoveredRepo }
  | { type: "done"; count: number; durationMs: number }
  | { type: "error"; message: string };

export type AnalyzeEvent =
  | {
      type: "started";
      repoPath: string;
      repoName: string;
      stack: StackId;
      mode: AuthMode;
      ts: number;
    }
  | { type: "progress"; durationMs: number }
  | { type: "sdk_message"; subtype: string; summary: string; ts: number }
  | {
      type: "done";
      ok: true;
      proposalPath: string;
      proposalMarkdown: string;
      tokensUsed: number;
      durationMs: number;
    }
  | { type: "error"; ok: false; message: string };

export type PlanEvent =
  | {
      type: "started";
      repoPath: string;
      repoName: string;
      stack: StackId;
      mode: AuthMode;
      ts: number;
    }
  | { type: "progress"; durationMs: number }
  | { type: "sdk_message"; subtype: string; summary: string; ts: number }
  | {
      type: "done";
      ok: true;
      planPath: string;
      planMarkdown: string;
      taskCount: number;
      estimatedTokens: number;
      estimatedDurationMs: number;
      tokensUsed: number;
      durationMs: number;
    }
  | { type: "error"; ok: false; message: string };

// Run lifecycle types -----------------------------------------------------

export type ProposalAction = "accept" | "reject" | "reanalyze";
export type PlanAction = "accept" | "reject" | "replan";

export interface StepDecisions {
  proposals?: Record<string, ProposalAction>;
  plans?: Record<string, PlanAction>;
  runConfirmed?: boolean;
}

export interface StartRunBody {
  config: RunConfig;
  authMode: AuthMode;
  selectedRepos: DiscoveredRepo[];
}

export interface StartRunResponse {
  runId: string;
  manifest: RunManifest;
}

export interface ManifestResponse {
  manifest: RunManifest;
  loopActive: boolean;
  // ISO timestamp of the most recent heartbeat, or null if the run has
  // never had a background loop (e.g. manual autonomy) or pre-heartbeat.
  lastHeartbeatAt: string | null;
}

export interface LogReplayResponse {
  events: LogEvent[];
  nextByte: number;
}

export interface StepRunResponse {
  manifest: RunManifest;
}

export interface SubmitDecisionsResponse {
  ok: true;
  runId: string;
  pending: StepDecisions;
}

export interface ResumeRunResponse {
  runId: string;
  manifest: RunManifest;
}

export type StopMode = "soft" | "force";

export interface StopRunResponse {
  runId: string;
  mode: StopMode;
  loopWasActive: boolean;
  stopped: boolean;
}

export interface RunLogStreamHandlers {
  onTail?: (payload: { events: LogEvent[]; nextByte: number }) => void;
  onIdle?: (payload: { nextByte: number; fileExists: boolean }) => void;
  onError?: (message: string) => void;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}));
    const errMsg =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(errMsg);
  }
  return (await res.json()) as T;
}

export const api = {
  authStatus: () => fetch("/api/auth/status").then(json<AuthStatus>),
  setAuthMode: (mode: AuthMode | null) =>
    fetch("/api/auth/mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    }).then(json<{ preferredAuthMode: AuthMode | null }>),
  setApiKey: (key: string, persist = true) =>
    fetch("/api/auth/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, persist }),
    }).then(json<{ apiKeyDetected: boolean; apiKeyPersisted: boolean }>),
  clearApiKey: () =>
    fetch("/api/auth/key", { method: "DELETE" }).then(
      json<{ apiKeyDetected: boolean; apiKeyPersisted: boolean }>,
    ),
  listRuns: () => fetch("/api/runs").then(json<RunsResponse>),
  approveProposal: (args: { repoPath: string; proposalPath: string }) =>
    fetch("/api/analyze/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }).then(json<{ ok: true; markerPath: string }>),
  getApproval: (repoPath: string) =>
    fetch(`/api/analyze/approval?repoPath=${encodeURIComponent(repoPath)}`).then(
      json<{ approval: { approvedAt: string; proposalPath: string } | null }>,
    ),
  approvePlan: (args: { repoPath: string; planPath: string; taskCount: number }) =>
    fetch("/api/plan/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }).then(json<{ ok: true; markerPath: string }>),
  getPlanApproval: (repoPath: string) =>
    fetch(`/api/plan/approval?repoPath=${encodeURIComponent(repoPath)}`).then(
      json<{
        approval: { approvedAt: string; planPath: string; taskCount: number } | null;
      }>,
    ),
  streamSmoke(mode: AuthMode, onEvent: (event: SmokeEvent) => void): StreamHandle {
    const es = new EventSource(`/api/smoke/stream?mode=${encodeURIComponent(mode)}`);
    const dispatch = (eventName: SmokeEvent["type"]) => (msg: MessageEvent<string>) => {
      try {
        const data = JSON.parse(msg.data) as Record<string, unknown>;
        onEvent({ type: eventName, ...data } as SmokeEvent);
      } catch {
        // skip malformed payloads
      }
    };
    es.addEventListener("started", dispatch("started"));
    es.addEventListener("progress", dispatch("progress"));
    es.addEventListener("sdk_message", dispatch("sdk_message"));
    es.addEventListener("done", (msg: MessageEvent<string>) => {
      dispatch("done")(msg);
      es.close();
    });
    es.addEventListener("error", (msg: Event) => {
      if (msg instanceof MessageEvent && typeof msg.data === "string") {
        dispatch("error")(msg);
      } else {
        onEvent({ type: "error", ok: false, mode, message: "stream disconnected" });
      }
      es.close();
    });
    return { close: () => es.close() };
  },
  streamAnalyze(
    args: {
      repoPath: string;
      mode: AuthMode;
      userNotes?: string;
      iteration?: number;
      thoroughness?: Thoroughness;
    },
    onEvent: (event: AnalyzeEvent) => void,
  ): StreamHandle {
    const q = new URLSearchParams({ repoPath: args.repoPath, mode: args.mode });
    if (args.userNotes && args.userNotes.trim().length > 0) {
      q.set("userNotes", args.userNotes);
    }
    if (args.iteration && args.iteration > 1) q.set("iteration", String(args.iteration));
    if (args.thoroughness) q.set("thoroughness", args.thoroughness);
    const es = new EventSource(`/api/analyze/stream?${q.toString()}`);
    const safeParse = (msg: MessageEvent<string>): Record<string, unknown> | null => {
      try {
        return JSON.parse(msg.data) as Record<string, unknown>;
      } catch {
        return null;
      }
    };
    es.addEventListener("started", (msg: MessageEvent<string>) => {
      const data = safeParse(msg);
      if (data) onEvent({ type: "started", ...data } as AnalyzeEvent);
    });
    es.addEventListener("progress", (msg: MessageEvent<string>) => {
      const data = safeParse(msg);
      if (data) onEvent({ type: "progress", ...data } as AnalyzeEvent);
    });
    es.addEventListener("sdk_message", (msg: MessageEvent<string>) => {
      const data = safeParse(msg);
      if (data) onEvent({ type: "sdk_message", ...data } as AnalyzeEvent);
    });
    es.addEventListener("done", (msg: MessageEvent<string>) => {
      const data = safeParse(msg);
      if (data) onEvent({ type: "done", ...data } as AnalyzeEvent);
      es.close();
    });
    es.addEventListener("error", (msg: Event) => {
      if (msg instanceof MessageEvent && typeof msg.data === "string") {
        const data = safeParse(msg);
        if (data) onEvent({ type: "error", ok: false, message: String(data.message ?? "stream error") });
      } else {
        onEvent({ type: "error", ok: false, message: "stream disconnected" });
      }
      es.close();
    });
    return { close: () => es.close() };
  },
  streamPlan(
    args: {
      repoPath: string;
      mode: AuthMode;
      userNotes?: string;
      iteration?: number;
      thoroughness?: Thoroughness;
    },
    onEvent: (event: PlanEvent) => void,
  ): StreamHandle {
    const q = new URLSearchParams({ repoPath: args.repoPath, mode: args.mode });
    if (args.userNotes && args.userNotes.trim().length > 0) {
      q.set("userNotes", args.userNotes);
    }
    if (args.iteration && args.iteration > 1) q.set("iteration", String(args.iteration));
    if (args.thoroughness) q.set("thoroughness", args.thoroughness);
    const es = new EventSource(`/api/plan/stream?${q.toString()}`);
    const safeParse = (msg: MessageEvent<string>): Record<string, unknown> | null => {
      try {
        return JSON.parse(msg.data) as Record<string, unknown>;
      } catch {
        return null;
      }
    };
    es.addEventListener("started", (msg: MessageEvent<string>) => {
      const data = safeParse(msg);
      if (data) onEvent({ type: "started", ...data } as PlanEvent);
    });
    es.addEventListener("progress", (msg: MessageEvent<string>) => {
      const data = safeParse(msg);
      if (data) onEvent({ type: "progress", ...data } as PlanEvent);
    });
    es.addEventListener("sdk_message", (msg: MessageEvent<string>) => {
      const data = safeParse(msg);
      if (data) onEvent({ type: "sdk_message", ...data } as PlanEvent);
    });
    es.addEventListener("done", (msg: MessageEvent<string>) => {
      const data = safeParse(msg);
      if (data) onEvent({ type: "done", ...data } as PlanEvent);
      es.close();
    });
    es.addEventListener("error", (msg: Event) => {
      if (msg instanceof MessageEvent && typeof msg.data === "string") {
        const data = safeParse(msg);
        if (data)
          onEvent({ type: "error", ok: false, message: String(data.message ?? "stream error") });
      } else {
        onEvent({ type: "error", ok: false, message: "stream disconnected" });
      }
      es.close();
    });
    return { close: () => es.close() };
  },
  // Run lifecycle -------------------------------------------------------

  startRun: (body: StartRunBody) =>
    fetch("/api/run/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<StartRunResponse>),

  stepRun: (runId: string, decisions?: StepDecisions) =>
    fetch(`/api/run/${encodeURIComponent(runId)}/step`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(decisions ? { decisions } : {}),
    }).then(json<StepRunResponse>),

  submitDecisions: (runId: string, decisions: StepDecisions) =>
    fetch(`/api/run/${encodeURIComponent(runId)}/decisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(decisions),
    }).then(json<SubmitDecisionsResponse>),

  getManifest: (runId: string) =>
    fetch(`/api/run/${encodeURIComponent(runId)}/manifest`).then(json<ManifestResponse>),

  resumeRun: (runId: string) =>
    fetch(`/api/run/${encodeURIComponent(runId)}/resume`, { method: "POST" }).then(
      json<ResumeRunResponse>,
    ),

  stopRun: (runId: string, mode: StopMode = "soft") =>
    fetch(`/api/run/${encodeURIComponent(runId)}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    }).then(json<StopRunResponse>),

  recoverRun: (runId: string) =>
    fetch(`/api/run/${encodeURIComponent(runId)}/recover`, { method: "POST" }).then(
      json<{ runId: string; previousStatus: string; lastHeartbeatAt: string | null }>,
    ),

  retryFromFailure: (runId: string) =>
    fetch(`/api/run/${encodeURIComponent(runId)}/retry-from-failure`, { method: "POST" }).then(
      json<{
        runId: string;
        manifest: RunManifest;
        repoCount: number;
        taskCount: number;
        loopStarted: boolean;
      }>,
    ),

  getRunLog: (runId: string, fromByte = 0) =>
    fetch(
      `/api/run/${encodeURIComponent(runId)}/log?fromByte=${encodeURIComponent(String(fromByte))}`,
    ).then(json<LogReplayResponse>),

  getRepoArtifacts: (runId: string, repoPath: string) =>
    fetch(
      `/api/run/${encodeURIComponent(runId)}/repo-artifacts?repoPath=${encodeURIComponent(repoPath)}`,
    ).then(
      json<{
        proposalMarkdown: string | null;
        planMarkdown: string | null;
        proposalApproval: { approvedAt: string; proposalPath: string } | null;
        planApproval: { approvedAt: string; planPath: string; taskCount: number } | null;
      }>,
    ),

  streamRunLog(
    runId: string,
    fromByte: number,
    handlers: RunLogStreamHandlers,
  ): StreamHandle {
    const q = new URLSearchParams({ fromByte: String(fromByte) });
    const es = new EventSource(
      `/api/run/${encodeURIComponent(runId)}/log/stream?${q.toString()}`,
    );
    const safeParse = (msg: MessageEvent<string>): unknown | null => {
      try {
        return JSON.parse(msg.data);
      } catch {
        return null;
      }
    };
    es.addEventListener("tail", (msg: MessageEvent<string>) => {
      const data = safeParse(msg) as { events: LogEvent[]; nextByte: number } | null;
      if (data && handlers.onTail) handlers.onTail(data);
    });
    es.addEventListener("idle", (msg: MessageEvent<string>) => {
      const data = safeParse(msg) as { nextByte: number; fileExists: boolean } | null;
      if (data && handlers.onIdle) handlers.onIdle(data);
    });
    es.addEventListener("error", (msg: Event) => {
      if (msg instanceof MessageEvent && typeof msg.data === "string") {
        const data = safeParse(msg) as { message?: string } | null;
        if (handlers.onError) handlers.onError(String(data?.message ?? "stream error"));
      } else if (handlers.onError) {
        handlers.onError("stream disconnected");
      }
      es.close();
    });
    return { close: () => es.close() };
  },

  streamDiscover(
    args: { path: string; depth?: number; exclude?: string[] },
    onEvent: (event: DiscoverEvent) => void,
  ): StreamHandle {
    const q = new URLSearchParams({ path: args.path });
    if (args.depth !== undefined) q.set("depth", String(args.depth));
    if (args.exclude && args.exclude.length > 0) q.set("exclude", args.exclude.join(","));
    const es = new EventSource(`/api/discover/stream?${q.toString()}`);
    const safeParse = (msg: MessageEvent<string>): Record<string, unknown> | null => {
      try {
        return JSON.parse(msg.data) as Record<string, unknown>;
      } catch {
        return null;
      }
    };
    es.addEventListener("started", (msg: MessageEvent<string>) => {
      const data = safeParse(msg);
      if (data) onEvent({ type: "started", ...data } as DiscoverEvent);
    });
    es.addEventListener("progress", (msg: MessageEvent<string>) => {
      const data = safeParse(msg);
      if (data) onEvent({ type: "progress", ...data } as DiscoverEvent);
    });
    es.addEventListener("repo", (msg: MessageEvent<string>) => {
      const data = safeParse(msg);
      if (data) onEvent({ type: "repo", repo: data as unknown as DiscoveredRepo });
    });
    es.addEventListener("done", (msg: MessageEvent<string>) => {
      const data = safeParse(msg);
      if (data) onEvent({ type: "done", ...data } as DiscoverEvent);
      es.close();
    });
    es.addEventListener("error", (msg: Event) => {
      if (msg instanceof MessageEvent && typeof msg.data === "string") {
        const data = safeParse(msg);
        if (data) onEvent({ type: "error", message: String(data.message ?? "stream error") });
      } else {
        onEvent({ type: "error", message: "stream disconnected" });
      }
      es.close();
    });
    return { close: () => es.close() };
  },
};
