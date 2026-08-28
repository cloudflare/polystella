# PolyStella Monorepo Extraction Plan

Status: Local Step 12 gate complete; release blocked by external prerequisites
Last updated: 2026-08-28

## ELI5: What Will Happen

PolyStella is currently one large box containing four different things: the
translation engine, file readers, AI provider connections, and Astro-specific
behavior. We will separate those things without changing what an Astro build
produces.

| Step                           | ELI5                                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 1. Record the baseline         | Take a "before" picture so we can tell whether the move changes anything.                                      |
| 2. Prepare the workspace       | Mark where the new package shelves will go while leaving the current Astro package where it is.                |
| 3. Extract core                | Move the translation brain into a package that knows nothing about Astro, filesystems, or Cloudflare bindings. |
| 4. Extract adapters            | Move the Markdown, MDX, JSON, YAML, and TOML readers/writers into one reusable package.                        |
| 5. Extract providers           | Move Workers AI and Anthropic connections into one package, including both Workers AI HTTP and binding calls.  |
| 6. Reconnect Astro             | Make the existing Astro integration use the three new packages while it is still at the repository root.       |
| 7. Prove portability           | Run the reusable packages in Node and workerd and make sure they do not secretly need Node compatibility.      |
| 8. Check the extraction        | Compare the new behavior with the "before" picture before moving any remaining Astro files.                    |
| 9. Move Astro                  | Move the now-smaller Astro package into `packages/astro` and make the repository root private.                 |
| 10. Finish packaging           | Make versions, tarballs, builds, CLI files, and package exports work as a real four-package release.           |
| 11. Update automation and docs | Teach CI, pkg.pr.new, Changesets, documentation, and contributor guidance about all four packages.             |
| 12. Run the release gate       | Test the exact artifacts consumers will install, including one manual real-provider smoke test.                |

No package is published between these steps. The first release happens only
after Step 12 passes.

## End State

```text
polystella/
  package.json                         private workspace root
  tsconfig.base.json
  packages/
    core/                              @cloudflare/polystella-core
    adapters/                          @cloudflare/polystella-adapters
    providers/                         @cloudflare/polystella-providers
    astro/                             @cloudflare/polystella
  docs/
  playgrounds/
  agent-work/
```

Dependency direction:

```text
@cloudflare/polystella-core
  ^                 ^
  |                 |
adapters         providers
  ^                 ^
  +--------+--------+
           |
        Astro
```

Core never imports adapters, providers, Astro, React, Cloudflare bindings,
filesystem APIs, storage APIs, or environment globals.

## Fixed Decisions

- Public names use the existing `@cloudflare` scope.
- All four public packages use lockstep versions.
- The compatibility target is functionality, not preservation of every
  existing low-level import or error string.
- Existing Astro configuration, CLI behavior, generated files, cache keys,
  markers, routes, and runtime behavior should stay unchanged unless the
  extraction itself requires a documented change.
- All current providers live in one package with `./workers-ai` and
  `./anthropic` subpath exports.
- Workers AI supports both the current HTTP transport and a workerd binding
  transport.
- All current file adapters live in one package. We will not create one
  package per format.
- Astro stays at the root during extraction and moves only after the new
  packages pass their gates.
- Until Step 6, the existing package is frozen: do not edit root
  `package.json`, `src/**`, `tests/**`, `client.d.ts`, or `types-internal/**`.
  Steps 2-5 build shadow packages by copying behavior into new files. Step 6
  is the first cutover and the first point where duplicated root
  implementations are rewired or removed.
- The Translation Agent is not moved in this plan. The packages and a workerd
  fixture prepare for that later migration.
- There is no hosted core service and no extra network hop. Consumers call
  core directly in their own process or Worker.

## Package Responsibilities

### `@cloudflare/polystella-core`

Owns:

- `Segment`, `Glossary`, `StyleRule`, and the empty glossary value.
- `Translator`, `PermanentProviderError`, and permanent-error detection.
- Locale-aware model resolution.
- Prompt construction and strict response parsing.
- Translation batching and group invariants.
- Retry orchestration, logging contracts, and `AbortSignal` propagation.

Does not own:

- Files, paths, adapters, cache keys, R2, URL rewriting, output markers,
  provider HTTP, or provider bindings.

### `@cloudflare/polystella-adapters`

Owns:

- Shared adapter types and the current Markdown/MDX, JSON, YAML, and TOML
  implementations.
- Parsing, extraction, translation application, grouping, key-path helpers,
  and MDX placeholder handling.
- A portable Remark parser and an injectable Markdown parser contract.

Does not own:

- Satteri, Astro configuration, file walking, cache hashing, AI marker policy,
  locale URL policy, or staging-path import rewriting.

### `@cloudflare/polystella-providers`

Owns:

- Workers AI HTTP request construction and response normalization.
- Workers AI binding invocation and response normalization.
- Anthropic HTTP request construction and response normalization.
- Provider-specific HTTP error classification.

Does not own:

- Prompts, response protocol validation, retries, locale model maps, cache
  behavior, or generated Cloudflare `Ai` types.

Public exports:

```text
@cloudflare/polystella-providers
@cloudflare/polystella-providers/workers-ai
@cloudflare/polystella-providers/anthropic
```

### `@cloudflare/polystella`

Owns:

- Astro integration hooks, configuration, CLI, filesystem access, source
  walking, staging, R2 cache, reports, routing, runtime APIs, content
  collections, React helpers, UI strings, and recipes.
- Satteri-backed Markdown/MDX parsing for current Astro behavior.
- Source, glossary, and MDX extraction-policy hashing.
- `noTranslate`, URL rewriting, document-context selection, and AI marker
  policy around the shared adapters.

## Progress

