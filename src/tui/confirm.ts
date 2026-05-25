import { confirm, select, editor, input } from "@inquirer/prompts";

export async function confirmPrompt(message: string, defaultYes = true): Promise<boolean> {
  return confirm({ message, default: defaultYes });
}

export type ProposalAction = "accept" | "reject" | "reanalyze";

export async function proposalGate(): Promise<ProposalAction> {
  return select<ProposalAction>({
    message: "Completion proposal — what would you like to do?",
    choices: [
      { name: "Accept and proceed to planning", value: "accept" },
      { name: "Reject (skip this repo)", value: "reject" },
      { name: "Re-analyze with my notes", value: "reanalyze" },
    ],
  });
}

export type PlanAction = "accept" | "reject" | "replan";

export async function planGate(): Promise<PlanAction> {
  return select<PlanAction>({
    message: "Plan — what would you like to do?",
    choices: [
      { name: "Accept and proceed to execution", value: "accept" },
      { name: "Reject (skip this repo)", value: "reject" },
      { name: "Replan with my notes", value: "replan" },
    ],
  });
}

export async function captureNotes(prompt: string): Promise<string> {
  return editor({ message: prompt, postfix: ".md" });
}

export async function shortText(message: string): Promise<string> {
  return input({ message });
}
