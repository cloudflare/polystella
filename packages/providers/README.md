# @cloudflare/polystella-providers

Portable Workers AI and Anthropic transports for PolyStella.

## Scope

This package owns:

- Workers AI HTTP and binding translators.
- Anthropic HTTP translators.
- Package-owned structural types for Workers bindings.
- Transport error normalization and permanent/retriable classification.

It does not own prompts, batching, file formats, Astro options, or cache policy.

## How It Connects

```text
providers --> core
astro     --> providers
```

Every provider implements `Translator` from
[`@cloudflare/polystella-core`](https://www.npmjs.com/package/@cloudflare/polystella-core).
The canonical
[`@cloudflare/polystella-astro`](https://www.npmjs.com/package/@cloudflare/polystella-astro)
package maps user configuration to these factories.

## Public Imports

- `@cloudflare/polystella-providers` - all provider factories.
- `@cloudflare/polystella-providers/workers-ai` - Workers AI factories and types.
- `@cloudflare/polystella-providers/anthropic` - Anthropic factory and types.

Key implementations are `src/workers-ai.ts`, `src/anthropic.ts`, and
`src/http-error.ts`.

See the
[package architecture](https://github.com/cloudflare/polystella/blob/main/PACKAGE_ARCHITECTURE.md)
and [translator contract](https://github.com/cloudflare/polystella/blob/main/ARCHITECTURE.md#translator-contract)
for contributor guidance.
