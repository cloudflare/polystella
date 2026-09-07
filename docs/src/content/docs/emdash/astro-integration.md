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
