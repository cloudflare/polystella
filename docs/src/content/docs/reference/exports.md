---
title: Public exports
description: "Every export path across the seven public packages, with ownership and import examples."
aiGenerated: true
---

PolyStella ships forty-three public import paths across seven packages.
The canonical Astro package, `@cloudflare/polystella-astro`, is also
available through the `@cloudflare/polystella` compatibility package; both expose
the same API.

| Owner     | Path                                              | Purpose                                                                                                   | Example                                                                                        |
| --------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Core      | `@cloudflare/polystella-core`                     | `Segment`, glossary and translator contracts, prompts, batching, parsing provider responses, and retries. | `import { translateSegments } from "@cloudflare/polystella-core";`                             |
| Core      | `@cloudflare/polystella-core/catalog`             | Dependency-free catalog lookup, fallback, and interpolation.                                              | `import { buildTranslateFn } from "@cloudflare/polystella-core/catalog";`                      |
| Core      | `@cloudflare/polystella-core/catalog/translate`   | Selected-entry catalog AI translation and `{{token}}` validation.                                         | `import { translateCatalogEntries } from "@cloudflare/polystella-core/catalog/translate";`     |
| Adapters  | `@cloudflare/polystella-adapters`                 | Portable Markdown, MDX, JSON, YAML, and TOML adapters plus parser and key-path helpers.                   | `import { jsonAdapter } from "@cloudflare/polystella-adapters";`                               |
| Providers | `@cloudflare/polystella-providers`                | All provider factories from one entrypoint.                                                               | `import { createWorkersAIBindingTranslator } from "@cloudflare/polystella-providers";`         |
| Providers | `@cloudflare/polystella-providers/workers-ai`     | Workers AI HTTP and binding factories plus their structural input types.                                  | `import { createWorkersAIHttpTranslator } from "@cloudflare/polystella-providers/workers-ai";` |
| Providers | `@cloudflare/polystella-providers/anthropic`      | Anthropic HTTP factory.                                                                                   | `import { createAnthropicTranslator } from "@cloudflare/polystella-providers/anthropic";`      |
| CLI       | `@cloudflare/polystella-cli`                      | Shared Node.js catalog commands and filesystem utilities.                                                 | `import { runCheckUi } from "@cloudflare/polystella-cli";`                                     |
| CLI       | `@cloudflare/polystella-cli/check-ui`             | Catalog drift command parser and handler.                                                                 | `import { runCheckUi } from "@cloudflare/polystella-cli/check-ui";`                            |
| CLI       | `@cloudflare/polystella-cli/config`               | Narrow config loader used by catalog commands.                                                            | `import { loadConfig } from "@cloudflare/polystella-cli/config";`                              |
| CLI       | `@cloudflare/polystella-cli/drift`                | Catalog drift detection and formatting.                                                                   | `import { loadAndCheckDrift } from "@cloudflare/polystella-cli/drift";`                        |
| CLI       | `@cloudflare/polystella-cli/glossary`             | Node.js YAML glossary loading.                                                                            | `import { loadGlossaries } from "@cloudflare/polystella-cli/glossary";`                        |
| CLI       | `@cloudflare/polystella-cli/run-command`          | Shared dispatch for catalog CLI hosts.                                                                    | `import { runCatalogCommand } from "@cloudflare/polystella-cli/run-command";`                  |
| CLI       | `@cloudflare/polystella-cli/sync`                 | Catalog key reconciliation and layout-aware writing.                                                      | `import { syncUi } from "@cloudflare/polystella-cli/sync";`                                    |
| CLI       | `@cloudflare/polystella-cli/sync-ui`              | Catalog sync command parser and handler.                                                                  | `import { runSyncUi } from "@cloudflare/polystella-cli/sync-ui";`                              |
| CLI       | `@cloudflare/polystella-cli/translate-ui`         | Catalog AI translation command parser and handler.                                                        | `import { runTranslateUi } from "@cloudflare/polystella-cli/translate-ui";`                    |
| EmDash    | `@cloudflare/polystella-emdash`                   | Native EmDash descriptor, routes, deployment policy validation, and catalog override helpers.             | `import { polystellaEmdash } from "@cloudflare/polystella-emdash";`                            |
| EmDash    | `@cloudflare/polystella-emdash/admin`             | Native React catalog, settings, and content-editor panel entry consumed by EmDash.                        | `import { contentEditorPanels } from "@cloudflare/polystella-emdash/admin";`                   |
| EmDash    | `@cloudflare/polystella-emdash/config`            | Deployment-time YAML glossary loading.                                                                    | `import { loadGlossaryDefaults } from "@cloudflare/polystella-emdash/config";`                 |
| Astro     | `@cloudflare/polystella-astro`                    | Default export: the Astro integration factory and Astro-owned host utilities.                             | `import polystella from "@cloudflare/polystella-astro";`                                       |
| Astro     | `@cloudflare/polystella-astro/content`            | Content-config helpers: `polystellaCollections`, `file`, `polystellaLoader`.                              | `import { polystellaCollections } from "@cloudflare/polystella-astro/content";`                |
| Astro     | `@cloudflare/polystella-astro/runtime`            | Runtime API: `getLocalizedEntry`, `getLocalizedCollection`, `localizedHref`, `polystellaMiddleware`.      | `import { localizedHref } from "@cloudflare/polystella-astro/runtime";`                        |
| Astro     | `@cloudflare/polystella-astro/runtime/middleware` | Direct middleware entrypoint used by the integration. Rarely imported by consumers.                       | `import { polystellaMiddleware } from "@cloudflare/polystella-astro/runtime/middleware";`      |
| Astro     | `@cloudflare/polystella-astro/i18n`               | UI-string glue: `i18nLoader`, `i18nSchema`, `getTranslations`, `getDictionary`, drift helpers.            | `import { getDictionary } from "@cloudflare/polystella-astro/i18n";`                           |
| Astro     | `@cloudflare/polystella-astro/catalog`            | Pure catalog helpers for JSON UI-string dictionaries.                                                     | `import { buildTranslateFn } from "@cloudflare/polystella-astro/catalog";`                     |
| Astro     | `@cloudflare/polystella-astro/catalog/middleware` | Catalog-only middleware that binds `Astro.locals.t` and `Astro.locals.lhref`.                             | `import { catalogMiddleware } from "@cloudflare/polystella-astro/catalog/middleware";`         |
| Astro     | `@cloudflare/polystella-astro/catalog/astro`      | Catalog-only Astro integration factory.                                                                   | `import catalogAstro from "@cloudflare/polystella-astro/catalog/astro";`                       |
| Astro     | `@cloudflare/polystella-astro/react`              | React hooks: `useTranslations`, `useLocalizedHref` for islands.                                           | `import { useTranslations } from "@cloudflare/polystella-astro/react";`                        |
| Astro     | `@cloudflare/polystella-astro/recipes`            | MDX recipe helpers and built-in recipes.                                                                  | `import { defineMdxRecipe } from "@cloudflare/polystella-astro/recipes";`                      |
| Astro     | `@cloudflare/polystella-astro/recipes/starlight`  | Conservative Starlight MDX recipe.                                                                        | `import { starlightRecipe } from "@cloudflare/polystella-astro/recipes/starlight";`            |
| Astro     | `@cloudflare/polystella-astro/client`             | Types only. Reference from `src/env.d.ts` for virtual-module types. No runtime import.                    | `/// <reference types="@cloudflare/polystella-astro/client" />`                                |
| Astro     | `@cloudflare/polystella`                          | Compatibility package; equivalent to `@cloudflare/polystella-astro`.                                      | `import polystella from "@cloudflare/polystella";`                                             |
| Astro     | `@cloudflare/polystella/content`                  | Compatibility content-config entrypoint.                                                                  | `import { polystellaCollections } from "@cloudflare/polystella/content";`                      |
| Astro     | `@cloudflare/polystella/runtime`                  | Compatibility runtime entrypoint.                                                                         | `import { localizedHref } from "@cloudflare/polystella/runtime";`                              |
| Astro     | `@cloudflare/polystella/runtime/middleware`       | Compatibility direct middleware entrypoint.                                                               | `import { polystellaMiddleware } from "@cloudflare/polystella/runtime/middleware";`            |
| Astro     | `@cloudflare/polystella/i18n`                     | Compatibility UI-string entrypoint.                                                                       | `import { getDictionary } from "@cloudflare/polystella/i18n";`                                 |
| Astro     | `@cloudflare/polystella/catalog`                  | Compatibility pure catalog entrypoint.                                                                    | `import { buildTranslateFn } from "@cloudflare/polystella/catalog";`                           |
| Astro     | `@cloudflare/polystella/catalog/middleware`       | Compatibility catalog-only middleware entrypoint.                                                         | `import { catalogMiddleware } from "@cloudflare/polystella/catalog/middleware";`               |
| Astro     | `@cloudflare/polystella/catalog/astro`            | Compatibility catalog-only Astro integration entrypoint.                                                  | `import catalogAstro from "@cloudflare/polystella/catalog/astro";`                             |
| Astro     | `@cloudflare/polystella/react`                    | Compatibility React hooks entrypoint.                                                                     | `import { useTranslations } from "@cloudflare/polystella/react";`                              |
| Astro     | `@cloudflare/polystella/recipes`                  | Compatibility MDX recipe entrypoint.                                                                      | `import { defineMdxRecipe } from "@cloudflare/polystella/recipes";`                            |
| Astro     | `@cloudflare/polystella/recipes/starlight`        | Compatibility Starlight recipe entrypoint.                                                                | `import { starlightRecipe } from "@cloudflare/polystella/recipes/starlight";`                  |
| Astro     | `@cloudflare/polystella/client`                   | Compatibility virtual-module types entrypoint.                                                            | `/// <reference types="@cloudflare/polystella/client" />`                                      |

