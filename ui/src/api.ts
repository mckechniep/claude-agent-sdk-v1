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

export interface SmokeResult {
  ok: boolean;
  mode: AuthMode;
  response?: string;
  tokensUsed?: number;
  durationMs?: number;
  error?: string;
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
  listRuns: () => fetch("/api/runs").then(json<RunsResponse>),
  smoke: (mode: AuthMode) =>
    fetch("/api/smoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    }).then(json<SmokeResult>),
};
