/**
 * `polystella translate-ui` — sync (key add/remove) followed by AI
 * fill of empty values, one batched LLM call per locale with work.
 * Uses the same provider stack as the markdown pipeline. Token
 * placeholders (`{{name}}`) are validated post-translation; failures
 * retry the batch and, if persistent, leave the key empty for manual
 * fix-up.
 *
 * R2 caching is intentionally NOT used here: ~118 strings × 3
 * locales is a trivial workload and the cache-key design (per-file
 * sha256) would force a full re-translation on every key change.
 * If translation volume grows materially, revisit per-string caching
 * via a dedicated `i18n-ui/` R2 prefix.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolveOptions, type PolyStellaResolvedOptions } from "../config/options.js";
import { EMPTY_GLOSSARY, loadGlossaries } from "../glossary/glossary.js";
import { applySyncToDisk, formatLocaleFile, formatSyncSummary, parseSourceLayout, syncLocaleDict } from "../i18n/sync.js";
import { selectEmptyKeys, translateUiStringsForLocale, type TokenValidationIssue } from "../i18n/ui-translate.js";
import { DEFAULT_CATALOG_BASE } from "../catalog/constants.js";
import { runWithConcurrency } from "../source/pool.js";
import { createTranslator } from "../translation/provider.js";

import { loadAstroI18n, loadPolystellaConfig } from "./i18n-config.js";

export interface TranslateUiArgs {
  base?: string | undefined;
  /** Restrict to one locale. Must be declared in i18n.locales. */
  locale?: string | undefined;
  /** Don't call the provider — only run the sync step. Useful for dry-runs. */
  syncOnly: boolean;
  help: boolean;
}

export const TRANSLATE_UI_USAGE = `polystella translate-ui

Sync UI-string JSON files (key add/remove) and fill empty placeholders
via the configured AI provider. Complete locale JSONs are skipped
before provider setup. Locales with work run in parallel up to 3 at a
time (also capped by polystella.config.mjs \`concurrency\`).

Usage:
  polystella translate-ui [flags]

Flags:
  --base <dir>     UI-strings base directory, relative to project root.
                   Default: ${DEFAULT_CATALOG_BASE}.
  --locale <code>  Restrict to a single locale; must be declared in
                   astro.config.mjs i18n.locales.
  --sync-only      Run the sync step only — no AI calls. Equivalent
                   to \`polystella sync-ui\` but exits with the same
                   summary format.
  --help           Print this message.

Exit codes:
  0  every empty placeholder was filled successfully (and tokens
     preserved); or --sync-only completed cleanly.
  1  config error (missing astro.config.mjs, no provider, etc).
  2  AI translation failed for at least one (locale, key) pair AND
     the token validator never converged after maxRetries attempts.
     The unaffected pairs ARE still written; only the unresolved
     ones are left empty.
`;

export interface TranslateUiDeps {
  cwd: string;
  log: (msg: string) => void;
  warn: (msg: string) => void;
  err: (msg: string) => void;
  signal?: AbortSignal | undefined;
}

const TRANSLATE_UI_MAX_CONCURRENCY = 3;

