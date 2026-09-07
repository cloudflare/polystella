---
title: EmDash configuration
description: PolystellaEmdashOptions — provider, catalogs, models, glossaryDefaults, and rules.
aiGenerated: true
sidebar:
  label: Configuration
---

`polystellaEmdash(options)` and `polystellaEmdashAstro(options)` both
accept a `PolystellaEmdashOptions` object. It is validated eagerly at
integration setup; bad input fails with a concrete error naming the
offending field.

## `provider`

The Workers AI transport. Either a named binding on the EmDash
deployment, or HTTP with runtime environment variable names (never
literal credentials):

| Field          | Type                                          | Notes                                                                                                                                              |
| -------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`         | `"workers-ai-binding"` or `"workers-ai-http"` | Selects the transport.                                                                                                                             |
| `binding`      | string                                        | Binding kind only. The named Workers AI binding on the EmDash deployment.                                                                          |
| `accountIdEnv` | string                                        | HTTP kind only. Env var name for the account ID.                                                                                                   |
| `apiTokenEnv`  | string                                        | HTTP kind only. Env var name for the API token.                                                                                                    |
| `endpoint`     | string                                        | HTTP kind only, optional. Overrides the Workers AI endpoint.                                                                                       |
| `maxTokens`    | number                                        | Optional. Defaults to `8192`. Do not lower it — the default is already the floor for multi-segment translations; truncation produces invalid JSON. |

## `catalogs`

The UI-string dictionaries. Repository JSON remains canonical.

| Field           | Type   | Notes                                                             |
| --------------- | ------ | ----------------------------------------------------------------- |
| `defaultLocale` | string | Must exist in `locales`. Must match Astro's `i18n.defaultLocale`. |
| `locales`       | record | Per-locale `{ dictionary, filePath }`. At least one locale.       |

Each locale's `filePath` is a repository-relative path (no leading
`/`, no `..`, no backslashes) used by the JSON export. The
`dictionary` maps keys to strings.

## `models`

The model bounds for translation.

| Field      | Type                  | Notes                                                                                                                                  |
| ---------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `allowed`  | string[]              | Non-empty, unique. Administrators cannot select a model outside this list. Cannot contain the reserved `__polystella_code_default__`.  |
| `defaults` | string or `ModelSpec` | A single model id, or `{ default, <locale>: model }`. Every locale key must match a configured catalog locale and appear in `allowed`. |

`models.defaults` may set a `default` fallback and locale-specific
models. Each target locale receives its own model and glossary
settings.

## `glossaryDefaults`

Optional. Structured per-locale glossaries loaded at deployment
time. Use `loadGlossaryDefaults` from `@cloudflare/polystella-emdash/config`:

```ts
import { loadGlossaryDefaults } from "@cloudflare/polystella-emdash/config";

glossaryDefaults: await loadGlossaryDefaults({
  locales: ["en-US"],
  file: "./src/i18n/glossary/{locale}.yaml",
  projectRoot: new URL(".", import.meta.url),
}),
```

Every key must match a configured catalog locale. Administrators can
use each glossary unchanged, append plain-text `notes`, or replace
them; structured YAML remains code-defined.

## `rules`

Optional. Shared code-defined translation instructions, joined into
a single prompt. Administrators can use them unchanged, append to
them, or replace them.

## Collections are not a config option

Enabled collections, their source locales, and their translatable
fields are administrator-owned and stored per project in EmDash —
they are deliberately absent from `PolystellaEmdashOptions`. The
deployment only sets the bounds (locale set, allowed models) that
administrator policy operates within. Configure them in the
[Collections tab](/emdash/admin-ui/).

## Validation rules

- `catalogs.defaultLocale` must exist in `catalogs.locales`.
- `catalogs.locales` must contain at least one locale; every
  dictionary value must be a string.
- `filePath` must be a repository-relative path.
- `models.allowed` must be non-empty and unique, and must not
  contain `__polystella_code_default__`.
- Every `models.defaults.<locale>` must match a configured catalog
  locale and appear in `models.allowed`.
- Every `glossaryDefaults` key must match a configured catalog
  locale.
- Provider env/binding names must be valid environment binding
  names; `endpoint` must be a valid URL; `maxTokens` must be a
  positive integer.

## Astro integration options

`polystellaEmdashAstro(options, runtimeOptions)` takes a second,
optional argument:

| Field               | Type    | Default | Notes                                                         |
| ------------------- | ------- | ------- | ------------------------------------------------------------- |
| `fallbackToDefault` | boolean | `true`  | Missing visitor-locale keys fall back to the default catalog. |

## See also

- [Overview](/emdash/) — setup and architecture.
- [Admin UI](/emdash/admin-ui/) — how administrators customize
  models, glossaries, and instructions at runtime.
