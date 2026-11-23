---
"@cloudflare/polystella-core": minor
"@cloudflare/polystella-emdash": minor
---

Workers AI requests can now be tuned and measured.

- `models.params` (EmDash) sets extra Workers AI input per allowed model, such as `{ chat_template_kwargs: { enable_thinking: false } }` to turn off GLM-4.7-flash's reasoning. Keys PolyStella sets (`messages`, `prompt`, `max_tokens`, `max_completion_tokens`, `stream`) are rejected. Core's Workers AI translators take the same `params`.
- `provider.timeoutMs` (EmDash, default 200,000) stops waiting for a reply, under Workers AI's own ~236 s timeout, and fails with "The translation model timed out". Core's Workers AI translators take `timeoutMs` and throw the retriable `ProviderTimeoutError`. HTTP requests are aborted; with the binding, PolyStella stops waiting while the upstream call may finish.
- Each attempt in the debug trace, and the server log entry of a failed reply, shows the finish reason, input, output and reasoning tokens, and the reasoning text size. `Translator.translate` takes an optional `onResponse` callback for this, and `TranslateBatchAttemptEvent` gains `providerResponse`.
- Fixed: `glossaryMatchInflections` was dropped when EmDash options were serialized, so it never reached the server.
