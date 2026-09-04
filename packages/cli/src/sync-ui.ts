import { readFile } from "node:fs/promises";
import path from "node:path";

import { loadAstroI18n } from "./config.js";
import { applySyncToDisk, formatLocaleFile, formatSyncSummary, parseSourceLayout, syncLocaleDict } from "./sync.js";

const DEFAULT_CATALOG_BASE = "./src/content/i18n";

export interface SyncUiArgs {
  base?: string | undefined;
  check: boolean;
  help: boolean;
}

export const SYNC_UI_USAGE = `polystella sync-ui

Reconcile non-default-locale UI-string JSON files against the default.
Adds missing keys (empty placeholders), removes extra keys, preserves
existing values, source key order, and blank-line section layout.

Usage:
  polystella sync-ui [flags]

Flags:
  --base <dir>   UI-strings base directory, relative to project root.
                 Default: ${DEFAULT_CATALOG_BASE}.
  --check        Don't write — exit 2 if changes would be made.
                 Useful for CI verification of an already-synced tree.
  --help         Print this message.

Exit codes:
  0  no changes needed (or changes applied successfully).
  1  config error.
  2  --check requested and changes would be needed.
`;

export interface SyncUiDeps {
  cwd: string;
  log: (message: string) => void;
  err: (message: string) => void;
}

export function parseSyncUiArgs(argv: ReadonlyArray<string>): SyncUiArgs {
  const out: SyncUiArgs = { check: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined || arg === "--") continue;
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--check") out.check = true;
    else if (arg === "--base") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`--base requires a value (got: ${value ?? "<end>"})`);
      out.base = value;
    } else throw new Error(`Unknown flag: ${arg}`);
  }
  return out;
}

export async function runSyncUi(args: SyncUiArgs, deps: SyncUiDeps): Promise<number> {
  if (args.help) {
    deps.log(SYNC_UI_USAGE);
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
    deps.err("[polystella] astro.config.mjs is missing an `i18n` block — nothing to sync.");
    return 1;
  }
  if (i18n.locales.length === 0 || !i18n.locales.includes(i18n.defaultLocale)) {
    deps.err(`[polystella] astro.config.mjs i18n.locales must include defaultLocale (${i18n.defaultLocale}).`);
    return 1;
  }

  const baseDir = args.base ?? DEFAULT_CATALOG_BASE;
  if (args.check) return runSyncCheck(deps.cwd, baseDir, i18n.defaultLocale, i18n.locales, deps);

  let result;
  try {
    result = await applySyncToDisk({ rootDir: deps.cwd, baseDir, defaultLocale: i18n.defaultLocale, locales: i18n.locales });
  } catch (error) {
    deps.err(`[polystella] ${errorMessage(error)}`);
    return 1;
  }
  if (!result.changed) {
    deps.log(`[polystella] UI-strings already in sync (${i18n.locales.length} locales, base: ${path.normalize(baseDir)}).`);
    return 0;
  }
  deps.log("[polystella] UI-strings sync:");
  deps.log(formatSyncSummary(result));
  deps.log("");
  deps.log("Next step: `pnpm i18n:translate` to fill empty placeholders, or edit the locale files by hand.");
  return 0;
}

async function runSyncCheck(
  cwd: string,
  baseDir: string,
  defaultLocale: string,
  locales: ReadonlyArray<string>,
  deps: SyncUiDeps,
): Promise<number> {
  const sourcePath = path.resolve(cwd, baseDir, `${defaultLocale}.json`);
  let sourceRaw: string;
  try {
    sourceRaw = await readFile(sourcePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      deps.err(`[polystella] default-locale UI-strings file not found at ${sourcePath}.`);
      return 1;
    }
    throw error;
  }
  const sourceDict = JSON.parse(sourceRaw) as Record<string, string>;
  const layout = parseSourceLayout(sourceRaw);
  const changes: string[] = [];

  for (const locale of locales) {
    if (locale === defaultLocale) continue;
    const filePath = path.resolve(cwd, baseDir, `${locale}.json`);
    let existingRaw: string | undefined;
    try {
      existingRaw = await readFile(filePath, "utf8");
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const existingDict = existingRaw === undefined ? {} : (JSON.parse(existingRaw) as Record<string, string>);
    const sync = syncLocaleDict({ source: sourceDict, existing: existingDict, sourceKeyOrder: layout.keys });
    const nextText = formatLocaleFile({ dict: sync.dict, layout });
    if (existingRaw === nextText) continue;
    const parts: string[] = [];
    if (sync.added.length > 0) parts.push(`+${sync.added.length} added`);
    if (sync.removed.length > 0) parts.push(`-${sync.removed.length} removed`);
    if (parts.length === 0) parts.push("layout-only");
    changes.push(`  • ${locale} (${existingRaw === undefined ? "would-create" : "would-update"}): ${parts.join(", ")}`);
  }

  if (changes.length === 0) {
    deps.log("[polystella] UI-strings already in sync (--check ok).");
    return 0;
  }
  deps.err("[polystella] UI-strings sync changes pending (--check):");
  deps.err(changes.join("\n"));
  deps.err("");
  deps.err("Run `pnpm i18n:sync` to apply.");
  return 2;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
