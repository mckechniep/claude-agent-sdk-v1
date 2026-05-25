import type { RunManifest } from "../types.js";

export function renderRunSummary(m: RunManifest): string {
  const lines: string[] = [];
  lines.push(`Run ${m.runId} ${m.status} — created ${m.createdAt}`);
  for (const repo of m.repos) {
    const sym = repoSymbol(repo.status);
    const counts = repo.taskState
      ? ` ${repo.taskState.filter((t) => t.status === "completed").length}/${repo.taskState.length} tasks`
      : "";
    lines.push(`  ${sym} ${repo.name.padEnd(28)} ${repo.status}${counts}`);
  }
  lines.push(`Tokens: ${m.budget.tokensUsed.toLocaleString()}`);
  return lines.join("\n");
}

export function repoSymbol(status: string): string {
  switch (status) {
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "skipped":
      return "⊘";
    default:
      return "•";
  }
}
