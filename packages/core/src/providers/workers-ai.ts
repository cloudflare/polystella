import type { ProviderResponseInfo, Translator } from "../index.js";

import { createProviderHttpError } from "./http-error.js";
import { outOfTokensError } from "./out-of-tokens.js";
import { withRequestTimeout } from "./timeout.js";

export { ProviderTimeoutError } from "./timeout.js";

export interface WorkersAIInput {
  messages: Array<{ role: "system" | "user"; content: string }>;
  max_tokens: number;
  /** Model-specific parameters from `params`, such as `chat_template_kwargs`. */
  [parameter: string]: unknown;
}

/** Input keys PolyStella sets itself, so `params` can't override them. */
export const RESERVED_WORKERS_AI_PARAMS: readonly string[] = ["messages", "prompt", "max_tokens", "max_completion_tokens", "stream"];

interface WorkersAITranslatorOptions {
  modelId: string;
  maxTokens: number;
  /** Extra input sent with every request, such as `{ chat_template_kwargs: { enable_thinking: false } }`. */
  params?: Readonly<Record<string, unknown>> | undefined;
  /** Stop waiting after this many milliseconds and throw `ProviderTimeoutError`. Default: no limit. */
  timeoutMs?: number | undefined;
}

export interface WorkersAIHttpTranslatorOptions extends WorkersAITranslatorOptions {
  accountId: string;
  apiToken: string;
  endpoint?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export type WorkersAIBindingRun = (modelId: string, input: WorkersAIInput) => Promise<unknown>;

export interface WorkersAIBindingTranslatorOptions extends WorkersAITranslatorOptions {
  run: WorkersAIBindingRun;
}

export function createWorkersAIHttpTranslator(options: WorkersAIHttpTranslatorOptions): Translator {
  const { accountId, apiToken, modelId, maxTokens, endpoint, fetchImpl = fetch } = options;
  const url = endpoint ?? `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelId}`;
  assertNoReservedParams(options.params);

  return {
    modelId,
    async translate(systemPrompt, userPrompt, signal, onResponse) {
      signal?.throwIfAborted();
      const data = await withRequestTimeout(options.timeoutMs, signal, async (requestSignal) => {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(createInput(systemPrompt, userPrompt, maxTokens, options.params)),
          ...(requestSignal !== undefined ? { signal: requestSignal } : {}),
        });
        requestSignal?.throwIfAborted();
        if (!response.ok) throw await createProviderHttpError("Workers AI", response, requestSignal);
        const body: unknown = await response.json();
        return body;
      });
      signal?.throwIfAborted();
      if (property(data, "success") === false) {
        throw new Error(`[polystella] Workers AI returned errors: ${JSON.stringify(property(data, "errors") ?? [])}`);
      }

      onResponse?.(responseInfo(property(data, "result") ?? data));
      return normalizeWorkersAIHttpResponse(data, modelId, maxTokens);
    },
  };
}

export function createWorkersAIBindingTranslator(options: WorkersAIBindingTranslatorOptions): Translator {
  const { modelId, maxTokens, run } = options;
  assertNoReservedParams(options.params);
  return {
    modelId,
    async translate(systemPrompt, userPrompt, signal, onResponse) {
      signal?.throwIfAborted();
      const input = createInput(systemPrompt, userPrompt, maxTokens, options.params);
      const data = await withRequestTimeout(options.timeoutMs, signal, async () => await run(modelId, input));
      signal?.throwIfAborted();
      onResponse?.(responseInfo(data));
      return normalizeWorkersAIBindingResponse(data, modelId, maxTokens);
    },
  };
}

function createInput(
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  params: Readonly<Record<string, unknown>> | undefined,
): WorkersAIInput {
  return {
    ...params,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: maxTokens,
  };
}

function assertNoReservedParams(params: Readonly<Record<string, unknown>> | undefined): void {
  const reserved = Object.keys(params ?? {}).find((key) => RESERVED_WORKERS_AI_PARAMS.includes(key));
  if (reserved !== undefined) throw new Error(`[polystella] Workers AI params cannot set "${reserved}"; PolyStella sets it`);
}

