---
"@cloudflare/polystella-emdash": patch
---

Server batch jobs now report `status: "finished"` once every queued translation has a result, instead of staying `running`. A translation that was already running when its job was cancelled still saves, and its result row now says "Finished after the job was cancelled." The browser runner explains that **Stop** lets translations that already started finish, which can take minutes with a slow model. The editor panel rechecks the AI-translated flag when the tab regains focus and again shortly after a save, so a flag cleared by a save hook no longer needs a reload to disappear.
