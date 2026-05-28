import type { BudgetTracker } from "../orchestrator/budget.js";

export interface QueryParams {
  prompt: string;
  allowedTools: string[];
  cwd: string;
  tracker: BudgetTracker;
  model?: string;
  systemPrompt?: string | string[];
  queryFn?: AsyncGeneratorFn;
  // When fired, the in-flight SDK query is cancelled. The generator throws
  // an AbortError on its next iteration; callers should treat that as a
  // deliberate force-stop, not a real error.
  abortSignal?: AbortSignal;
}

export class QueryAbortedError extends Error {
  constructor() {
    super("query aborted");
    this.name = "QueryAbortedError";
  }
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

  // Fail fast: an already-aborted signal means a force-stop landed between
  // step() iterations. No point spinning up an SDK process just to tear it down.
  if (params.abortSignal?.aborted) {
    throw new QueryAbortedError();
  }

  // Mint a fresh AbortController for the SDK and bridge the external signal
  // into it. We can't reuse the caller's AbortController directly because the
  // SDK option is typed as AbortController (not AbortSignal), and we want to
  // keep ownership of when it fires (e.g. on early exits from this generator).
  const sdkController = new AbortController();
  const onAbort = (): void => sdkController.abort();
  params.abortSignal?.addEventListener("abort", onAbort, { once: true });

  const stream = queryFn({
    prompt: params.prompt,
    options: {
      cwd: params.cwd,
      allowedTools: params.allowedTools,
      abortController: sdkController,
      ...(params.model ? { model: params.model } : {}),
      ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
    },
  });

  try {
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
  } catch (err) {
    // SDK throws when its controller is aborted; surface that as our own
    // tagged error so callers can distinguish "we cancelled" from a genuine
    // SDK failure. The DOMException check covers Node's native AbortError too.
    if (
      params.abortSignal?.aborted ||
      (err instanceof Error && (err.name === "AbortError" || err.name === "QueryAbortedError"))
    ) {
      throw new QueryAbortedError();
    }
    throw err;
  } finally {
    params.abortSignal?.removeEventListener("abort", onAbort);
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
