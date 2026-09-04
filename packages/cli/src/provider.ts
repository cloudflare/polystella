import { resolveModelId, type Translator } from "@cloudflare/polystella-core";
import { createAnthropicTranslator } from "@cloudflare/polystella-providers/anthropic";
import { createWorkersAIHttpTranslator } from "@cloudflare/polystella-providers/workers-ai";

import type { CatalogProviderConfig } from "./config.js";

export function createTranslator(provider: CatalogProviderConfig, locale: string): Translator {
  const modelId = resolveModelId(provider.model, locale);
  if (provider.kind === "workers-ai") {
    return createWorkersAIHttpTranslator({
      accountId: provider.accountId,
      apiToken: provider.apiToken,
      modelId,
      maxTokens: provider.maxTokens,
      ...(provider.endpoint === undefined ? {} : { endpoint: provider.endpoint }),
    });
  }
  return createAnthropicTranslator({ apiKey: provider.apiKey, modelId, maxTokens: provider.maxTokens });
}
