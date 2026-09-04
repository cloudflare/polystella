# PolyStella

> ⚠️ **Work in progress.** PolyStella is in active development. APIs, configuration shapes, and internal behaviour may change without notice. Do not adopt for new projects yet.

PolyStella is an [Astro](https://astro.build) integration that translates content into additional locales at build time using AI, caches translations in Cloudflare R2, and injects locale-prefixed routes for the translated pages.

The repository publishes seven packages. The canonical Astro package and its
compatibility package share a version; the others are versioned independently:

| Package                            | Directory              | Role                                                                  | Internal dependencies          |
| ---------------------------------- | ---------------------- | --------------------------------------------------------------------- | ------------------------------ |
| `@cloudflare/polystella-core`      | `packages/core/`       | Platform-neutral catalogs, prompts, batching, retries, and contracts. | None                           |
| `@cloudflare/polystella-adapters`  | `packages/adapters/`   | Portable Markdown, MDX, JSON, YAML, and TOML adapters.                | Core                           |
| `@cloudflare/polystella-providers` | `packages/providers/`  | Workers AI HTTP/binding and Anthropic transports.                     | Core                           |
| `@cloudflare/polystella-cli`       | `packages/cli/`        | Shared Node.js catalog CLI commands and filesystem policy.            | Core, providers                |
| `@cloudflare/polystella-emdash`    | `packages/emdash/`     | Native EmDash translation, admin UI, overrides, and Astro runtime.    | CLI, core, providers           |
| `@cloudflare/polystella-astro`     | `packages/astro/`      | Canonical Astro integration, CLI, R2, routing, and host policy.       | CLI, core, adapters, providers |
| `@cloudflare/polystella`           | `packages/polystella/` | Temporary compatibility forwarding to the Astro package.              | Astro                          |

Dependencies point toward reusable code:

```text
@cloudflare/polystella --> @cloudflare/polystella-astro
                               ├──> @cloudflare/polystella-adapters --> core
                               ├──> @cloudflare/polystella-cli --> core
                               ├──> @cloudflare/polystella-providers --> core
                               └──> @cloudflare/polystella-core

@cloudflare/polystella-emdash --> @cloudflare/polystella-cli --> core
                              ├──> @cloudflare/polystella-providers --> core
                              └──> @cloudflare/polystella-core
```

Core, adapters, and providers are portable and use standard Web APIs. CLI is
Node.js-only. The
Astro and EmDash packages compose them and own host-specific behavior. The
generic package contains forwarding files only; new Astro projects should use
`@cloudflare/polystella-astro`.

Contributors should start with
[`PACKAGE_ARCHITECTURE.md`](./PACKAGE_ARCHITECTURE.md) for package boundaries,
key files, dependency rules, and enforcement checks. Detailed subsystem
invariants remain in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

Direct low-level use stays in-process:

```text
source/record -> adapter -> core -> provider -> core -> adapter -> output
```

The reusable packages work in Workers without `nodejs_compat`; consumers may
still enable it.

## What it does

- **Build-time translation.** Translates `.md`, `.mdx`, and `.toml` content into additional locales during `astro build`. Visitors get static bytes; no runtime AI calls.
- **R2-cached.** Translations are content-addressed by source bytes + glossary + model. Unchanged pages cost zero on rebuild. Translations are never committed to the repo.
- **Glossary control.** Per-locale YAML files pin do-not-translate terms, preferred translations, and free-form translator notes.
- **Hand-translation overrides.** Drop a file at `i18n/overrides/{locale}/<mirrored-path>` and it wins over AI output verbatim.
- **Locale-prefixed routing.** Ships its own route shims that locale-prefix pages via injected dynamic routes.
- **UI-string maintenance.** Per-locale JSON files for chrome text, with build-time drift detection and a CLI for sync + AI-fill.

## Install

Install from npm:

```bash
pnpm add @cloudflare/polystella-astro
```

Peer dependencies: `astro ^7.0.10`, optionally `react ^17 || ^18 || ^19`.

Install the owning package for low-level APIs. `Segment`, `Glossary`,
`Translator`, `PermanentProviderError`, prompt helpers, and batching moved
to `@cloudflare/polystella-core`; portable format helpers moved to
`@cloudflare/polystella-adapters`; provider factories moved to
`@cloudflare/polystella-providers`. The Astro package does not provide
compatibility shims for those old low-level imports.

## Quick start

Four files participate in a typical setup.

**1. `astro.config.mjs`** — register the integration. Locale set lives here.

```js
import { defineConfig } from "astro/config";
import polystella from "@cloudflare/polystella-astro";
import polystellaConfig from "./polystella.config.mjs";

export default defineConfig({
  i18n: {
    defaultLocale: "en-US",
    locales: ["en-US", "pt-BR", "ja-JP"],
  },
  integrations: [polystella(polystellaConfig)],
});
```

**2. `polystella.config.mjs`** — provider, glossary, R2, format-specific keys. Every option is documented in the [configuration reference](https://polystella-docs.pcx-team.workers.dev/configuration/reference/).

**3. `src/content.config.ts`** — register sibling collections so Astro's content layer picks up translations. Locale set is auto-derived from `astro.config.mjs`.

```ts
import { defineCollection } from "astro:content";
import { polystellaCollections } from "@cloudflare/polystella-astro/content";
import { i18nLoader, i18nSchema } from "@cloudflare/polystella-astro/i18n";

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
/// <reference types="@cloudflare/polystella-astro/client" />
```

## Catalog-Only Usage

Projects that already handle localized content and routing can adopt only
PolyStella's JSON catalog flow:

```ts
import catalogAstro from "@cloudflare/polystella-astro/catalog/astro";

export default defineConfig({
  i18n: { defaultLocale: "en-US", locales: ["en-US", "pt-BR"] },
  integrations: [catalogAstro({ baseDir: "./src/i18n" })],
});
```

This binds `Astro.locals.t` and `Astro.locals.lhref` only. It does not
run content translation, route shims, R2 cache setup, or localized
collection APIs.

## Documentation

Full documentation lives at the Nimbus docs site (under `docs/` in this repo):

- [Getting started](https://polystella-docs.pcx-team.workers.dev/getting-started/install/) — install, quick start, mental model
- [Concepts](https://polystella-docs.pcx-team.workers.dev/concepts/how-it-works/) — pipeline, cache, overrides, runtime bridge
- [Configuration reference](https://polystella-docs.pcx-team.workers.dev/configuration/reference/) — every option
- [CLI](https://polystella-docs.pcx-team.workers.dev/cli/) — `translate`, `check-ui`, `sync-ui`, `translate-ui`
- [Runtime API](https://polystella-docs.pcx-team.workers.dev/runtime-api/locals/) — `Astro.locals`, middleware, React hooks
- [Roadmap](https://polystella-docs.pcx-team.workers.dev/roadmap/) — shipped vs planned features

## Contributing

Contributions are welcome, but PolyStella is maintained by a small
team and review is not guaranteed. See
[`CONTRIBUTING.md`](./CONTRIBUTING.md). The agent-facing context is in
[`AGENTS.md`](./AGENTS.md),
[`PACKAGE_ARCHITECTURE.md`](./PACKAGE_ARCHITECTURE.md), and
[`ARCHITECTURE.md`](./ARCHITECTURE.md).

## License

[MIT](./LICENSE)
