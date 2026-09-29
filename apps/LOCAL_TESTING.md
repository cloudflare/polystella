# Testing the Translation Apps Locally

How to run and check [`apps/server`](./server/) (the Translation Agent API
Worker) and [`apps/console`](./console/) (its React UI) on your machine.

Automated checks need nothing beyond `pnpm install`. Running the Worker needs
a Cloudflare login, because its `AI` binding always calls remote Workers AI.
**Every translation request runs real inference on your account.**

## 1. Set Up

From the repository root:

```bash
pnpm install
pnpm build:internal   # builds @cloudflare/polystella-core; needed for types and glossary loading
```

## 2. Run the Automated Checks

```bash
pnpm test:apps        # server unit and HTTP tests; no network, no glossaries
pnpm typecheck:apps   # server and console
pnpm build:apps       # server dry-run bundle and console Vite build
pnpm audit:prod
```

Tests never read the generated glossary file. `vitest.config.ts` swaps it for
an empty object, and `prompt-utils.test.ts` installs synthetic glossaries.

## 3. Choose a Glossary Source

Terminology, do-not-translate terms, and style guides come from PolyStella
glossaries. `pnpm --filter polystella-server glossaries` loads them and writes
`apps/server/src/generated/glossaries.json` (gitignored). `dev` and `build` run
it first. `typecheck` runs it only if the file is missing.

The loader runs in Node before Wrangler starts, so set these variables in the
shell that runs `pnpm`, not in `.dev.vars`:

| Variable           | Meaning                                                                                                                        |
| :----------------- | :----------------------------------------------------------------------------------------------------------------------------- |
| `GLOSSARY_SOURCE`  | JSON in PolyStella's `glossary` config shape. Unset writes `{}`: prompts have no terminology, do-not-translate list, or guide. |
| `GLOSSARY_LOCALES` | Comma-separated locales. Defaults to every supported locale plus `default`. Required for `http` and `r2`.                      |

Relative `file` paths resolve from `apps/server/`. Every template needs a
`{locale}` placeholder.

### Local files

Missing locales are skipped. If you have the local conversion in
`apps/server/generated-glossaries/` (gitignored):

```bash
export GLOSSARY_SOURCE='{"file":"generated-glossaries/{locale}.yaml"}'
pnpm --filter polystella-server glossaries
# [glossaries] wrote 19 glossaries
```

The directory has 21 files. `es-LA` and `pt-PT` aren't supported target
locales, so they are never loaded.

Without it, write a synthetic pair:

```yaml
# apps/server/generated-glossaries/default.yaml
doNotTranslate:
  - Cloudflare
  - Workers
styleRules:
  - category: tone
    instruction: Use a neutral, professional tone.
```

```yaml
# apps/server/generated-glossaries/zh-TW.yaml
doNotTranslate:
  - Cloudflare
  - Workers
preferredTranslations:
  "data center;Data center": 資料中心
  Firewall: 防火牆
styleRules:
  - category: punctuation
    instruction: Use full-width punctuation.
    example: 你好，世界。
```

Allowed keys: `version`, `doNotTranslate`, `preferredTranslations`,
`styleRules` (`category`, `instruction`, optional `example`), and `notes`.
Unknown keys fail the load.

### HTTP or R2

Any missing locale fails the whole load, so list only the locales that exist:

```bash
export GLOSSARY_SOURCE='{"http":{"url":"https://example.com/glossaries/{locale}.yaml","headers":{"Authorization":"Bearer <token>"}}}'
export GLOSSARY_LOCALES='default,de-DE,ja-JP,zh-TW'
```

```bash
export GLOSSARY_SOURCE='{"r2":{"accountId":"<account>","bucket":"<bucket>","key":"glossaries/{locale}.yaml","accessKeyId":"<id>","secretAccessKey":"<secret>"}}'
export GLOSSARY_LOCALES='default,de-DE,ja-JP,zh-TW'
```

HTTP URLs must be HTTPS. Keep tokens out of shell history, for example by
sourcing them from an ignored file.

### How glossaries reach the prompt

For each target locale:

| Prompt section                   | Source                                                                                       |
| :------------------------------- | :------------------------------------------------------------------------------------------- |
| Terminology reference            | That locale's `preferredTranslations`; `;` separates aliases in a key. English sources only. |
| Product names (do-not-translate) | That locale's `doNotTranslate`, else `default`'s.                                            |
| Language style guide             | That locale's `styleRules` and `notes`, else `default`'s.                                    |

To inspect what was loaded:

```bash
node -e 'const g=require("./apps/server/src/generated/glossaries.json");for(const[k,v]of Object.entries(g))console.log(k,Object.keys(v.preferredTranslations).length,v.doNotTranslate.length,v.styleRules.length)'
```

## 4. Configure the Worker

1. Authenticate Wrangler: run `pnpm --filter polystella-server exec wrangler login`, or
   export `CLOUDFLARE_API_TOKEN` (with Workers AI access) and
   `CLOUDFLARE_ACCOUNT_ID`. Without either, `wrangler dev` exits with
   "Failed to start the remote proxy session".
2. Optionally create `apps/server/.dev.vars` (gitignored):

   ```ini
   GUARDRAIL_MODE=off
   # Braintrust tracing; logging is disabled with a warning when these are absent.
   BRAINTRUST_API_KEY=
   BRAINTRUST_API_URL=
   BRAINTRUST_PROJECT_NAME=
   ```

   The Agent's Claude path is disabled in code, so `ANTHROPIC_API_KEY` isn't
   needed.

3. Optionally cut retries: `NODE_ENV=development` in the shell running
   `pnpm dev` makes each locale try once instead of three times. Wrangler inlines it
   at bundle time, so setting it in `.dev.vars` has no effect.