| Step                           | Status   | Completion evidence                                                                                                   |
| ------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------- |
| 1. Record the baseline         | Complete | `agent-work/polystella-monorepo-baseline.md` records commands, keys, hashes, outputs, and known limitations           |
| 2. Prepare the workspace       | Complete | `packages/*` discovery and framework-neutral `tsconfig.base.json` added; existing package remains unchanged and green |
| 3. Extract core                | Complete | Core builds from one runtime dependency; 26 package tests and import-boundary inspection pass                         |
| 4. Extract adapters            | Complete | Shared adapters build with 40 portable format, parser, grouping, and reconstruction tests passing                     |
| 5. Extract providers           | Complete | Three portable factories build with 33 HTTP, binding, cancellation, and retry-integration tests passing               |
| 6. Reconnect Astro             | Complete | Root delegates to shared packages; 1,161 Astro tests and baseline playground outputs pass                             |
| 7. Prove portability           | Complete | Node, no-compat workerd, and boundary checks pass                                                                     |
| 8. Check the extraction        | Complete | Four-package tarball install and all deterministic Step 1 baseline comparisons pass                                   |
| 9. Move Astro                  | Complete | Private root, moved Astro package, aggregate gates, package checks, baselines, playground, and docs pass              |
| 10. Finish packaging           | Complete | Four release-ready tarballs install and expose every public entrypoint with exact internal versions                   |
| 11. Update automation and docs | Complete | CI/docs/pkg.pr.new configuration covers all packages                                                                  |
| 12. Run the release gate       | Blocked  | Local automation passes; npm bootstrap, publisher setup, and external manual checks remain                            |

## Step 1: Record The Baseline

Purpose: Establish known-good behavior before changing package boundaries.

Changes:

- Add characterization tests only where current tests do not already pin a
  critical invariant.
- Record stable values from the MDX playground in
  `agent-work/polystella-monorepo-baseline.md` rather than retaining noisy raw
  logs.
- Record representative staged Markdown and MDX output from the local fake
  translator, plus direct adapter fixtures for JSON, YAML, and TOML because the
  playground does not stage those formats.
- Record representative R2 keys, source hashes, markers, model IDs, and build
  report fields.
- Inspect the current `pnpm pack --dry-run` output for
  `@cloudflare/polystella`.

Critical invariants:

- Cache key bytes remain unchanged.
- `flat(groups) === segments` by reference and order.
- Adapter application inserts the AI marker before cache PUT.
- Markdown uses Markdown syntax and MDX uses MDX syntax.
- Permanent provider errors skip retries; transient and parse failures retry.
- Translation still runs during `astro:config:setup`.

Automated verification:

```sh
pnpm test
pnpm exec tsc --noEmit
pnpm build
node dist/cli.js --version
pnpm playground:mdx-jsx:build
pnpm playground:mdx-jsx:translate:dry-run
```

Manual verification:

- Read the dry-run log and save the representative R2 keys for comparison in
  Step 8.
- Open generated Markdown and MDX files and record formatting, marker
  placement, and rewritten links. Inspect direct reconstruction fixtures for
  JSON, YAML, and TOML.
- Confirm `git status --short` contains only intentional baseline tests or
  artifacts.

Stop condition: Do not begin extraction while any baseline command fails or a
critical behavior lacks a reproducible check.

Completion evidence (2026-08-28): All baseline commands passed: 62 test files
and 1,159 tests, strict typecheck, package build, CLI `0.4.0`, six-page
playground build, local fake-provider translation, and package dry-run. The
baseline file records 10 dry-run keys, 10 normalized output digests, source and
prompt hashes, report fields, structured adapter outputs, and existing tests
covering the non-playground paths.

## Step 2: Prepare The Workspace

Purpose: Create package/build structure without moving Astro first.

Changes:

- Add package workspace patterns for `packages/core`, `packages/adapters`, and
  `packages/providers` to `pnpm-workspace.yaml`.
- Keep `.` as the published `@cloudflare/polystella` package during Steps 2-8.
- Add `tsconfig.base.json` with framework-neutral strict TypeScript options.
- Define the package-local `package.json`, `tsconfig.json`, and
  `tsconfig.build.json` conventions. Create each real package and manifest with
  its first production files in Steps 3-5 instead of adding empty placeholder
  packages.
- Use plain `tsc` builds with declarations, declaration maps, and source maps.
- Use pnpm's dependency graph for build order. Do not add Turbo, Nx, tsup, or
  another build orchestrator.
- Build each lower package directly during the shadow phase. Do not alter the
  root package's build or `prepare` scripts until Step 6.
- Start all new public package manifests at `0.4.0` so they can join the fixed
  version group before the first coordinated release.
- Treat root `package.json`, `src/**`, `tests/**`, `client.d.ts`, and
  `types-internal/**` as read-only throughout Steps 2-5.

Expected initial package dependencies:

```text
core       -> p-retry
adapters   -> core + portable parsing dependencies
providers  -> core
Astro      -> core + adapters + providers + host-only dependencies
```

Automated verification:

```sh
pnpm install
pnpm list -r --depth 0
pnpm build
```

Manual verification:

- Inspect `pnpm list -r --depth 0` and confirm workspace discovery still sees
  the current root, docs, and playground packages without phantom package
  entries.
- Review the shared TypeScript settings and confirm they do not extend Astro or
  include Node types by default.
- Confirm `git diff -- package.json src tests client.d.ts types-internal` is
  empty.

Stop condition: Do not move production code until the shared configuration and
workspace patterns leave the existing root build green.

Completion evidence (2026-08-28): `pnpm install --frozen-lockfile` retained the
lockfile and discovered only the root, docs, and MDX playground packages.
Tests, typecheck, build, CLI, playground build, and `pnpm pack --dry-run` all
passed. `git diff -- package.json src tests client.d.ts types-internal
pnpm-lock.yaml` is empty. The shared config has no Astro extension and sets
`types: []`, so Node ambient types are not included by default.

## Step 3: Extract Core

Purpose: Copy the reusable translation engine and its smallest shared data
contracts into a platform-neutral shadow package. The existing package remains
unchanged until Step 6.

Target files in `packages/core/src`:

```text
index.ts
segment.ts
glossary.ts
translator.ts
logger.ts
prompt.ts
batch.ts
translate-batch.ts
translate-segments.ts
```

Changes:

