# @cloudflare/polystella-emdash

Native EmDash integration for PolyStella.

The plugin translates selected saved content fields, manages temporary UI-string
overrides, and exports deterministic locale JSON. Deployment configuration is
the security boundary; EmDash settings may narrow it but cannot add collections,
fields, locales, or models.

```ts
import { polystellaEmdash, type PolystellaEmdashOptions } from "@cloudflare/polystella-emdash";
import { polystellaEmdashAstro } from "@cloudflare/polystella-emdash/astro";
import { loadGlossaryDefaults } from "@cloudflare/polystella-emdash/config";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";

const polystellaOptions = {
  provider: { kind: "workers-ai-binding", binding: "AI" },
  collections: {
    posts: { sourceLocale: "en-US", fields: ["title", "body"] },
  },
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
});
```

Keep `polystellaEmdashAstro()` after `emdash()`. It binds `Astro.locals.t` and
`Astro.locals.lhref`, overlays enabled EmDash overrides, and falls back to the
deployed dictionaries when storage is unavailable. Configure the named Workers
AI binding on the EmDash deployment.

For Workers AI over HTTP, use runtime environment variable names instead of
literal credentials:

```ts
provider: {
  kind: "workers-ai-http",
  accountIdEnv: "CLOUDFLARE_ACCOUNT_ID",
  apiTokenEnv: "CLOUDFLARE_WORKERS_AI_TOKEN",
}
```

`models.defaults` may set a `default` fallback and locale-specific models. Each
target locale receives its own model and glossary settings. Administrators can
use the deployment glossary unchanged or append/replace it with plain text;
they cannot select a model outside `models.allowed`.

This package also installs `polystella check-ui`, `polystella sync-ui`, and
`polystella translate-ui`. They retain the Astro CLI's config and flags.

## Content Translation

The native editor panel appears for Editors and Administrators. The PolyStella
settings page loads the current EmDash project's collections and lets an
Administrator enable any deployment-allowlisted subset. All allowlisted
collections start enabled.

The panel translates selected `string`, `text`, and Portable Text fields in an
existing target-locale draft. The private route rereads selected values through
its `content:read` capability, while the panel updates with EmDash's `_rev` token
and reloads after success. Unsaved browser changes are not translated and are
lost after confirmation.

## Catalog Overrides

Repository JSON remains canonical. The catalog page can generate, edit, clear,
inspect deployment state, and export temporary per-key overrides. Runtime
overrides are disabled per locale until an Administrator explicitly enables them.

The Astro integration reads enabled overrides directly from EmDash storage and
caches them for 60 seconds. The public `GET
/_emdash/api/plugins/polystella/overrides?locale=<locale>` remains available for
other runtimes. Its success envelope's `data` is either:

```json
{ "enabled": false, "overrides": {} }
```

or an enabled envelope containing only stored overrides. Overlay enabled values
on the bundled locale dictionary; keep bundled JSON as the fallback.

For server routes that need a locale other than `Astro.currentLocale`, reference
the virtual module types and build the translator explicitly:

```ts
/// <reference types="@cloudflare/polystella-emdash/client" />

import { buildCatalogTranslator } from "polystella:catalog";

const t = await buildCatalogTranslator(locale);
```

## EmDash 0.36 Limitations

- Panels use the latest saved entry, not unsaved form state.
- EmDash leaves an empty PolyStella section on collections disabled in plugin
  settings because panel visibility cannot be resolved asynchronously.
- The server route enforces deployment field allowlists and value shapes, but
  EmDash does not expose authoritative collection schema metadata to plugin
  routes yet.
