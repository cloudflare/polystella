---
"@cloudflare/polystella-emdash": minor
---

EmDash `blocks` fields can now be enabled and translated. List each block type's text fields in `blockFields`, keyed by the block type slug (for example `hero: ["heading", "body", "link_label"]`). Unlisted block types and fields, `_version`, `_key`, URLs and media are copied unchanged, and EmDash's own Portable Text block defaults don't apply inside `blocks` fields.
