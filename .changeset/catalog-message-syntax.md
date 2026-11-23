---
"@cloudflare/polystella-core": minor
"@cloudflare/polystella-astro": minor
"@cloudflare/polystella-emdash": minor
---

UI-string catalogs can use standard ICU MessageFormat. Set `catalog: { messageSyntax: "icu" }` in `polystella.config.mjs` to write placeholders as `{name}` and plurals as `{count, plural, one {# item} other {# items}}` instead of the default `{{name}}` syntax. This fits catalogs from inlang's ICU MessageFormat plugin.

`check-ui`, `translate-ui`, the build's drift checks, `Astro.locals.t`, `getTranslations()`, `useTranslations()` and `catalogAstro()` follow the setting. Single-brace placeholders get the same missing/spurious checks, plural-category checks and translation retries as `{{name}}`. A default-locale string that isn't valid ICU (such as inlang markup) is reported by `check-ui` and never sent to the model by `translate-ui`, which lists it as a failure. The standalone `formatMessage()` and the core validators take the syntax as an optional argument, defaulting to `"polystella"`.

The EmDash plugin takes the same block as a new `catalog` option (`catalog: { ignoreKeys, messageSyntax }`), since it can't read `polystella.config.mjs`. Ignored keys are left out of the Catalog tab, validation and generation, and JSON export keeps them as they are. An ignored array value no longer fails validation. `messageSyntax` applies to override validation, catalog generation, the Catalog tab's placeholder hint and the runtime `t()`. A nested JSON export now keeps an override for a key that only the default-locale file has; it used to drop it.

`check-ui` now fails with exit 1 when the default-locale catalog file is missing, as `sync-ui --check` already did. The build's drift check still skips it.
