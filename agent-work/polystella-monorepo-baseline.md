# PolyStella Monorepo Extraction Baseline

Status: Recorded  
Recorded: 2026-08-28  
Source commit: `c7a8e0e0ea7638ce2e98a771255f809d1265abb7`

## Purpose

This is the before-extraction reference for
`agent-work/polystella-monorepo-extraction.md`. Step 8 must reproduce the
stable values below before Astro moves to `packages/astro`.

Timestamps, durations, temporary server ports, and concurrent log order are
not parity fields.

## Existing Package Freeze

The existing package remains unchanged through Steps 1-5. No baseline tests
were added because the current suite already covers the critical invariants.

Protected until Step 6:

```text
package.json
src/**
tests/**
client.d.ts
types-internal/**
```

## Environment

| Item                         | Baseline                                   |
| ---------------------------- | ------------------------------------------ |
| Node                         | `v22.22.3`                                 |
| pnpm                         | `11.5.2`                                   |
| Vitest                       | `4.1.9`                                    |
| PolyStella                   | `0.4.0`                                    |
| Git commit                   | `c7a8e0e0ea7638ce2e98a771255f809d1265abb7` |
| Local branch selected by CLI | `main`                                     |

CI currently runs Node 24. The local Node 22 baseline satisfies the current
`p-retry` engine requirement.

## Automated Baseline

| Command                                                     | Result                                                                     |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| `pnpm test`                                                 | Pass: 62 files, 1,159 tests, 1.28 seconds                                  |
| `pnpm exec tsc --noEmit`                                    | Pass                                                                       |
| `pnpm build`                                                | Pass                                                                       |
| `node dist/cli.js --version`                                | Pass: `0.4.0`                                                              |
| `pnpm playground:mdx-jsx:build`                             | Pass: 6 pages; dry-run reports 10 keys across 5 files and 2 target locales |
| `LOG_LEVEL=debug pnpm playground:mdx-jsx:translate:dry-run` | Pass: exact keys recorded below                                            |
| `pnpm playground:mdx-jsx:translate:local`                   | Pass: 10 misses, 0 hits, 0 overrides, 0 failures                           |
| `pnpm pack --dry-run`                                       | Pass: `@cloudflare/polystella@0.4.0`                                       |

`pnpm pack --dry-run` runs the existing `prepare` build. Its expected tarball
name is `cloudflare-polystella-0.4.0.tgz`. The dry run includes `src`, `dist`,
all current export targets, the executable CLI, package docs, `llms` files,
and both shipped skills.

## Dry-Run R2 Keys

The dry run has no configured provider, so each source has the same hash for
both target locales. The locale still appears in the key.

| Source                   | Hash                                                               |
| ------------------------ | ------------------------------------------------------------------ |
| `docs/block-jsx.mdx`     | `1bd2533d354aac689865d610b9ef2c660a940eba7df2d02b3b01c4dee9a8081c` |
| `docs/expressions.mdx`   | `a45472cf8b6fafe58710b6f810cf8116a9213a02039b9209c686f339d28c5fc3` |
| `docs/inline-jsx.mdx`    | `db88cc682b22c78b6e7cdcfba1d16d906e49ffd93a52c8504808d961565c1de2` |
| `docs/plain-markdown.md` | `8ccebd5b5dd1254b71c67d3b0e58c1e567219d67fd68437347893d30526337ea` |
| `docs/static-data.mdx`   | `ea3f9e1ca502f7714e794dd273e1dae8ccab2fc49fd3809478dd76f3f640b99e` |

Key formula used by the CLI:

```text
i18n/{locale}/{source}#{hash}.md
```

Target locales are `pt-BR` and `fr-FR`, producing 10 keys total.

## Fake-Provider Translation Baseline

The local playground uses one concrete model per locale:

```text
pt-BR = playground/fake-workers-ai/pt-BR
fr-FR = playground/fake-workers-ai/fr-FR
```

