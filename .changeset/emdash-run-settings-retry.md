---
"@cloudflare/polystella-emdash": minor
---

Batch translation gets **Run settings**: for one run only, pick a model for every target locale (with its thinking level), a max output token limit, and extra instructions added to the prompt, such as "Don't translate product names". They work for browser runs and server queue jobs, and only administrators can set them.

**Retry...** on a finished or cancelled run replaces **Retry failed**. It opens those settings, filled in with the ones the run used, and reruns the failed rows. It can also redo the translations the run wrote, in place. Translations that were published, scheduled, or edited since are skipped. A server retry is a new job, marked as a retry of the original. Redone rows show as `updated`. The AI-translated flag now records the model the run actually used.
