import { resolveModelId, type Translator } from "../index.js";
import { createAnthropicTranslator } from "../providers/anthropic.js";
import { createWorkersAIHttpTranslator, workersAIParamsForLocale } from "../providers/workers-ai.js";

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
