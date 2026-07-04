# PolyStella MDX JSX Playground

Small Astro workspace used to exercise PolyStella's MDX and JSX translation behavior.

## Commands

From the repository root:

```sh
pnpm playground:mdx-jsx:build
pnpm playground:mdx-jsx:translate:dry-run
pnpm playground:mdx-jsx:translate:local
pnpm playground:mdx-jsx:translate:workers-ai
pnpm playground:mdx-jsx:audit
```

The dry-run command validates planning and cache-key reachability only; it does not write translated files.

The local translate command starts a fake Workers AI-compatible HTTP endpoint, runs the normal live `polystella translate` CLI, and writes inspectable output to:

- `.astro/i18n-staging/<locale>/...` for the canonical staged files.
- `i18n-preview/<locale>/...` for disposable human inspection copies.

The fake endpoint preserves PolyStella segment ids and MDX placeholders while prefixing each translated segment with `[<locale>]`. This tests prompt encoding, response parsing, MDX placeholder restoration, byte-splice application, and staging writes without requiring provider credentials or network access. It does not test real translation quality or Workers AI model behavior.

The Workers AI command runs the same live translation path against Cloudflare Workers AI. It requires credentials in the environment and also writes `.astro/i18n-staging/` plus `i18n-preview/`:

```sh
POLYSTELLA_WORKERS_AI_ACCOUNT_ID="..." \
POLYSTELLA_WORKERS_AI_API_TOKEN="..." \
pnpm playground:mdx-jsx:translate:workers-ai
```

The command automatically loads env files when present. Shell-provided values take precedence over env-file values. Files are loaded in this order:

- Repository root `.env`.
- Repository root `.env.local`.
- Playground `.env`.
- Playground `.env.local`.

You can also use `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. Optional knobs:

- `POLYSTELLA_WORKERS_AI_MODEL`, default `@cf/meta/llama-3.1-8b-instruct`.
- `POLYSTELLA_WORKERS_AI_ENDPOINT`, for AI Gateway or endpoint debugging.
- `POLYSTELLA_WORKERS_AI_MAX_TOKENS`, default `8192`.
- `POLYSTELLA_WORKERS_AI_BATCH_INPUT_TOKEN_BUDGET`, default `4000`.

Forward CLI filters after `--`:

```sh
pnpm playground:mdx-jsx:translate:workers-ai -- --locale pt-BR --file "docs/inline-jsx.mdx"
```

Astro build logs warn that localized staging directories do not exist when only dry-run/build has been executed; that is expected until `translate:local` or a live translation run creates staging files.

## Fixtures

- `src/content/docs/block-jsx.mdx` covers block-level JSX wrappers.
- `src/content/docs/inline-jsx.mdx` covers inline JSX placeholder scenarios.
- `src/content/docs/static-data.mdx` covers static arrays, annotations, return literals, and direct JSX prop literals.
- `src/content/docs/expressions.mdx` covers dynamic-expression boundaries.
- `src/content/docs/plain-markdown.md` is the `.md` control file.
