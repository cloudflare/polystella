---
"@cloudflare/polystella-emdash": minor
---

New **Batch translation** admin tab: translate a whole collection, or entries you pick from a searchable list, into one or more target locales. Missing locales are created as drafts. Existing translations are skipped unless you turn on **Update existing translations**, which saves with EmDash's `_rev` token so an entry edited during the run is skipped instead of overwritten. The run happens in the browser, three translations at a time, with a result for each entry and locale, a **Stop** button, and **Retry failed**.

Optional server jobs on Cloudflare Queues: set `batchQueueBinding` and export `handlePolystellaBatchQueue` from `@cloudflare/polystella-emdash/queue` as the Worker's `queue` handler. The tab then offers **Run in: Server queue**, which keeps going after the tab closes, creates only missing translations (as drafts, with the source slug), and lists recent jobs with progress, failures, **Cancel**, and **Retry failed**. The plugin declares two new storage collections, `batch_jobs` and `batch_results`.

Locale pickers in the Batch tab and the content-editor panel start empty and have **Select all** and **Clear all**. The Batch tab adds **Select untranslated** for selected entries. On a source entry, the editor panel now creates drafts for several locales in one go.

Administrators can set **Max output tokens** in the Translation settings tab; empty uses `provider.maxTokens` or `8192`.

Content translation now covers text inside Portable Text tables.

**Publish translations immediately** in the Batch tab publishes each translation right after it is saved, in the browser and on the server queue. Browser results link to each translation.

Entries translated by PolyStella are now flagged as AI-translated. Themes read the flag with `getEnrichedEntry` and `getEnrichedCollection` from the new `@cloudflare/polystella-emdash/content` export: same arguments and result as EmDash's getters, plus `entry.polystella.aiTranslated`, `aiTranslatedAt`, and `aiTranslationModel`. The plugin declares a new storage collection, `ai_translations`.