/** OpenAI-style `choices[0].finish_reason`, reasoning text and `usage`, as chat models on Workers AI return them. */
function responseInfo(data: unknown): ProviderResponseInfo {
  const choices = property(data, "choices");
  const choice: unknown = Array.isArray(choices) ? choices[0] : undefined;
  const message = property(choice, "message");
  const reasoning = property(message, "reasoning_content") ?? property(message, "reasoning");
  const usage = property(data, "usage");
  const info: ProviderResponseInfo = {};
  const finishReason = property(choice, "finish_reason");
  if (typeof finishReason === "string") info.finishReason = finishReason;
  if (typeof reasoning === "string") info.reasoningCharacters = reasoning.length;
  const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const inputTokens = count(property(usage, "prompt_tokens"));
  const outputTokens = count(property(usage, "completion_tokens"));
  const reasoningTokens = count(property(property(usage, "completion_tokens_details"), "reasoning_tokens"));
  if (inputTokens !== undefined) info.inputTokens = inputTokens;
  if (outputTokens !== undefined) info.outputTokens = outputTokens;
  if (reasoningTokens !== undefined) info.reasoningTokens = reasoningTokens;
  return info;
}

function normalizeWorkersAIHttpResponse(data: unknown, modelId: string, maxTokens: number): string {
  const result = property(data, "result");
  throwIfOutOfTokens([property(result, "choices"), property(data, "choices")], modelId, maxTokens);
  const candidates = [
    property(result, "response"),
    firstChoiceContent(property(result, "choices")),
    firstChoiceContent(property(data, "choices")),
  ];
  for (const candidate of candidates) {
    const normalized = normalizeValue(candidate);
    if (normalized !== undefined) return normalized;
  }

  throw unexpectedResponseError(
    "Workers AI",
    modelId,
    "none of result.response, result.choices[0].message.content, or choices[0].message.content held a usable string or object",
    data,
  );
}

function normalizeWorkersAIBindingResponse(data: unknown, modelId: string, maxTokens: number): string {
  if (typeof data === "string") return data;
  throwIfOutOfTokens([property(data, "choices")], modelId, maxTokens);
  if (data !== null && typeof data === "object") {
    const hasResponseEnvelope = Object.hasOwn(data, "response");
    const hasChoicesEnvelope = Object.hasOwn(data, "choices");
    if (!hasResponseEnvelope && !hasChoicesEnvelope) {
      const normalized = normalizeValue(data);
      if (normalized !== undefined) return normalized;
    }

    for (const candidate of [property(data, "response"), firstChoiceContent(property(data, "choices"))]) {
      const normalized = normalizeValue(candidate);
      if (normalized !== undefined) return normalized;
    }
  }

  throw unexpectedResponseError(
    "Workers AI binding",
    modelId,
    "none of the direct value, response, or choices[0].message.content held a usable string or object",
    data,
  );
}

/** Reasoning models often spend the whole budget before answering; other models drop the last segments. */
function throwIfOutOfTokens(choiceLists: unknown[], modelId: string, maxTokens: number): void {
  for (const choices of choiceLists) {
    if (Array.isArray(choices) && property(choices[0], "finish_reason") === "length") throw outOfTokensError(modelId, maxTokens);
  }
}

function firstChoiceContent(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  return property(property(value[0], "message"), "content");
}

function property(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function normalizeValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return undefined;
}

function unexpectedResponseError(providerName: string, modelId: string, detail: string, data: unknown): Error {
  const serialized = safeStringify(data);
  const preview = serialized.length > 800 ? `${serialized.slice(0, 800)}\n... [truncated, total length ${serialized.length}]` : serialized;
  return new Error(
    `[polystella] unexpected ${providerName} response shape (model="${modelId}"): ${detail}. Raw response was:\n${firstChoiceSummary(data)}${preview}`,
  );
}

/** Reasoning fields can fill the preview, so the finish reason and field sizes are listed first. */
function firstChoiceSummary(data: unknown): string {
  const choices = [property(property(data, "result"), "choices"), property(data, "choices")].find(Array.isArray);
  const choice: unknown = choices?.[0];
  if (choice === undefined) return "";
  const message = property(choice, "message");
  const fields =
    message !== null && typeof message === "object"
      ? Object.entries(message).map(
          ([key, value]) => `${key}=${typeof value === "string" ? `${value.length} chars` : value === null ? "null" : typeof value}`,
        )
      : [];
  return `choices[0]: finish_reason=${JSON.stringify(property(choice, "finish_reason")) ?? "undefined"}; message: ${fields.join(", ") || "none"}\n`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
