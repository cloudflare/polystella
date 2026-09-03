# @cloudflare/polystella-core

Platform-neutral translation contracts and orchestration for PolyStella.

## Scope

This package owns:

- `Segment`, `Glossary`, `Logger`, and `Translator` contracts.
- Prompt construction and provider-response parsing.
- Token estimation, grouping validation, and batch packing.
- Translation execution, retries, cancellation, and `PermanentProviderError`.
- Catalog lookup, fallback, interpolation, and UI-string translation.

It does not parse file formats, call a specific AI provider, or depend on
Astro, Node filesystem APIs, or R2.

## Key Files

- `src/index.ts` - public barrel.
- `src/translator.ts` - provider contract and permanent errors.
- `src/prompt.ts` - prompt construction and response parsing.
- `src/batch.ts` - token estimation and batch packing.
- `src/translate-batch.ts` - retries and one provider request.
- `src/translate-segments.ts` - end-to-end segment orchestration.
- `src/catalog/index.ts` - dependency-free catalog runtime.
- `src/catalog/translate.ts` - catalog AI translation and token validation.

Public import paths:

- `@cloudflare/polystella-core` - translation protocol and orchestration.
- `@cloudflare/polystella-core/catalog` - catalog runtime without the retry path.
- `@cloudflare/polystella-core/catalog/translate` - selected-entry and empty-placeholder catalog AI translation.

See the
[package architecture](https://github.com/cloudflare/polystella/blob/main/PACKAGE_ARCHITECTURE.md)
and [translator contract](https://github.com/cloudflare/polystella/blob/main/ARCHITECTURE.md#translator-contract)
for contributor guidance.
