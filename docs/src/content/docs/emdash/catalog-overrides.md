---
title: Catalog overrides
description: Temporary per-key UI-string overrides, runtime enablement, caching, the public endpoint, and deterministic JSON export.
aiGenerated: true
sidebar:
  label: Catalog overrides
---

Repository JSON remains canonical. The **Catalog** tab lets an
Administrator generate, edit, clear, inspect deployment state, and
export temporary per-key overrides on top of the deployed
dictionaries. Overrides are stored in EmDash, never in the
repository.

## Override states

Each entry in the catalog view is one of:

| State     | Meaning                                                           |
| --------- | ----------------------------------------------------------------- |
| `active`  | An override exists and differs from the deployed value.           |
| `synced`  | An override exists and matches the deployed value.                |
| `missing` | An override exists for a key absent from the deployed dictionary. |

## Runtime enablement

Runtime overrides are disabled per locale until an Administrator
explicitly enables them. A locale with runtime overrides disabled
serves the deployed dictionary untouched.

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
- The catalog view and generation cap at 100 keys per request.

## See also

- [Admin UI](/emdash/admin-ui/) — the Catalog tab and debug traces.
- [Astro integration](/emdash/astro-integration/) — how overrides
  reach `Astro.locals.t`.
