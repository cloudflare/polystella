---
"@cloudflare/polystella-astro": minor
---

Builds now log an `AI usage:` line with model calls, tokens, and an estimated cost (tokens × list price). `dist/i18n-r2-report.json` fills in `tokens` per entry and `tokensIn`/`tokensOut` in `totals`, which were always empty before, and adds `estimatedCostUsd`, the same estimate. Workers AI prices come from the model catalog; set `provider.prices` to override them or to price Anthropic models.
