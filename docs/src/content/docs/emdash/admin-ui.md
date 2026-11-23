---
title: EmDash admin UI
description: The Kumo React panels — Catalog, Collections, Batch translation, Translation settings, Translation sandbox — and the content-editor translation panel.
aiGenerated: true
sidebar:
  label: Admin UI
---

The native admin registers one **PolyStella** page with five tabs —
**Catalog**, **Collections**, **Batch translation**, **Translation
settings**, and **Translation sandbox** — rendered with EmDash's Kumo
design system. No generated plugin settings page is registered.

## Collections tab

Lets an Administrator enable project collections and choose their
translatable fields. The source is always the code-defined
`catalogs.defaultLocale`; plugin settings display it but cannot change
it. Only fields the collection schema marks as translatable and of a
supported type (`string`, `text`, Portable Text) are offered.

No collection is enabled until an Administrator saves a valid policy.
Missing or malformed stored policy fails closed — the collection is
simply not translated. At translation time the server also checks the
live collection schema (`schema:read`): a stored field that was
removed, changed type, or marked non-translatable is refused.

Saving is conditional on the settings revision you loaded. If another
Administrator saved in the meantime, the save is rejected; reload the
tab and reapply your change. The Translation settings tab behaves the
same way.

## Batch translation tab

Translates many entries of one enabled collection at once, using the
same route and saves as the content-editor panel. Choose:

- **Entries** — the whole collection, or entries you tick in a list
  of source-locale entries that shows each slug and searches by
  title or slug.
- **Target locales** — any of the configured non-default locales.
  None are ticked at first. **Select all** and **Clear all** change
  them together. With selected entries, **Select untranslated** ticks
  each locale that at least one selected entry has no translation for.
- **Update existing translations** — off by default. When off, only
  missing locales are created and existing translations are skipped.
  When on, the collection's enabled fields are retranslated into
  existing translations and saved with EmDash's `_rev` token, so an
  entry edited during the run is skipped instead of overwritten.
- **Publish translations immediately** — off by default, so
  translations are saved as drafts. When on, each created or updated
  translation is published right after it is saved. If publishing
  fails, the draft stays and its result row says why.

**Translate … in a new tab** opens a run page in a new browser tab, so
you can keep using the admin. The run page shows what it will do and
waits for **Start translating**. It runs in that tab, three
translations at a time: keep it open until it finishes, because
closing, reloading, or leaving it stops the run. **Stop** lets
in-flight translations finish and starts no new ones. Each entry and
locale gets a result row (created, updated, skipped, or failed) with
links that open in a new tab: **Edit**, **View live** for a published
translation, and **Preview draft** for an unpublished one. **Retry
failed** reruns only the failed rows. A run page that was already
started, or never started within a day, can't be reopened. Debug
traces are not collected for batch runs.

