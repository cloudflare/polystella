## What does this PR do?

Extracts PolyStella from a single Astro package into five packages with explicit dependency boundaries. Astro and its compatibility package share a version; core, adapters, and providers are versioned independently:

```text
@cloudflare/polystella -> @cloudflare/polystella-astro
                              |-> @cloudflare/polystella-adapters -> core
                              |-> @cloudflare/polystella-providers -> core
                              `-> @cloudflare/polystella-core
```

- Makes `@cloudflare/polystella-astro` the canonical Astro integration.
- Keeps `@cloudflare/polystella` as a forwarding compatibility package.
- Extracts platform-neutral translation orchestration, format adapters, and provider transports into reusable packages that work without `nodejs_compat`.
- Adds package boundary, clean-consumer, tarball, workerd, and baseline checks.
- Updates CI, release workflows, documentation, examples, contributor guidance, and the MDX playground for the new package graph.
- Documents package ownership and dependency direction in `PACKAGE_ARCHITECTURE.md`.

The extraction also hardens the new package boundaries:

- Moves format-specific prompt guidance from core to the Markdown adapter.
- Enforces segment grouping and unique-ID invariants in core.
- Colocates Markdown and MDX implementation files and moves MDX options out of generic adapter contracts.
- Protects recursively nested inline MDX JSX and restores nested placeholders inside-out.
- Rejects malformed structured-data key paths after array indexes.
- Consolidates duplicated private MDX AST utilities.

### Migration notes

- Astro consumers should import the integration from `@cloudflare/polystella-astro`.
- Existing `@cloudflare/polystella` integration imports continue through the compatibility package.
- Low-level consumers should import contracts from `@cloudflare/polystella-core`, formats from `@cloudflare/polystella-adapters`, and transports from `@cloudflare/polystella-providers`.
- Markdown adapter callers should use `MarkdownAdapterExtractOptions` and `MarkdownAdapterApplyOptions` for `mdxRules`; the generic adapter options are now format-neutral.

## Type of change

- [x] Bug fix
- [ ] Feature
- [x] Refactor (no behavior change)
- [x] Documentation
- [x] Tests
- [x] CI / tooling
- [x] Chore

## PolyStella invariants touched

- [ ] None
- [ ] Cache key formula
- [x] Translation batching / segment grouping
- [ ] Apply-before-PUT cache write order
- [ ] Local cache index isolation
- [ ] Runtime bridge timing
- [ ] URL-rewrite idempotence
- [ ] Provider permanent vs retriable errors
- [ ] R2 key / local path separator handling

## Checklist

- [x] I have read `CONTRIBUTING.md`
- [x] I have added or updated tests, or this change does not need tests
- [x] I have added a changeset, or this change does not affect the published package
- [x] I have updated docs, or this change does not affect public behavior
- [x] `pnpm test` passes
- [x] `pnpm typecheck` passes
- [x] Docs checks and builds pass

## AI-generated code disclosure

- [x] This PR includes AI-generated code - model/tool: OpenCode (GPT-5.6 Sol)

## Screenshots / logs / test output

- `pnpm test`: 1,299 tests passed, including package, Astro, workerd, and boundary suites.
- `pnpm typecheck`: all five public packages passed strict typechecking.
- `pnpm check:packages`: five tarballs, 17 runtime imports, clean Astro consumers, and both CLIs passed.
- `pnpm check:baseline`: passed.
- `pnpm format:check` and `git diff --check`: passed.
- Documentation export checks, example checks, and production build passed.
