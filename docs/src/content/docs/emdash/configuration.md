---
title: EmDash configuration
description: PolystellaEmdashOptions — provider, catalogs, models, glossaryDefaults, glossaryMatchInflections, rules, blockFields, localeTags, and batchQueueBinding.
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

| Field          | Type                                          | Notes                                                                                                                                                                                                                                             |
| -------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`         | `"workers-ai-binding"` or `"workers-ai-http"` | Selects the transport.                                                                                                                                                                                                                            |
| `binding`      | string                                        | Binding kind only. The named Workers AI binding on the EmDash deployment.                                                                                                                                                                         |
| `accountIdEnv` | string                                        | HTTP kind only. Env var name for the account ID.                                                                                                                                                                                                  |
| `apiTokenEnv`  | string                                        | HTTP kind only. Env var name for the API token.                                                                                                                                                                                                   |
| `endpoint`     | string                                        | HTTP kind only, optional. Overrides the Workers AI endpoint.                                                                                                                                                                                      |
| `timeoutMs`    | number                                        | Optional. Defaults to `200000` (200 s), under Workers AI's own timeout of about 236 s. A request still running then fails with "The translation model timed out". With the binding, PolyStella stops waiting, but Workers AI may finish the call. |
| `maxTokens`    | number                                        | Optional. Defaults to `8192`. Do not lower it — the default is already the floor for multi-segment translations; truncation produces invalid JSON. Administrators can override it in the Translation settings tab.                                |

## `catalogs`

The UI-string dictionaries. Repository JSON remains canonical.

| Field           | Type   | Notes                                                             |
| --------------- | ------ | ----------------------------------------------------------------- |
| `defaultLocale` | string | Must exist in `locales`. Must match Astro's `i18n.defaultLocale`. |
| `locales`       | record | Per-locale `{ dictionary, filePath }`. At least one locale.       |

Each locale's `filePath` is a repository-relative path (no leading
`/`, no `..`, no backslashes) used by the JSON export. The
`dictionary` accepts the same flat string-to-string or nested group
shape as the main Astro catalog integration. Nested groups are
flattened to dotted runtime keys; `i18n_group_title` remains metadata
and is preserved by JSON export.

## `models`

The model bounds for translation.

| Field      | Type                  | Notes                                                                                                                                                                                                                       |
| ---------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allowed`  | string[]              | Non-empty, unique. Administrators cannot select a model outside this list. Cannot contain the reserved `__polystella_code_default__`.                                                                                       |
| `defaults` | string or `ModelSpec` | A single model id, or `{ default, <locale>: model }`. A model can be `{ model, enable_thinking }` (see [Thinking](#thinking)). Every locale key must match a configured catalog locale and every model appear in `allowed`. |

`models.defaults` may set a `default` fallback and locale-specific
models. Each target locale receives its own model and glossary
settings.

### Thinking

Reasoning models think before they answer. Turning thinking off often
makes them several times faster, but tricky languages may need it. Set
it per locale, next to the locale's model: an entry in
`models.defaults` can be `{ model, enable_thinking }` instead of a
model id.

```js
const MODEL = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";

models: {
  allowed: [MODEL],
  defaults: {
    default: { model: MODEL, enable_thinking: false },
    "ja-JP": { model: MODEL, enable_thinking: true },
    "zh-CN": { model: MODEL, enable_thinking: true },
  },
},
```

The setting applies while the locale uses that model. If an
administrator picks a different model for the locale in the admin, that
model's own `models.params` apply instead, so a model that can't turn
thinking off never receives `false`.

PolyStella sends `enable_thinking` as
`chat_template_kwargs.enable_thinking`, the only form Workers AI reads;
it ignores a top-level `enable_thinking` without an error. Set it
explicitly: some models still think when it is left out, even if their
schema says it defaults to `false`. Some models can't turn thinking off,
and Workers AI rejects `false` for them.

### `models.params`

Optional: extra Workers AI input per allowed model, for settings the
model's schema documents, sent as written. `enable_thinking: true` or
`false` here applies whatever the locale; a locale's own
`enable_thinking` in `models.defaults` wins over it.

```js
params: {
  "@cf/deepseek-ai/deepseek-v4.1-flash-1017": { reasoning_effort: "low" },
},
```

Keys must be allowed models. `messages`, `prompt`, `max_tokens`,
`max_completion_tokens` and `stream` are set by PolyStella and are
rejected. Params apply to both the binding and HTTP providers.

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

The helper also accepts the same `http` and `r2` source forms as the
Astro integration. Remote sources do not require `projectRoot`.

Glossaries can be large: each translation request carries only the
terms its text uses, plus the style rules and notes. A locale's
glossary can be up to 1,000,000 characters. Set
`glossaryMatchInflections: true` to let any letters follow a term, so
`Worker` also matches "Workers"; by default a term must end at a word
boundary.

Every key must match a configured catalog locale. Administrators can
use each glossary unchanged, append plain-text `notes`, or replace
them for target locales; structured YAML and the source-only default
locale remain code-defined.

## `rules`

Optional. Shared code-defined translation instructions, joined into
a single prompt. Administrators can use them unchanged, append to
them, or replace them.

## `blockFields`

Optional. Text to translate inside custom Portable Text blocks, keyed by
the block's `_type`. Standard paragraphs, headings, lists and tables are
always translated; custom blocks are copied unchanged unless listed here.

EmDash's own block types are translated without configuration:

| Block type  | Translated paths                   |
| :---------- | :--------------------------------- |
| `image`     | `alt`, `caption`, `title`          |
| `gallery`   | `images[].alt`, `images[].caption` |
| `video`     | `caption`                          |
| `button`    | `text`                             |
| `buttons`   | `buttons[].text`                   |
| `columns`   | `columns[].content`                |
| `cover`     | `content`                          |
| `pullquote` | `text`, `citation`                 |
| `embed`     | `caption`                          |
| `iframe`    | `title`                            |

A `blockFields` entry for one of these types replaces its default, and
an empty list (`image: []`) copies that type unchanged. `code`,
`htmlBlock` and `file` blocks are never translated.

A path can also be an object that marks a Markdown string:

```js
blockFields: {
  faq: ["question", { path: "answer", format: "markdown" }],
}
```

A Markdown string is translated one paragraph, heading or list item at
a time, so its structure can't be merged or reordered. Links, images,
emphasis and code spans are replaced with placeholders before the model
sees the text, so URLs are never sent and lost links are caught. Inline
tags such as `<gradient>…</gradient>` are protected the same way in
every translated string. When a reply loses, repeats or reorders a
placeholder, that text is resent once with the problem explained; if it
fails again, the translation fails with "model changed inline markup".

[`blocks` fields](https://docs.emdashcms.com/guides/blocks/) use the same
map, keyed by block type slug:

```js
blockFields: {
  hero: ["heading", "body", "link_label"],
  feature_grid: ["heading", "items[].title", "items[].description"],
}
```

Inside a `blocks` field only the site's entries apply. A block type named
`image` or `table` there is the site's own, so it gets neither EmDash's
defaults nor Portable Text table handling. `_version`, `_key`, URLs and
media are always copied unchanged.

```js
blockFields: {
  "marketing.hero": ["headline", "banners[].title", "body"],
  "marketing.columns": ["columns[].content"],
}
```

| Path              | Meaning                                                                                                  |
| :---------------- | :------------------------------------------------------------------------------------------------------- |
| `headline`        | A string property                                                                                        |
| `cta.label`       | A property of a nested object                                                                            |
| `banners[].title` | A property of every item in a list                                                                       |
| `tags[]`          | Every string in a list                                                                                   |
| `columns[].body`  | If the value is a Portable Text array, its text blocks (and any listed custom blocks) are translated too |

A path a block doesn't have, or whose value is neither text nor an array,
is skipped silently. One list can therefore cover several stored shapes of
the same block type. An array at the end of a path without `[]` is read as
Portable Text.

List only copy. Leave URLs, IDs, icons, dates and media references out.
Plain strings are sent to the model as text, so Markdown fields keep
their syntax only as well as the model preserves it. Nested Portable
Text must be valid (every node needs `_type` and `_key`); otherwise the
request fails with the exact location, such as
`body[3].columns[0].content[1]`.

## `localeTags`

Optional. Catalog locale → BCP 47 tag, for locale codes `Intl` would
misread (`{ jp: "ja" }`). Tags drive plural rules, number formatting,
override validation and the language named in translation prompts.
See [Catalog messages](/concepts/catalog-messages/#locale-tags).

## `batchQueueBinding`

Optional. The name of a Cloudflare Queue producer binding. When set,
the [Batch translation tab](/emdash/admin-ui/#batch-translation-tab)
can run jobs on the server, so they keep going after the browser tab
closes. Server jobs only create missing translations, as drafts unless
the administrator turns on **Publish translations immediately**.

EmDash plugins cannot declare bindings or queue consumers, so the site
wires both. In `wrangler.jsonc`, point a producer and a consumer at the
same queue:

```jsonc
{
  "queues": {
    "producers": [{ "binding": "POLYSTELLA_BATCH", "queue": "polystella-batch" }],
    "consumers": [{ "queue": "polystella-batch", "max_batch_size": 5, "max_retries": 3 }],
  },
}
```

Then export the consumer from the Worker entry next to EmDash's own
handlers:

```ts
// src/worker.ts
import worker from "@emdash-cms/cloudflare/worker";
import { handlePolystellaBatchQueue } from "@cloudflare/polystella-emdash/queue";

export { PluginBridge } from "@emdash-cms/cloudflare/worker";
export default { ...worker, queue: handlePolystellaBatchQueue };
```

If the Worker already consumes other queues, call
`handlePolystellaBatchQueue(batch)` when `batch.queue` is the
PolyStella queue.

Each message is one source entry × one locale. The consumer runs
inside EmDash with `withEmDashRuntime`, asks the plugin to translate
the entry, then creates the draft with the source slug, as the
administrator who started the job. A whole-collection job is listed
by the queue too, 100 source entries at a time, so its total grows
until listing ends. A job holds at most 5,000 translations: listing
stops there, and the job card says later entries were not queued.
Translation errors are recorded as failed rows that
**Retry failed** requeues. Infrastructure errors (for example, the
database is unreachable) use the queue's own retries.

## Collections are not a config option

Enabled collections and their translatable fields are
administrator-owned and stored per project in EmDash — they are
deliberately absent from `PolystellaEmdashOptions`. Their source locale
is always `catalogs.defaultLocale`, which plugin settings cannot
replace. Configure collection and field policy in the
[Collections tab](/emdash/admin-ui/).

## Validation rules

- `catalogs.defaultLocale` must exist in `catalogs.locales`.
- `catalogs.locales` must contain at least one locale; every catalog
  leaf must be a string.
- `filePath` must be a repository-relative path.
- `models.allowed` must be non-empty and unique, and must not
  contain `__polystella_code_default__`.
- Every `models.defaults.<locale>` must match a configured catalog
  locale and appear in `models.allowed`.
- Every `glossaryDefaults` key must match a configured catalog
  locale, and each glossary must be at most 1,000,000 characters.
- `glossaryMatchInflections` must be a boolean.
- Every `localeTags` key must match a configured catalog locale, and
  every locale must resolve to a tag `Intl` recognises.
- Every `blockFields` list must be unique (an empty list turns a default off), hold
  strings or `{ path, format: "markdown" }` objects, use paths like
  `title`, `cta.label` or `cards[].title`, and not target the reserved
  `block` or `span` types.
- Every `models.params` key must be in `models.allowed`, and its object
  must not set `messages`, `prompt`, `max_tokens`,
  `max_completion_tokens` or `stream`. `enable_thinking` must be `true`
  or `false`, here and in `models.defaults` entries, and can't also be
  set in that model's `chat_template_kwargs`.
- Provider env/binding names and `batchQueueBinding` must be valid
  environment binding names; `endpoint` must be a valid URL;
  `maxTokens` and `timeoutMs` must be positive integers.

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
