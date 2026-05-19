# PolyStella

> ⚠️ **Work in progress.** PolyStella is in active development and not yet published to npm. APIs, configuration shapes, and internal behaviour may change without notice. Do not adopt for new projects yet.

PolyStella is an [Astro](https://astro.build) integration that translates content into additional locales at build time using AI, caches translations in Cloudflare R2, and injects locale-prefixed routes for the translated pages.

## What it does

- **Build-time translation.** Translates `.md`, `.mdx`, and `.toml` content into additional locales during `astro build`. Visitors get static bytes; no runtime AI calls.
- **R2-cached.** Translations are content-addressed by source bytes + glossary + model. Unchanged pages cost zero on rebuild. Translations are never committed to the repo.
- **Glossary control.** Per-locale YAML files pin do-not-translate terms, preferred translations, and free-form translator notes.
- **Hand-translation overrides.** Drop a file at `i18n/overrides/{locale}/<mirrored-path>` and it wins over AI output verbatim.
- **Locale-prefixed routing.** Ships its own route shims that locale-prefix pages via injected dynamic routes.
- **UI-string maintenance.** Per-locale JSON files for chrome text, with build-time drift detection and a CLI for sync + AI-fill.

## Install

PolyStella isn't on npm yet. Install from GitHub:

```bash
pnpm add github:cloudflare/polystella#vX.Y.Z
```

Peer dependencies: `astro ^6.0.0`, optionally `react ^17 || ^18 || ^19`.

## Quick start

Four files participate in a typical setup.

**1. `astro.config.mjs`** — register the integration. Locale set lives here.

```js
import { defineConfig } from "astro/config";
import polystella from "polystella";
import polystellaConfig from "./polystella.config.mjs";

export default defineConfig({
  i18n: {
    defaultLocale: "en-US",
    locales: ["en-US", "pt-BR", "ja-JP"],
  },
  integrations: [polystella(polystellaConfig)],
});
```

**2. `polystella.config.mjs`** — provider, glossary, R2, format-specific keys. Every option is documented in the [configuration reference](https://polystella.example.com/configuration/reference/).

**3. `src/content.config.ts`** — register sibling collections so Astro's content layer picks up translations. Locale set is auto-derived from `astro.config.mjs`.

```ts
import { defineCollection } from "astro:content";
import { polystellaCollections } from "polystella/content";
import { i18nLoader, i18nSchema } from "polystella/i18n";

import { blog, authors } from "./content-schemas";

export const collections = {
  ...polystellaCollections({
    source: { blog, authors },
  }),
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
```

**4. `src/env.d.ts`** — pick up types for PolyStella's virtual modules:

```ts
/// <reference types="polystella/client" />
```

## Documentation

Full documentation lives at the Starlight docs site (under `docs/` in this repo):

- [Getting started](https://polystella.example.com/getting-started/install/) — install, quick start, mental model
- [Concepts](https://polystella.example.com/concepts/how-it-works/) — pipeline, cache, overrides, runtime bridge
- [Configuration reference](https://polystella.example.com/configuration/reference/) — every option
- [CLI](https://polystella.example.com/cli/) — `translate`, `check-ui`, `sync-ui`, `translate-ui`
- [Runtime API](https://polystella.example.com/runtime-api/locals/) — `Astro.locals`, middleware, React hooks
- [Roadmap](https://polystella.example.com/roadmap/) — shipped vs planned features

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). The agent-facing context is in [`AGENTS.md`](./AGENTS.md) and [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## License

[MIT](./LICENSE)
