# PolyStella docs — runnable examples

This directory holds compile-only documentation fixtures.

## Status

`direct-packages/` typechecks the direct core/adapters/providers flow and
the package-owned Workers AI binding types without generated Cloudflare
types.

## Adding an example

Add a focused fixture under a descriptive slug:

```
docs/examples/direct-packages/
```

`docs/scripts/check-examples.ts` runs `tsc` against the fixture. Keep it
dependency-free and map public workspace imports to package sources in its
local `tsconfig.json`.
