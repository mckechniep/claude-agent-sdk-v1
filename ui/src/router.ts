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
  const path = hash.startsWith("#") ? hash.slice(1) : hash;
  if (path === "/runs/new") return { kind: "new-run" };
  const runMatch = path.match(/^\/runs\/([^/]+)$/);
  if (runMatch && runMatch[1] && ULID_REGEX.test(runMatch[1])) {
    return { kind: "run-dashboard", runId: runMatch[1] };
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
