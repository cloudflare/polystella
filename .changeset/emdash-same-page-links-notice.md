---
"@cloudflare/polystella-emdash": minor
---

Translations that contain same-page links (`#…`) now come with a notice asking the editor to review them by hand. EmDash gives headings no ids, so each site builds its own, often from the heading text, and a translated heading can get a different anchor than the copied link. The content-editor panel shows the notice instead of reloading, and batch results record it on each created entry. `TranslateContentResponse` gains an optional `notice`.
