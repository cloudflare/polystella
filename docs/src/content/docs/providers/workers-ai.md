---
title: Workers AI provider
description: Cloudflare Workers AI as the translation provider.
---

The Workers AI provider routes translation through Cloudflare's
Workers AI inference platform. A natural choice when your site
already runs on Cloudflare.

## Cloudflare setup

PolyStella calls Workers AI from your build process through the REST
API. You do not need a Worker binding; you need an account ID, API
token, and model id.

1. In the Cloudflare dashboard, open **Workers AI** and choose **Use
   REST API**.
2. Choose **Create a Workers AI API Token**, copy the token, then copy
   the account ID shown on the same page. If you create a custom API
   token instead of using Cloudflare's template, grant account-level
   `Workers AI - Read` and `Workers AI - Edit` permissions.
3. Store those values as secrets in your shell / CI environment. The
   examples below use `CF_ACCOUNT_ID` and `CF_API_TOKEN`, but the names
   are only conventions:

   ```bash
   export CF_ACCOUNT_ID="..."
   export CF_API_TOKEN="..."
   ```

4. Pick a model from the Workers AI model catalog. The examples use
   `@cf/meta/llama-3.1-8b-instruct`, which is a reasonable starting
   point for most projects.
5. Add the provider block to `polystella.config.mjs` and keep the
   token out of source control. Pass only the raw token value;
   PolyStella adds the `Bearer` authorization header.

Run `polystella translate --dry-run` first to verify PolyStella can
load the project and plan the work without calling Workers AI. Then
run a normal translation or `astro build` to make the first live
provider call.

## Configuration

```js
// polystella.config.mjs
export default {
  provider: {
    kind: "workers-ai",
    accountId: process.env.CF_ACCOUNT_ID,
    apiToken: process.env.CF_API_TOKEN,
    model: "@cf/meta/llama-3.1-8b-instruct",
    maxTokens: 8192,
    batchInputTokenBudget: 4000,
  },
};
```

Required: `accountId`, `apiToken`, `model`. The rest have sensible
defaults.

## Models

The model id is part of the cache key. Switching models is an
explicit cache invalidation. For per-locale model selection (e.g.
larger model for CJK locales):

```js
model: {
  default: "@cf/meta/llama-3.1-8b-instruct",
  "ja-JP": "@cf/qwen/qwen3-30b-a3b-fp8",
  "zh-CN": "@cf/qwen/qwen3-30b-a3b-fp8",
}
```

The `default` key is consulted for any locale not in the map.

## Endpoint override

`endpoint` is an escape hatch for tests or proxy deployments. When it
is set, PolyStella sends the Workers AI request body to that exact URL
instead of constructing Cloudflare's native
`/accounts/{accountId}/ai/run/{model}` URL:

```js
endpoint: "https://gateway.example/run",
```

PolyStella does not template-substitute this value and does not add
gateway-specific headers. If your proxy needs the model id in the URL,
include it in the `endpoint` value you configure.

## Token budgets

- **`maxTokens`** — max output tokens per call. Workers AI's
  default is ~256, which truncates multi-segment translations.
  PolyStella's default of 8192 fits under llama-3.1-8b's cap.
- **`batchInputTokenBudget`** — soft cap on per-batch input tokens.
  The pipeline groups adapter segments into batches that fit under
  this budget. See [Providers → Batching](/providers/batching/).

## Permanent vs retriable errors

Workers AI returns three classes of HTTP error PolyStella treats
differently:

- **401, 403, 404, 422** — permanent. `PermanentProviderError`
  short-circuits the retry loop. Fix your credentials / model id
  and rerun.
- **429, 500, 502, 503, 504** — retriable. `p-retry` retries with
  exponential backoff and jitter.
- **Other 4xx (e.g. 400)** — treated as retriable by default. If
  the request shape is malformed, retries won't help; PolyStella
  logs the response body and exits non-zero.

See [Providers → Permanent errors](/providers/permanent-errors/)
for the contract.
