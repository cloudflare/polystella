---
"@cloudflare/polystella-emdash": minor
---

Long entries no longer fail with "cannot translate more than 30000 characters at once". Content translation now splits an entry into parts of up to 30,000 characters and 500 segments and translates one part per request: the editor panel and browser batch runner send the parts one after another, and queued batch jobs translate one part per queue message, keeping finished parts in plugin storage until the entry is created. An entry can hold up to 500,000 characters and 5,000 segments. If the source entry changes between parts, the translation stops with "The source entry changed while it was being translated."
