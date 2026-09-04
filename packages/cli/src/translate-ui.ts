import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { EMPTY_GLOSSARY } from "@cloudflare/polystella-core";
import {
  DEFAULT_UI_STRING_BATCH_SIZE,
  selectEmptyKeys,
  translateUiStringsForLocale,
  type TokenValidationIssue,
} from "@cloudflare/polystella-core/catalog/translate";

import { loadAstroI18n, loadPolystellaConfig, resolveCatalogConfig } from "./config.js";
import { loadGlossaries } from "./glossary.js";
import { runWithConcurrency } from "./pool.js";
import { createTranslator } from "./provider.js";
import { applySyncToDisk, formatLocaleFile, formatSyncSummary, parseSourceLayout, syncLocaleDict } from "./sync.js";

const DEFAULT_CATALOG_BASE = "./src/content/i18n";
const TRANSLATE_UI_MAX_CONCURRENCY = 3;

export interface TranslateUiArgs {
  base?: string | undefined;
  locale?: string | undefined;
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
  log: (message: string) => void;
  warn: (message: string) => void;
  err: (message: string) => void;
  signal?: AbortSignal | undefined;
}

export function parseTranslateUiArgs(argv: ReadonlyArray<string>): TranslateUiArgs {
  const out: TranslateUiArgs = { syncOnly: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined || arg === "--") continue;
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--sync-only") out.syncOnly = true;
    else if (arg === "--base") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`--base requires a value (got: ${value ?? "<end>"})`);
      out.base = value;
    } else if (arg === "--locale") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`--locale requires a value (got: ${value ?? "<end>"})`);
      out.locale = value;
    } else throw new Error(`Unknown flag: ${arg}`);
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
  } catch (error) {
    deps.err(`[polystella] ${errorMessage(error)}`);
    return 1;
  }
  if (i18n === undefined) {
    deps.err("[polystella] astro.config.mjs is missing an `i18n` block.");
    return 1;
  }
  if (i18n.locales.length === 0 || !i18n.locales.includes(i18n.defaultLocale)) {
    deps.err(`[polystella] astro.config.mjs i18n.locales must include defaultLocale (${i18n.defaultLocale}).`);
    return 1;
  }
  if (args.locale !== undefined && !i18n.locales.includes(args.locale)) {
    deps.err(`[polystella] --locale ${args.locale} not declared in astro.config.mjs i18n.locales (${i18n.locales.join(", ")}).`);
    return 1;
  }

  const baseDir = args.base ?? DEFAULT_CATALOG_BASE;
  let syncResult;
  try {
    syncResult = await applySyncToDisk({
      rootDir: deps.cwd,
      baseDir,
      defaultLocale: i18n.defaultLocale,
      locales: i18n.locales,
    });
  } catch (error) {
    deps.err(`[polystella] ${errorMessage(error)}`);
    return 1;
  }
  if (syncResult.changed) {
    deps.log("[polystella] sync step:");
    deps.log(formatSyncSummary(syncResult));
  } else deps.log("[polystella] sync step: no key changes needed.");
  if (args.syncOnly) return 0;

  const sourcePath = path.resolve(deps.cwd, baseDir, `${i18n.defaultLocale}.json`);
  const sourceRaw = await readFile(sourcePath, "utf8");
  const sourceDict = JSON.parse(sourceRaw) as Record<string, string>;
  const layout = parseSourceLayout(sourceRaw);
  const targets = args.locale === undefined ? i18n.locales.filter((locale) => locale !== i18n.defaultLocale) : [args.locale];
  if (targets.length === 0) return 0;

  const outcomes: PerLocaleOutcome[] = [];
  const pending: PendingLocale[] = [];
  for (let index = 0; index < targets.length; index++) {
    const locale = targets[index];
    if (locale === undefined) continue;
    const position = index + 1;
    const progress = progressLabel(position, targets.length);
    const outcome: PerLocaleOutcome = { filled: [], tokenFailures: [], error: undefined };
    outcomes.push(outcome);
    const localePath = path.resolve(deps.cwd, baseDir, `${locale}.json`);
    let localeRaw: string;
    let localeDict: Record<string, string>;
    try {
      localeRaw = await readFile(localePath, "utf8");
      localeDict = JSON.parse(localeRaw) as Record<string, string>;
    } catch (error) {
      outcome.error = asError(error);
      deps.err(`[polystella] translate-ui: ${progress} ${locale} — failed: ${errorMessage(error)}`);
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
  if (pending.length === 0) return outcomes.some((outcome) => outcome.error !== undefined) ? 2 : 0;

  let resolved;
  try {
    resolved = resolveCatalogConfig(await loadPolystellaConfig(deps.cwd), i18n);
  } catch (error) {
    deps.err(`[polystella] ${errorMessage(error)}`);
    return 1;
  }
  const provider = resolved.provider;
  if (provider === undefined) {
    deps.err(
      "[polystella] no provider configured in polystella.config.mjs — translate-ui needs one when empty placeholders exist. Add a `provider` block or use `pnpm i18n:sync` for offline key reconciliation only.",
    );
    return 1;
  }

  let glossaries: Awaited<ReturnType<typeof loadGlossaries>>;
  try {
    glossaries = await loadGlossaries({ config: resolved, projectRoot: pathToFileURL(deps.cwd + path.sep) });
  } catch (error) {
    deps.err(`[polystella] ${errorMessage(error)}`);
    return 1;
  }

  const activeConcurrency = Math.min(pending.length, resolved.concurrency, TRANSLATE_UI_MAX_CONCURRENCY);
  deps.log(
    `[polystella] translate-ui: translating ${pending.length} locale(s) out of ${targets.length} checked (concurrency ${activeConcurrency}, max ${TRANSLATE_UI_MAX_CONCURRENCY}).`,
  );
  let startedCount = 0;

  await runWithConcurrency(pending, activeConcurrency, async (job) => {
    const progress = `${progressLabel(++startedCount, pending.length)} to translate, ${progressLabel(job.position, targets.length)} total`;
    try {
      deps.log(
        `[polystella] translate-ui: ${progress} — starting locale ${job.locale} (${job.emptyCount} empty placeholder(s), up to ${DEFAULT_UI_STRING_BATCH_SIZE} per request) …`,
      );
      const result = await translateUiStringsForLocale({
        translator: createTranslator(provider, job.locale),
        glossary: glossaries.get(job.locale) ?? EMPTY_GLOSSARY,
        sourceDict,
        localeDict: job.localeDict,
        sourceLocale: resolved.defaultLocale,
        targetLocale: job.locale,
        ...(resolved.prompt.context === undefined ? {} : { context: resolved.prompt.context }),
        maxRetries: resolved.maxRetries,
        inputTokenBudget: provider.batchInputTokenBudget,
        retryMinTimeoutMs: 250,
        retryFactor: 2,
        retryRandomize: true,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        onRetry: ({ attempt, totalAttempts, error }) => {
          deps.warn(`[polystella]   ${progress} — ${job.locale}: attempt ${attempt}/${totalAttempts} failed: ${error.message}`);
        },
      });
      const reconciled = syncLocaleDict({ source: sourceDict, existing: result.dict, sourceKeyOrder: layout.keys });
      const nextText = formatLocaleFile({ dict: reconciled.dict, layout });
      if (nextText !== job.localeRaw) await writeFile(job.localePath, nextText, "utf8");
      job.outcome.filled = result.filled;
      job.outcome.tokenFailures = result.tokenFailures;

      if (result.filled.length > 0) {
        deps.log(
          `[polystella] translate-ui: ${progress} — ${job.locale} filled ${result.filled.length} key(s) across ${result.batchCount} request batch(es): ${result.filled.join(", ")}`,
        );
      } else {
        deps.log(
          `[polystella] translate-ui: ${progress} — ${job.locale} had no empty placeholders left to fill across ${result.batchCount} request batch(es).`,
        );
      }
      if (result.tokenFailures.length > 0) {
        deps.warn(`[polystella]   ${progress} — ${job.locale}: token-preservation failed for ${result.tokenFailures.length} key(s):`);
        for (const failure of result.tokenFailures) {
          deps.warn(`      - ${failure.key}: missing=[${failure.missing.join(", ")}], spurious=[${failure.spurious.join(", ")}]`);
        }
        deps.warn(`[polystella]   ${progress} — ${job.locale}: these keys were left empty; fix manually then re-run.`);
      }
    } catch (error) {
      job.outcome.error = asError(error);
      deps.err(`[polystella] translate-ui: ${progress} — ${job.locale} failed: ${errorMessage(error)}`);
    }
  });

  return outcomes.some((outcome) => outcome.tokenFailures.length > 0 || outcome.error !== undefined) ? 2 : 0;
}

interface PerLocaleOutcome {
  filled: string[];
  tokenFailures: TokenValidationIssue[];
  error: Error | undefined;
}

interface PendingLocale {
  locale: string;
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

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return asError(error).message;
}
