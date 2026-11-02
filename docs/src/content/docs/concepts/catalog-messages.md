---
title: Catalog messages
description: Placeholders, plurals, select, ordinals and number/date formatting in UI-string catalogs.
aiGenerated: true
---

Catalog strings are messages. A plain string stays plain; a string with
placeholders uses ICU MessageFormat, written with **double outer braces**.
Every placeholder opens with `{{` and closes with `}}`. Branch bodies use
single braces, and a placeholder inside a branch uses `{{ }}` again.

```json
{
  "careers": {
    "roles": "{{count, plural, =0 {No open roles} one {# role} other {# roles}}}",
    "showing": "Showing {{visible}} of {{total, plural, one {# role} other {# roles}}}",
    "located": "{{count, plural, one {{{place}} has # role} other {{{place}} has # roles}}}",
    "owner": "{{gender, select, female {Her team} male {His team} other {Their team}}}",
    "rank": "{{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}}",
    "growth": "{{pct, number, ::percent}} more roles",
    "posted": "Posted {{when, date, medium}}"
  }
}
```

```astro
<p>{t("careers.showing", { visible: 3, total: 9 })}</p>
<!-- Showing 3 of 9 roles -->
```

Existing `{{name}}` strings keep working, and `{{ name }}` with spaces works
too. Placeholder names use letters, digits and `_` only: `{{user.name}}` is an
invalid message.

## Plural branches per language

Each language uses its own plural categories. Write exactly the categories
the language uses, plus any exact `=N` branches:

| Language | Categories                       |
| :------- | :------------------------------- |
| English  | one, other                       |
| French   | one, many, other                 |
| Polish   | one, few, many, other            |
| Arabic   | zero, one, two, few, many, other |
| Japanese | other                            |

`#` stands for the number, formatted for the locale (`1,200` in English,
`1.200` in German). A branch does not have to contain `#`.

## Apostrophes and literal braces

Apostrophes follow ICU quoting. Write `''` (two apostrophes) for an apostrophe
directly before `{{`, before `}`, or before `#` inside a plural branch. A
single apostrophe anywhere else is literal.

```json
{
  "team": "l''équipe {{company}}",
  "offers": "{{n, plural, one {l''# offre} other {# offres}}}",
  "plain": "Don't stop"
}
```

A single `'` before `{{` quotes the placeholder away: `l'{{company}}` renders
as `l{{company}}`. `check-ui` reports it.

Single `{` and `}` in plain text are literal. A literal `}` inside a branch
must be quoted (`'{a}'`), and a literal `{{` is written `'{{'`.

## Runtime behaviour

- `t(key, params)` always formats, so `''` renders as `'` even without params.
- A missing or unusable value stays visible as source text:
  `Showing {{visible}} of 9 roles`. It never throws.
- A string that is not a valid message falls back to the default locale's
  string, formatted with the default locale's rules. If that is broken too,
  `t` returns the key.
- `t.raw(key)` returns the template for client code; `t.locale` is the BCP 47
  tag the strings are formatted with.
- `formatMessage(template, values, locale)` from
  `@cloudflare/polystella-core/catalog` is the same formatter as a pure,
  browser-safe function. It throws `MessageSyntaxError` only for an invalid
  template.

## Locale tags

Plural rules and number formatting need a BCP 47 language tag. When a site's
locale codes are not tags, map them with `localeTags`:

```js
// polystella.config.mjs
export default {
  localeTags: { jp: "ja", "es-la": "es-419", cz: "cs" },
};
```

Codes not in the map are used as they are. The same option exists on
`catalogAstro()`, `polystellaEmdash()` and `polystellaEmdashAstro()`.
Tags also name the language in translation prompts, so `es-la` without a
mapping is described to the model as "Spanish (Laos)". R2 keys and file names
keep the locale code.

The build fails when a tag is malformed (`zh_cn`) or names a language `Intl`
does not know (`jp`, `cz`). It cannot detect codes that are valid tags for a
different language: `se` is Northern Sami, not Swedish (`sv`), and `kr` is
Kanuri, not Korean (`ko`).

## Checks

- [`check-ui`](/cli/check-ui/) reports invalid syntax, apostrophes that hide a
  placeholder, and translations whose placeholders, select keys, `=N` branches
  or plural categories differ from the default-locale string. The Astro build
  logs the same findings as warnings.
- [`translate-ui`](/cli/translate-ui/) tells the model which plural categories
  the target language uses and retries translations that fail the same checks.
- EmDash rejects catalog overrides that fail the checks on save.