## Direct package flow

Low-level consumers run directly in-process, with no hosted service or
extra network hop:

```text
source/record -> adapter -> core -> provider -> core -> adapter -> output
```

For example, extract a JSON field, translate it through core, and apply
the returned map through the same adapter:

```ts
import { EMPTY_GLOSSARY, translateSegments } from "@cloudflare/polystella-core";
import { jsonAdapter } from "@cloudflare/polystella-adapters";
import { createWorkersAIHttpTranslator } from "@cloudflare/polystella-providers/workers-ai";

const source = JSON.stringify({ title: "Hello" });
const parsed = jsonAdapter.parse(source, "record.json");
const segments = jsonAdapter.extractSegments(parsed, source, {
  sourcePath: "record.json",
  translatableKeys: { "record.json": ["title"] },
});
const translator = createWorkersAIHttpTranslator({
  accountId: "your-account-id",
  apiToken: "your-api-token",
  modelId: "@cf/meta/llama-3.1-8b-instruct",
  maxTokens: 8192,
});
const { translations } = await translateSegments({
  translator,
  segments,
  glossary: EMPTY_GLOSSARY,
  sourceLocale: "en-US",
  targetLocale: "pt-BR",
});
const output = jsonAdapter.applyTranslations(parsed, source, translations);
```

