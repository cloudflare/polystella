# @cloudflare/polystella-emdash

Native EmDash integration for PolyStella.

The initial package foundation validates deployment-owned content and catalog
policy, declares EmDash storage and settings, and provides deterministic catalog
override helpers. Content translation, catalog routes, and admin UI will land in
subsequent phases.

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

Use the returned descriptor in EmDash's `plugins` array.
