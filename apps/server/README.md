# Translation Server App

Private workspace app containing the Translation Agent's Hono API Worker,
imported from the old repo at commit
`0757e8fdbf0c436dcaf42240a3bfe15135891031`.
Its execution path is gradually consolidated with `@cloudflare/polystella-core`.
The translation UI lives in [`apps/console`](../console/) and talks to this app
only over HTTP.

## Migration State

This port runs in isolation until it is confirmed to replace the old repo
entirely:

- The old repo remains authoritative for production and for language
  resources. It is not being archived.
- Wrangler configs contain no production account, route, or zone identifiers.
- Real glossaries, guardrail allowlists, and evaluation datasets are
  intentionally absent. Empty and synthetic resources keep public tests and
  builds deterministic.

Do not deploy this app as a translation service until private resource loading
and parity verification are complete.

## Glossaries

Terminology, do-not-translate terms, and style guides come from PolyStella
glossaries. `pnpm glossaries` (run by `dev` and `build`) loads them with Core's
glossary loader and writes `src/generated/glossaries.json` (gitignored), which
is bundled into the Worker.

| Variable           | Value                                                                                                                               |
| :----------------- | :---------------------------------------------------------------------------------------------------------------------------------- |
| `GLOSSARY_SOURCE`  | JSON in PolyStella's `glossary` config shape: `{"file": "..."}`, `{"http": {...}}`, or `{"r2": {...}}`. Unset writes no glossaries. |
| `GLOSSARY_LOCALES` | Comma-separated locales to load. Defaults to every supported locale plus `default`; required for `http` and `r2`.                   |

For each target locale the prompt uses that locale's `preferredTranslations`
(keys may list `;`-separated aliases). Do-not-translate terms and style rules
come from the locale's glossary, falling back to the `default` glossary.

## Syncing From the Old Repo

Paths map by prefix, so upstream changes can be replayed into the port:

| Old repo path     | Port path                                                              |
| :---------------- | :--------------------------------------------------------------------- |
| `api/`            | `apps/server/`                                                         |
| `docs/`, `NOTICE` | `apps/server/docs/`, `apps/server/NOTICE`                              |
| `ui/`             | `apps/console/`                                                        |
| `vite.config.ts`  | `apps/console/vite.config.ts`; tests in `apps/server/vitest.config.ts` |
| `package.json`    | Split between `apps/server` and `apps/console` by dependency           |

For example, `git diff <old>..<new> -- api | git apply -p2 --directory=apps/server`.
Language resources (`api/locales/`, `api/src/terminology.ts`) are not replayed;
publish them as glossaries instead.

## Commands

```bash
pnpm --filter polystella-server test
pnpm --filter polystella-server typecheck
pnpm --filter polystella-server build
pnpm --filter polystella-server dev
pnpm dev:apps
```

The API runs at `http://localhost:8787`. `pnpm dev:apps` also starts the
console at `http://localhost:5173`, which proxies `/api` to the local Worker.
See [`../LOCAL_TESTING.md`](../LOCAL_TESTING.md) for an end-to-end walkthrough.

The compatibility contract is recorded in `docs/openapi.yaml`.