| Source                   | Segments | `pt-BR` source hash                                                | `fr-FR` source hash                                                |
| ------------------------ | -------: | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `docs/block-jsx.mdx`     |       11 | `d603785e2ee730cd61c299fffed971882438f20abd59a1776f52432a6844b95c` | `6e0fa4eeda9f2d8be76e38f6583fba8c7877e4ef50380f2375813ce268af5aa2` |
| `docs/expressions.mdx`   |        5 | `b3aeadf4eda27ef6f83faf521b7c382271c603601a8eba91578bf8e12cdf33ca` | `9ec3feed4aeae36d06a2fecb049752fdefa962814a7760164222d497f0b73562` |
| `docs/inline-jsx.mdx`    |        8 | `d0fd6e76bd4fe60319b2427ddaac6f13f1a6f49e0c9ca52a66e2f4e7bad50adf` | `9126c18f9bc2059a260e002d9ee1dec3aca7462175afb870c9be20ef7bb5f191` |
| `docs/plain-markdown.md` |        5 | `da48b6282dd5fb8ef174eca1cc6bde469d0f1dc6516445e0cab45180196d8f3c` | `f302200778242da8d6574216e40a2bb2328493e235c78d5324c923986c5574a6` |
| `docs/static-data.mdx`   |       14 | `66841e3dcdc8e1a4926fb34b244cf42da073b5b3215946ad0770b98f71524ebb` | `4c1c9a1ac749596481fbfac4e4bc33d205356f1e880f57410d3406464a0fad23` |

Stable report totals:

```json
{
  "cacheHits": 0,
  "aiTranslated": 10,
  "overrides": 0,
  "skipped": 0,
  "localSkipped": 0,
  "errors": 0
}
```

## Normalized Output Digests

For comparison, replace the complete `aiTranslatedAt:` line with
`aiTranslatedAt: <timestamp>` and compute SHA-256 over the resulting UTF-8
bytes. These are the `i18n-preview` inspection copies; MDX files under
`.astro/i18n-staging` have intentionally different relative import paths.

| Output                         | SHA-256                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| `pt-BR/docs/block-jsx.mdx`     | `0dd866e0845d17b368399c067368c5e9ea5ebcd04e2c76f057851f2dd1bcb407` |
| `pt-BR/docs/expressions.mdx`   | `5b26369e1494cc12d929f10343aa5da90ef6edbfc91b87aa8dcae8c3eb58bc24` |
| `pt-BR/docs/inline-jsx.mdx`    | `5a18c49dad816aaa4927b6895a314868137650453d471236a4f8ee5f99c3f87c` |
| `pt-BR/docs/plain-markdown.md` | `63d19914e7932d5911b7a2e2db502f63d05ad1ceb52c3ec2ab0e5e183dea1bff` |
| `pt-BR/docs/static-data.mdx`   | `6587cc19c5b1aa37729e6ad8c2cc412ae0b73138b920fba04c7974b14d7e9661` |
| `fr-FR/docs/block-jsx.mdx`     | `0580cc3c2e0aaea0dfb1905ce689a971bf850f56cd8451c2ddbb912800b65271` |
| `fr-FR/docs/expressions.mdx`   | `7fe3552758a30774a699932fa2036ce10811d6c25ece4d4a51d24c2ef1dc707b` |
| `fr-FR/docs/inline-jsx.mdx`    | `094b341575f2189ab1a51bb9bde4e0076aa35cbcd5f9879f5d5eafdbd45d0f2e` |
| `fr-FR/docs/plain-markdown.md` | `eec245f660e9574679ae1f7dd4956867f4f7b7742e904b45199dbf58a147d22d` |
| `fr-FR/docs/static-data.mdx`   | `1cabe32c0a9ef9764e83b7ed3952ec9d567ab6ef3e4b621651f105695e9415f6` |

Normalized report digest:

```text
44d4a570c5d4ece964117508ef1b22ab5bfe5e3fc4ca80b0f0af0a6bb844ba50
```

Report normalization removes `build.startedAt`, `build.durationMs`, and every
entry `durationMs`; entries are sorted by `{locale}/{sourcePath}` before
hashing the emitted two-space-indented JSON with its trailing newline. The
original recorded checksum was corrected in Step 8 because it did not match
this documented normalization; every normalized report field still matched.

## Manual Output Observations

Plain Markdown:

- Frontmatter translations are quoted by YAML serialization.
- `canonicalUrl` changes from `/docs/plain-markdown` to
  `/pt-BR/docs/plain-markdown` for the `pt-BR` output.
