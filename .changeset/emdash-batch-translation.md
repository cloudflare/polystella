---
"@cloudflare/polystella-emdash": minor
---

New **Batch translation** admin tab: translate a whole collection, or entries you pick from a searchable list, into one or more target locales. Missing locales are created as drafts. Existing translations are skipped unless you turn on **Update existing translations**, which saves with EmDash's `_rev` token so an entry edited during the run is skipped instead of overwritten. The run happens in the browser, three translations at a time, with a result for each entry and locale, a **Stop** button, and **Retry failed**.

Optional server jobs on Cloudflare Queues: set `batchQueueBinding` and export `handlePolystellaBatchQueue` from `@cloudflare/polystella-emdash/queue` as the Worker's `queue` handler. The tab then offers **Run in: Server queue**, which keeps going after the tab closes, creates only missing translations (as drafts, with the source slug), and lists recent jobs with progress, failures, **Cancel**, and **Retry failed**. The plugin declares two new storage collections, `batch_jobs` and `batch_results`.
