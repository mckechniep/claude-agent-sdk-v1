import type { BudgetTracker } from "../orchestrator/budget.js";

export interface QueryParams {
  prompt: string;
  allowedTools: string[];
  cwd: string;
  tracker: BudgetTracker;
  model?: string;
  systemPrompt?: string | string[];
  queryFn?: AsyncGeneratorFn;
}

export interface QueryResult {
  messages: unknown[];
  finalText: string;
  tokensUsed: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  durationMs: number;
}

export interface SdkStreamMessage {
  type: string;
  message?: { content: Array<{ type: string; text?: string }> };
  result?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export type QueryEvent =
  | { type: "started"; ts: number }
  | { type: "sdk_message"; message: SdkStreamMessage; ts: number };

type AsyncGeneratorFn = (args: unknown) => AsyncGenerator<SdkStreamMessage>;

let cachedSdkQuery: AsyncGeneratorFn | null = null;
async function getDefaultQueryFn(): Promise<AsyncGeneratorFn> {
  if (cachedSdkQuery) return cachedSdkQuery;
  const mod = await import("@anthropic-ai/claude-agent-sdk");
  cachedSdkQuery = mod.query as unknown as AsyncGeneratorFn;
  return cachedSdkQuery;
}

export async function* runQueryStream(
  params: QueryParams,
): AsyncGenerator<QueryEvent, QueryResult> {
  const queryFn = params.queryFn ?? (await getDefaultQueryFn());
  const startedAt = Date.now();
  const messages: unknown[] = [];
  let finalText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;

  yield { type: "started", ts: startedAt };

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
    yield { type: "sdk_message", message: msg, ts: Date.now() };
    if (msg.type === "result") {
      finalText = msg.result ?? "";
      inputTokens = msg.usage?.input_tokens ?? 0;
      outputTokens = msg.usage?.output_tokens ?? 0;
      cacheCreationInputTokens = msg.usage?.cache_creation_input_tokens ?? 0;
      cacheReadInputTokens = msg.usage?.cache_read_input_tokens ?? 0;
    }
    params.tracker.check();
  }

  const tokensUsed = inputTokens + outputTokens;
  params.tracker.add(tokensUsed);

  return {
    messages,
    finalText,
    tokensUsed,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    durationMs: Date.now() - startedAt,
  };
}

export async function runQuery(params: QueryParams): Promise<QueryResult> {
  const gen = runQueryStream(params);
  // Drain the generator. We don't care about intermediate events here —
  // streaming consumers use runQueryStream directly.
  for (;;) {
    const next = await gen.next();
    if (next.done) return next.value;
  }
}