- `aiTranslated`, `aiTranslationModel`, and `aiTranslatedAt` appear in
  frontmatter before the closing delimiter.
- Body links are locale-prefixed.
- The fake translator prefixes each translated segment with `[locale]`.

MDX:

- ESM imports remain executable and retain their relative target after staging
  rewriting.
- Static exported arrays, annotation-selected arrays, function-return arrays,
  and inline JSX prop arrays preserve syntax while selected string values are
  prefixed.
- JSX expressions and configured visible props preserve their surrounding
  syntax.
- Markdown and MDX continue through separate parser paths.

## Core Hash And Prompt Fixtures

Source-hash fixture:

```json
{
  "body": "# Hello\n\nA paragraph.\n",
  "frontmatter": { "title": "Hello", "year": 2025 },
  "glossaryHash": "g0",
  "modelId": "@cf/meta/llama-3.1-8b-instruct"
}
```

Expected source hash:

```text
df40a08682e9df8e0643f5e95651478da8ff06922ad2f8aaec7d479db70bb7ee
```

Prompt fixture uses segments `fm:title = Hello` and
`body:0 = A paragraph.`, source locale `en-US`, target locale `pt-BR`, and
`EMPTY_GLOSSARY`.

| Prompt field  | Length | SHA-256                                                            |
| ------------- | -----: | ------------------------------------------------------------------ |
| System prompt |    734 | `32b336fbdce5ab269488f3f5d77840d1f1a9fa7c7e544d6f4c70bca570e4ef34` |
| User prompt   |    322 | `975ae31980e7f7a782ec257d7584e0ba689b01f006e86c34c82ba029a1363685` |

## Structured Adapter Fixtures

The current playground contains only Markdown and MDX. JSON, YAML, and TOML
are therefore characterized directly through their adapters and their existing
unit suites.

Each fixture selects `title` and `nested.body` and must emit these segments in
order:

```json
[
  { "id": "title", "text": "Hello" },
  { "id": "nested.body", "text": "World" }
]
```

Translations are `X:Hello` and `X:World`. The marker is intentionally injected
into the top-level object-valued entry (`nested`), matching Astro's collection
entry behavior.

Expected JSON output:

```json
{
  "title": "X:Hello",
  "nested": {
    "body": "X:World",
    "aiTranslated": true
  }
}
```

Expected YAML output:

```yaml
title: X:Hello
nested:
  body: X:World
  aiTranslated: true
```

Expected TOML output:

```toml
title = "X:Hello"

[nested]
body = "X:World"
aiTranslated = true
```

## Existing Invariant Coverage

| Requirement                                  | Existing coverage                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Cache hash composition and boundaries        | `tests/storage/hash.test.ts`                                                                     |
| Apply before PUT and cache hit/miss behavior | `tests/storage/cache.test.ts`                                                                    |
| Local cache index isolation                  | `tests/storage/local-cache.test.ts`, `tests/translation/run.test.ts`                             |
| Prompt bytes and response protocol           | `tests/translation/prompt.test.ts`                                                               |
| Group flattening and batching                | `tests/translation/batch.test.ts`, `tests/translation/translate-segments.test.ts`, adapter tests |
| Permanent versus retriable provider errors   | `tests/translation/provider.test.ts`                                                             |
| Markdown versus MDX parser behavior          | `tests/parsing/parse.test.ts`, `tests/parsing/mdx.test.ts`, `tests/parsing/round-trip.test.ts`   |
| Every current format adapter                 | `tests/parsing/*-adapter.test.ts`                                                                |
| Astro setup timing and end-to-end flow       | `tests/smoke.test.ts`, `tests/translation/run.test.ts`                                           |
| UI token/retry behavior                      | `tests/i18n/ui-translate*.test.ts`                                                               |

## Baseline Limitations

- R2 is intentionally not configured in the playground baseline. Real cache
  hit, fallback, prune, and write behavior is covered by storage and run tests.
- Override, `noTranslate`, and local-cache skip paths are covered by tests but
  are not represented in the playground's generated report.
- Structured formats have direct adapter fixtures rather than a staged Astro
  playground fixture.
- No real provider credentials or R2 credentials were used.

These are not extraction exceptions. Their existing tests must remain green,
and Step 12 still requires real provider and safe test-R2 manual verification
before release.