- Copy `Segment` from `src/parsing/extract.ts`.
- Copy `Glossary`, `StyleRule`, and `EMPTY_GLOSSARY` from
  `src/glossary/glossary.ts`.
- Copy `Translator` and `PermanentProviderError` from
  `src/translation/provider.ts`.
- Add `isPermanentProviderError()` using the existing
  `_tag: "PermanentProviderError"` discriminator so duplicate installs do not
  accidentally re-enable retries.
- Copy locale-aware model ID resolution into core. Provider factories receive
  only a concrete model ID.
- Copy `src/translation/logger.ts`, `prompt.ts`, `batch.ts`, and
  `translate-segments.ts` into core.
- Copy `translateBatch` and its retry event/options, without provider transport
  code, into `translate-batch.ts`.
- Keep prompt bytes, response parsing, retry counts, retry callbacks, jitter,
  empty-input handling, batching order, and abort behavior unchanged.
- Keep `loadGlossaries`, Zod validation, `hashGlossary`,
  `EMPTY_GLOSSARY_HASH`, `computeSourceHash`, and MDX policy hashing in Astro.
  Those functions are host/cache concerns and currently rely on Node crypto or
  filesystem APIs.
- Keep `p-retry` initially. Its implementation and `is-network-error`
  dependency use Web primitives, although its package metadata declares Node
  `>=22`.

`nodejs_compat` policy:

- Consumers may enable `nodejs_compat`; doing so is not a problem.
- Core must also run without it. This is a negative portability test that
  prevents an accidental Node-only import from becoming an undocumented
  requirement for every Worker consumer.
- Workerd does not enforce npm's Node `engines` metadata. Node installation and
  CI continue on Node 24, which satisfies `p-retry`.
- If `p-retry` cannot execute in no-compat workerd, replace only the currently
  used retry subset and pin it with the existing retry tests. Do not design a
  general retry framework.

Tests copied to `packages/core/tests` during the shadow phase:

- Prompt construction and response parsing.
- Token-budget batching and oversize warnings.
- `translateBatch` success, parse failures, transient failures, permanent
  failures, final-error behavior, retry callbacks, and cancellation.
- `translateSegments` grouping, sequential batches, merged results, and aborts.

Automated verification:

```sh
pnpm --filter @cloudflare/polystella-core test
pnpm --filter @cloudflare/polystella-core build
pnpm exec tsc --noEmit
```

Manual verification:

- Compare one generated system/user prompt with the Step 1 baseline byte for
  byte.
- Inspect `packages/core/src` imports and confirm there is no `node:`, Astro,
  React, provider, adapter, filesystem, storage, or environment dependency.
- Inspect the emitted core declaration entry and confirm a downstream consumer
  can implement `Translator` without importing Astro types.
- Confirm `git diff -- package.json src tests client.d.ts types-internal` is
  empty.

Stop condition: Core is not complete while any host concern or provider
transport is needed to run a translation with a fake `Translator`.

Completion evidence (2026-08-28): `@cloudflare/polystella-core@0.4.0`
builds declarations and source maps with only `p-retry` at runtime. Its 26
tests pin the recorded prompt hashes, response parsing, batching and reference
order, model resolution, retries, cross-install permanent errors, sequential
multi-batch translation, and cancellation. Package typecheck, dist import,
tarball dry-run, root tests/typecheck/build, and the six-page playground build
pass. Source import inspection finds no Node, Astro, React, adapter, provider,
filesystem, storage, R2, or environment dependency. Protected root package
paths remain unchanged.

## Step 4: Extract Adapters

Purpose: Copy current file-format translation into a reusable shadow package
without carrying Astro or Satteri into workerd. Root parsing code remains
unchanged until Step 6.

Portable code to copy or reimplement from `src/parsing`:

```text
adapter.ts
adapters/json.ts
adapters/markdown.ts
adapters/toml.ts
adapters/yaml.ts
apply.ts
extract.ts
key-paths.ts
mdx-jsx-attributes.ts
mdx-placeholders.ts
mdx-static-data.ts
traverse.ts
portable Remark parser functions from parse.ts
normalized MDX rule data types
```

Changes:

- Define the reusable `FileAdapter<TParsed>` around parsing, segment
  extraction, translation application, and optional segment grouping.
- Import `Segment` from core rather than defining adapter-owned segment types.
- Accept already-resolved per-source extraction policy instead of Astro's
  resolved configuration type.
- Define an injectable Markdown parser contract with separate Markdown and MDX
  operations.
- Make the package's built-in parser use Remark and Web-compatible modules.
- Keep Satteri and its ESTree/position compatibility repair in Astro. Astro
  maps its existing `markdown.parser` option to either the injected Satteri or
  Remark parser.
- Keep cache-value selection, `noTranslate`, URL rewriting,
  document-context selection, and AI marker policy out of the required shared
  adapter contract.
- Allow pure format helpers for those operations to live in the adapters
  package when Astro needs format-aware parsing. Astro decides when and why
  they run.
- Keep the Astro policy registry in Astro and register wrappers around the
  shared adapter objects. The adapters package exports all current adapters
  from one root entry; it does not create per-format packages.
- Keep `mdx-audit.ts`, `rewrite-links.ts`, `rewrite-mdx-imports.ts`, MDX recipe
  normalization, glob selection, and policy hashing in Astro.
- Preserve the group flattening runtime assertion.
- Do not add HTML, plain text, or any other new format in this extraction.

Expected portable runtime dependencies:

```text
@cloudflare/polystella-core
@types/mdast
picomatch
remark-frontmatter
remark-gfm
remark-mdx
remark-parse
smol-toml
unified
yaml
```

`satteri` and `acorn` remain Astro dependencies for the current Satteri
compatibility path.

Tests copied to `packages/adapters/tests` during the shadow phase:

- Current JSON, YAML, TOML, Markdown, MDX, extraction, application, key-path,
  grouping, placeholder, and round-trip tests.
- Parser-injection tests proving Astro can supply Satteri while a workerd
  consumer can use Remark.
- One reconstruction fixture per format that checks untouched bytes or
  formatting according to the current format contract.

Automated verification:

