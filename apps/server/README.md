# Translation Server App

Private workspace app containing the Translation Agent's Hono API Worker,
imported from
`cloudflare/fe/cf-translation-agent@0757e8fdbf0c436dcaf42240a3bfe15135891031`.
Its execution path is gradually consolidated with `@cloudflare/polystella-core`.
The translation UI lives in [`apps/console`](../console/) and talks to this app
only over HTTP.

## Migration State

This port runs in isolation until it is confirmed to replace the GitLab
repository entirely:

- The GitLab repository remains authoritative for production and for language
  resources. It is not being archived.
- Wrangler configs contain no production account, route, or zone identifiers.
- Real language guides, terminology, do-not-translate terms, guardrail
  allowlists, and evaluation datasets are intentionally absent.
- Empty and synthetic resources keep public tests and builds deterministic.
- Language resources will load as PolyStella glossaries published from the
  GitLab repository.

Do not deploy this app as a translation service until private resource loading
and parity verification are complete.

## Syncing From GitLab

Paths map by prefix, so upstream changes can be replayed into the port:

| GitLab path       | Port path                                                              |
| :---------------- | :--------------------------------------------------------------------- |
| `api/`            | `apps/server/`                                                         |
| `docs/`, `NOTICE` | `apps/server/docs/`, `apps/server/NOTICE`                              |
| `ui/`             | `apps/console/`                                                        |
| `vite.config.ts`  | `apps/console/vite.config.ts`; tests in `apps/server/vitest.config.ts` |
| `package.json`    | Split between `apps/server` and `apps/console` by dependency           |

For example, `git diff <old>..<new> -- api | git apply -p2 --directory=apps/server`.

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

The compatibility contract is recorded in `docs/openapi.yaml`.
