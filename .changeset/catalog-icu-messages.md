---
"@cloudflare/polystella-core": minor
"@cloudflare/polystella-astro": minor
"@cloudflare/polystella-emdash": minor
---

Catalog strings are now ICU messages written with double outer braces, so plurals, select, ordinals and number/date formatting work in `t()`: `{{count, plural, =0 {No roles} one {# role} other {# roles}}}`. Existing `{{name}}` strings keep working, and `{{ name }}` with spaces now works too. A missing value stays visible as source text; a string that is not a valid message falls back to the default locale's string, then to the key. Apostrophes follow ICU quoting: write `''` directly before `{{`, `}` or a plural `#`.

New: `formatMessage`, `MessageSyntaxError`, `createPassthroughTranslateFn` and locale-tag helpers in `@cloudflare/polystella-core/catalog`; `t.raw(key)` and `t.locale` on every translator; `useTranslations(dictionary, locale?)`; and a `localeTags` option (site locale code → BCP 47 tag) on `polystella.config.mjs`, the Astro integration, `catalogAstro()` and the EmDash plugin. Startup fails when a locale does not resolve to a tag `Intl` recognises. Tags also name the language in translation prompts.

`check-ui` now reports invalid messages, apostrophes that hide a placeholder, stray `{`/`}` (a doubled `}}}}` that would show on the page), and translations whose placeholders or plural/select branches differ from the default locale (exit 1); Astro builds log them as warnings. `translate-ui` and EmDash catalog generation tell the model the target's plural categories, remove branches the target never uses, and retry mismatches: a retry resends only the failed keys, with the previous answer and the problem in the prompt. EmDash rejects overrides that fail the same checks.

Breaking: `TranslateFn` is now an interface with required `raw` and `locale` members, so hand-written `(key) => key` mocks need `createPassthroughTranslateFn()`. Placeholder names with dots or hyphens (`{{user.name}}`) make a string invalid, and a single apostrophe directly before `{{` now quotes the placeholder. The main Astro middleware's `t` now falls back per key to the default-locale dictionary.
