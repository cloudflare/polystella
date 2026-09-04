# @cloudflare/polystella-cli

Shared Node.js implementations of PolyStella's `check-ui`, `sync-ui`, and
`translate-ui` catalog commands.

The package owns catalog drift/sync/glossary tooling and the narrow consumer
config loader used by those commands. It has no standalone binary; host
packages dispatch the exported command handlers.
