import { createModelPriceLookup, resolveModelId, type ModelPriceLookup, type Translator } from "../index.js";
import { createAnthropicTranslator } from "../providers/anthropic.js";
import { createWorkersAIHttpTranslator, workersAIParamsForLocale, workersAIPriceLookup } from "../providers/workers-ai.js";

import type { CatalogProviderConfig } from "./config.js";

export function createTranslator(provider: CatalogProviderConfig, locale: string): Translator {
  const modelId = resolveModelId(provider.model, locale);
  if (provider.kind === "workers-ai") {
    return createWorkersAIHttpTranslator({
      accountId: provider.accountId,
      apiToken: provider.apiToken,
      modelId,
      maxTokens: provider.maxTokens,
      params: workersAIParamsForLocale(provider.params?.[modelId], provider.model, locale, modelId),
      ...(provider.endpoint === undefined ? {} : { endpoint: provider.endpoint }),
    });
  }
  return createAnthropicTranslator({ apiKey: provider.apiKey, modelId, maxTokens: provider.maxTokens });
}

/** `provider.prices`, then the Workers AI catalog. A custom `endpoint` may be a gateway, so its token is not sent to the catalog. */
export function createPriceLookup(provider: CatalogProviderConfig, onError?: (modelId: string, error: unknown) => void): ModelPriceLookup {
  const catalog =
    provider.kind === "workers-ai" && provider.endpoint === undefined
      ? workersAIPriceLookup({ accountId: provider.accountId, apiToken: provider.apiToken })
      : undefined;
  return createModelPriceLookup({ prices: provider.prices, fallback: catalog, onError });
}
