---
title: Model selection
description: Single model id vs per-locale map; how model choice affects the cache.
aiGenerated: true
---

The `provider.model` option is either a single model id or a per-
locale map with a mandatory `default` key.

## Single model

```js
model: "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
```

Same model for every locale. Simplest, cheapest, often fine.

## Per-locale map

```js
model: {
  default: "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
  "ja-JP": "@cf/qwen/qwen3.8-27b",
  "zh-CN": "@cf/qwen/qwen3.8-27b",
}
```

The `default` is mandatory and applies to any locale not in the
map. Use this when:

- Some locales need a larger model (CJK, Arabic).
- You're A/B testing model output for a specific locale.
- One locale's content domain demands a specialised model.

## How the choice affects the cache

The resolved model id is part of the cache key. Different model
for different locale ⇒ different keys ⇒ cache hits are still
per-locale-correct.

Switching a locale's model:

```js
// Before
model: "@cf/deepseek-ai/deepseek-v4.1-flash-1017";

// After
model: {
  default: "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
  "ja-JP": "@cf/qwen/qwen3.8-27b",
}
```

Invalidates every cached translation for `ja-JP`. The next build
retranslates everything for that locale. The other locales still
hit the cache.

## When to switch models

The default Workers AI model (`@cf/deepseek-ai/deepseek-v4.1-flash-1017`) is
a sensible starting point for most projects. Reasons to switch:

- **CJK quality.** Latin-script models often produce mediocre
  output for Japanese, Chinese, Korean. Try Qwen or a Claude tier.
- **Token budget.** Larger models give the AI more room to honour
  complex glossary rules. If you have a long, opinionated style
  guide, a 70B-parameter model honours it more reliably than 8B.
- **Throughput.** Some Workers AI models throttle differently;
  switching can change build latency.

There's no universally-right answer. A common pattern is Qwen 3
30B (or similar) for CJK and llama 3.1 8B for Latin-script locales.

## Documenting your choice

Whatever model you pick, write it down somewhere your future self
can find. The R2 metadata stamp helps (every cached translation
records its model), but a one-line comment in
`polystella.config.mjs` saves hunting later.
