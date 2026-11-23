---
"@cloudflare/polystella-core": minor
"@cloudflare/polystella-emdash": minor
---

`translateSegments` accepts an opt-in `concurrency` (default 1) that sends several batches at once; the first failure aborts the batches still in flight. EmDash content translation now sends up to 3 batches of an entry at once, so long entries translate faster. The Astro build keeps one batch at a time per file, since it already translates several files in parallel.

A reply cut off at the output token limit (`finish_reason: "length"` from Workers AI, `stop_reason: "max_tokens"` from Anthropic) now fails with "model ran out of output tokens", naming the model and limit, instead of an "unexpected response shape" or missing-segment error. EmDash shows this message to editors.
