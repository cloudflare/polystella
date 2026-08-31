---
title: Permanent errors
description: PermanentProviderError vs retriable failures — how the retry loop decides.
aiGenerated: true
---

When a provider call fails, PolyStella has to decide: retry, or
give up? The `PermanentProviderError` class encodes that decision.

## The class

Owned by the platform-neutral core package:

```ts
import { PermanentProviderError, type Translator } from "@cloudflare/polystella-core";
```

Both built-in providers (`workers-ai`, `anthropic`) throw it from
their `translate(...)` method on specific HTTP statuses.

## Which statuses are "permanent"

| HTTP status | Classification | Reasoning                                                                          |
| ----------- | -------------- | ---------------------------------------------------------------------------------- |
| 400         | Permanent      | The request is invalid. Retries with the same body will fail.                      |
| 401         | Permanent      | Auth failure. Retries with the same credentials will fail the same way.            |
| 403         | Permanent      | Forbidden — wrong account, wrong model permission, gated feature. Retry won't fix. |
| 404         | Permanent      | Model id is wrong (or revoked). Retry against the same id will fail.               |
| 422         | Permanent      | Request shape rejected at validation. Retries with the same body will fail.        |
| 408         | Retriable      | Timeout. Backoff before retry.                                                     |
| 425, 429    | Retriable      | Rate-limited / too-early. Backoff before retry.                                    |
| 5xx         | Retriable      | Server-side error. Backoff before retry.                                           |
| Other 4xx   | Retriable      | Default. The built-in permanent set is deliberately narrow.                        |

## What the retry loop does

PolyStella uses `p-retry` for the translator retry loop:

```ts
import pRetry from "p-retry";
import { isPermanentProviderError, parseResponse } from "@cloudflare/polystella-core";

const translations = await pRetry(
  async () => {
    signal?.throwIfAborted();
    const rawText = await translator.translate(systemPrompt, userPrompt, signal);
    return parseResponse(rawText, expectedIds);
  },
  {
    retries: maxRetries,
    factor: 2,
    randomize: true,
    shouldRetry: ({ error }) => !isPermanentProviderError(error),
  },
);
```

If `translator.translate(...)` throws a `PermanentProviderError`,
the retry loop short-circuits and propagates the error. The build
fails fast.

For any other error (network drop, 5xx, malformed model output that
the parser rejects), the retry loop backs off and tries again. The
backoff is exponential with jitter to avoid thundering-herd against
the provider.

## When you'd write your own

If you implement a custom provider (rare; the two built-in
providers cover the common cases), throw `PermanentProviderError`
for any failure that retries can't fix:

```ts
const translator: Translator = {
  modelId: "example-model",
  async translate(systemPrompt, userPrompt, signal) {
    signal?.throwIfAborted();
    const response = await fetch(endpoint, {
      method: "POST",
      body: JSON.stringify({ systemPrompt, userPrompt }),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (response.status === 401) throw new PermanentProviderError("authentication failed");
    if (!response.ok) throw new Error(`provider error ${response.status}: ${await response.text()}`);
    return response.text();
  },
};
```

The retry loop sees `PermanentProviderError` and stops. Anything
else gets retried.

Before the package split this class was a low-level named export from
`@cloudflare/polystella`. Import it from core now; no compatibility shim
is provided by the Astro package.

## AbortSignal

Independently of the permanent/retriable distinction, every
translator call respects an `AbortSignal`. Hitting Ctrl-C during a
build aborts in-flight provider calls cleanly. See ARCHITECTURE.md
`#abortsignal` for the threading model.
