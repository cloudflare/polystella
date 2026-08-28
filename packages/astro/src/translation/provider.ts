import { resolveModelId, type Translator } from "@cloudflare/polystella-core";
import { createAnthropicTranslator } from "@cloudflare/polystella-providers/anthropic";
import { createWorkersAIHttpTranslator } from "@cloudflare/polystella-providers/workers-ai";

import type { PolyStellaResolvedOptions } from "../config/options.js";

type ProviderConfig = NonNullable<PolyStellaResolvedOptions["provider"]>;

export interface CreateTranslatorOptions {
  /** Defaults to global `fetch`; tests pass a stub. */
  fetchImpl?: typeof fetch;
}

/**
 * Throws on unknown provider kind. Doesn't validate credentials —
 * auth failures surface from the first `translate()` call.
 */
export function createTranslator(provider: ProviderConfig, locale: string, options: CreateTranslatorOptions = {}): Translator {
  if (provider.kind === "workers-ai") {
    const modelId = resolveModelId(provider.model, locale);
    return createWorkersAIHttpTranslator({
      accountId: provider.accountId,
      apiToken: provider.apiToken,
      modelId,
      maxTokens: provider.maxTokens,
      ...(provider.endpoint !== undefined ? { endpoint: provider.endpoint } : {}),
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    });
  }
  if (provider.kind === "anthropic") {
    const modelId = resolveModelId(provider.model, locale);
    return createAnthropicTranslator({
      apiKey: provider.apiKey,
      modelId,
      maxTokens: provider.maxTokens,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    });
  }
  throw new Error(`[polystella] unknown provider kind: ${(provider as { kind: string }).kind}`);
}
