---
"@cloudflare/polystella-emdash": minor
---

On EmDash 1.6 and later, the content-editor panel puts translations into the open form instead of saving and reloading. Unsaved changes are kept, and editors are asked to review the translation. If a selected field changes during translation, the form is left as it was and the panel asks to translate again. A read-only editor sends nothing. Each translated field is marked AI-written when a save first changes it. EmDash before 1.6 keeps the save-and-reload behaviour.

In collections with SEO, the panel also translates the SEO title and meta description. EmDash saves SEO text at once, so on published and scheduled entries this is off unless an Administrator turns on **Translate the SEO title and meta description of published and scheduled entries** in Translation settings.

On EmDash 1.5 and later, the PolyStella section is hidden on collections that aren't enabled in plugin settings.
