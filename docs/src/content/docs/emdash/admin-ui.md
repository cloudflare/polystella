---
title: EmDash admin UI
description: The Kumo React panels — Catalog, Collections, Batch translation, Translation settings, Translation sandbox — and the content-editor translation panel.
aiGenerated: true
sidebar:
  label: Admin UI
---

The native admin adds a **PolyStella** sidebar group with three pages,
rendered with EmDash's Kumo design system:

- **Settings** (`/settings`) — the **Translation settings**,
  **Collections**, and **Sandbox** tabs. `?tab=translation`,
  `?tab=collections` or `?tab=sandbox` opens a tab directly.
- **Catalog** (`/catalog`).
- **Batch translation** (`/batch-translation`).

EmDash before 1.6 lists the three pages without the group. The old `/`
address still opens Settings. Links that open a new window show a ↗ icon.
After a translation, hover its result text (such as the sandbox's
translation time or a server job's progress count) to see the tokens
it used and an estimated cost. The cost uses the model's list price, so
it's an estimate, not an invoice; it's left out when the price is
unknown.
No generated plugin settings page is registered.

## Collections

Lets an Administrator enable project collections and choose their
translatable fields. Collections are listed under **Enabled** and
**Disabled**, by what is saved, so a row doesn't move while you
change it. An enabled row shows its fields as chips; **Edit** opens
**Fields to translate**, where each field is a toggle chip, with
**Select all** and **Clear all**. Turning a collection on opens it too. The source is always the code-defined
`catalogs.defaultLocale`; plugin settings display it but cannot change
it. Only fields the collection schema marks as translatable and of a
supported type (`string`, `text`, Portable Text, repeater) are offered.

A selected repeater's chip shows how many of its `string`, `text`, and
`image` subfields are picked, for example **FAQ · 2/3**; its caret opens
them in a popover. When the
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

A collection with no field PolyStella can translate says so, and its switch is off. Turning
a collection off and on again before saving keeps the fields you had
chosen. If one collection's schema fails to load, only its row shows
the error, and its saved policy is kept.

No collection is enabled until an Administrator saves a valid policy.
Missing or malformed stored policy fails closed — the collection is
simply not translated. At translation time the server also checks the
live collection schema (`schema:read`): a stored field that was
removed, changed type, or marked non-translatable is refused.

Saving is conditional on the settings revision you loaded. If another
Administrator saved in the meantime, the save is rejected; reload the
tab and reapply your change. The Translation settings tab behaves the
same way. On both tabs, **Saved** or the error shows next to the
**Save** button, and a tab that fails to load offers **Retry**.

## Batch translation

Translates many entries of one enabled collection at once, using the
same route and saves as the content-editor panel. Choose:

- **Entries** — entries you tick (the default) in a list of
  source-locale entries that shows each slug and searches by title or
  slug, or the whole collection. Ticked entries are listed under
  **… selected**, where **Remove** and **Clear selection** untick them,
  so the selection stays visible when you search for something else. For the whole collection, the right
  column shows how many source entries there are, how many are
  published, the fields that are translated, and per target locale how
  many entries are untranslated, with how many translations a run
  creates. When a run would do nothing, the run button is off and says
  why. With selected entries and **Update existing translations** off,
  the button is also off when every selected entry already has the
  chosen locales.
- **Target locales** — any of the configured non-default locales.
  None are ticked at first. **Select all** and **Clear all** change
  them together. With selected entries, **Select untranslated** ticks
  each locale that at least one selected entry has no translation for,
  or says they are all translated already.
- **Update existing translations** — off by default. When off, only
  missing locales are created and existing translations are skipped.
  When on, the collection's enabled fields are retranslated into
  existing translations and saved with EmDash's `_rev` token, so an
  entry edited during the run is skipped instead of overwritten.
- **Publish translations immediately** — off by default, so
  translations are saved as drafts. When on, each created or updated
  translation is published right after it is saved. If publishing
  fails, the draft stays and its result row says why.
- **Run settings** — closed at first; while closed it shows a badge for
  each change, and **Reset** clears them. Changes translation settings
  for this run only: one **Model** for every target locale (with its
  **Thinking**), **Max output tokens**, and **Additional instructions**
  added after the translation instructions. Anything left empty uses
  the translation settings. **Max output
  tokens** checks its 256–131,072 range as you type, and the run
  button stays off until it's fixed. If Translation settings can't be
  loaded, the fields show the error and a **Retry** button.

**Translate … in a new tab** opens a run page in a new browser tab, so
you can keep using the admin. The run page summarizes the run (entries,
translations, whether existing ones are skipped or updated, drafts or
published, and any run settings) and waits for **Start translating**. It runs in that tab, three
translations at a time: keep it open until it finishes, because
closing, reloading, or leaving it stops the run. **Stop** lets
in-flight translations finish and starts no new ones. When the run
ends, a green, amber or grey banner says whether it finished, finished
with failures, or stopped early, with the counts that aren't zero; an
error shows in red. After a stop or an error, **Translate the
… left** continues the translations that never started. Each entry and
locale gets a result row (created, updated, skipped, or failed) with
links that open in a new tab: **Edit**, **View live** for a published
translation, and **Preview draft** for an unpublished one. Rows show
100 at a time, with **Show more**. **Retry**
opens the run settings, filled in with the ones the run used, and
reruns the failed rows. **Also redo the translations this run created
or updated** translates them again and overwrites them; any that were
published, scheduled, or edited since are left alone. A browser
run holds at most 5,000 translations, like a server job; a larger one
is refused before it starts. A run page that was already
started, or never started within a day, can't be reopened. Debug
traces are not collected for batch runs.

When the deployment sets
[`batchQueueBinding`](/emdash/configuration/#batchqueuebinding), a
**Run in** choice adds **Server queue**. The job is queued on
Cloudflare Queues and keeps running after you close the tab. Server
jobs follow **Update existing translations** and **Publish
translations immediately** too. An update reads the translation's
`_rev` before translating and saves with it, so a translation an
editor saves meanwhile is skipped instead of overwritten.
The tab lists the last ten jobs under the run button. Each row is
named after the collection and the time the job started, with its
status, locales, entries, whether it publishes or updates existing
translations (hover for details), whether it is a retry (**Retry of**
the original job's start time while that job is still listed), its run
settings (hover for details), and a bar split into created,
updated, skipped and failed. A running job opens on its own; open any
other to see its tabs: **Entries** (the selected source entries, each
opening in the editor in a new tab), **Results** (every row with the
same links as browser runs, with **Refresh** to reload them after **Load more**), and
**Failures** (every failed row with its entry title, locale, reason
and an **Edit source** link). It also offers
**Cancel** (queued entries finish without translating; the job then
says how many translations didn't finish), **Retry** on a finished
or cancelled job, and **Remove**, which takes a finished or cancelled job off the list.
A retry is a new job, marked as a retry, with its own run settings: it
reruns the failed rows, on a cancelled job also the selected entries
that never ran, and, if you choose, redoes the translations the job
wrote, with the same checks as browser runs.
**Clear finished jobs** removes all of them; the translations they
created stay. Jobs older than 30 days are deleted
automatically when the list loads. The list refreshes every five
seconds while a job runs.

## Translation settings

A **General** card (default model, debug mode, max output tokens, the
AI-flag and SEO switches) and an **Additional translation instructions**
card sit side by side. Below them, each target locale has a card, closed at first,
with its own model and glossary behavior. Its header shows **Default**
when the language changes nothing, or **Custom** when it does; hover
the badge for the model, thinking and glossary it uses, or what it
changed.
The code-defined default locale is source-only and is not listed here.

- **Default model** (in General) — the model every language uses
  unless it picks its own, from `models.allowed`, with its own
  **Thinking** choice. Until you pick one, it shows the code fallback
  with a **From code** badge:
  `models.defaults` when the deployment sets it, otherwise the first
  model in `models.allowed`.
- **Translation model** — keep the default model, or pick another one
  from `models.allowed` for this language. A model outside `allowed`
  cannot be selected.
- **Thinking** — shown for the default model and when a language picks
  its own model. _No override_ (the code's `models.params` for the
  model apply), _Off_ when the model can turn thinking off, and each
  effort the model lists in the Workers AI catalog (or in
  `models.reasoningInput`). Changing the model resets it. A language on
  the default model uses the default model's thinking. With no default
  model set, the thinking set by `models.defaults` or `models.params`
  applies and is shown read-only.
- **Glossary behavior** — use the code glossary, append custom plain
  text, or replace the code glossary. Structured YAML stays
  code-defined; only `notes` can be appended or replaced.
- **Custom glossary** — plain text applied per the behavior above,
  up to 10,000 characters. Code-defined glossaries have no such cap:
  each request carries only the terms its text uses.
- **Additional translation instructions** — use code defaults, append,
  or replace the `rules` from configuration. They are sent with every
  translation in every language, together with that language's glossary.

**View code-defined additional translation instructions** and **View
code-defined glossary** open the code's text in a new window, with the
same append or replace controls and a **Save** button. The glossary
page has an **Overview** tab (**Don't translate** with a filter,
**Preferred translations**, **Style rules**, notes) and a **Raw** tab
with the glossary file as written; **Copy** copies it. A glossary set
inline in code, not loaded from a file, is shown as JSON. **Save** stays
off until you change something, and the browser asks before you leave
the page with unsaved text.

**Max output tokens** caps how much text the model may return per
request, for every translation. Leave it empty to use `provider.maxTokens`
from configuration (or `8192`). Raise it if long entries fail with
truncated responses; accepted values are 256 to 131,072. A value
outside that range is flagged under the field and turns **Save** off.

**Remove AI flag on edit** is
off by default, so edited AI text keeps its flag until an editor
decides in the content-editor panel. When on, saving different text in
any field PolyStella wrote removes the flag right away.

**Translate SEO on published entries** (the SEO title and meta
description of published and scheduled entries) is off by default. EmDash saves SEO text as soon as it changes, without
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

## Translation sandbox

Lets an Administrator translate up to 30,000 characters of freeform
text from `catalogs.defaultLocale` to any configured non-default
locale. Each request can select any model in `models.allowed` without
changing saved settings. The target locale's glossary and shared
instructions apply. **Additional instructions** (optional, up to 2,000
characters) are added to them for that request only and never saved.
Output stays in the browser and does not change
content, catalog overrides, or repository files. The source text and
the output sit side by side, below the locale and model choices.
Models are listed by short name, with the full ID under each option.
**Copy** copies the output, next to how long the translation took and
the output's character count. Text over the limit is flagged under the
source box. With no target locale or no allowed model, the tab says
so and links to Translation settings.

While it translates, the tab shows the current step over a progress
bar, and the button shows it's busy. The steps describe the browser's
request; EmDash plugin routes do not stream provider or batch progress.

## Content-editor panel

The panel appears for Editors and Administrators. It translates
selected `string`, `text`, Portable Text, `blocks` and repeater fields in an existing
target-locale draft — the source locale is the code-defined
`catalogs.defaultLocale`, and the target must differ from it. The
fields are toggle chips under **Fields to translate**, with **Select
all** and **Clear all**; one translation takes up to 25 fields. The
button names what it does, for example **Translate 3 fields**, and its
ⓘ says which entry it translates from. When a collection has no fields set up,
the panel links Administrators to the Collections tab.

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
form without saving, and keeps your other unsaved changes. The panel
asks you to review it before saving; EmDash's autosave may save it
within seconds.
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
**Translate SEO on published entries**. A source-locale entry doesn't offer them. A translated SEO
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
translations. With one locale and no warnings it opens the new draft;
otherwise the progress bar stays up when the run ends, and the created
drafts are listed under it with an **Open** button each. Failures and warnings are
listed per locale. Failed locales stay ticked so
**Retry** reruns only them. Locales that already have an entry aren't
offered, and if someone creates one in the meantime, the panel reports
it instead of creating a duplicate. With no target locale configured,
the panel says so instead.

On an AI-translated entry, the panel shows an **AI-translated** badge;
hover or click it for the time and model, and **Remove flag** sits
beside it. Once a person saves different text in a field
PolyStella wrote, it shows **Edited after AI translation** and the
changed fields, with **Keep AI flag** and **Remove AI flag**. When
PolyStella can't compare the fields (for example the entry has no
fingerprints), it shows **Couldn't check for edits** with both buttons.

A step list over a progress bar shows the panel's progress, from
loading the entry and translating to filling the form or saving.

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
  links Administrators to Settings, on the Collections tab. From 1.5 on, the section
  is hidden there.

## See also

- [Catalog overrides](/emdash/catalog-overrides/) — the Catalog page
  in more detail.
- [Configuration](/emdash/configuration/) — the deployment-side
  bounds these panels operate within.