Core, adapters, and providers use standard Web APIs and work in Workers without
`nodejs_compat`. The CLI package is Node.js-only.

## Which import goes where

### Direct core, adapter, and provider use

```ts
import { translateSegments, type Translator } from "@cloudflare/polystella-core";
import { markdownAdapter, type FileAdapter } from "@cloudflare/polystella-adapters";
import { createAnthropicTranslator } from "@cloudflare/polystella-providers/anthropic";
```

### `astro.config.mjs`

```js
import polystella from "@cloudflare/polystella-astro";
```

### `polystella.config.mjs`

Usually no imports are needed — it's a plain config object. If you
use MDX recipes, import them here:

```js
import { starlightRecipe } from "@cloudflare/polystella-astro/recipes/starlight";
```

### `src/content.config.ts`

```ts
import { polystellaCollections } from "@cloudflare/polystella-astro/content";
import { i18nLoader, i18nSchema } from "@cloudflare/polystella-astro/i18n";
```

### `src/env.d.ts`

```ts
/// <reference types="@cloudflare/polystella-astro/client" />
```

### `.astro` page templates

Use `Astro.locals` for the locale-bound runtime — no explicit import
required. The middleware populates these automatically.

For explicit imports (uncommon — `getStaticPaths` and similar):

```ts
import { getLocalizedEntry, getLocalizedCollection, localizedHref } from "@cloudflare/polystella-astro/runtime";
```

### React islands

```tsx
import { useTranslations, useLocalizedHref } from "@cloudflare/polystella-astro/react";
```

### Locale switcher

PolyStella doesn't ship a built-in component. See the
[locale-picker cookbook recipe](/cookbook/locale-picker/) for a
copy-paste starting point you can drop into your project.

## What's NOT public

Anything not in the table above is implementation detail and may move
between minor versions. Each package's `package.json` `exports` field is
the source of truth.

Low-level names formerly exported from `@cloudflare/polystella` moved to
their owners: `Segment`, `Glossary`, `Translator`,
`PermanentProviderError`, prompt helpers, and batching are in
`@cloudflare/polystella-core`; portable parsing and application helpers
are in `@cloudflare/polystella-adapters`; concrete transports are in
`@cloudflare/polystella-providers`. The old low-level imports have no
compatibility shims.
