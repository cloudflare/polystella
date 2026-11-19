---
"@cloudflare/polystella-emdash": minor
---

Translate custom Portable Text blocks. A new `blockFields` option maps a block `_type` to the text paths to translate (`"headline"`, `"cta.label"`, `"cards[].title"`, `"tags[]"`, or a nested Portable Text array such as `"columns[].content"`). Unlisted blocks and fields are still copied unchanged, so existing sites behave as before. Placeholder tokens are checked in block text like any other field, invalid content errors now name the exact location (`body[3].columns[0].content[1]`), and the debug view labels custom block segments.