```sh
pnpm --filter @cloudflare/polystella-adapters test
pnpm --filter @cloudflare/polystella-adapters build
pnpm exec tsc --noEmit
```

Manual verification:

- Open the dependency tree and confirm `satteri`, native bindings, Astro, and
  Node built-ins are absent from the adapters package.
- Translate one `.md`, `.mdx`, `.json`, `.yaml`, and `.toml` fixture and compare
  segment IDs and reconstructed output with Step 1.
- Confirm the Markdown and MDX paths use distinct syntax rules.
- Confirm applying the adapter twice does not duplicate generic top-level
  additions used by the Astro marker wrapper.
- Confirm `git diff -- package.json src tests client.d.ts types-internal` is
  empty.

Stop condition: Do not proceed if Astro parity requires importing Satteri from
the shared adapters entry or if a format emits different segment IDs.

Completion evidence (2026-08-28): `@cloudflare/polystella-adapters@0.4.0`
builds declarations and source maps with a narrow parser-injection contract and
Remark as its default parser. Its 40 tests cover JSON, YAML, TOML, Markdown,
MDX, parser injection, extraction/application, key paths, placeholders, static
data, reconstruction, generic-addition idempotence, and group reference/order
identity. Package and root typechecks/builds, 1,159 root tests, dist imports,
tarball dry-run, formatting, and the six-page playground build pass. Runtime
dependency and source inspection find no Satteri, Astro, Node built-in, or
native binding dependency. Protected root package paths remain unchanged.

## Step 5: Extract Providers

Purpose: Copy provider transports behind the core `Translator` contract so
Node and workerd hosts can use the same inference behavior. Root provider code
remains unchanged until Step 6.

Target files:

```text
packages/providers/src/index.ts
packages/providers/src/workers-ai.ts
packages/providers/src/anthropic.ts
```

Public factories:

```text
createWorkersAIHttpTranslator
createWorkersAIBindingTranslator
createAnthropicTranslator
```

Changes:

- Make provider options accept a concrete `modelId` and `maxTokens`.
- Keep locale model maps and `batchInputTokenBudget` outside providers. Astro
  resolves the model through core before constructing the translator.
- Preserve Workers AI HTTP endpoint construction, bearer authentication,
  custom endpoint support, chat messages, and `max_tokens`.
- Preserve Workers AI HTTP response precedence:
  `result.response`, `result.choices[0].message.content`, then
  `choices[0].message.content`.
- Add binding normalization for top-level `response`, top-level `choices`,
  direct strings, and parsed object responses.
- Accept a small binding invocation callback rather than depending on
  `@cloudflare/workers-types` or generated `Ai` model overloads.
- Check the binding translator's `AbortSignal` before and after inference.
  Cloudflare's documented binding API does not currently expose true in-flight
  cancellation, so do not claim that it does.
- Preserve Anthropic's endpoint, headers, body, first text-block behavior, and
  injected `fetch` support without adding an SDK.
- Import the one canonical `PermanentProviderError` from core.
- Preserve permanent HTTP statuses exactly: `400`, `401`, `403`, `404`, and
  `422`. Keep `408`, `425`, `429`, and `5xx` retriable.
- Do not retry inside provider factories. Core owns the single retry loop so
  provider, parse, and malformed-output failures share one attempt budget.
- Leave binding errors unchanged unless the caller explicitly throws core's
  `PermanentProviderError`; do not classify errors by message text.

Tests copied or added in `packages/providers/tests` during the shadow phase:

- Current Workers AI and Anthropic request/response tests from
  `tests/translation/provider.test.ts`.
- Every permanent status plus representative `429` and `503` failures.
- HTTP signal forwarding and pre-aborted binding signals.
- Binding invocation arguments and every supported response envelope.
- Unexpected response previews and object-to-JSON normalization.
- Core/provider permanent-error identity.

Automated verification:

```sh
pnpm --filter @cloudflare/polystella-providers test
pnpm --filter @cloudflare/polystella-providers build
pnpm exec tsc --noEmit
```

Manual verification:

- Inspect captured fake HTTP requests and compare URL, headers, body, and
  `max_tokens` with Step 1.
- Run the binding factory with a small fake `env.AI.run` wrapper and inspect the
  exact model ID and input object it receives.
- Confirm a `401` makes one core attempt and a `503` can consume the configured
  retry budget.
- Confirm package manifests contain no Anthropic SDK or Cloudflare Workers
  types runtime dependency.
- Confirm `git diff -- package.json src tests client.d.ts types-internal` is
  empty.

Stop condition: Do not rewire Astro until model identity, permanent errors,
and both existing HTTP transports match the baseline.

Completion evidence (2026-08-28): `@cloudflare/polystella-providers@0.4.0`
exports Workers AI HTTP/binding and Anthropic factories with concrete model
IDs and the canonical core error type. Its 33 tests pin request bytes, response
precedence and normalization, all five permanent statuses, representative
retriable statuses, signal forwarding, binding cancellation boundaries, and
core retry behavior. Package/root tests, typechecks, builds, dist/subpath
imports, tarball dry-run, and the six-page playground build pass. Runtime
dependency and source inspection find no provider SDK, Workers ambient type,
Astro, Node built-in, locale-resolution, or provider-owned retry dependency.
Protected root package paths remain unchanged, and final review found no
remaining issues.

## Step 6: Reconnect Astro At The Root

Purpose: Prove the extraction independently from the later filesystem move.

Primary callers to update:

```text
src/index.ts
src/translation/provider.ts
src/translation/run.ts
src/storage/cache.ts
src/runtime/custom-loader-runtime.ts
src/i18n/ui-translate.ts
src/cli/translate-ui.ts
src/cli/audit-mdx.ts
```

Changes:

- Replace relative imports of extracted code with workspace package imports.
- This is the first step allowed to edit root `package.json`, `src/**`,
  `tests/**`, `client.d.ts`, or `types-internal/**`.
- Remove duplicated root implementations only after their callers import the
  tested shadow packages.
- Keep a small Astro-local `createTranslator()` facade that maps validated
  provider configuration to the provider package's concrete factories.
