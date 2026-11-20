---
"@cloudflare/polystella-core": patch
"@cloudflare/polystella-emdash": patch
---

Translation failures now log the raw error under their Diagnostic ID, in the server log only: the full message (including the provider response preview), any error code, and the cause chain. Editors still see only the short, safe message. Workers AI "unexpected response shape" errors now start their preview with the first choice's `finish_reason` and the size of each reply field, such as `reasoning_content`, so a long reasoning field no longer hides them.