When the deployment sets
[`batchQueueBinding`](/emdash/configuration/#batchqueuebinding), a
**Run in** choice adds **Server queue**. The job is queued on
Cloudflare Queues and keeps running after you close the tab. Server
jobs only create missing translations; existing ones are skipped.
They follow **Publish translations immediately** too.
The tab lists the last ten jobs with their progress, the first
failures, **Show results** (every row with the same links as browser
runs), **Cancel** (queued entries finish without translating), and
**Retry failed**. **Remove** takes a finished or cancelled job off the
list, and **Clear finished jobs** removes all of them; the
translations they created stay. Jobs older than 30 days are deleted
automatically when the list loads. The list refreshes every five
seconds while a job runs.

## Translation settings tab

Target-locale settings, each with its own model and glossary behavior. The
code-defined default locale is source-only and is not listed here:

- **Translation model** — pick from `models.allowed`, or keep the
  code default (`models.defaults`). A model outside `allowed` cannot
  be selected.
- **Glossary behavior** — use the code default, append custom plain
  text, or replace the code glossary. Structured YAML stays
  code-defined; only `notes` can be appended or replaced.
- **Custom glossary** — plain text applied per the behavior above,
  up to 10,000 characters. Code-defined glossaries have no such cap:
  each request carries only the terms its text uses.
- **Shared translation instructions** — use code defaults, append,
  or replace the `rules` from configuration.

**Max output tokens** caps how much text the model may return per
request, for every translation. Leave it empty to use `provider.maxTokens`
from configuration (or `8192`). Raise it if long entries fail with
truncated responses; accepted values are 256 to 131,072.

**Remove the AI-translated flag when an editor changes AI text** is
off by default, so edited AI text keeps its flag until an editor
decides in the content-editor panel. When on, saving different text in
any field PolyStella wrote removes the flag right away.

**Debug mode** is a per-project switch. When enabled, content,
catalog, and sandbox translation traces include the effective model, batch
metrics, exact prompts, every provider attempt, normalized model
responses, parsed translations, validation issues, timings, and a
diagnostic ID. Traces are returned only to administrators, are not
stored server-side, and never include credentials, authorization
headers, account IDs, or raw provider HTTP envelopes.

Whether or not debug mode is on, every failure writes its diagnostic ID to the
server log with the full error message, its code and cause chain, and for an
unusable model reply the finish reason and reply field sizes. Editors see only a
short, safe message and the same ID.

## Translation sandbox tab

Lets an Administrator translate up to 30,000 characters of freeform
text from `catalogs.defaultLocale` to any configured non-default
locale. Each request can select any model in `models.allowed` without
changing saved settings. The target locale's glossary and shared
instructions apply. Output stays in the browser and does not change
content, catalog overrides, or repository files.

The tab shows a named percentage stage while translation runs and a
100% completion state. These percentages describe client request
stages; EmDash plugin routes do not stream provider or batch progress.

## Content-editor panel

The panel appears for Editors and Administrators. It translates
selected `string`, `text`, Portable Text and `blocks` fields in an existing
target-locale draft — the source locale is the code-defined
`catalogs.defaultLocale`, and the target must differ from it.

After a translation, the panel lists any same-page links (`#…`) in the
translated fields for review instead of reloading. EmDash gives headings
no ids, so each site builds its own, often from the heading text. A
translated heading can then get a different anchor than the copied link,
and PolyStella can't know the site's rule. Batch results show the same
note on each created entry.

Long entries are translated in parts of up to 30,000 characters and 500
text segments, one request per part; the panel shows which part is
running, and queued batch jobs translate one part per queue message. An
entry can hold up to 500,000 characters and 5,000 segments. If the source
changes between parts, the translation stops and asks to start again.

The private route rereads selected values through its `content:read`
capability, so the browser never supplies the values being
translated. The panel updates the draft with EmDash's `_rev` token
and reloads after success. Unsaved browser changes are not translated
and are lost after confirmation. If another editor has taken over the
entry's edit lock, the save is refused and the panel names the lock
holder.

On a source-locale entry, the panel creates missing translations
instead. Tick one or more locales that have no entry yet (or
**Select all**) and the fields to translate, then select **Create
drafts**. The panel creates each draft in turn, as you, the same way
EmDash's own **Create translation** button does: it copies the source
entry and slug and replaces the selected fields with their
translations. With one locale it opens the new draft; with several it
lists them with an **Open** button each. Failed locales stay ticked so
**Retry** reruns only them. Locales that already have an entry aren't
offered, and if someone creates one in the meantime, the panel reports
it instead of creating a duplicate.

On an AI-translated entry, the panel shows **AI-translated** with the
time and model. Once a person saves different text in a field
PolyStella wrote, it shows **Edited since AI translation** and the
changed fields, with **Keep AI flag** and **Remove AI flag**.

Named percentage stages show when the panel is loading the latest
saved entry, translating selected fields, and saving the patch.

Successful content traces survive the existing editor reload in
browser session storage for one view, so an Administrator can inspect
the trace after the panel reloads.

## EmDash limitations

- Panels use the latest saved entry, not unsaved form state.
- EmDash shows the PolyStella section on every collection because
  panel visibility cannot be resolved asynchronously. On collections
  not enabled in plugin settings, the panel says so and links
  Administrators to the Collections tab.

## See also

- [Catalog overrides](/emdash/catalog-overrides/) — the Catalog tab
  in more detail.
- [Configuration](/emdash/configuration/) — the deployment-side
  bounds these panels operate within.
