---
title: EmDash plugin
description: "Native EmDash integration for PolyStella: content and sandbox translation, catalog overrides, and deterministic locale JSON."
aiGenerated: true
sidebar:
  label: Overview
---

`@cloudflare/polystella-emdash` is a native EmDash plugin for
PolyStella. It translates selected saved content fields inside the
EmDash content editor, provides a freeform translation sandbox,
manages temporary UI-string overrides, and exports deterministic
locale JSON. Deployment configuration owns the default locale and
bounds available locales and models; administrators own enabled
collections and field policies.

## Install

The package is installed alongside the EmDash plugin host and a
companion Astro integration:

```sh
pnpm add @cloudflare/polystella-emdash
```

Peer dependencies you already have in an EmDash + Astro project:
`emdash` `^0.36.0`, `@emdash-cms/admin` `^0.36.0`,
`@cloudflare/kumo` `^2.6.0`, `react`, and `astro` `^7.0.10`.

## Setup

Register `polystellaEmdash()` in the EmDash plugin list and
`polystellaEmdashAstro()` in the Astro integration list. Keep
`polystellaEmdashAstro()` **after** `emdash()`.

```ts
import { polystellaEmdash, type PolystellaEmdashOptions } from "@cloudflare/polystella-emdash";
import { polystellaEmdashAstro } from "@cloudflare/polystella-emdash/astro";
import { loadGlossaryDefaults } from "@cloudflare/polystella-emdash/config";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";

const polystellaOptions = {
  provider: { kind: "workers-ai-binding", binding: "AI" },
  catalogs: {
    defaultLocale: "en-US",
    locales: {
      "en-US": {
        dictionary: { greeting: "Hello" },
        filePath: "src/i18n/en-US.json",
      },
    },
  },
  models: {
    allowed: ["@cf/zai-org/glm-4.7-flash"],
    defaults: {
      default: "@cf/zai-org/glm-4.7-flash",
    },
  },
  glossaryDefaults: await loadGlossaryDefaults({
    locales: ["en-US"],
    file: "./src/i18n/glossary/{locale}.yaml",
    projectRoot: new URL(".", import.meta.url),
  }),
} satisfies PolystellaEmdashOptions;

export default defineConfig({
  integrations: [emdash({ plugins: [polystellaEmdash(polystellaOptions)] }), polystellaEmdashAstro(polystellaOptions)],
  i18n: { defaultLocale: "en-US", locales: ["en-US"] },
});
```

`polystellaEmdashAstro()` binds `Astro.locals.t` and
`Astro.locals.lhref`, overlays enabled EmDash overrides, and falls
back to the deployed dictionaries when storage is unavailable.
Configure the named Workers AI binding on the EmDash deployment.

Astro's i18n locale set must exactly match `catalogs`. Prerendered
pages always use deployed dictionaries so temporary overrides cannot
be baked into a build.

For Workers AI over HTTP, use runtime environment variable names
instead of literal credentials:

```ts
provider: {
  kind: "workers-ai-http",
  accountIdEnv: "CLOUDFLARE_ACCOUNT_ID",
  apiTokenEnv: "CLOUDFLARE_WORKERS_AI_TOKEN",
}
```

## Architecture: who owns what

The plugin splits authority between deployment configuration and
administrator policy.

**Server-owned (code, cannot be changed from the admin UI):**

- Provider credentials and the Workers AI binding.
- The default locale, locale set, and per-locale dictionaries
  (`catalogs`).
- `models.allowed` — administrators cannot select a model outside
  this list.
- Structured glossary YAML defaults and code-defined translation
  instructions (`rules`).

**Administrator-owned (EmDash admin UI, stored per project):**

- Which collections are enabled for translation and which fields are
  translatable.
- The per-target-locale model (within `models.allowed`) and glossary
  behavior: use the code default, append plain text, or replace it.
- Shared instruction customization (append or replace).
- Whether runtime overrides are enabled per locale.

`models.defaults` may set a `default` fallback and locale-specific
models. Each target locale receives its own model and glossary
settings. Administrators can use the deployment glossary unchanged
or append/replace `Glossary.notes` with plain text; structured YAML
remains code-defined.

## What the plugin installs

- One native admin page (**PolyStella**) with **Catalog**,
  **Collections**, **Translation settings**, and **Translation
  sandbox** tabs, rendered with EmDash's Kumo design system. No
  generated plugin settings page is registered.
- A content-editor panel that translates selected fields in an
  existing target-locale draft.
- An administrator-only freeform sandbox that translates from the
  code-defined default locale with a per-request allowlisted model,
  without saving its output or model choice.
- A `polystella` binary that hosts `check-ui`, `sync-ui`, and
  `translate-ui`, retaining the Astro CLI's config and flags.
- A public overrides endpoint for other runtimes.

Translation actions show named percentage stages. Content translation
tracks its load, provider, and save requests; catalog and sandbox
translation show their provider stage and a 100% completion state.
The routes do not stream batch-level progress.

## EmDash 0.36 limitations

- Panels use the latest saved entry, not unsaved form state.
- EmDash leaves an empty PolyStella section on collections disabled
  in plugin settings because panel visibility cannot be resolved
  asynchronously.
- EmDash does not expose authoritative collection schema metadata to
  plugin routes. The server enforces the stored collection/field
  policy and saved value shapes; administrators must revisit the
  **Collections** tab after schema changes.

## See also

- [Configuration](/emdash/configuration/) — `PolystellaEmdashOptions`.
- [Admin UI](/emdash/admin-ui/) — the Kumo React panels.
- [Catalog overrides](/emdash/catalog-overrides/) — temporary
  UI-string overrides and JSON export.
- [Astro integration](/emdash/astro-integration/) — runtime catalog
  locals.
- [CLI](/emdash/cli/) — the EmDash CLI host.
