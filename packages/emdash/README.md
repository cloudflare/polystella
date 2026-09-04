# @cloudflare/polystella-emdash

Native EmDash integration for PolyStella.

The plugin translates selected saved content fields, manages temporary UI-string
overrides, and exports deterministic locale JSON. Deployment configuration is
the security boundary; EmDash settings may narrow it but cannot add collections,
fields, locales, or models.

```ts
import { polystellaEmdash } from "@cloudflare/polystella-emdash";

polystellaEmdash({
  aiBinding: "AI",
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
    default: "@cf/zai-org/glm-4.7-flash",
  },
});
```

Use the returned descriptor in EmDash's `plugins` array and configure the named
Workers AI binding on the EmDash deployment.

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

Applications may cache `GET
/_emdash/api/plugins/polystella/overrides?locale=<locale>`. The EmDash success
envelope's `data` is either:

```json
{ "enabled": false, "overrides": {} }
```

or an enabled envelope containing only stored overrides. Overlay enabled values
on the bundled locale dictionary; keep bundled JSON as the fallback.

## EmDash 0.36 Limitations

- Panels use the latest saved entry, not unsaved form state.
- EmDash leaves an empty PolyStella section on collections disabled in plugin
  settings because panel visibility cannot be resolved asynchronously.
- The server route enforces deployment field allowlists and value shapes, but
  EmDash does not expose authoritative collection schema metadata to plugin
  routes yet.
