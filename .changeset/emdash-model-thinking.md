---
"@cloudflare/polystella-emdash": minor
"@cloudflare/polystella-core": minor
---

Thinking control for translation models. In the Translation settings tab, a locale that overrides its model gets a **Thinking** choice: model default, off, or one of the efforts the model lists in the Workers AI catalog. The new `models.reasoning` option sets the thinking effort for the code-default models, per locale if needed, and `models.reasoningInput` tells PolyStella exactly what to send for a model whose catalog entry is missing or wrong.

Core: the Workers AI translators accept `extraInput`, model-specific input fields merged into each request.
