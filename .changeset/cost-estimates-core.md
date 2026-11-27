---
"@cloudflare/polystella-core": minor
---

Add cost estimates for AI calls: tokens × list price. New exports: `ModelPrice`, `TokenUsage`, `estimateCostUsd`, `createModelPriceLookup`, `summarizeUsage`, `formatUsageSummary`, and helpers for summing token usage. `@cloudflare/polystella-core/providers/workers-ai` adds `fetchWorkersAIModels`, `workersAIModelPrice`, and `workersAIPriceLookup`, which read list prices from the Workers AI model catalog. The Anthropic provider now reports token counts and stop reasons through `onResponse`, and Workers AI replies report cached input tokens as `cachedInputTokens`. `polystella translate-ui` logs calls, tokens, and an estimated cost at the end of a run, and accepts `provider.prices`.
