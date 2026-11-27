---
"@cloudflare/polystella-emdash": minor
---

PolyStella now emits events you can send to your own metrics. A `provider_call` event fires for each model request, including each retry: surface, locale, model, success or error kind, duration, and token counts. A `batch_result` event fires each time a batch outcome is written. Events never carry prompts, text, or model output. Each one is logged as `polystella.<type>`. Call `setPolystellaEventSink(sink)` at Worker module scope to also send them somewhere else, such as Workers Analytics Engine.
