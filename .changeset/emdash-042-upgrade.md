---
"@cloudflare/polystella-emdash": minor
---

Require EmDash `>=0.42.0 <1.0.0 || ^1.0.1-rc.0` (verified against `0.42.0`; `1.0.1-rc.1` source-checked). Content translation now checks the live collection schema (`schema:read`) and refuses fields that were removed, changed type, or marked non-translatable. Settings and catalog-override saves are conditional, so a concurrent edit returns a 409 conflict instead of being overwritten. A new **Clear synced overrides** action removes overrides that already match the deployed catalog. The source-locale lookup uses `ctx.content.getTranslations()`, routes declare their HTTP methods, settings use `ctx.settings`, and the editor panel explains when another editor's lock blocks the save.
