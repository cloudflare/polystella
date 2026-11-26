---
"@cloudflare/polystella-emdash": minor
---

Administrators now pick the **Default model** in Translation settings, with its own **Thinking** choice. Every language uses it unless it picks another model. `models.defaults` is optional and only used as a fallback until an administrator picks a default model; without it, the fallback is the first model in `models.allowed`. Code still decides which models are allowed.

Batch translation tab:

- Ticked entries are listed under **… selected**, with **Remove** and **Clear selection**, so the selection stays visible when the search changes.
- Server jobs are listed in the left column under the run button. A job with more than three locales shows the count, with the full list in a tooltip.
- A cancelled job says how many translations never started.

Translations of entries with custom Portable Text blocks that `blockFields` doesn't list now come with a notice naming those block types, because their text was copied from the source untranslated.

Server jobs can now **Update existing translations**, like browser runs. The queue consumer reads each existing translation's `_rev` before translating and saves with it, so a translation an editor saves meanwhile is skipped instead of overwritten. Updated rows count as **updated** in the job's progress. The queue consumer now also calls EmDash's `handleContentGet` and `handleContentUpdate`.

The server jobs list is easier to scan. Each job is a compact row named after its collection and start time, with a status badge, tooltips for locales, publishing and updating, and a bar split into created, updated, skipped and failed. Open a row to see the Entries, Results and Failures tabs. Entries open the source entry in the editor.
