# PolyStella EmDash Playground

A small EmDash site for exercising `@cloudflare/polystella-emdash` in the admin. It runs two ways from the same source:

| Runtime        | Command                                 | Database and files                          | Covers                                                                                    |
| :------------- | :-------------------------------------- | :------------------------------------------ | :---------------------------------------------------------------------------------------- |
| **Node**       | `pnpm playground:emdash:dev`            | SQLite `data.db`, `uploads/`                | Content translation, catalog, sandbox, overrides, settings, browser batch runs.           |
| **Cloudflare** | `pnpm playground:emdash:dev:cloudflare` | Local D1, R2 and Queue in `.wrangler/state` | Everything above, plus the **server queue** for batch translation and the **AI binding**. |

Neither needs a Cloudflare account: translations come from a fake Workers AI endpoint unless you [opt into real Workers AI](#fake-or-real-ai).

## Run it

Run from the repository root. Each command builds the packages first.

1. Start a dev server and open the dev-bypass URL it prints (`/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin/plugins/polystella/settings`). It applies [`seed/seed.json`](./seed/seed.json), signs you in as a dev admin, and skips passkey setup. It only works in dev.
2. Add what a seed cannot hold, using the origin the dev server printed:

   ```sh
   pnpm --filter polystella-playground-emdash seed:extras http://localhost:4322
   ```

   It sets SEO text on `welcome` and creates `long-guide`, a post long enough to translate in two parts. It is safe to run again. It only writes to a local address that serves this playground (it checks for a marker on the home page and follows no redirects), because it signs in with dev-bypass and writes to whatever answers.

Astro moves to the next free port when 4321 is taken, so use the URL it prints rather than assuming 4321. Dev-bypass and the plugin routes write to whichever EmDash server answers, including another project's.

`astro dev` backgrounds itself when there is no TTY (for example inside an agent). The fake AI server then stops with the wrapper, so start it first with `pnpm --filter polystella-playground-emdash fake-ai`. The dev scripts reuse a fake that is already running on its port.

Reset by stopping the server and deleting `data.db*` and `uploads/` (Node) or `.wrangler/state` (Cloudflare).

If the admin redirects to the dashboard or shows a stale page after you restart the dev server on the same port, the browser is holding module files from the previous run. Hard-reload, or start on another port (`astro dev --port 4361`). Vite names its bundled dependencies per run, and the browser caches them per origin.

Both runtimes build into `dist/`, so each build overwrites the other. `pnpm playground:emdash:build` and `pnpm playground:emdash:build:cloudflare` check that each runtime bundles. The built site is not usable without a real EmDash setup, because dev-bypass is dev only.

## Locales

| Locale  | Why it is here                                                                            |
| :------ | :---------------------------------------------------------------------------------------- |
| `en-US` | Source locale.                                                                            |
| `pt-BR` | A familiar Latin-script target, partly translated.                                        |
| `ja-JP` | No plural forms beyond `other`, no word spaces, CJK text.                                 |
| `ar-SA` | Right-to-left (the page sets `dir="rtl"`), and six plural categories (`zero` to `other`). |

The catalogs in [`src/i18n`](./src/i18n) include a plural message, `home.postCount`. Generating it for `ja-JP` drops `one`; generating it for `ar-SA` needs `zero`, `two`, `few` and `many` to pass validation. The fake AI adds the missing branches so both succeed.

`pt-BR` has one translated key and `ja-JP` and `ar-SA` are empty, so the Catalog page shows `missing` rows. The site at `/`, `/pt-BR/`, `/ja-JP/` and `/ar-SA/` renders posts and UI strings through `Astro.locals.t`.

Each non-default locale has a glossary in [`src/i18n/glossary`](./src/i18n/glossary): do-not-translate terms (`PolyStella`, `EmDash`), preferred translations and style rules. With the fake AI they only show up in debug traces. With real AI they are what you check the output against.

## What is seeded

| Collection | Entry                                  | Locale  | Status    | Use                                                                                                                                                                |
| :--------- | :------------------------------------- | :------ | :-------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `posts`    | `welcome`                              | `en-US` | published | Marks, link, list, odd spacing, `{{name}}`, a code block, built-in `pullquote`, `buttons` and `columns` blocks, and a `faq` repeater. SEO text from `seed:extras`. |
| `posts`    | `launch-notes`                         | `en-US` | published | A second source entry with no siblings.                                                                                                                            |
| `posts`    | `partner-update`                       | `en-US` | published | A custom `partner.badge` block that `blockFields` does not list, so translating it shows the copied-untranslated notice.                                           |
| `posts`    | `bem-vindo` (translation of `welcome`) | `pt-BR` | draft     | An existing target draft to re-translate, including its SEO text.                                                                                                  |
| `posts`    | `long-guide` (from `seed:extras`)      | `en-US` | published | 520 paragraphs and 13 headings: over 30,000 characters, so it splits into two translation parts.                                                                   |
| `landing`  | `home`                                 | `en-US` | published | A `blocks` field with `hero`, `note` (Markdown) and `cards` (a repeater inside a block).                                                                           |

No entry exists for `ja-JP` or `ar-SA`, so the panel on a source entry offers to create them.

How the text paths are chosen:

- **`faq` repeater:** you pick the subfields in **Settings → Collections**. Pick `question` and `answer`; `source` is a URL, so it is copied.
- **`landing.layout` blocks:** the paths live in `blockFields` in [`polystella.options.mjs`](./polystella.options.mjs). `link_url` and `icon` are left out on purpose, so they are copied.
- **Built-in blocks:** `pullquote`, `buttons` and `columns` are translated by default. `code` never is.

A seed cannot set per-entry SEO text, which is why `seed:extras` does it through the content API.

## Fake or real AI

| `POLYSTELLA_AI`  | Node                                                    | Cloudflare                                                                            |
| :--------------- | :------------------------------------------------------ | :------------------------------------------------------------------------------------ |
| `fake` (default) | HTTP to the fake endpoint on `127.0.0.1:8799`.          | The same HTTP call from workerd, using placeholder credentials from `wrangler.jsonc`. |
| `real`           | Workers AI over HTTP, with the credentials from `.env`. | The same HTTP call, or the remote `AI` binding if `.env` has no credentials.          |

To test against real Workers AI, copy [`.env.example`](./.env.example) to `.env` (gitignored) and fill it in:

```sh
cp .env.example .env
```

| Variable                      | Meaning                                                                                                               |
| :---------------------------- | :-------------------------------------------------------------------------------------------------------------------- |
| `POLYSTELLA_AI`               | `fake` or `real`. The example file leaves it out. Credentials alone do not switch modes.                              |
| `CLOUDFLARE_ACCOUNT_ID`       | Your account ID.                                                                                                      |
| `CLOUDFLARE_WORKERS_AI_TOKEN` | A token with Workers AI access.                                                                                       |
| `POLYSTELLA_AI_MODELS`        | Optional. Replaces the model list in [`models.mjs`](./models.mjs) with comma-separated ids; the first is the default. |

Shell variables override `.env` for everything Node decides, so `POLYSTELLA_AI=fake pnpm playground:emdash:dev` forces the fake. Both runtimes read the same file: Node loads it itself, and wrangler loads it for the Worker. The Worker sees `.env` only, never shell variables, so on Cloudflare put the credentials in `.env`; the config stops with an error if they are only in the shell. If you create a `.dev.vars` file, wrangler reads that instead of `.env` for the Worker.

### One `.env` for every worktree

Keep the real file in your primary checkout, at `playgrounds/emdash/.env`. The dev scripts then link every other worktree's `.env` to it when that worktree has no `.env` of its own, so you fill it in once and edit it once. A worktree's own `.env` is never replaced. `pnpm --filter polystella-playground-emdash link-env` links without starting a server.

The file also decides the AI mode, so if it sets `POLYSTELLA_AI=real`, every worktree's dev server uses paid AI. The dev scripts print the mode at startup (`AI: fake` or `AI: REAL`). To keep worktrees on the free fake by default, leave `POLYSTELLA_AI` out of the file and set it in the shell when you want real.

The primary checkout is the one `git worktree list` shows first, and git finds it from any worktree, so there is nothing to configure. Everything stays local: `.env` is gitignored, so neither the file nor the links are ever committed, and `.env.example` is the only tracked piece. `git clean -x` in the primary checkout would delete the ignored file.

Real mode on Node needs credentials and stops at startup without them. On Cloudflare it needs either credentials or `wrangler login` for the remote binding. Every real request costs money, and `long-guide` makes several.

In fake mode the credentials use different variable names, so a real token in `.env` is never sent to the local fake. A Cloudflare build copies `.env` into `dist/server/.dev.vars` in plain text whenever `.env` holds credentials, in any mode, so delete `dist/` after one, or build with `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false`, which skips the copy.

[`scripts/with-fake-ai.mjs`](./scripts/with-fake-ai.mjs) is the fake. It returns `[<locale>] <source text>` for every segment and keeps segment ids, `{{tokens}}` and Portable Text structure intact. That proves the plumbing and the patch shape, not translation quality. Quality, glossary effects and placeholder-loss retries need real mode.

Two opt-in knobs make the fake misbehave, so the new job states can be exercised offline. Set them in the shell or in `.env`, and restart the fake:

| Variable                        | Effect                                                                                                     |
| :------------------------------ | :--------------------------------------------------------------------------------------------------------- |
| `POLYSTELLA_FAKE_AI_DELAY_MS`   | Delays every reply, so a running job can be watched, edited under, or cancelled.                           |
| `POLYSTELLA_FAKE_AI_MIN_TOKENS` | Cuts a reply off, like a model out of output tokens, when the request's `max_tokens` is below this number. |

For example, with `POLYSTELLA_FAKE_AI_MIN_TOKENS=4000`, a run with a 2048 token limit fails, and **Retry...** with 8192 succeeds.

## Models

[`models.mjs`](./models.mjs) lists the 13 Workers AI chat models the playground allows, with `@cf/deepseek-ai/deepseek-v4.1-flash-1017` first. The first model is the code fallback: the plugin's `models.defaults` is not set, and an administrator can pick another default in **Settings → Translation settings**. They cover DeepSeek, GLM, Qwen, Inkling, Gemma, `gpt-oss`, Llama, Mistral and Granite, from small to very large, with and without thinking. They were checked against the catalogue on 2026-11-26.

Left out:

- **Deprecated:** every model with a `planned_deprecation_date` of 2026-11-20, including Kimi K2.6 and K2.7, DeepSeek V4 Flash 0731 and V4 Pro, GLM 5.2 and 5.3 Flash, Qwen3 30B, QwQ, Nemotron 3 and the small Llama 3.1 and 3.2 models. Check that field before adding a model back.
- **Not chat translation:** `clairic` and `clef` (structured I/O), Llama Guard, code- and voice-tuned models, and the dedicated translation models `m2m100` and `indictrans2`, which the plugin cannot call.
- **Needs setup:** LoRA-only bases, and `apertus` and `eurollm`, which need an access request.

Third-party models such as Kimi K3.1 Pro (`moonshotai/kimi-k3.1-pro`) are called through the Workers AI binding, not the `@cf/` REST route this playground uses with `.env` credentials. The plugin accepts their ids, but they are not listed because the HTTP route is unverified.

Real mode reads each model's thinking options from the live Workers AI catalogue. The fake endpoint has no catalogue, so in fake mode `models.mjs` supplies the same choices for the models that have them, which keeps the thinking pickers working offline. Thinking tokens count against the output limit and the bill. The catalogue marks DeepSeek V4.1 Flash as off by default, but GLM 4.7 Flash and 5.3, Qwen 3.8, Inkling and Gemma 4 as on, so pick a lower effort in **Settings** for cheap, fast runs.

Check the list against the public catalogue with `pnpm --filter polystella-playground-emdash check:models`. It fails for a model that is missing, deprecated, not a chat model, or lacking `messages` and `max_tokens`, and warns about a planned deprecation within 60 days. Pass model ids to check your own list. The source is the cloudflare-docs repo, which can lag the live catalogue.

### What a real run showed

On 2026-11-26 the `welcome` post was translated into Japanese with each model, thinking off where the model allows, on both runtimes with the `.env` credentials. Three runs gave different results, so treat them as a starting point: the same models do not fail every time.

- **Works:** between 9 and 11 of 13 models kept the structure, `{{name}}` and `{{token}}`, `PolyStella` and `EmDash` in Latin letters, the code block and every URL. That includes `gpt-oss-120b` and `gpt-oss-20b`, whose reply shape the catalogue does not document.
- **Placeholder failures:** the `faq` answer says "`{{tokens}}` stay exactly as written", which tempts a model to translate the word inside the braces. Llama 4 Scout did it (`{{トークン}}`) in every run, and Qwen 3.8 and SEA-LION in one run each. The plugin catches it, makes one provider call, retries nothing and saves no translation, with a "changed placeholder tokens" error. That is a ready-made failure to look at in the admin.
- **Other refusals:** GLM 4.7 Flash once returned an empty segment, Granite 4.0 Micro once cut its reply short, and Inkling 2 Small ran out of a 4096 token limit. Each time the plugin refused and saved nothing.
- **Inkling 2 Small** used about six times the output tokens of the others, even with thinking set to none.
- **Thinking choices:** the live catalogue matched the offline choices in `models.mjs` for all eight models that have them.
- **Run settings:** the extra instruction "Keep the English word 'demo' untranslated" was followed in Japanese and Arabic. Server jobs, **Retry...** with redo, and a 256 token limit failing with the out-of-tokens message all behaved as in the fake runs.
- **Cost:** about 0.1 cent per language for `welcome` with DeepSeek V4.1 Flash; the whole pass, 13 models plus the job and truncation checks, cost a few cents.

## Smoke tests

[`scripts/smoke.mjs`](./scripts/smoke.mjs) drives a running playground through the plugin's routes and prints `PASS`, `WARN` or `FAIL` for each check. It covers the same ground as the manual checklist's settings, server jobs, run settings and retry steps, without the admin UI. It exits 1 only on `FAIL`.

Start a dev server, open the dev-bypass URL once (it seeds the database), run `seed:extras`, then pass the origin the server printed:

| Command                                                          | AI   | Cost        | Checks                                                                                                                                                                                                 |
| :--------------------------------------------------------------- | :--- | :---------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter polystella-playground-emdash smoke <origin>`      | fake | free        | `base`: default model and thinking, custom block notice, update existing, run settings, retry with redo. `tokens` and `race` need the fake's [knobs](#fake-or-real-ai); phases are optional arguments. |
| `pnpm --filter polystella-playground-emdash smoke:real <origin>` | real | a few cents | `sweep`: `welcome` into `ja-JP` with every allowed model, plus thinking choices against the live catalogue. `truncate`: a 256 token limit, then recovery. `jobs`: real queue jobs and a redo.          |

For every phase, start the fake with `POLYSTELLA_FAKE_AI_MIN_TOKENS=4000 POLYSTELLA_FAKE_AI_DELAY_MS=3000` and run `smoke <origin> base tokens race`. Server jobs need the Cloudflare dev server (`dev:cloudflare`); on Node those checks print `skipped`.

- The script finds out which AI the server uses before it writes anything. `smoke` refuses a real server and `smoke:real` refuses a fake one. That check sends one one-word request to the first allowed model, so a free run on a real server costs a fraction of a cent, not a few cents.
- It signs in with dev-bypass, so it has the same guard as `seed:extras`: a local address that serves this playground, and nothing else.
- It writes drafts and jobs, turns on collection policies for `posts` and `landing` when none are set (it leaves them on), and changes **Translation settings**, then puts the settings back. Use a playground you can reset.
- In the real sweep a model that is refused, or that loses a placeholder, is a `WARN`: models vary between runs and the plugin saves nothing in that case. A `FAIL` means the plugin or the playground is at fault, for example the code block or a URL changed.

## Manual checklist

1. **PolyStella → Settings → Collections**: enable `posts` with `title`, `excerpt`, `content` and `faq` (subfields `question` and `answer`), and `landing` with `title` and `layout`.
2. Open `welcome`, use the PolyStella panel to create `ja-JP`, and compare the structure of the new draft: marks, link, list, pullquote, buttons, columns, code block and the `faq` rows.
3. Open `bem-vindo` and translate it again. Include the SEO title and description, and confirm the fresh source values arrive. SEO is only offered on a target-locale draft.
4. Open `home` in `landing`, create `ja-JP`, and check the hero, the Markdown note (links and `{{name}}` intact) and the cards, with `link_url` and `icon` unchanged.
5. Open `long-guide` and create `ar-SA`. The panel names each part as it runs, and the finished draft has every paragraph translated.
6. **Settings → Sandbox**: translate text containing `{{name}}` into each locale.
7. **PolyStella → Catalog**: generate `ar-SA` including `home.postCount`, edit a value, save, enable runtime overrides, then reload `/ar-SA/` and check it reads right to left.
8. **Export JSON** and compare it with `src/i18n/ar-SA.json`.
9. **Settings → Translation settings**: turn on debug traces and repeat step 6.
10. **Settings → Translation settings**: pick a **Default model** and its **Thinking**, then give one language its own model. With debug traces on, a translation shows which model it used. Until you pick one, the default is the first model in `models.mjs`.
11. Open `partner-update` and translate it. The result carries a notice that `partner.badge` blocks were copied untranslated; adding it to `blockFields` removes the notice. The editor shows the block as an opaque `Partner.badge` card. Saving the post from the editor has not been tested, so translate from the panel and avoid saving the source.
12. **PolyStella → Batch translation**: translate `posts` and `landing` into `ja-JP` and `ar-SA` with **This browser**. Drafts appear for each entry and locale.
13. Cloudflare only: repeat step 12 with **Run in → Server queue**. Each job reaches `finished`, and `long-guide` goes through two queue messages per locale.
14. **Update existing translations** (browser runs and the server queue both honour it; the queue is the one that can be slowed and edited under): queue `welcome` into `pt-BR`. With the switch off the row is skipped, and with it on the `bem-vindo` draft is updated. Run it with `POLYSTELLA_FAKE_AI_DELAY_MS=3000` and save the draft while the job runs: the row is skipped and your text survives.
15. **Run settings** on a run: pick a model, a thinking level, a token limit and extra instructions. Qwen 3.8 may ignore the token limit, because the catalogue says it does not support `max_tokens`. The job row keeps them under **Run settings**, and the AI-translated flag records the model the run used.
16. **Retry...** on a finished job. It opens the run settings filled in, and **Also redo the translations it wrote** redoes them in place; a translation published or edited since is skipped. With `POLYSTELLA_FAKE_AI_MIN_TOKENS=4000`, a run limited to 2048 tokens fails, and retrying with 8192 succeeds.
17. Real mode only: run `smoke:real` and read its `WARN` lines, then translate `welcome` into `ja-JP` and `ar-SA` and check that `PolyStella`, `EmDash` and `Workers AI` stay in Latin letters, and that `{{name}}` survives. Try Llama 4 Scout too: it should fail on the `faq` answer with the placeholder error.

On Node the **Server queue** option is not offered, because there is no Queue binding; **This browser** still works.
