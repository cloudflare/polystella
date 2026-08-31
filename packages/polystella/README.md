# @cloudflare/polystella

Compatibility package forwarding the Astro API to
[`@cloudflare/polystella-astro`](https://www.npmjs.com/package/@cloudflare/polystella-astro).

New Astro projects should install the canonical package directly:

```sh
pnpm add @cloudflare/polystella-astro
```

## Scope

This package contains no product implementation. It exists to keep the old
package name working during migration.

- Every public entry re-exports the matching Astro entry.
- `client.d.ts` references the canonical client declarations.
- The `polystella` executable launches the canonical CLI.
- Low-level APIs moved to core, adapters, and providers are not restored here.

## How It Connects

```text
@cloudflare/polystella --> @cloudflare/polystella-astro
```

The forwarding files live under `src/`; `src/cli.ts` forwards the executable.
The export map in `package.json` must stay aligned with the canonical package.
Compatibility parity is checked by `scripts/check-packages.mjs` in the
repository.

See the
[package architecture](https://github.com/cloudflare/polystella/blob/main/PACKAGE_ARCHITECTURE.md)
for package ownership and migration boundaries.
