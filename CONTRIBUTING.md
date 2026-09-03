# Contributing to PolyStella

Thanks for the interest. PolyStella is pre-1.0 and changes land
quickly. Contributions, issues, and proposals are welcome.

PolyStella is maintained by a small team. We cannot guarantee that
issues, discussions, or pull requests will be reviewed promptly, or
reviewed at all. The guidance below is meant to make contributions
easier to evaluate when maintainer time is available.

## Repository overview

PolyStella is a pnpm workspace with six public packages under `packages/`:

- `packages/astro/` — `@cloudflare/polystella-astro`.
- `packages/polystella/` — `@cloudflare/polystella`, a forwarding compatibility package.
- `packages/core/` — platform-neutral translation orchestration.
- `packages/adapters/` — Markdown, MDX, JSON, YAML, and TOML adapters.
- `packages/providers/` — Workers AI and Anthropic transports.
- `packages/emdash/` — native EmDash integration and catalog override policy.

The private root coordinates those packages, the `docs/` site, and the
`playgrounds/` fixtures.

The agent-facing context lives in [`AGENTS.md`](./AGENTS.md). The
post-migration package map lives in
[`PACKAGE_ARCHITECTURE.md`](./PACKAGE_ARCHITECTURE.md), and the system-level
design rationale lives in [`ARCHITECTURE.md`](./ARCHITECTURE.md). Read those
before working on anything non-trivial; they save a lot of back-and-forth.

## Development setup

```bash
git clone https://github.com/cloudflare/polystella
cd polystella
pnpm install
```

Required:

- Node 22.12+ (24 recommended).
- pnpm 9+ (the lockfile is `pnpm-lock.yaml`).

## Commands

| Command                               | Purpose                                                         |
| ------------------------------------- | --------------------------------------------------------------- |
| `pnpm test`                           | Run package, Astro, workerd, and boundary tests.                |
| `pnpm typecheck`                      | Build and typecheck all six public packages.                    |
| `pnpm build`                          | Build all six public packages.                                  |
| `pnpm build:llms`                     | Regenerate `llms-full.txt` from canonical agent docs.           |
| `pnpm --filter polystella-docs dev`   | Run the Nimbus docs site locally.                               |
| `pnpm --filter polystella-docs build` | Build the docs site (includes auto-generated config reference). |
| `pnpm --filter polystella-docs check` | Astro check over docs content.                                  |

## Pull request workflow

1. **Open a Discussion first** for features, refactors, and
   performance work. PolyStella has tight coupling between adapters /
   providers / the cache layer; a 5-minute up-front discussion saves
   a rebase later. Bug fixes and docs-only changes can go straight to
   a PR if the scope is clear.
2. **Branch from `main`**. Branch names like
   `<type>/<short-slug>` are nice but not enforced.
3. **Add a changeset** for any user-visible change. Run
   `pnpm changeset` from the repo root and follow the prompts.
   The Changesets bot will pick this up at release time.
4. **Run the test suite + typecheck + docs build** locally before
   pushing. CI does the same but local-first saves round-trips.
5. **Reference the issue or Discussion** in the PR description if you
   opened one.

## Coding conventions

- **TypeScript strict mode**, including `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitReturns`,
  `noFallthroughCasesInSwitch`. Tooling configured in
  `tsconfig.base.json` and each package's local config.
- **No `any`, no `!`.** Use `unknown` + type guards; use
  destructure-and-check instead of non-null assertions. See
  [`AGENTS.md`](./AGENTS.md) for the rationale.
- **`.describe()` every public schema field.** The docs site
  auto-generates the configuration reference; missing `.describe()`
  calls produce empty cells in the table.
- **Comments document the "why", not the "what".** Long-form
  rationale belongs in `ARCHITECTURE.md`. Inline comments are for
  non-obvious decisions and known footguns.
- **Tests are integration-heavy.** Package tests live under each
  `packages/*/tests/` directory. Astro tests under `packages/astro/tests/`
  mirror `packages/astro/src/` and include an end-to-end smoke suite.

## Adding new APIs

Before adding to the public surface:

- **Is it covered by an existing export path?** Check the `exports` field in
  the owning `packages/*/package.json`; avoid adding a namespace when an
  existing entry already fits.
- **Does it have a documentation page?** `pnpm
--filter polystella-docs check-exports` asserts every
  `exports` path is mentioned on `docs/src/content/docs/reference/exports.md`.
  CI fails if not.
- **Does the schema reference need updating?** The
  `docs/scripts/generate-config-ref.ts` script auto-walks
  `packages/astro/src/config/options.ts` zod schema. If your change adds a new
  config field, regenerate the page locally with
  `pnpm --filter polystella-docs prebuild` and verify the
  output reads cleanly.

## Adding a new adapter

Portable adapters implement `FileAdapter` in
`packages/adapters/src/adapter.ts`; Astro policy wrappers implement
`FileTypeAdapter` in `packages/astro/src/parsing/adapter.ts` and register via
`packages/astro/src/parsing/registry.ts`.
See [`ARCHITECTURE.md`](./ARCHITECTURE.md) `#adapter-contract` for
the full contract. The Markdown adapter is the reference
implementation.

## Adding a new provider

Providers implement the `Translator` interface in
`packages/core/src/translator.ts` and expose transports from
`packages/providers/src/`. Throw `PermanentProviderError` on
4xx HTTP responses that retries can't fix (400/401/403/404/422); throw
plain `Error` on anything retriable. See [`ARCHITECTURE.md`](./ARCHITECTURE.md)
`#translator-contract` for the detail.

## Reporting bugs

Bug reports against PolyStella are most useful when they include:

- Minimum reproducible config (the `polystella.config.mjs` slice
  that exhibits the issue).
- Source file(s) that trigger the issue (or a synthetic example
  with the same shape).
- The `i18n-r2-report.json` build report, if relevant.
- The PolyStella version (visible in the report; or `polystella --version`).

## License

By contributing, you agree that your contributions are licensed
under the MIT License — same as the project.
