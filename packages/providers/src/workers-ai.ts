import type { Translator } from "@cloudflare/polystella-core";

import { createProviderHttpError } from "./http-error.js";

export interface WorkersAIInput {
  messages: Array<{ role: "system" | "user"; content: string }>;
  max_tokens: number;
}

interface WorkersAITranslatorOptions {
  modelId: string;
  maxTokens: number;
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

  return {
    modelId,
    async translate(systemPrompt, userPrompt, signal) {
      signal?.throwIfAborted();
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(createInput(systemPrompt, userPrompt, maxTokens)),
        ...(signal !== undefined ? { signal } : {}),
      });
      signal?.throwIfAborted();
      if (!response.ok) throw await createProviderHttpError("Workers AI", response, signal);

      const data: unknown = await response.json();
      signal?.throwIfAborted();
      if (property(data, "success") === false) {
        throw new Error(`[polystella] Workers AI returned errors: ${JSON.stringify(property(data, "errors") ?? [])}`);
      }

      return normalizeWorkersAIHttpResponse(data, modelId);
    },
  };
}

export function createWorkersAIBindingTranslator(options: WorkersAIBindingTranslatorOptions): Translator {
  const { modelId, maxTokens, run } = options;
  return {
    modelId,
    async translate(systemPrompt, userPrompt, signal) {
      signal?.throwIfAborted();
      const data = await run(modelId, createInput(systemPrompt, userPrompt, maxTokens));
      signal?.throwIfAborted();
      return normalizeWorkersAIBindingResponse(data, modelId);
    },
  };
}

function createInput(systemPrompt: string, userPrompt: string, maxTokens: number): WorkersAIInput {
  return {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: maxTokens,
  };
}

function normalizeWorkersAIHttpResponse(data: unknown, modelId: string): string {
  const result = property(data, "result");
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

function normalizeWorkersAIBindingResponse(data: unknown, modelId: string): string {
  if (typeof data === "string") return data;
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
  return new Error(`[polystella] unexpected ${providerName} response shape (model="${modelId}"): ${detail}. Raw response was:\n${preview}`);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
