import type { BudgetTracker } from "../orchestrator/budget.js";

export interface QueryParams {
  prompt: string;
  allowedTools: string[];
  cwd: string;
  tracker: BudgetTracker;
  model?: string;
  systemPrompt?: string;
  queryFn?: AsyncGeneratorFn;
}

export interface QueryResult {
  messages: unknown[];
  finalText: string;
  tokensUsed: number;
  durationMs: number;
}

type AsyncGeneratorFn = (args: unknown) => AsyncGenerator<{
  type: string;
  message?: { content: Array<{ type: string; text?: string }> };
  result?: string;
  usage?: { input_tokens: number; output_tokens: number };
}>;

let cachedSdkQuery: AsyncGeneratorFn | null = null;
async function getDefaultQueryFn(): Promise<AsyncGeneratorFn> {
  if (cachedSdkQuery) return cachedSdkQuery;
  const mod = await import("@anthropic-ai/claude-agent-sdk");
  cachedSdkQuery = mod.query as unknown as AsyncGeneratorFn;
  return cachedSdkQuery;
}

export async function runQuery(params: QueryParams): Promise<QueryResult> {
  const queryFn = params.queryFn ?? (await getDefaultQueryFn());
  const startedAt = Date.now();
  const messages: unknown[] = [];
  let finalText = "";
  let inputTokens = 0;
  let outputTokens = 0;

  const stream = queryFn({
    prompt: params.prompt,
    options: {
      cwd: params.cwd,
      allowedTools: params.allowedTools,
      ...(params.model ? { model: params.model } : {}),
      ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
    },
  });

  for await (const msg of stream) {
    messages.push(msg);
    if (msg.type === "result") {
      finalText = msg.result ?? "";
      inputTokens = msg.usage?.input_tokens ?? 0;
      outputTokens = msg.usage?.output_tokens ?? 0;
    }
    params.tracker.check();
  }

  const tokensUsed = inputTokens + outputTokens;
  params.tracker.add(tokensUsed);

  return {
    messages,
    finalText,
    tokensUsed,
    durationMs: Date.now() - startedAt,
  };
}
