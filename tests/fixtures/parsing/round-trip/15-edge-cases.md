---
title: Edge cases that have historically caused parser drift
metaDescription: "Tricky punctuation: colons, ellipses…, em-dashes—and 'curly quotes'."
---

Punctuation stress test: this paragraph has em-dashes — like this —
and "smart quotes" and apostrophes don't break either. Also Unicode:
日本語, Português, العربية, emoji 🎉.

A paragraph with multiple sentences. First sentence. Second sentence
with a [link](/foo). Third sentence ending in an ellipsis…

Escaped characters: \*not bold\*, \_not italic\_, \`not code\`.
Backslash before a newline does NOT produce a hard break unless
there's content before:

End of sentence.\
This is the next line.

A paragraph containing inline `code with \backslash` and `code with
"quotes"` and `code with [brackets]`.

A definition-like construction (not GFM, just markdown):

term1
: definition one

term2
: definition two with **formatting**
