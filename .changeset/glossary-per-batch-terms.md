---
"@cloudflare/polystella-core": minor
"@cloudflare/polystella-astro": minor
"@cloudflare/polystella-emdash": minor
---

Large glossaries now work. Each translation request carries only the `doNotTranslate` terms and `preferredTranslations` whose source term appears in its text or document context (case-insensitive, at word boundaries); style rules and notes are always sent. A 35K-character glossary drops from about 9K tokens per request to the style rules plus a few matched terms. Cache keys are unchanged.

- `glossary.matchInflections` (Astro and the catalog CLI) and `glossaryMatchInflections` (EmDash) let any letters follow a term, so `Worker` also matches "Workers". Default off.
- `provider.maxPromptTokens` (default 8000) caps a whole prompt. A batch over it is split; a single segment over it fails with `PromptTooLargeError` ("prompt for segment … is about N tokens, over maxPromptTokens").
- EmDash no longer caps the effective glossary at 10,000 characters, which blocked both translation and saving Translation settings for sites with large code-defined glossaries. Only the administrator-typed glossary text keeps its 10,000-character cap; `glossaryDefaults` get a 1,000,000-character sanity bound.
- Debug traces show how many glossary terms each batch sent.
- Core exports `selectGlossaryForText`, `buildBatchPrompt`, `estimatePromptTokens`, `DEFAULT_MAX_PROMPT_TOKENS` and `PromptTooLargeError`; `TranslateBatchAttemptEvent` gains `glossary` stats.
