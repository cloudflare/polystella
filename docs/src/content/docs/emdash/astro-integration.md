---
title: Astro integration
description: polystellaEmdashAstro — runtime catalog locals, EmDash override overlay, and fallback to deployed dictionaries.
aiGenerated: true
sidebar:
  label: Astro integration
---

`polystellaEmdashAstro()` is the companion Astro integration that
binds runtime catalog locals and overlays enabled EmDash overrides.
It replaces the standalone catalog integration: if
`catalogAstro()` is present, setup fails with a clear error.

## Setup

```ts
import { polystellaEmdashAstro } from "@cloudflare/polystella-emdash/astro";

export default defineConfig({
  integrations: [emdash({ plugins: [polystellaEmdash(polystellaOptions)] }), polystellaEmdashAstro(polystellaOptions)],
  i18n: { defaultLocale: "en-US", locales: ["en-US"] },
});
```

Keep `polystellaEmdashAstro()` **after** `emdash()` in the
integrations array; the order is enforced at `astro:config:done`.

## Locale contract

Astro's i18n locale set must exactly match `catalogs.locales`, and
`i18n.defaultLocale` must match `catalogs.defaultLocale`. The
integration reads `i18n.routing` to build locale-prefixed hrefs, so
`lhref` honors `prefixDefaultLocale` and custom locale paths.
For custom locale paths such as `{ path: "fr", codes: ["fr-FR"] }`,
catalogs use the codes. EmDash 1.3 stores new content under the path,
and the editor panel matches the two through EmDash's locale aliases.

## Runtime locals

The middleware binds three properties on `Astro.locals`:

- **`t(key, params?)`** — look up a UI string in the request's
  locale, falling back to the default catalog (and then the key
  itself) when `fallbackToDefault` is enabled.
- **`lhref(href)`** — locale-prefix an internal URL, idempotently.
- **`buildCatalogTranslator(locale?)`** — build a translator for an
  explicit locale.

Overrides are layered on top of the deployed dictionary: enabled
overrides from EmDash storage win; a failed storage read falls back
to the deployed dictionary. See [catalog
overrides](/emdash/catalog-overrides/) for the 60-second caching
behavior.

Flat and nested dictionaries use the same core normalization and
lookup as the main Astro catalog integration. EmDash adds only the
server override layer; nested groups still resolve through dotted
keys such as `t("nav.home")`.

## AI-translated flag

EmDash plugins cannot add fields to a collection, so PolyStella keeps
its own record of which entries its AI wrote. Read it with
`getEnrichedEntry` and `getEnrichedCollection`. They take the same
arguments as `getEmDashEntry` and `getEmDashCollection` and return the
same result, with `entry.polystella` added to each entry:

```astro
---
import { getEnrichedEntry } from "@cloudflare/polystella-emdash/content";

const { entry, cacheHint } = await getEnrichedEntry("posts", Astro.params.slug, { locale: Astro.currentLocale });
Astro.cache.set(cacheHint);
---

{entry?.polystella.aiTranslated && (
  <p>Translated by AI on {entry.polystella.aiTranslatedAt}.</p>
)}
```

| Field                           | Type             | Meaning                                              |
| ------------------------------- | ---------------- | ---------------------------------------------------- |
| `polystella.aiTranslated`       | `boolean`        | PolyStella's AI translated this entry.               |
| `polystella.aiTranslatedAt`     | `string \| null` | ISO time of the latest AI translation.               |
| `polystella.aiTranslationModel` | `string \| null` | Model the locale was configured to use at that time. |

- The flag is set whenever PolyStella saves a translation: from the
  content-editor panel, the Batch translation page, and server queue
  jobs. It is written before any publish. If only the flag fails to
  save, the translation stays saved and the panel or result row shows
  a warning.
- A human edit keeps the flag by default. PolyStella stores a
  fingerprint of each field it wrote, as saved, and the editor panel
  shows **Edited since AI translation** with the changed fields once
  one differs. The editor chooses **Keep AI flag** (the current text
  becomes the new baseline) or **Remove AI flag**. Changes to fields
  PolyStella didn't write never count; translating again sets the flag
  with the new time and model.
- **Remove the AI-translated flag when an editor changes AI text**
  in Translation settings removes it automatically instead, checked
  after every save and publish. Restoring an old revision is then
  checked when that revision is published, and writes by other plugins
  through `ctx.content.update` skip EmDash's save hooks until the next
  save or publish.
- The plugin's read-only `content:revisions:read` capability lets it
  fingerprint unpublished drafts.
- A locale that falls back to the source entry reads as not
  AI-translated, because the source entry has no record.
- If the record can't be read, the page still renders and the entry
  reads as not AI-translated; the error is logged.
- Reads use EmDash's object cache when the site configures one (for
  example `kvCache`): a single entry is cached by its id, a page of
  entries as one unit. Saving a flag clears them; other servers see the
  change within EmDash's revalidate window (1 second by default).
  Without an object cache, each entry or page is read once per request.

## Prerendering

Prerendered pages always use deployed dictionaries, so temporary
overrides cannot be baked into a build. The override overlay applies
only to on-demand (server) rendering.

## Other locales in server routes

For server routes that need a locale other than `Astro.currentLocale`,
reference the client types and use the request-bound factory:

```ts
/// <reference types="@cloudflare/polystella-emdash/client" />

const t = await Astro.locals.buildCatalogTranslator(locale);
```

## See also

- [Configuration](/emdash/configuration/) — `PolystellaEmdashOptions`
  and the `fallbackToDefault` runtime option.
- [Catalog overrides](/emdash/catalog-overrides/) — what the overlay
  reads and how it caches.