export function parseTranslateUiArgs(argv: ReadonlyArray<string>): TranslateUiArgs {
  const out: TranslateUiArgs = { syncOnly: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
      case "--":
        continue;
      case "--help":
      case "-h":
        out.help = true;
        break;
      case "--sync-only":
        out.syncOnly = true;
        break;
      case "--base": {
        const value = argv[++i];
        if (!value || value.startsWith("--")) {
          throw new Error(`--base requires a value (got: ${value ?? "<end>"})`);
        }
        out.base = value;
        break;
      }
      case "--locale": {
        const value = argv[++i];
        if (!value || value.startsWith("--")) {
          throw new Error(`--locale requires a value (got: ${value ?? "<end>"})`);
        }
        out.locale = value;
        break;
      }
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return out;
}

export async function runTranslateUi(args: TranslateUiArgs, deps: TranslateUiDeps): Promise<number> {
  if (args.help) {
    deps.log(TRANSLATE_UI_USAGE);
    return 0;
  }

  let i18n: Awaited<ReturnType<typeof loadAstroI18n>>;
  try {
    i18n = await loadAstroI18n(deps.cwd);
  } catch (err) {
    deps.err(`[polystella] ${(err as Error).message}`);
    return 1;
  }
  if (i18n === undefined) {
    deps.err(`[polystella] astro.config.mjs is missing an \`i18n\` block.`);
    return 1;
  }

  const localeStrings = (i18n.locales as Array<string | { path: string }>).filter((entry): entry is string => typeof entry === "string");
  if (localeStrings.length === 0 || !localeStrings.includes(i18n.defaultLocale)) {
    deps.err(`[polystella] astro.config.mjs i18n.locales must include defaultLocale (${i18n.defaultLocale}).`);
    return 1;
  }
  if (args.locale !== undefined && !localeStrings.includes(args.locale)) {
    deps.err(`[polystella] --locale ${args.locale} not declared in astro.config.mjs i18n.locales (${localeStrings.join(", ")}).`);
    return 1;
  }

  const baseDir = args.base ?? DEFAULT_CATALOG_BASE;

  // Step 1 — sync (mechanical).
  let syncResult;
  try {
    syncResult = await applySyncToDisk({
      rootDir: deps.cwd,
      baseDir,
      defaultLocale: i18n.defaultLocale,
      locales: localeStrings,
    });
  } catch (err) {
    deps.err(`[polystella] ${(err as Error).message}`);
    return 1;
  }
  if (syncResult.changed) {
    deps.log(`[polystella] sync step:`);
    deps.log(formatSyncSummary(syncResult));
  } else {
    deps.log(`[polystella] sync step: no key changes needed.`);
  }

  if (args.syncOnly) {
    return 0;
  }

  // Step 2 — scan locale files before touching provider config. Fully
  // translated JSONs should not produce provider setup or "starting"
  // lines; they are skipped immediately with progress context.
  // `dryRun` is intentionally NOT honoured here. It governs the
  // markdown pipeline (R2 writes, paid provider calls, branch
  // dispatch) where a no-op preview run is genuinely useful. UI-
  // string translation writes to local files only and the workload
  // is small (~118 keys × N locales), so a dryRun-aware path would
  // just be a hidden way to skip work. Operators who want a no-AI
  // run should use `--sync-only`.

  // Re-read the synced source + locale files. (applySyncToDisk
  // already wrote them; we re-read so the in-memory state matches
  // what landed on disk byte-for-byte.)
  const sourcePath = path.resolve(deps.cwd, baseDir, `${i18n.defaultLocale}.json`);
  const sourceRaw = await readFile(sourcePath, "utf8");
  const sourceDict = JSON.parse(sourceRaw) as Record<string, string>;
  const layout = parseSourceLayout(sourceRaw);

  const targets = args.locale !== undefined ? [args.locale] : localeStrings.filter((locale) => locale !== i18n.defaultLocale);
  if (targets.length === 0) {
    return 0;
  }

  const results: PerLocaleOutcome[] = [];
  const pending: PendingLocale[] = [];

  for (let i = 0; i < targets.length; i++) {
    const locale = targets[i];
    if (locale === undefined) continue;
    const position = i + 1;
    const progress = progressLabel(position, targets.length);
    const outcome: PerLocaleOutcome = {
      locale,
      filled: [],
      tokenFailures: [],
      error: undefined,
    };
    results.push(outcome);

    const localePath = path.resolve(deps.cwd, baseDir, `${locale}.json`);
    let localeRaw: string;
    let localeDict: Record<string, string>;
    try {
      localeRaw = await readFile(localePath, "utf8");
      localeDict = JSON.parse(localeRaw) as Record<string, string>;
    } catch (caught) {
      outcome.error = caught as Error;
      deps.err(`[polystella] translate-ui: ${progress} ${locale} — failed: ${(caught as Error).message}`);
      continue;
    }

    const emptyCount = selectEmptyKeys(sourceDict, localeDict).length;
    if (emptyCount === 0) {
      deps.log(`[polystella] translate-ui: ${progress} ${locale} — skipped, no empty placeholders to fill.`);
      continue;
    }

    deps.log(`[polystella] translate-ui: ${progress} ${locale} — queued ${emptyCount} empty placeholder(s).`);
    pending.push({ locale, position, localePath, localeRaw, localeDict, emptyCount, outcome });
  }

  if (pending.length === 0) {
    return results.some((r) => r.error !== undefined) ? 2 : 0;
  }

  // Step 3 — AI fill for locales that actually have work.
  let resolved: PolyStellaResolvedOptions;
  try {
    const polyConfig = await loadPolystellaConfig(deps.cwd);
    resolved = resolveOptions(polyConfig, i18n);
  } catch (err) {
    deps.err(`[polystella] ${(err as Error).message}`);
    return 1;
  }
  const provider = resolved.provider;
  if (provider === undefined) {
    deps.err(
      `[polystella] no provider configured in polystella.config.mjs — translate-ui needs one when empty placeholders exist. Add a \`provider\` block or use \`pnpm i18n:sync\` for offline key reconciliation only.`,
    );
    return 1;
  }

  // Glossaries live under `projectRoot` per `loadGlossaries`'s
  // contract. The standalone CLI doesn't have an Astro `URL` for
  // root, so synthesise one.
  const projectRoot = pathToFileURL(deps.cwd + path.sep);
  let glossaries: Awaited<ReturnType<typeof loadGlossaries>>;
  try {
    glossaries = await loadGlossaries({ config: resolved, projectRoot });
  } catch (err) {
    deps.err(`[polystella] ${(err as Error).message}`);
    return 1;
  }

  const activeConcurrency = Math.min(pending.length, resolved.concurrency, TRANSLATE_UI_MAX_CONCURRENCY);
  deps.log(
    `[polystella] translate-ui: translating ${pending.length} locale(s) out of ${targets.length} checked (concurrency ${activeConcurrency}, max ${TRANSLATE_UI_MAX_CONCURRENCY}).`,
  );

  let startedCount = 0;

  await runWithConcurrency(pending, activeConcurrency, async (job) => {
    const translatePosition = ++startedCount;
    const translateProgress = progressLabel(translatePosition, pending.length);
    const totalProgress = progressLabel(job.position, targets.length);
    const progress = `${translateProgress} to translate, ${totalProgress} total`;
    // The pool rejects on uncaught worker errors. Catch every locale
    // failure so one provider/read/write problem doesn't kill the run.

    try {
      deps.log(`[polystella] translate-ui: ${progress} — starting locale ${job.locale} (${job.emptyCount} empty placeholder(s)) …`);

      const translator = createTranslator(provider, job.locale);
      const glossary = glossaries.get(job.locale) ?? EMPTY_GLOSSARY;

      const result = await translateUiStringsForLocale({
        translator,
        glossary,
        sourceDict,
        localeDict: job.localeDict,
        sourceLocale: resolved.defaultLocale,
        targetLocale: job.locale,
        ...(resolved.prompt.context !== undefined ? { context: resolved.prompt.context } : {}),
        maxRetries: resolved.maxRetries,
        retryMinTimeoutMs: 250,
        retryFactor: 2,
        retryRandomize: true,
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
        onRetry: ({ attempt, totalAttempts, error: retryErr }) => {
          deps.warn(`[polystella]   ${progress} — ${job.locale}: attempt ${attempt}/${totalAttempts} failed: ${retryErr.message}`);
        },
      });

      // Re-sync against the source one more time so any keys that
      // came in or out between the sync step and now are reflected.
      // (Belt-and-braces; in practice no other writer touches the
      // file mid-run.)
      const reconciled = syncLocaleDict({
        source: sourceDict,
        existing: result.dict,
        sourceKeyOrder: layout.keys,
      });
      const nextText = formatLocaleFile({ dict: reconciled.dict, layout });
      if (nextText !== job.localeRaw) {
        await writeFile(job.localePath, nextText, "utf8");
      }

      job.outcome.filled = result.filled;
      job.outcome.tokenFailures = result.tokenFailures;

      if (result.filled.length > 0) {
        deps.log(
          `[polystella] translate-ui: ${progress} — ${job.locale} filled ${result.filled.length} key(s): ${result.filled.join(", ")}`,
        );
      } else {
        deps.log(`[polystella] translate-ui: ${progress} — ${job.locale} had no empty placeholders left to fill.`);
      }
      if (result.tokenFailures.length > 0) {
        deps.warn(`[polystella]   ${progress} — ${job.locale}: token-preservation failed for ${result.tokenFailures.length} key(s):`);
        for (const f of result.tokenFailures) {
          deps.warn(`      - ${f.key}: missing=[${f.missing.join(", ")}], spurious=[${f.spurious.join(", ")}]`);
        }
        deps.warn(`[polystella]   ${progress} — ${job.locale}: these keys were left empty; fix manually then re-run.`);
      }
    } catch (caught) {
      job.outcome.error = caught as Error;
      deps.err(`[polystella] translate-ui: ${progress} — ${job.locale} failed: ${(caught as Error).message}`);
    }
  });

  const anyTokenFailures = results.some((r) => r.tokenFailures.length > 0 || r.error !== undefined);
  return anyTokenFailures ? 2 : 0;
}

interface PerLocaleOutcome {
  locale: string;
  filled: string[];
  tokenFailures: TokenValidationIssue[];
  /** Set on read failure or unexpected throw inside the worker. */
  error: Error | undefined;
}

interface PendingLocale {
  locale: string;
  /** 1-indexed position in the full target locale list. */
  position: number;
  localePath: string;
  localeRaw: string;
  localeDict: Record<string, string>;
  emptyCount: number;
  outcome: PerLocaleOutcome;
}

function progressLabel(position: number, total: number): string {
  return `[${position}/${total}]`;
}
