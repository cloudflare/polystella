---
"@cloudflare/polystella-core": minor
"@cloudflare/polystella-astro": minor
---

UI-string catalogs can use standard ICU MessageFormat. Set `catalog: { messageSyntax: "icu" }` in `polystella.config.mjs` to write placeholders as `{name}` and plurals as `{count, plural, one {# item} other {# items}}` instead of the default `{{name}}` syntax. This fits catalogs from inlang's ICU MessageFormat plugin.

`check-ui`, `translate-ui`, the build's drift checks, `Astro.locals.t`, `getTranslations()`, `useTranslations()` and `catalogAstro()` follow the setting. Single-brace placeholders get the same missing/spurious checks, plural-category checks and translation retries as `{{name}}`. A default-locale string that isn't valid ICU (such as inlang markup) is reported by `check-ui` and never sent to the model by `translate-ui`, which lists it as a failure. The EmDash plugin stays on `{{name}}`. The standalone `formatMessage()` and the core validators take the syntax as an optional argument, defaulting to `"polystella"`.
