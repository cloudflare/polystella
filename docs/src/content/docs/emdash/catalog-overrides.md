---
title: Catalog overrides
description: Temporary per-key UI-string overrides, runtime enablement, caching, the public endpoint, and deterministic JSON export.
aiGenerated: true
sidebar:
  label: Catalog overrides
---

Repository JSON remains canonical. The **Catalog** page lets an
Administrator generate, edit, clear, inspect deployment state, and
export temporary per-key overrides on top of the deployed
dictionaries. Overrides are stored in EmDash, never in the
repository. The locale selector lists translation targets only;
`catalogs.defaultLocale` remains the source catalog.

## Catalog view

Entries are grouped by their first key segment. A group with an
`i18n_group_title` displays that title with the group key alongside;
groups without one fall back to the key. The left column lists the
groups alphabetically; click one to show its keys in the card on the
right. In a column narrower than 720px, a **Translation group** select
replaces the list and each key is a stacked row instead of a table
row. The first group opens on load. Within a group, keys are shown
without the group prefix. A search box above the list filters groups
by title or group key, and keys by key or source text; when a group's
own name matches, all its keys stay. An override's text box stays
closed behind **Edit** until you change it. The action bar is a card under the locale picker, with the number
of unsaved changes and a **Discard** button, and says why a disabled action is disabled. Source cells containing
`{{variables}}` placeholders show a question-mark icon before the text;
hovering or clicking it explains that overrides should retain those
placeholders. Saving an override that is not a valid
[catalog message](/concepts/catalog-messages/) for its source string
(lost placeholder, wrong plural branches, broken syntax) fails with a
400 that names the problem.

## Override states

Each entry in the catalog view is one of:

| State     | Meaning                                                            |
| --------- | ------------------------------------------------------------------ |
| `active`  | An override exists and differs from the current translation.       |
| `synced`  | An override exists and matches the current translation.            |
| `missing` | An override exists for a key absent from the current translations. |

The **Current translation** column shows what the deployed site
serves. The override switch shows whether an override exists. A
**Synced** or **Missing** badge marks the other two states, and
**Unsaved** marks a change you haven't saved.

**Clear synced overrides** deletes every `synced` override for the
selected locale in one step, typically after a deploy has absorbed
them. It reports how many it cleared. Any override edited while the
clear runs is kept and reported.

Saves are conditional: if another Administrator changed the same
override after you loaded the catalog, the save is rejected with a
conflict instead of overwriting their value. Select **Reload catalog**
and reapply.

## Runtime enablement

Runtime overrides are disabled per locale until an Administrator
explicitly enables them with **Apply overrides**. Opening the Catalog
page shows the saved setting and never changes it. The switch can be
turned on once the locale has a saved override; its ⓘ says what off
and on mean. A locale with runtime overrides disabled serves the
deployed dictionary untouched, and its saved overrides are faded and
marked **Not applied**.

## How the Astro integration reads them

`polystellaEmdashAstro()` reads enabled overrides directly from EmDash
storage and overlays them on the deployed dictionary. It caches each
locale's override dictionary for **60 seconds per database and Worker
isolate** — this is not an HTML or response cache.

- A write or runtime-toggle request handled by the same isolate
  invalidates that locale immediately.
- Other isolates can keep serving their previous dictionary until
  their own 60-second entry expires.
- A failed override read falls back to the deployed dictionary, and
  that fallback may also remain cached until expiry.

Application/CDN response caching is separate and can preserve
already-rendered HTML longer than 60 seconds. Purge that cache when
an override must be visible immediately.

## Public endpoint

The public `GET /_emdash/api/plugins/polystella/overrides?locale=<locale>`
remains available for other runtimes. Its separate HTTP cache policy
allows a response to be fresh for 60 seconds and served stale while
revalidating for another 300 seconds. The success envelope's `data`
is either:

```json
{ "enabled": false, "overrides": {} }
```

or an enabled envelope containing only stored overrides. Overlay
enabled values on the bundled locale dictionary; keep bundled JSON
as the fallback.

## Deterministic JSON export

The **Export JSON** action downloads the locale file with all
overrides applied. Output is deterministic: keys are sorted, values
are applied in sorted-key order, and the result is pretty-printed
with a trailing newline. The exported filename comes from the
configured `filePath`.

## Limits

- Overrides are validated against the union of default and target
  locale keys; unknown keys are rejected.
- Per-key override length is capped at 20,000 characters and the
  total across a locale at 100,000, distributed across keys.
- The catalog view and generation cap at 100 keys per request. The
  page shows how many are selected, and says when a group's selection
  is full.
- Keys matching [`catalog.ignoreKeys`](/emdash/configuration/#catalog)
  can't be overridden; JSON export keeps them as they are.
- Overrides are validated in the configured
  [`catalog.messageSyntax`](/emdash/configuration/#catalog) (`{{name}}`
  by default).

## See also

- [Admin UI](/emdash/admin-ui/) — the Catalog page and debug traces.
- [Astro integration](/emdash/astro-integration/) — how overrides
  reach `Astro.locals.t`.
