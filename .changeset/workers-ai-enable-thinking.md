---
"@cloudflare/polystella-core": minor
"@cloudflare/polystella-emdash": minor
---

`enable_thinking: true | false` in `models.params` (EmDash) or the Workers AI translators' `params` (core) turns a reasoning model's thinking on or off. PolyStella sends it as `chat_template_kwargs.enable_thinking`, the only form Workers AI reads; it silently ignores a top-level `enable_thinking`, so that key used to have no effect. A non-boolean value, or setting it in both places, is rejected. Core exports `workersAIParamsProblem` to check params the same way.

`enable_thinking` can also be set per locale, like `models.defaults`: `{ default: false, "ja-JP": true }`. Core exports `workersAIParamsForLocale` to pick one locale's params. The `translate-ui` CLI takes the same per-model params as `provider.params` in `polystella.config.mjs` (`kind: "workers-ai"`).
