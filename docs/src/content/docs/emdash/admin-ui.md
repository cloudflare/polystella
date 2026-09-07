---
title: EmDash admin UI
description: The Kumo React panels — Catalog, Collections, Translation settings — and the content-editor translation panel.
aiGenerated: true
sidebar:
  label: Admin UI
---

The native admin registers one **PolyStella** page with three tabs —
**Catalog**, **Collections**, and **Translation settings** — rendered
with EmDash's Kumo design system. No generated plugin settings page
is registered.

## Collections tab

Lets an Administrator enable project collections and choose their
source locale and translatable fields. Only fields the collection
schema marks as translatable and of a supported type (`string`,
`text`, Portable Text) are offered.

No collection is enabled until an Administrator saves a valid policy.
Missing or malformed stored policy fails closed — the collection is
simply not translated. The server enforces the stored
collection/field policy and saved value shapes, so revisit this tab
after schema changes (EmDash does not expose authoritative schema
metadata to plugin routes).

## Translation settings tab

Per-locale settings, each with its own model and glossary behavior:

- **Translation model** — pick from `models.allowed`, or keep the
  code default (`models.defaults`). A model outside `allowed` cannot
  be selected.
- **Glossary behavior** — use the code default, append custom plain
  text, or replace the code glossary. Structured YAML stays
  code-defined; only `notes` can be appended or replaced.
- **Custom glossary** — plain text applied per the behavior above.
- **Shared translation instructions** — use code defaults, append,
  or replace the `rules` from configuration.

**Debug mode** is a per-project switch. When enabled, content and
catalog translation traces include the effective model, batch
metrics, exact prompts, every provider attempt, normalized model
responses, parsed translations, validation issues, timings, and a
diagnostic ID. Traces are returned only to administrators, are not
stored server-side, and never include credentials, authorization
headers, account IDs, or raw provider HTTP envelopes.

## Content-editor panel

The panel appears for Editors and Administrators. It translates
selected `string`, `text`, and Portable Text fields in an existing
target-locale draft — the source locale is the collection's policy
source, and the target must differ from it.

The private route rereads selected values through its `content:read`
capability, so the browser never supplies the values being
translated. The panel updates the draft with EmDash's `_rev` token
and reloads after success. Unsaved browser changes are not translated
and are lost after confirmation.

Successful content traces survive the existing editor reload in
browser session storage for one view, so an Administrator can inspect
the trace after the panel reloads.

## EmDash 0.36 limitations

- Panels use the latest saved entry, not unsaved form state.
- EmDash leaves an empty PolyStella section on collections disabled
  in plugin settings because panel visibility cannot be resolved
  asynchronously.
- EmDash does not expose authoritative collection schema metadata to
  plugin routes; the server enforces the stored policy.

## See also

- [Catalog overrides](/emdash/catalog-overrides/) — the Catalog tab
  in more detail.
- [Configuration](/emdash/configuration/) — the deployment-side
  bounds these panels operate within.
