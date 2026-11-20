---
"@cloudflare/polystella-core": patch
"@cloudflare/polystella-emdash": patch
---

A one-segment batch whose reply has no `@@<id>@@` marker line is now accepted as that segment's translation instead of failing with "no segment markers"; inline-markup placeholders are still checked afterwards. EmDash shows Workers AI timeouts (`AiError` "3046: Request timeout") as "The translation model timed out (Workers AI error 3046). Try again, or translate fewer fields at once or pick a faster model." instead of the generic failure.
