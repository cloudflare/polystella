# PolyStella MDX JSX Playground

Small Astro workspace used to exercise PolyStella's MDX and JSX translation behavior.

## Commands

From the repository root:

```sh
pnpm playground:mdx-jsx:build
pnpm playground:mdx-jsx:translate:dry-run
```

The playground intentionally runs PolyStella with `dryRun: true`, no provider, and no R2 credentials. Build logs warn that localized staging directories do not exist; that is expected until live translation or fixture staging is added.

## Fixtures

- `src/content/docs/block-jsx.mdx` covers block-level JSX wrappers.
- `src/content/docs/inline-jsx.mdx` covers inline JSX placeholder scenarios.
- `src/content/docs/static-data.mdx` covers static arrays, annotations, return literals, and direct JSX prop literals.
- `src/content/docs/expressions.mdx` covers dynamic-expression boundaries.
- `src/content/docs/plain-markdown.md` is the `.md` control file.