- Resolve each locale's model once and use `translator.modelId` for inference,
  cache keys, metadata, reports, and output markers.
- Wrap shared adapters with Astro-owned cache selection, `noTranslate`, URL,
  document-context, marker, and parser policies.
- Keep marker insertion inside the `apply` closure passed to
  `translateOrLoadFromCache`, before R2 PUT.
- Keep Satteri as Astro's default parser and Remark as its configured fallback.
- Keep source walking, local cache index isolation, R2, overrides, staging,
  route shims, bridge timing, and all runtime APIs in Astro.
- Keep the existing Astro package export subpaths. Move low-level translation,
  adapter, and provider imports to their new package homes rather than adding
  compatibility-only modules.
- Do not mix unrelated behavior fixes into this step.
- Update the root build and `prepare` scripts here, not during workspace
  preparation. The root build now builds internal dependencies first;
  `prepare` installs the Git hook only.

Automated verification:

```sh
pnpm test
pnpm exec tsc --noEmit
pnpm build
node dist/cli.js --version
pnpm playground:mdx-jsx:build
pnpm playground:mdx-jsx:translate:dry-run
```

Manual verification:

- Compare dry-run R2 keys with Step 1.
- Compare one cache miss, one cache hit, one override, one `noTranslate` file,
  and one local-cache skip report entry.
- Inspect staged Markdown/MDX and structured-data files for marker placement,
  links, MDX imports, and formatting.
- Confirm logs still identify the resolved provider/model for each locale.

Stop condition: Any cache-key, staged-byte, routing, marker, retry, or report
drift blocks the move to `packages/astro`.

Completion evidence (2026-08-28): The root Astro integration delegates core,
adapter, and provider behavior to the three workspace packages while retaining
Satteri parsing and host cache/URL/marker policy. Eleven duplicate source files
were removed. All 1,161 root tests and 99 package tests pass, including direct
Remark routing, Satteri-to-Remark MDX fallback, and marker-before-cache checks.
Root/package typechecks and builds, CLI `0.4.0`, the six-page playground build,
10-key dry-run, and local fake-provider translation pass. Dry-run keys and all
10 normalized staged outputs match the Step 1 baseline. Review found no
remaining Step 6 defects; the coordinated Changesets entry remains scheduled
for Step 10.

## Step 7: Prove Node And Workerd Portability

Purpose: Turn the Node/workerd support decision into executable checks.

Changes:

- Keep the existing Node Vitest configuration for the full suite.
- Add `@cloudflare/vitest-plugin` as a root development dependency and add a
  separate workerd Vitest configuration.
- Run representative core, adapters, and providers tests inside workerd.
- Add a minimal Worker fixture importing all three reusable packages.
- Configure that fixture with explicit `no_nodejs_compat` and
  `no_nodejs_compat_v2`.
- Add a small source/package boundary test rejecting imports of `node:`, Astro,
  React, Satteri, filesystem, and environment modules from reusable packages.
- Keep consumers free to enable `nodejs_compat`. Passing without it is a
  stronger portability guarantee, not a prohibition.

Workerd coverage:

- Core prompt, parse, batch, retry, and cancellation behavior with a fake
  translator.
- JSON and Remark-backed Markdown adapter round trips.
- Workers AI binding behavior with a fake invocation callback.
- Provider HTTP behavior with a fake global `fetch`.

Automated verification:

```sh
pnpm test:packages
pnpm test:node
pnpm test:workerd
pnpm test:boundaries
pnpm build
pnpm bundle:workerd:dry-run
```

Manual verification:

- Inspect the Worker fixture's Wrangler configuration and confirm it explicitly
  sets `no_nodejs_compat` and `no_nodejs_compat_v2`.
- Inspect its generated bundle for Node built-in imports and Satteri/native
  binding references.
- Optionally repeat the fixture with `nodejs_compat` enabled to confirm that a
  downstream Worker using the flag remains compatible.

Stop condition: A reusable package that only works when `nodejs_compat` is
enabled is not platform-neutral and must be corrected before proceeding.

Completion evidence (2026-08-28): The existing 1,161-test Node suite, eight
detailed Vitest workerd tests, and 23 reusable-package boundary checks pass.
The Vitest suite covers core prompt parsing, batching, retries, cancellation,
JSON and Remark Markdown round trips, and Workers AI binding and HTTP
transports; it is not the no-compat proof. A separate Node harness uses the docs
workspace's Wrangler 4.127.0 to bundle, inspect, start, and fetch the Worker with
explicit `no_nodejs_compat` and `no_nodejs_compat_v2`. The 1,248.57 KiB bundle
(255.99 KiB gzip) contains no Node built-in imports, Astro, React, Satteri, or
native binding references. The aggregate root test command includes the
Wrangler runtime check and all 99 lower-package tests. Root/package typechecks,
clean frozen install, root build, bounded subprocesses, cross-platform process-
tree cleanup, unique OS-temp state, and generated-artifact checks pass.

## Step 8: Check The Extraction Before Moving Astro

Purpose: Isolate extraction defects from path-move defects.

Changes:

- Pack the root Astro package and all three lower packages from the intermediate
  layout.
- Install them into a temporary clean project.
- Import every lower-package entry and representative Astro entrypoints.
- Run the Astro playground against workspace packages.
- Update pkg.pr.new for the intermediate layout in the same commit that creates
  the lower package manifests.

Intermediate preview command:

```sh
pnpm exec pkg-pr-new publish --pnpm --commentWithSha \
  '.' \
  './packages/core' \
  './packages/adapters' \
  './packages/providers'
```

All directories must be published in one command. pkg.pr.new then rewrites
sibling workspace dependencies to the matching preview URLs.

Automated verification:

```sh
pnpm test
pnpm exec tsc --noEmit
pnpm build
pnpm check:packages
pnpm playground:mdx-jsx:build
pnpm playground:mdx-jsx:translate:dry-run
```

Manual verification:

- Inspect the pkg.pr.new PR comment and confirm it shows four installable
  package previews.
