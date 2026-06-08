import { useEffect, useState } from "react";

// Hash-based route descriptor. Lightweight enough to avoid pulling in
// react-router for v0.1's three routes. If the route surface grows past
// ~6 routes, swap this out.
export type Route =
  | { kind: "home" }
  | { kind: "new-run" }
  | { kind: "run-dashboard"; runId: string };

const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function parseHash(hash: string): Route {
  // location.hash includes the leading "#"; strip it before matching.
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const qIdx = raw.indexOf("?");
  const path = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
  const queryStr = qIdx >= 0 ? raw.slice(qIdx + 1) : "";
  const params = new URLSearchParams(queryStr);

  if (path === "/runs/new") return { kind: "new-run" };
  const runMatch = path.match(/^\/runs\/([^/]+)$/);
  if (runMatch && runMatch[1] && ULID_REGEX.test(runMatch[1])) {
    return { kind: "run-dashboard", runId: runMatch[1] };
  }

  // The home scanner that refine deep-links used to target was removed in the
  // IA consolidation; a valid refine link now opens the run surface, where
  // analysis happens inline per repo.
  const refineKind = params.get("refine");
  const refinePath = params.get("repoPath");
  if ((refineKind === "analyze" || refineKind === "plan") && refinePath) {
    return { kind: "new-run" };
  }

  return { kind: "home" };
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const handler = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  return route;
}

// Programmatic navigation. Setting hash fires hashchange so the hook
// reacts; falls back to no-op outside the browser (SSR / test env).
export function navigate(path: string): void {
  if (typeof window === "undefined") return;
  window.location.hash = path;
}
