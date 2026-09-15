---
"@cloudflare/polystella-core": minor
"@cloudflare/polystella-astro": patch
"@cloudflare/polystella-emdash": patch
---

Merge the `@cloudflare/polystella-adapters`, `@cloudflare/polystella-providers`, and `@cloudflare/polystella-cli` packages into `@cloudflare/polystella-core` as namespaced subpaths (`/adapters`, `/providers`, `/providers/*`, `/cli`, `/cli/*`). The old package names are not republished as compatibility wrappers; rewrite imports to the new subpaths. Core's root, catalog, adapters, and providers entrypoints stay Workerd-portable without `nodejs_compat`; Node imports exist only under `/cli`.
