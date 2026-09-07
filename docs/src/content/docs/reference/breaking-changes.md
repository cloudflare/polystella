---
title: Breaking changes
description: Pre-1.0 breaking-change log.
aiGenerated: true
---

PolyStella is in pre-1.0 development. Breaking changes happen.
The log below tracks them so consumers can update incrementally.

Each public package's `CHANGELOG.md` is authoritative; this page mirrors
the breaking entries.

## Unreleased (v0.x)

### Low-level APIs moved to owning packages

Translation contracts and orchestration now come from
`@cloudflare/polystella-core`, portable formats from
`@cloudflare/polystella-adapters`, and provider transports from
`@cloudflare/polystella-providers`. `@cloudflare/polystella-astro` owns the
Astro integration and host-owned APIs. No compatibility shims preserve the
old low-level root imports.

### `r2.bulkListOnStart` defaults to `true`

Issues one `r2.list()` per locale at the start of the live phase
to populate an in-memory key set, turning per-pair cache checks
into O(1) lookups.

Consumers with caches >10k keys per locale (rare) may want
`bulkListOnStart: false` if the list cost dominates. Most
consumers see strictly faster builds.

### `provider.batchInputTokenBudget` added

Soft cap on per-batch input tokens during translation. Default 4000. Affects how the translator splits large files into batches;
doesn't affect the cache (the cache key is per-file).

Existing consumers see no behaviour change unless they set the
value explicitly.

### Nested catalog format support

UI-string JSON dictionaries now support a nested format, with
`i18n_group_title` keys grouping related entries. The format is
auto-detected per file; `i18n_group_title` values are excluded from
keys, drift detection, and translation.

All locale files must match the default locale's format. A locale
file that mixes or diverges from the default's nested vs flat
structure fails validation.

### Catalog CLI commands extracted to `@cloudflare/polystella-cli`

The catalog subcommands (`check-ui`, `sync-ui`, `translate-ui`) and
their shared filesystem utilities now live in the
`@cloudflare/polystella-cli` package, shared by both the Astro and
EmDash hosts. Import the commands from the new package instead of
the old host-local paths.

### Catalog-only mode entrypoints

A catalog-only adoption path is now available via
`@cloudflare/polystella-astro/catalog/*` (integration, middleware,
and pure helpers). It binds only `Astro.locals.t` and
`Astro.locals.lhref` over JSON UI-string dictionaries, with no
content translation, routing shims, or R2 cache.

## How we track breaking changes

- Every breaking change gets an entry under "Breaking changes" in
  the relevant version's changelog block.
- Before 1.0, minor bumps (`0.x` → `0.y`) may contain breaking changes;
  read their entries before upgrading.
- Patch bumps (`0.x.y` → `0.x.z`) do not intentionally break public APIs.
- After 1.0, breaking changes require a major bump.

Package changelogs follow the [Keep a Changelog](https://keepachangelog.com/)
format.
