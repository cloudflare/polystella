---
"@cloudflare/polystella-emdash": minor
---

Thinking control for translation models. In the Translation settings tab, a locale that overrides its model gets a **Thinking** choice: no override, off, or one of the efforts the model lists in the Workers AI catalog. Picking an effort turns the code's thinking-off switch back on for that model. Locales on the code-default model show the thinking set by `models.defaults` or `models.params`. The new `models.reasoningInput` option tells PolyStella exactly what to send for a model whose catalog entry is missing or wrong.
