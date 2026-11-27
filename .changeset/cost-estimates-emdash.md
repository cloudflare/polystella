---
"@cloudflare/polystella-emdash": minor
---

`provider_call` events now carry `cachedInputTokens` and `estimatedCostUsd`, an estimate (tokens × list price). Prices come from the Workers AI model catalog, or from the new `models.prices` option.
