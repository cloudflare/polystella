import { createModelPriceLookup, resolveModelId, type ModelPriceLookup, type Translator } from "@cloudflare/polystella-core";
import { createAnthropicTranslator } from "@cloudflare/polystella-core/providers/anthropic";
import { createWorkersAIHttpTranslator, workersAIPriceLookup } from "@cloudflare/polystella-core/providers/workers-ai";

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

/** `provider.prices`, then the Workers AI catalog. A custom `endpoint` may be a gateway, so its token is not sent to the catalog. */
export function createPriceLookup(
  provider: ProviderConfig,
  onError?: (modelId: string, error: unknown) => void,
  options: CreateTranslatorOptions = {},
): ModelPriceLookup {
  const catalog =
    provider.kind === "workers-ai" && provider.endpoint === undefined
      ? workersAIPriceLookup({
          accountId: provider.accountId,
          apiToken: provider.apiToken,
          ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
        })
      : undefined;
  return createModelPriceLookup({ prices: provider.prices, fallback: catalog, onError });
}
