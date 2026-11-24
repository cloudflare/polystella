---
"@cloudflare/polystella-emdash": minor
---

Repeater fields can be translated. The Collections tab lists each repeater's `string`, `text`, and `image` subfields, all ticked by default; only ticked subfields are translated (images get their alt text and caption), and every other subfield is copied from the source row. Collection policies gain an optional `subFields` map.

The Batch tab now starts on **Selected entries**, shows the run button above and below the entry list, and lists only source-locale entries. Server jobs record the entries they were started for and show **Show entries** on their card; whole-collection jobs say so.

Locales across the admin are shown by name and code, for example "French (fr)", in the browser's language.
