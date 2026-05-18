# Changelog

All notable changes to PolyStella are tracked here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning will follow [semver](https://semver.org/) once the package
is on npm.

## [Unreleased]

The next release target is **v0.2.0** — the first GitHub-installable
tag after the repository split.

### Added

- Documentation site (Starlight) under `docs/`. Configuration
  reference auto-generated from the zod schema; CI asserts every
  public export has a docs entry.
- `react` declared as an **optional peer dependency**
  (`^17.0.0 || ^18.0.0 || ^19.0.0`). The `polystella/react`
  subpath only imports `useMemo`, which is stable across all
  three React majors. Marked optional so consumers that don't use
  the React hooks aren't pestered for the dep. `@types/react`
  added as a dev dependency so contributors get IntelliSense
  without a manual install.
- `@astrojs/sitemap` declared as a **dev dependency**. The
  `polystella/i18n/sitemap` helper produces options for
  `@astrojs/sitemap` but doesn't import it at runtime; the test
  `tests/i18n/sitemap-types.test.ts` does, for structural type
  compatibility. Consumers wire their own `@astrojs/sitemap`
  install as usual.
- `polystella/client` export — types-only entrypoint for
  `env.d.ts` virtual-module references.
- `polystella/runtime/middleware` export — direct middleware
  entrypoint used by `addMiddleware`. Rarely imported directly.
- `r2.bulkListOnStart` config option (default `true`). Issues one
  `r2.list()` per locale at the start of the live phase to populate
  an in-memory key set, replacing per-pair cache-check GETs with
  O(1) lookups.
- `provider.batchInputTokenBudget` config option (default 4000).
  Soft cap on per-batch input tokens; the pipeline groups adapter
  segments into batches that fit under this budget.
- Per-batch document-context block. `markdown.contextKeys`
  declares frontmatter keys whose source-language values are
  injected into the system prompt to keep terminology consistent
  across batches when a long document is split.
- `polystella check-ui`, `sync-ui`, `translate-ui` subcommands for
  UI-string maintenance. Drift detection (`check-ui`) is wired
  into the host project's pre-commit hook.
- `PermanentProviderError` class. Translator implementations throw
  it on 401/403/404/422 to short-circuit the retry loop.
- `AbortSignal` threading. Ctrl-C during a build cleanly aborts
  in-flight provider calls.
- End-to-end smoke test (`tests/smoke.test.ts`) that drives the
  `polystella(options)` factory against a real temp project.

### Changed

- **Breaking:** `polystella-translate` binary renamed to
  `polystella translate`. Direct invocations must update; the
  host project's `pnpm translate` wrapper transparently redirects.
- **Breaking:** the CLI is now subcommand-based. Run
  `polystella --help` for the menu. Subcommands own their own argv
  parsing.
- Test count grew from ~940 to 1105 across the work in this
  release (1168 in the host monorepo; 63 of those were per-
  publication round-trip cases that were inherently coupled to
  the host's content corpus). The README's "Tests" section
  reflects the new total.
- The parser round-trip test now runs over a bundled
  `tests/fixtures/parsing/round-trip/` corpus instead of reading
  from the host monorepo's `content/publications/`. 15 fixtures
  cover the full feature surface of `remark-parse + remark-gfm +
  remark-frontmatter`: frontmatter shapes, inline formatting,
  headings, lists (incl. task lists), code blocks, blockquotes,
  GFM tables, raw HTML, thematic breaks, empty frontmatter, no
  frontmatter, footnotes, images, and a punctuation-heavy edge-
  case file with Unicode + escapes. The standalone repo is now
  self-contained for testing.
- `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitReturns`, `noFallthroughCasesInSwitch` enabled in
  `tsconfig.json`. Surfaced 14 errors; all fixed.
- Translation retries migrated from a hand-rolled loop to
  `p-retry` with exponential backoff and jitter.
- `POLYSTELLA_VERSION` constant now reads from `package.json` via
  a JSON import. Previously hard-coded to `0.2.0` in two places
  while `package.json` said `0.1.5`; every R2 metadata entry
  shipped to date had the wrong version stamp.

### Performance

- Dry-run and live passes merged. Live builds now do ONE
  `adapter.parse` per source (was two).
- R2 bulk pre-list (see Added). Replaces per-pair GETs with O(1)
  lookups; typically reduces cold-build network round-trips by
  20–30x.
- Picomatch matcher caching. `WeakMap` per `noPrefixUrls` array in
  the runtime hot paths; pattern-keyed `Map` per glob in the build
  hot paths. Compilation moves from per-call to first-call-only.
- Glossary reuse between `runTranslationPass` and
  `publishRuntimeBridge`. Saves one FS read per locale per build.

### Fixed

- `extractSegments` and `selectTranslatableFrontmatter` no longer
  crash on files with empty YAML frontmatter (`---\n---`). The
  `yaml` parser returns `null` for empty input, which the old
  `as Record<string, unknown>` cast didn't guard against. Both
  functions now coerce non-object YAML to an empty record.
  Surfaced by the new bundled round-trip fixture corpus; never
  hit in the host monorepo because no real publication used
  empty frontmatter.
- `publishRuntimeBridge` no longer loses its `stagingDir` parameter
  on signature changes (a regression from the comment-cleanup pass
  that only surfaced at typecheck time).
- Vitest `singleThread: true` retained after measuring multi-worker
  is slower at this scale. The original AGENTS.md gotcha about
  "shared module state" was wrong; updated to reflect the real
  reason (perf at small scale).
- 6 non-null assertions (`!`) and 4 `: any` annotations removed
  from `src/`. Codex RFC 009 compliance.

### Documentation

- New `ARCHITECTURE.md` covers system-level design, hard
  invariants, domain glossary, and per-subsystem reference.
- New `AGENTS.md` covers agent-facing context per codex RFC 004.
- New `skills/polystella-consumer/SKILL.md` and
  `skills/polystella-contributor/SKILL.md` — opt-in agent skills
  for consumer and contributor workflows.
- New `llms.txt` and `llms-full.txt` at the package root per the
  llmstxt.org convention.

## Earlier history

Pre-0.1, breaking changes were rolled forward without a log because
the package was internal-only. The package's git history is the
authoritative record.
