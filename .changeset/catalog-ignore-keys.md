---
"@cloudflare/polystella-core": minor
"@cloudflare/polystella-astro": minor
---

UI-string catalogs can skip entries that are not messages. List regex strings in `catalog.ignoreKeys` in `polystella.config.mjs`, for example `catalog: { ignoreKeys: ["\\$schema"] }` for the `$schema` key in inlang / Paraglide message files. Each pattern must match the whole dotted key, and a matched group skips its whole subtree.

`sync-ui`, `check-ui`, `translate-ui`, the build's drift check and `catalogAstro()` skip ignored entries: they are never synced, checked or sent to the model, and they may hold any value, such as an inlang variant-message array. Ignored entries already in a locale file are kept as they are. A top-level `$schema` from the default-locale file is copied into locale files that lack it. An invalid pattern fails at config load.

The option is read only from `polystella.config.mjs`. `polystella()` accepts a `catalog` key so a shared config object still validates, and warns when an inline value differs from the file. `sync-ui` and `translate-ui --sync-only` now load `polystella.config.mjs` when it exists. A catalog array value that is not ignored still fails, and the error now suggests `catalog.ignoreKeys`. The catalog commands now report an unreadable catalog file (invalid JSON, an array value) with exit code 1 instead of crashing, and `polystella.config.mjs` falls back to Astro's Vite loader when Node cannot import it, the same way `astro.config.mjs` does.