- Install the Astro preview URL in a temporary Astro project and confirm its
  package manifest points at the core, adapters, and providers preview URLs,
  not unresolved `workspace:` ranges.
- Compare all Step 1 baseline artifacts one final time.

Stop condition: Do not move Astro or make the root private until the
intermediate packages work outside the repository.

Completion evidence (2026-08-28): The local automated gate is complete.
`check:packages` builds and packs the explicit root, core, adapters, and
providers directories into OS-temporary storage; validates names, exports,
allowlists, required files, forbidden files, common versions, exact internal
dependency versions, and removal of `workspace:` ranges; then proves from the
lockfile and installed manifests that a clean ESM consumer uses all four
tarballs. That consumer imports every lower-package entry and all six Node-safe
Astro entries, resolves `./client` types, builds and typechecks an installed
Astro project exercising the integration-backed virtual-module entrypoints,
and runs CLI `0.4.0`. `check:baseline` first deletes all ignored playground
outputs, staging, and report data, then builds and runs the dry-run and local
fake provider itself before checking the exact 10 R2 keys, preview and staged
bytes including opposite MDX import paths, normalized report
digest/totals/models/source hashes, source/prompt fixtures, and JSON, YAML, and
TOML reconstruction bytes. Subprocesses are bounded with cross-platform process-
tree cleanup, all temporary package data is removed, and `.gitattributes` pins
text to LF. The original report checksum was corrected because it did not match
its documented normalization; every report field matched. The full 1,291-test
gate, root and lower-package typechecks, build, six-page playground build,
dry-run, local fake-provider run, CLI, formatting, and diff checks pass. The
preview workflow publishes all four explicit directories in one pkg.pr.new
invocation. The pkg.pr.new PR comment and preview-URL install remain pending
external checks because they require the enabled GitHub App/workflow. Real R2
remains external/manual; R2 hit/write/prune, override, `noTranslate`, and local-
skip paths remain covered by existing tests. No changeset was added.

## Step 9: Move Astro And Privatize The Root

Purpose: Finish the desired monorepo layout after extraction is proven.

Moves:

```text
src/**                 -> packages/astro/src/**
Astro-owned tests      -> packages/astro/tests/**
client.d.ts            -> packages/astro/client.d.ts
types-internal/**      -> packages/astro/types-internal/**
CHANGELOG.md           -> packages/astro/CHANGELOG.md
Astro package metadata -> packages/astro/package.json
```

Changes:

- Move only the remaining Astro-owned tree. Core, adapter, and provider files
  have already reached their final locations and do not move again.
- Put the current public name, description, repository, exports, binary,
  peers, publish configuration, and Astro dependencies in
  `packages/astro/package.json`.
- Keep `packages/astro/src/version.ts` importing `../package.json`, preserving
  the package version used in reports, metadata, and the runtime bridge.
- Preserve every existing Astro subpath export and `./client` type entry.
- Keep `chmod +x dist/cli.js` in the Astro package build.
- Replace the root manifest with a private `polystella-workspace` manifest
  containing workspace scripts and development/release dependencies only.
- Remove root `exports`, `bin`, `files`, `publishConfig`, peers, and runtime
  dependencies.
- Keep canonical repository-wide `AGENTS.md`, `ARCHITECTURE.md`, plans, and
  contributor documentation at the root.
- Add concise package-local READMEs and license files rather than copying the
  full architecture into every package.
- Update path-sensitive tests, docs scripts, Prettier ignores, and workflow
  filters. Do not globally replace `src/`, because docs contain intentional
  downstream Astro paths.

