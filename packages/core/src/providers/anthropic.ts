import type { ProviderResponseInfo, Translator } from "../index.js";

import { createProviderHttpError } from "./http-error.js";
import { outOfTokensError } from "./out-of-tokens.js";

export interface AnthropicTranslatorOptions {
  apiKey: string;
  modelId: string;
  maxTokens: number;
  fetchImpl?: typeof fetch | undefined;
}

export function createAnthropicTranslator(options: AnthropicTranslatorOptions): Translator {
  const { apiKey, modelId, maxTokens, fetchImpl = fetch } = options;
  return {
    modelId,
    async translate(systemPrompt, userPrompt, signal, onResponse) {
      signal?.throwIfAborted();
      const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        }),
        ...(signal !== undefined ? { signal } : {}),
      });
      signal?.throwIfAborted();
      if (!response.ok) throw await createProviderHttpError("Anthropic", response, signal);

      const data: unknown = await response.json();
      signal?.throwIfAborted();
      onResponse?.(responseInfo(data));
      if (property(data, "stop_reason") === "max_tokens") throw outOfTokensError(modelId, maxTokens);
      const content = property(data, "content");
      if (Array.isArray(content)) {
        const text = property(
          content.find((block) => property(block, "type") === "text"),
          "text",
        );
        if (typeof text === "string") return text;
      }
      throw new Error("[polystella] unexpected Anthropic response shape: no text content block");
    },
  };
}

/** Anthropic counts cache reads and writes apart from `input_tokens`; they are folded in so `inputTokens` is the whole prompt. */
function responseInfo(data: unknown): ProviderResponseInfo {
  const info: ProviderResponseInfo = {};
  const stopReason = property(data, "stop_reason");
  if (typeof stopReason === "string") info.finishReason = stopReason;
  const usage = property(data, "usage");
  const count = (key: string): number | undefined => {
    const value = property(usage, key);
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };
  const input = count("input_tokens");
  const output = count("output_tokens");
  const cacheRead = count("cache_read_input_tokens") ?? 0;
  // shortcut: cache writes are priced at the input rate (Anthropic bills ~1.25x); fine while prompts set no cache_control.
  if (input !== undefined) info.inputTokens = input + cacheRead + (count("cache_creation_input_tokens") ?? 0);
  if (cacheRead > 0) info.cachedInputTokens = cacheRead;
  if (output !== undefined) info.outputTokens = output;
  return info;
}

function property(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}
