# Translation Agent App

Private workspace app imported from
`cloudflare/fe/cf-translation-agent@0757e8fdbf0c436dcaf42240a3bfe15135891031`.
It contains the existing Hono API and React UI while their execution path is
gradually consolidated with `@cloudflare/polystella-core`.

## Migration State

This snapshot is buildable for consolidation work but is not a production
deployment source yet:

- The existing GitLab repository remains authoritative for production.
- Wrangler configs contain no production account, route, or zone identifiers.
- Real language guides, terminology, do-not-translate terms, guardrail
  allowlists, and evaluation datasets are intentionally absent.
- Empty and synthetic resources keep public tests and builds deterministic.
- R2 and authenticated HTTP resource loading are the next migration step.

Do not deploy this app as a translation service until private resource loading
and parity verification are complete.

## Commands

```bash
pnpm --filter @cloudflare/polystella-translation-agent test
pnpm --filter @cloudflare/polystella-translation-agent typecheck
pnpm --filter @cloudflare/polystella-translation-agent build
pnpm --filter @cloudflare/polystella-translation-agent dev:api
pnpm --filter @cloudflare/polystella-translation-agent dev:ui
```

The API runs at `http://localhost:8787`; Vite serves the UI at
`http://localhost:5173` and proxies `/api` to the local Worker.

The compatibility contract is recorded in `docs/openapi.yaml`. Migration scope
and sequencing live in the repository root
`TRANSLATION_AGENT_MIGRATION.md`.
