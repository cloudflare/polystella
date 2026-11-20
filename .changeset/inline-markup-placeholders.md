---
"@cloudflare/polystella-core": minor
"@cloudflare/polystella-astro": patch
"@cloudflare/polystella-emdash": minor
---

Inline markup is now protected during translation. A `Segment` can set `markup: "html"` or `"markdown"`; `translateSegments` swaps its tags (and Markdown links, images, emphasis, code spans and escapes) for `{{ps_N}}` placeholders before the model call and puts them back afterwards, so URLs never reach the model. A reply that loses, repeats, reorders or empties a placeholder is resent once with the problem explained, then fails with `InlineMarkupError` ("model changed inline markup") instead of saving broken links or tags.

The Markdown adapter opts `.md` body segments in, so Astro `.md` translations get the same protection; MDX keeps its existing inline JSX placeholders. Cache keys are unchanged.

EmDash protects inline tags such as `<gradient>…</gradient>` in every translated string, and `blockFields` paths can be `{ path, format: "markdown" }` to translate a Markdown string one paragraph, heading or list item at a time.
