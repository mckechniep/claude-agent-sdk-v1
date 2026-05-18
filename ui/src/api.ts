export type AuthMode = "api" | "subscription";

export interface AuthStatus {
  apiKeyDetected: boolean;
  subscriptionDetected: boolean;
  preferredAuthMode: AuthMode | null;
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
  listRuns: () => fetch("/api/runs").then(json<RunsResponse>),
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