## 5. Start the Apps

```bash
pnpm dev:apps                          # server on :8787 and console on :5173
pnpm --filter polystella-server dev    # server only
```

Glossaries are generated once at startup. After changing `GLOSSARY_SOURCE` or
the YAML files, restart `dev`.

## 6. Smoke-Test the API

The API is mounted at `/api`. Wrangler prints one line per locale showing the
model and prompt resources, for example
`[zh-TW] Start | model=@cf/moonshotai/kimi-k2.5 terminology=true guide=glossary:zh-TW`.

Health check (no inference):

```bash
curl -s localhost:8787/api
# {"status":"ok","message":"Translation API is running","version":"1.0.0"}
```

Validation errors (no inference; both return 400):

```bash
curl -s -i localhost:8787/api/translate -H 'content-type: application/json' \
  -d '{"text":"Hi","targetLocale":"xx-XX"}'
curl -s -i localhost:8787/api/translate -H 'content-type: application/json' \
  -d '{"text":"Hi","targetLocale":"fr-FR","sourceLocale":"fr-FR"}'
```

Plain text, the way the marketing site calls it (one string, default model):

```bash
curl -s localhost:8787/api/translate -H 'content-type: application/json' \
  -d '{"text":"Enable the Firewall for every Cloudflare data center.","targetLocale":"zh-TW"}'
```

Expect `success: true`, `translations["zh-TW"]` as a string, and
`meta["zh-TW"].model` as `kimi2_5`, or `qwen` if runtime fallback ran. With
glossaries loaded, the log line shows `terminology=true guide=glossary:zh-TW`.

JSON catalog, the way the dashboard calls it (one request per model group):

```bash
curl -s localhost:8787/api/translate -H 'content-type: application/json' \
  -d '{"text":"{\"nav.firewall\":\"Firewall\",\"nav.workers\":\"Workers\"}","targetLocale":"de-DE,ja-JP","model":"gpt"}'
curl -s localhost:8787/api/translate -H 'content-type: application/json' \
  -d '{"text":"{\"nav.firewall\":\"Firewall\",\"nav.workers\":\"Workers\"}","targetLocale":"zh-CN,pt-BR","model":"kimi2_5"}'
```

Expect `translations[locale][key]` for every key, and `meta[locale].model`
equal to the requested model. Fallback runs only when the request doesn't name
a model.

Non-English source (support use case):

```bash
curl -s localhost:8787/api/translate -H 'content-type: application/json' \
  -d '{"text":"Cloudflare Workers を設定したいです。","sourceLocale":"ja-JP","targetLocale":"en-US"}'
```

The log line shows `terminology=false`. English-keyed terminology is skipped
for non-English sources. Do-not-translate terms still apply, and `en-US` uses
the `default` style guide.

Models: `kimi2_5` (default), `gpt`, `qwen` (fallback), `llama`, `glm`.
Limits: 5,000 input tokens, 16-minute request timeout, 10 minutes per locale.

## 7. Test the Console

1. Run `pnpm dev:apps`.
2. Open <http://localhost:5173>. Vite proxies `/api` to the server on `:8787`.
3. Pick a source locale, one or more target locales, and a model, then
   translate. Each locale's accordion shows its result or error.

The console's Worker (`apps/console/index.ts`) only serves static assets, so
`wrangler dev` inside `apps/console` serves the built UI without an API.
Use Vite for end-to-end testing. To check just the Worker config:

```bash
pnpm --filter polystella-console build
pnpm --filter polystella-console exec wrangler deploy --dry-run
```

## Known Differences From the Old Repo

- Language resources come only from `GLOSSARY_SOURCE`; nothing is bundled from
  `locales/`. With no source, prompts have no terminology, product-name list,
  or style guide.
- Do-not-translate terms are per locale, with a `default` fallback, rather
  than one global list.
- The style guide is rendered from `styleRules` as `### <category>` sections.
  `meta.styleGuideSource` and the `style_guide_source` span field read
  `glossary:<locale>` or `glossary:default` instead of `<locale>.md`.
- Guardrail allowlists and evaluation datasets are synthetic placeholders, so
  guardrail and evaluation results don't reflect production.
- Worker names end in `-local`, and the configs contain no production routes.

## Troubleshooting

| Symptom                                                      | Fix                                                                                                    |
| :----------------------------------------------------------- | :----------------------------------------------------------------------------------------------------- |
| `Failed to start the remote proxy session`                   | Run `wrangler login`, or export `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.                    |
| `wrote 0 glossaries (GLOSSARY_SOURCE is not set)`            | Export `GLOSSARY_SOURCE` in the same shell as `pnpm dev`.                                              |
| `GLOSSARY_LOCALES is required for http and r2 sources`       | List the locales that exist remotely.                                                                  |
| `failed to load glossary ... HTTP 404` or `object not found` | Remove that locale from `GLOSSARY_LOCALES`.                                                            |
| `Cannot find module '@cloudflare/polystella-core/...'`       | Run `pnpm build:internal`.                                                                             |
| `... must contain the "{locale}" placeholder`                | Add `{locale}` to the file path, URL, or R2 key.                                                       |
| `Unrecognized key` in a glossary                             | Remove keys other than the allowed five.                                                               |
| Log shows `guide=none` with glossaries loaded                | Neither the locale nor `default` has `styleRules` or `notes`.                                          |
| Log shows `terminology=false` for an English source          | The locale has no `preferredTranslations` entry that appears in the text or in the always-include set. |
| Changes to glossaries don't show up                          | Restart `dev`; glossaries are generated once at startup.                                               |
| Console requests fail with a proxy error                     | The server isn't running on `:8787`.                                                                   |
