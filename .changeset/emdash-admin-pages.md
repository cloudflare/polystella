---
"@cloudflare/polystella-emdash": minor
"@cloudflare/polystella-core": minor
---

The EmDash admin now has a PolyStella sidebar group with Settings (Translation settings, Collections and Sandbox tabs, chosen with `?tab=`), Catalog and Batch translation pages; the old `/` address opens Settings. Code-defined instructions and glossaries open read-only in a new window, and every link that opens a new window shows an icon. Collections show as two columns with a link to each content type, catalog keys drop their group prefix, and the editor panel's SEO note is collapsed.

Batch run pages label locales with `localeTags`, counts read "1 entry" and "1 batch", debug traces show the extra Workers AI input each request sends (such as thinking settings), and Collections warns when a ticked repeater subfield looks like a link or ID. Core exports `workersAIRequestParams`.
