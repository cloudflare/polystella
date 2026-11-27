---
title: Configuration overview
description: Where polystella.config.mjs sits and how it relates to astro.config.mjs.
aiGenerated: true
sidebar:
  label: Overview
---

PolyStella's configuration lives in two files. Knowing which goes
where avoids a lot of confusion:

| Where                     | What lives there                                       |
| ------------------------- | ------------------------------------------------------ |
| `astro.config.mjs` `i18n` | `defaultLocale`, `locales`, Astro's i18n routing knobs |
| `polystella.config.mjs`   | Everything else: provider, R2, glossary, format keys   |

The split is deliberate. `i18n` is Astro's domain — every Astro
integration that cares about locales reads it from there, and the
build's URL routing flows through it. PolyStella reads it too, but
doesn't own it; you only declare your locale set once.

`polystella.config.mjs` exports a default object whose shape is the
schema documented in the
[full reference](/configuration/reference/). All fields are
optional in the sense that the schema has defaults, but you'll
need to set at minimum:

- `provider` — credentials for Workers AI or Anthropic.
- `r2` — credentials for the build cache (or omit for an
  uncached, dev-only setup).
- `markdown.keys` (or whichever adapter's `keys`) — which
  frontmatter fields to translate.

A minimal config:

```js
// polystella.config.mjs
export default {
  provider: {
    kind: "workers-ai",
    accountId: process.env.CF_ACCOUNT_ID,
    apiToken: process.env.CF_API_TOKEN,
    model: "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
  },
  r2: {
    accountId: process.env.CF_ACCOUNT_ID,
    bucket: "my-i18n-cache",
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  markdown: {
    keys: { "publications/**": ["title", "metaDescription"] },
  },
};
```

## Validation and errors

The config is parsed through zod at integration startup
(`resolveOptions` in `packages/astro/src/config/options.ts`). Bad input fails the
build with a concrete error pointing at the offending field — no
silent fallbacks. A few specific cross-checks:

- `defaultLocale` must appear in `locales`.
- The same key path can't appear in both `<format>.keys` and
  `<format>.urls` for the same glob — that would double-process the
  field.
- `mode: "starlight"` is rejected at parse time; that mode is
  planned but not yet shipped.

## Catalog options

The `catalog` block holds options for UI-string catalogs
(`src/content/i18n/<locale>.json`). It is read **only from
`polystella.config.mjs`**: by `sync-ui`, `check-ui` and `translate-ui`,
by the build's drift check, by `Astro.locals.t`, and by `catalogAstro()`.
`polystella()` accepts the key so you can pass the same config object to
it, but `catalog` options written inline in `astro.config.mjs` have no
effect (the integration warns). The standalone `i18nSchema()` helper
doesn't read it. The EmDash plugin can't read the file either, so it
takes the same block as its own
[`catalog` option](/emdash/configuration/#catalog).

`catalog.messageSyntax` picks how placeholders are written:
`"polystella"` (default) for `{{name}}`, or `"icu"` for standard ICU
MessageFormat (`{name}`). See
[Standard ICU syntax](/concepts/catalog-messages/#standard-icu-syntax).

`catalog.ignoreKeys` is a list of regex strings for entries that are
not messages, such as the `$schema` key that inlang / Paraglide message
files carry:

```js
// polystella.config.mjs
export default {
  catalog: {
    ignoreKeys: ["\\$schema", "internal\\..*"],
  },
};
```

- Each pattern must match the **whole** dotted key: `"\\$schema"`
  matches only `$schema`, `"internal\\..*"` every key under `internal`.
  Write strings, not `RegExp` objects.
- A pattern that matches a group (`"internal"`) skips the whole group.
- Ignored entries are never synced, checked or translated, and their
  value can be anything (an inlang variant message is an array).
- Ignored entries already in a locale file are kept as they are; the
  commands never add one, except a top-level `$schema` from the
  default-locale file, which is copied in first.
- An invalid pattern fails at config load.

## Branch-aware configuration

PolyStella reads `WORKERS_CI_BRANCH` from the environment. Workers
Builds exports this automatically. Your config can use it to switch
R2 prefixes:

```js
const branch = process.env.WORKERS_CI_BRANCH ?? "local";

export default {
  r2: {
    // ...
    prefix: branch === "main" ? "i18n/" : `previews/${branch}/i18n/`,
    readFallbackPrefixes: branch === "main" ? [] : ["i18n/"],
    readOnly: branch !== "main" && !process.env.POLYSTELLA_CLI,
  },
};
```

The [branch-dispatch operations page](/operations/branch-dispatch/)
covers the patterns. See also [preview
isolation](/operations/preview-isolation/) for how `readOnly` plus
`readFallbackPrefixes` give preview branches the production cache
without polluting it.

## Schema source of truth

The [reference page](/configuration/reference/) is **auto-generated**
from `packages/astro/src/config/options.ts` on every docs build. If you spot a
field there that isn't documented, it's a generator gap, not a
hidden feature — file an issue.
