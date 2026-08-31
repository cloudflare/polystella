# @cloudflare/polystella-core

Platform-neutral translation contracts and orchestration for PolyStella.

## Scope

This package owns:

- `Segment`, `Glossary`, `Logger`, and `Translator` contracts.
- Prompt construction and provider-response parsing.
- Token estimation, grouping validation, and batch packing.
- Translation execution, retries, cancellation, and `PermanentProviderError`.

It does not parse file formats, call a specific AI provider, or depend on
Astro, Node filesystem APIs, or R2.

## How It Connects

```text
adapters  ──┐
providers ──┼──> core
astro     ──┘
```

[`@cloudflare/polystella-adapters`](https://www.npmjs.com/package/@cloudflare/polystella-adapters)
uses the segment contracts.
[`@cloudflare/polystella-providers`](https://www.npmjs.com/package/@cloudflare/polystella-providers)
implements `Translator`. The canonical
[`@cloudflare/polystella-astro`](https://www.npmjs.com/package/@cloudflare/polystella-astro)
package composes both.

## Key Files

- `src/index.ts` - public barrel.
- `src/translator.ts` - provider contract and permanent errors.
- `src/prompt.ts` - prompt construction and response parsing.
- `src/batch.ts` - token estimation and batch packing.
- `src/translate-batch.ts` - retries and one provider request.
- `src/translate-segments.ts` - end-to-end segment orchestration.

The only public import path is `@cloudflare/polystella-core`.

See the
[package architecture](https://github.com/cloudflare/polystella/blob/main/PACKAGE_ARCHITECTURE.md)
and [translator contract](https://github.com/cloudflare/polystella/blob/main/ARCHITECTURE.md#translator-contract)
for contributor guidance.