Automated verification:

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
node packages/astro/dist/cli.js --version
```

Manual verification:

- Inspect the root manifest and confirm it is private and has no publishable
  entrypoints.
- Inspect `packages/astro/package.json` and compare its exports with the old
  root manifest.
- Run `packages/astro/dist/cli.js --version` and confirm it reports the Astro
  package version, not the private root version.
- Inspect a declaration map and source map from every package and confirm its
  referenced source is included in that package.

Stop condition: The move is incomplete while any source/test assumes the root
is still `@cloudflare/polystella` or any package version reads the private root
manifest.

Completion evidence (2026-08-28): The Astro source, 1,162 tests, client types,
internal types, changelog, and package-local TypeScript/Vitest configuration now
live under `packages/astro`; the root is a private workspace orchestrator with
no publish fields, runtime dependencies, or peers. All four public packages
remain at `0.4.0`, retain the current internal ranges, expose package-local
typechecks, and build source/declaration maps pointing to their own `src` trees;
all four tarballs include those sources. The 1,292-test aggregate
Node/workerd/boundary gate, no-compat Wrangler runtime, aggregate
typecheck/build, four-tarball package check, deterministic baseline, CLI
`0.4.0`, six-page playground build/dry-run/local translation, docs generator,
export/example checks, full docs build, and formatting pass. Root typecheck and
all five playground scripts also pass with every ignored package `dist` tree
temporarily absent. `release.yml` is the sole publisher. No changeset or version
change was added.

## Step 10: Finish Packaging And Lockstep Versions

Purpose: Make the four packages behave like released artifacts rather than
workspace-only source folders.

Changes:

- Use `workspace:*` for every internal runtime dependency so pnpm writes exact
  versions into packed manifests.
- Add all four public names to one Changesets `fixed` group:

```text
@cloudflare/polystella-core
@cloudflare/polystella-adapters
@cloudflare/polystella-providers
@cloudflare/polystella
```

- Keep all four source manifests at `0.4.0` during extraction.
- Add one minor changeset covering all four packages. The release PR should
  produce the first coordinated `0.5.0` release.
- Keep `src` and `dist` in each package tarball so declaration/source maps can
  resolve source files.
- Add one small root package-check script that packs all four packages,
  validates their export targets and internal versions, and installs them in a
  temporary consumer.
- In the temporary consumer, import core, adapters, providers root/subpaths,
  and all Astro runtime exports; typecheck representative APIs; run the CLI.
- Ensure no tarball contains tests, credentials, root tooling, or unresolved
  `workspace:` ranges.

Automated verification:

```sh
pnpm build
pnpm check:packages
pnpm changeset status
```

Manual verification:

- Open each tarball file list and inspect package name, version, files, export
  targets, README, license, changelog, and internal dependency versions.
- Confirm the providers tarball exposes both subpaths.
- Confirm the Astro tarball contains an executable CLI with its shebang.
- Inspect the generated Changesets release state and confirm all four packages
  move to the same version.

Stop condition: Workspace tests are insufficient; packaging is blocked until a
fresh project can install only the tarballs and use every public entrypoint.

Completion evidence (2026-08-28): All four source manifests remain at `0.4.0`
and use `workspace:*` for internal runtime dependencies; the private root's
workspace-only references match. One fixed Changesets group and one minor
changeset produce exactly four planned `0.5.0` releases, while private
workspaces remain unchanged. Lower-package changelogs exist now because
Changesets creates missing files only during versioning, after this step's
tarball inspection. The strengthened `check:packages` gate validates source and
packed versions, exact exports and internal versions, required `src`, `dist`,
README, license, and changelog files, tarball allowlists, forbidden files,
resolved workspace ranges, and the CLI mode and shebang. Its clean consumer
installed all four `0.4.0` tarballs, exercised all public surfaces through
direct imports, client types, and an Astro build/typecheck, and ran CLI `0.4.0`.
Install, build, package check, Changesets status/release-state inspection,
focused formatting, and `git diff --check` all pass. No publish, commit, or Step
11 work was performed.

## Step 11: Update Preview, Release, CI, And Documentation

Purpose: Make repository automation and guidance agree with the final layout.

Preview releases:

- Update `.github/workflows/preview-releases.yml` to build first and publish all
  package directories once.
- Keep the existing `PKG_PR_NEW_ENABLED` opt-in unless repository policy
  changes separately.

Final preview command:

```sh
pnpm exec pkg-pr-new publish --pnpm --commentWithSha './packages/*'
```

This generates separate pkg.pr.new previews for core, adapters, providers, and
Astro. Publishing them in one invocation lets pkg.pr.new replace sibling
workspace dependencies with their corresponding preview URLs.

Release and CI changes:

- Keep `.github/workflows/release.yml` as the single Changesets publisher.
- Remove `.github/workflows/publish.yml`; `npm publish` from the private root
  would be wrong and duplicates the Changesets path.
- Update `.github/workflows/ci.yml` to run Node tests, workerd tests, typecheck,
  topological builds, package checks, and the moved Astro CLI smoke test.
- Update `.github/workflows/docs.yml` path filters for
  `packages/astro/src/config/options.ts` and all package manifests.
- Update `.github/workflows/pr-triage.yml` area mappings from root `src/**` and
  `tests/**` paths to package paths.
- Update `.changeset/README.md` for four fixed public packages and remove the
  obsolete tag-publish fallback instructions.

Documentation changes:

- Update root `README.md`, `ARCHITECTURE.md`, `AGENTS.md`, `llms.txt`, generated
  `llms-full.txt`, and contributor/consumer skills.
- Update stable repository paths in `packages/astro/tests/docs.test.ts` and
  planning/reference documents that describe current architecture.
- Update `docs/scripts/generate-config-ref.ts` to import the moved Astro schema.
- Update `docs/scripts/check-exports.ts` to inspect all four public manifests.
- Document direct in-process flow:

```text
source/record -> adapter -> core -> provider -> core -> adapter -> output
```

- Document a Workers AI binding example without importing generated Cloudflare
  types into the provider package.
- Document that `nodejs_compat` is allowed but not required by reusable
  packages.
- Document migrated low-level imports instead of adding compatibility shims.

Automated verification:

```sh
pnpm test
pnpm --filter polystella-docs build
pnpm --filter polystella-docs check-exports
pnpm --filter polystella-docs check-examples
pnpm build:llms
pnpm format:check
```

Manual verification:

- Open the pkg.pr.new PR comment and confirm there are four package links and
  one updated comment rather than four separate comments.
- Install at least the Astro and providers preview URLs together in a temporary
  consumer and confirm sibling previews resolve.
- Read every changed command in `AGENTS.md` and run it from the repository root.
- Browse the docs export page and verify each package/subpath has a clear owner
  and import example.

Stop condition: Do not release while automation still assumes the root is a
publishable package or docs show old source paths/imports.

Completion evidence (2026-08-28): The opt-in preview workflow builds first,
then publishes `./packages/*` in one exact quoted pkg.pr.new invocation.
`release.yml` is the sole publisher and `publish.yml` is absent. CI explicitly
runs reusable-package and Astro Node tests, workerd tests, boundary checks,
typecheck, the topological build, four-tarball package checks, and the moved
Astro CLI smoke. Docs filters name the moved schema and all four manifests;
triage maps all package trees; Changesets guidance describes the fixed
four-package release. Current docs and skills identify package ownership,
migrated low-level imports with no compatibility shims, standard-Web-API
portability without requiring `nodejs_compat`, the exact direct package flow,
and a package-typed Workers AI binding example. `pnpm build`, the 1,292-test
Node/workerd/boundary gate, aggregate typecheck, clean-consumer package check,
43-page docs build, exact bidirectional checks for all 17 documented export
paths and their import examples, and a TypeScript-compiled direct
core/adapters/providers example with a structural Workers AI binding all pass.
`llms-full.txt` generation is deterministic, formatting passes, the CLI reports
`0.4.0`, all 10 workflow files parse as YAML, static assertions confirm package
checks immediately precede Changesets and docs verify generated context, and
`git diff --check` passes. Registry lookups for the core, adapters, and providers
package names returned 404; creating those npm packages is an external
prerequisite before the first release. The pkg.pr.new GitHub App comment, its
four external preview links, and a preview-URL install could not be exercised
locally; they remain external checks requiring the enabled GitHub App and
workflow. No commit, publish, npm bootstrap, Changesets versioning, or Step 12
work was performed.

## Step 12: Run The Final Release Gate

Purpose: Verify the same code paths and package artifacts real consumers will
use.

Automated verification:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm test:node
pnpm test:workerd
pnpm test:boundaries
pnpm typecheck
pnpm build
pnpm check:packages
pnpm format:check
pnpm --filter polystella-docs build
pnpm --filter polystella-docs check-exports
pnpm --filter polystella-docs check-examples
pnpm playground:mdx-jsx:build
pnpm playground:mdx-jsx:translate:dry-run
node packages/astro/dist/cli.js --version
```

Manual verification:

- Run one real Workers AI translation through the Astro HTTP path.
- Run one real Workers AI translation through a minimal Worker using the
  binding path. This may incur Workers AI usage charges and must remain outside
  normal CI.
- Run one Anthropic HTTP smoke test if credentials are available; otherwise
  rely on the unchanged request characterization and record the omission.
- Verify one cold cache miss and one warm cache hit against a safe test R2
  bucket.
- Compare resulting staged bytes, cache metadata, report fields, marker values,
  model IDs, links, and R2 keys with the Step 1 expectations.
- Install the four pkg.pr.new previews in a clean consumer and run an Astro
  build plus a direct core/adapters/providers example.
- Review `git diff`, package tarball contents, and the pending changeset for
  secrets or accidental unrelated changes.

Release condition: Every automated gate passes, required manual checks are
recorded, and no known behavior regression remains. Only then merge the
Changesets release PR and publish all four packages together.

Completion evidence (2026-08-28): The stale Step 12 root `tsc` command now
uses the aggregate `pnpm typecheck`. Every listed command passes in order:
frozen install, the 1,292-test aggregate gate, intentionally redundant 1,162-
test Astro Node, eight-test workerd/no-compat, and 23-test boundary reruns,
aggregate typecheck, build, four-tarball clean-consumer check, formatting,
43-page docs build, 17-export documentation check, direct-package example
compile, six-page playground build, 10-key dry-run, and CLI `0.4.0`. The final
`check:baseline` guard matches all 10 dry-run keys, all 10 normalized preview
and staged outputs, report totals/digest/models/source hashes, prompt/hash
fixtures, links/import rewrites, markers, and three structured adapters. It now
asserts the report version against the current Astro package manifest and
normalizes only that version before the otherwise-exact report digest.
Changesets status plans the fixed four-package group at minor (`0.5.0`). The
production audit improved from 23 advisories (12 high, eight moderate, three
low) to zero after compatible Astro, MDX, astro-icon, Nimbus, and narrow patched
transitive updates; the audit and peer-dependency checks both pass.

Manual artifact and release-state inspection also passes locally. Four public
`0.4.0` tarballs contain only allowlisted package files and complete source
maps: Astro has 132 emitted JS/declaration files and 132 maps, adapters 30/30,
core 18/18, and providers 8/8. Packed internal dependencies resolve exactly to
`0.4.0`; providers exposes both provider subpaths; Astro exposes all 12 export
paths and its executable CLI retains the Node shebang. All 10 workflow files
parse as YAML. The release runs only for main pushes, audits production
dependencies, and runs baseline then package checks immediately before the sole
Changesets action; CI also audits production dependencies, and no npm
environment was added. The tarball consumer now typechecks representative core,
adapter, aggregate-provider, both provider-subpath, and Astro APIs without path
mappings. The docs example launcher invokes TypeScript's JavaScript CLI through
Node on every platform and handles spawn errors. The upgraded docs render all
43 pages with zero diagnostics and
the same 41-page search index. `git diff --check` passes; changed and untracked
files have no forbidden secret filenames or recognized secret content
signatures, no files are staged, and final review found no unrelated change or
local extraction defect.

Release remains blocked. Registry reads return 404 for the three new package
names, so npm package bootstrap and Trusted Publishing setup are still
required. Workers AI credential variables are present only in the ignored
playground env file, but no explicit safe endpoint/model target is configured;
the real Astro HTTP call was therefore omitted. No real Worker binding target,
Anthropic credential, or safe R2 bucket/configuration exists, so the binding,
Anthropic, cold/warm R2, live cache metadata, and live output comparisons were
not run. Existing provider/workerd/cache/run tests and the local fake-provider
baseline cover those code paths without external calls, but do not complete
the manual checks. pkg.pr.new comment/link and preview-consumer checks also
remain omitted: local GitHub CLI authentication is absent and the public API
request returned 403, so the app state and preview URLs could not be confirmed.
No commit, publish, npm bootstrap, Changesets versioning, or paid external call
was performed.

## Explicitly Deferred

- Moving the Translation Agent into this repository.
- Designing partial-failure, provenance, token-usage, or model-fallback APIs
  before the Translation Agent source is available.
- Creating separate packages per provider or adapter.
- Adding new adapters or providers.
- Moving R2/cache behavior into core.
- Adding a hosted service or any required server hop.
- Securing or migrating to a dedicated npm scope.
- Broad cleanup or unrelated bug fixes discovered during extraction.

## Decision Log

Update this table when implementation requires changing an agreed boundary.

| Date       | Decision                                            | Reason                                                                             |
| ---------- | --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 2026-08-28 | Use `@cloudflare/polystella-*` names                | Dedicated scope is speculative and unnecessary for extraction.                     |
| 2026-08-28 | Use lockstep versions                               | The first releases are tightly coordinated and internal dependencies stay exact.   |
| 2026-08-28 | One providers package with subpaths                 | Current providers have no heavy SDK dependencies that justify separate releases.   |
| 2026-08-28 | Workers AI owns HTTP and binding transports         | Astro and the future Translation Agent can share normalization and error behavior. |
| 2026-08-28 | One adapters package                                | Current formats share contracts and portable parsing dependencies.                 |
| 2026-08-28 | Support Node and no-compat workerd                  | Consumers may use `nodejs_compat`, but reusable packages should not require it.    |
| 2026-08-28 | Extract before moving Astro                         | Each concern moves once and regressions remain attributable.                       |
| 2026-08-28 | Prepare for, but do not move, the Translation Agent | Its source and final result/provenance requirements are not part of this change.   |
