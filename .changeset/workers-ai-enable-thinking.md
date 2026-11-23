---
"@cloudflare/polystella-core": minor
"@cloudflare/polystella-emdash": minor
---

Reasoning models' thinking can be turned on or off per locale, next to the locale's model. An entry in EmDash `models.defaults`, or in the `translate-ui` CLI's `provider.model` (`kind: "workers-ai"`), can be `{ model, enable_thinking }`:

```js
defaults: {
  default: { model: MODEL, enable_thinking: false },
  "ja-JP": { model: MODEL, enable_thinking: true },
},
```

It applies while the locale uses that model; a model an administrator picks instead keeps its own params. `enable_thinking: true | false` in `models.params` (EmDash), `provider.params` (CLI, new) or the Workers AI translators' `params` (core) sets it for every locale. PolyStella sends it as `chat_template_kwargs.enable_thinking`, the only form Workers AI reads; it silently ignores a top-level `enable_thinking`, so that key used to have no effect. A non-boolean value, or also setting it in `chat_template_kwargs`, is rejected.

Core exports the `ModelChoice` and `ModelChoiceSpec` types, `resolveModelChoice`, and from `providers/workers-ai` `workersAIParamsProblem` and `workersAIParamsForLocale`. `resolveModelId` accepts a `ModelChoiceSpec`.
