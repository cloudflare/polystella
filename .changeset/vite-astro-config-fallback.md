---
"@cloudflare/polystella-core": patch
"@cloudflare/polystella-astro": patch
---

Load the Astro config the way Astro does in every CLI command: find `astro.config.{mjs,js,ts,mts}`, try a plain Node import, and fall back to the project's Astro-installed Vite when that fails. Configs that import TypeScript-only packages no longer break `check-ui`, `sync-ui`, `translate-ui`, `translate`, or `audit-mdx`.
