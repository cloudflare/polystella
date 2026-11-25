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
supported type (`string`, `text`, Portable Text, repeater) are offered.

A repeater lists its `string`, `text`, and `image` subfields. When the
repeater is enabled, all are ticked except ones named like links, IDs or
authors (`url`, `href`, `slug`, `id`, `author_name`, ...). Only ticked subfields are translated; an
image translates its alt text and caption. Every other subfield (links,
numbers, unticked text) is copied from the source row. Unticking every
subfield turns the repeater off. The source entry is the source of
truth: retranslating an existing translation replaces its whole
repeater list with the translated source list, including items added or
removed in the source. Use EmDash revisions to restore an earlier
version. Images, blocks, SEO metadata, and
images inside Portable Text are not translated yet; select, URL, slug,
number, boolean, date, file, reference, and JSON fields hold no
translatable text.

Locales are shown by name and code, for example "French (fr)", in the
browser's language.

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

- **Entries** — entries you tick (the default) in a list of
  source-locale entries that shows each slug and searches by title or
  slug, or the whole collection. The run button appears above and
  below the list.
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
The tab lists the last ten jobs with their progress, whether they cover
the whole collection or selected entries (**Show entries** lists them),
the first failures, **Show results** (every row with the same links as browser
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
- **Thinking** — shown when a locale overrides the model. _No
  override_ (the code's `models.params` for the model apply), _Off_ when the model can turn thinking off, and each effort
  the model lists in the Workers AI catalog (or in
  `models.reasoningInput`). Changing the model resets it. With the code
  default model, the thinking set by `models.defaults` or
  `models.params` applies and is shown read-only.
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

**Translate the SEO title and meta description of published and scheduled entries**
is off by default. EmDash saves SEO text as soon as it changes, without
waiting for **Save** or **Publish**, so on a published or scheduled
entry a translation takes effect before anyone reviews it. Off, the
panel translates SEO text only on drafts. On, it also translates it on
published and scheduled entries.

**Debug mode** is a per-project switch. When enabled, content,
catalog, and sandbox translation traces include the effective model, batch
metrics, exact prompts, every provider attempt, normalized model
responses, parsed translations, validation issues, timings, and a
diagnostic ID. Each attempt also shows what Workers AI reported: the
finish reason, input and output tokens (with reasoning tokens when the
model counts them) and the size of any reasoning text. Traces are returned only to administrators, are not
stored server-side, and never include credentials, authorization
headers, account IDs, or raw provider HTTP envelopes.

Whether or not debug mode is on, every failure writes its diagnostic ID to the
server log with the full error message, its code and cause chain, and for an
unusable model reply the finish reason and reply field sizes. When the model
replied but the reply failed a check, the log also carries the finish reason,
token usage and reasoning size. Editors see only a
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
selected `string`, `text`, Portable Text, `blocks` and repeater fields in an existing
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

The private route rereads the source values through its `content:read`
capability, so the browser never supplies the values being
translated.

On EmDash 1.6 and later, the panel puts the translation into the open
form without saving, and keeps your other unsaved changes. Please
review the translation; EmDash's autosave may save it within seconds.
If you change one of the selected fields while PolyStella translates,
the form is left as it was and the panel asks you to translate again.
Edits to other fields are kept.
In a read-only editor (another editor holds the lock, or a version is
open), nothing is sent. In collections with revisions, the first save
after a translation keeps the draft from before it in **Revisions**, so
you can restore it. PolyStella marks each translated field AI-written
when a save first changes it; a field not saved within an hour is not
marked.

In collections with SEO, the panel also offers the **SEO title** and
**Meta description**. EmDash saves these at once, so on published and
scheduled entries they're off unless an Administrator turns on
**Translate the SEO title and meta description of published and
scheduled entries**. A source-locale entry doesn't offer them. A translated SEO
value longer than EmDash allows (200 or 500 characters) is left out, and
the panel says so. SEO text doesn't count toward the AI-translated flag.

On EmDash before 1.6, the panel saves the translated fields with
EmDash's `_rev` token and reloads. Unsaved changes are lost after
confirmation. If another editor has taken over the entry's edit lock,
the save is refused and the panel names the lock holder.

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

Named percentage stages show the panel's progress, from loading the
entry and translating to filling the form or saving.

On EmDash before 1.6, successful content traces survive the editor
reload in browser session storage for one view, so an Administrator can
inspect the trace after the panel reloads.

## EmDash limitations

- The source values always come from the latest saved source-locale
  entry. Only the open entry's form takes patches.
- Before EmDash 1.6, panels save the translation and reload, so
  unsaved changes are lost.
- Before EmDash 1.5, the PolyStella section shows on every collection.
  On collections not enabled in plugin settings, the panel says so and
  links Administrators to the Collections tab. From 1.5 on, the section
  is hidden there.

## See also

- [Catalog overrides](/emdash/catalog-overrides/) — the Catalog tab
  in more detail.
- [Configuration](/emdash/configuration/) — the deployment-side
  bounds these panels operate within.
