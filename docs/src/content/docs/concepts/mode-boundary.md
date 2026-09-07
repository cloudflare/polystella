---
title: Mode boundary
description: Standalone, Starlight, and catalog-only modes — what differs between them.
aiGenerated: true
---

PolyStella ships **standalone mode** and **catalog-only mode** today.
**Starlight mode** is planned but not yet implemented; declaring
`mode: "starlight"` is rejected at config-parse time.

## Standalone mode

The default. PolyStella owns:

- **Routing.** Generates locale-prefixed route shims under
  `<cacheDir>/polystella-shims/` and injects them via
  `astro:config:setup`'s `injectRoute` API.
- **`Astro.locals.t`.** The middleware looks up UI strings via
  the `i18n` content collection.
- **The `LocalePicker` component.** Exported from
  `polystella/components/LocalePicker.astro`.

This works for any Astro project. No assumptions about other
integrations.

## Catalog-only mode

A third adoption path for projects that only want UI-string
catalogs. Install the catalog-only integration from
`@cloudflare/polystella-astro/catalog/astro`; it binds only
`Astro.locals.t` and `Astro.locals.lhref` over JSON UI-string
dictionaries.

Catalog-only mode owns:

- **`Astro.locals.t` / `Astro.locals.lhref`.** The catalog-only
  middleware binds just these two locals.
- **JSON dictionary helpers.** Lookup, fallback, and interpolation
  over per-locale JSON files.

It does NOT own:

- Content translation, the R2 cache, or routing shims. No content
  collections are touched; the catalog-only integration is pure and
  imports nothing from the full pipeline.

## Starlight mode (planned)

When your project uses Starlight, defer to Starlight's own
infrastructure for the parts it already owns:

- **Routing** — Starlight has its own routing system. PolyStella
  should NOT inject shims; Starlette page templates render the
  per-locale sibling content via Starlight's normal routing.
- **`Astro.locals.t`** — Starlight's i18next-backed `t` is
  reused; PolyStella's middleware skips installing its own.

PolyStella still owns:

- Content translation (file-based + custom loaders).
- The R2 cache.
- `getLocalizedEntry` / `getLocalizedCollection` — these are
  PolyStella's API, not Starlight's.

## Why the mode is config-level

The integration could try to auto-detect Starlight at
`config:setup` time. But:

- Auto-detection breaks when Starlight is partially configured
  (e.g. only a few routes are Starlight pages).
- The mode affects the route-shim story dramatically; an operator
  flipping between "real" projects and "test fixture" projects
  needs the predictability of explicit mode declaration.
- The Starlight version matters; we'd have to negotiate API
  surface across versions.

Explicit `mode` is one boolean knob. Auto-detect is many edge
cases.

## Current rejection

If you set `mode: "starlight"` today, config validation throws:

```text
[polystella] configuration error:
  - mode: "starlight" is not yet supported. Use "standalone" or
    omit `mode` for the default "auto".
```

The "auto" default resolves to "standalone" today.

When Starlight mode ships, "auto" will detect Starlight via
`config.integrations.some(i => i.name === "@astrojs/starlight")`
and pick the right mode. Setting `mode: "standalone"` explicitly
will continue to work and override the auto-detection.
