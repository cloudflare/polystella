# @cloudflare/polystella-adapters

Portable Markdown, MDX, JSON, YAML, and TOML translation adapters for
PolyStella.

## Scope

This package owns:

- The `FileAdapter` contract.
- Parsing and reconstruction for supported content formats.
- Segment extraction, grouping, and translation application.
- Structured key paths, MDX rules, and placeholder preservation.

It does not own prompts, model transports, Astro configuration, staging, R2,
or routing policy.

## How It Connects

```text
adapters --> core
astro    --> adapters
```

Adapters use `Segment` from
[`@cloudflare/polystella-core`](https://www.npmjs.com/package/@cloudflare/polystella-core).
The canonical
[`@cloudflare/polystella-astro`](https://www.npmjs.com/package/@cloudflare/polystella-astro)
package wraps the portable adapters with Astro-specific configuration and URL
policy.

## Key Files

- `src/index.ts` - public barrel.
- `src/adapter.ts` - `FileAdapter` contract.
- `src/adapters/` - built-in format adapters.
- `src/adapters/markdown/extract.ts` and `src/adapters/markdown/apply.ts` - shared Markdown operations.
- `src/key-paths.ts` - structured-data traversal.
- `src/adapters/markdown/mdx-rules.ts` and `src/adapters/markdown/mdx-placeholders.ts` - MDX safety rules.

The only public import path is `@cloudflare/polystella-adapters`.

See the
[package architecture](https://github.com/cloudflare/polystella/blob/main/PACKAGE_ARCHITECTURE.md)
and [adapter contract](https://github.com/cloudflare/polystella/blob/main/ARCHITECTURE.md#adapter-contract)
for contributor guidance.
