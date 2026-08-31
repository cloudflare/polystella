import type { Translator } from "@cloudflare/polystella-core";

import { createProviderHttpError } from "./http-error.js";

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
    async translate(systemPrompt, userPrompt, signal) {
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

function property(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}
