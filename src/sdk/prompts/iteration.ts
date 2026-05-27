// Iteration-aware prompt helpers — used by analyze + plan to throttle the
// model's habit of inventing fresh "open questions" forever. The mode the
// helper picks is injected into the prompt as an instruction block; the
// model then knows whether to keep probing, narrow its questions, or
// commit to defaults.

export type Thoroughness = "thorough" | "balanced" | "fast";
export type IterationMode = "normal" | "narrow" | "defaults";

interface Thresholds {
  narrow: number;
  defaults: number;
}

// Mode boundaries per thoroughness. `narrow` is the first iteration at
// which narrowing kicks in; `defaults` is the first iteration at which the
// model is asked to commit to RECOMMENDED defaults rather than ask further.
const THRESHOLDS: Record<Thoroughness, Thresholds> = {
  thorough: { narrow: 4, defaults: 6 },
  balanced: { narrow: 3, defaults: 5 },
  fast: { narrow: 2, defaults: 3 },
};

export function computeIterationMode(iteration: number, thoroughness: Thoroughness): IterationMode {
  const t = THRESHOLDS[thoroughness];
  if (iteration >= t.defaults) return "defaults";
  if (iteration >= t.narrow) return "narrow";
  return "normal";
}

export function nextModeAt(thoroughness: Thoroughness): Thresholds {
  return THRESHOLDS[thoroughness];
}

// Renders the mode-specific instruction block injected into the analyze
// prompt's body. The analyzer's required output section 5 is "Open
// questions" — we steer how that section behaves per mode.
export function renderAnalyzeModeBlock(iteration: number, thoroughness: Thoroughness): string {
  const mode = computeIterationMode(iteration, thoroughness);
  const header = `\n## Iteration ${iteration} guidance (${thoroughness}, mode: ${mode})\n`;
  switch (mode) {
    case "normal":
      return (
        header +
        `\nThis is an early iteration. Produce the full proposal as usual; in section 5 list any genuine ambiguities you would want the user to clarify. If you have no remaining questions, write "None." — do not invent questions to fill the section.\n`
      );
    case "narrow":
      return (
        header +
        `\nThis is a mid-loop iteration. The user has already answered earlier rounds. In section 5:\n\n- Do NOT re-ask questions the user has already addressed in their notes — read those carefully.\n- Do NOT invent new angles on points the user has already settled.\n- Only list questions that are STILL load-bearing after considering all prior notes. Be specific about what evidence would resolve each.\n- If nothing genuinely remains, write "None — proposal is ready for approval."\n\nThe user is signaling that they want to converge. Help them.\n`
      );
    case "defaults":
      return (
        header +
        `\nThis is a late iteration. The user is ready to commit. For section 5, REPLACE the "Open questions" header with "Recommended defaults" and follow this rule:\n\n- For any remaining ambiguity, take a position. Write each as: \`**[topic]** → [your default choice] · rationale: [one short line]\`.\n- These defaults will be locked into the proposal unless the user overrides them in their next reply.\n- If you have no remaining ambiguity, write "None — proposal is ready for approval as-is."\n- Do NOT ask further open questions. Make a call.\n\nThis is the convergence step. The user has signaled they want defaults, not more probing.\n`
      );
  }
}

// Renders the mode-specific instruction block injected into the plan
// prompt's body. The planner's output is structured (tasks), so the mode
// affects HOW it refines rather than a specific section.
export function renderPlanModeBlock(iteration: number, thoroughness: Thoroughness): string {
  const mode = computeIterationMode(iteration, thoroughness);
  const header = `\n## Iteration ${iteration} guidance (${thoroughness}, mode: ${mode})\n`;
  switch (mode) {
    case "normal":
      return (
        header +
        `\nThis is an early iteration. Produce the plan; if the user's notes ask for changes, apply them. If the proposal has genuine ambiguity about HOW to slice tasks, you may include a brief "## Open questions" section at the end of the plan to surface them.\n`
      );
    case "narrow":
      return (
        header +
        `\nThis is a mid-loop iteration. The user has already given feedback. Focus on:\n\n- Applying the user's most recent notes precisely.\n- NOT restructuring tasks the user did not ask to change.\n- Preserving task UUIDs for tasks the user did not touch.\n- If you append an "Open questions" section, it must contain ONLY questions the user has not addressed — no rehashing.\n- If nothing genuinely remains uncertain, omit the "Open questions" section entirely.\n`
      );
    case "defaults":
      return (
        header +
        `\nThis is a late iteration. The user is ready to commit. Rules:\n\n- Apply the user's notes precisely.\n- Make small, targeted edits — not wholesale restructures.\n- Preserve as many existing task UUIDs as possible.\n- Do NOT include an "Open questions" section. If any ambiguity is still load-bearing, decide it yourself and add a short "## Decisions made on your behalf" section at the end: one line per decision, e.g. \`**[topic]** → [your choice] · rationale: [one line]\`. The user will override in their next reply if they disagree.\n- This is convergence. Stop probing.\n`
      );
  }
}
