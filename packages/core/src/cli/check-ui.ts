import path from "node:path";

import type { LocaleTags } from "../catalog/locale-tags.js";

import { loadAstroI18n, loadOptionalPolystellaConfig, resolveLocaleTagsConfig } from "./config.js";
import { formatDriftIssues, formatMessageIssues, loadAndCheckDrift } from "./drift.js";

const DEFAULT_CATALOG_BASE = "./src/content/i18n";

export interface CheckUiArgs {
  base?: string | undefined;
  help: boolean;
}

export const CHECK_UI_USAGE = `polystella check-ui

Verify every non-default locale's UI-string JSON has the same key set as
the default locale, and that every string is a valid message whose
placeholders, plural and select branches match the default locale.
Runs offline — suitable for a pre-commit hook. Reads localeTags from
polystella.config.mjs when present.

Usage:
  polystella check-ui [flags]

Flags:
  --base <dir>   UI-strings base directory, relative to project root.
                 Default: ${DEFAULT_CATALOG_BASE}.
  --help         Print this message.

Exit codes:
  0  no drift or message problems; every locale matches the default.
  1  drift or message problems detected, or config error (missing astro.config.mjs etc).
`;

export interface CheckUiDeps {
  cwd: string;
  log: (message: string) => void;
  err: (message: string) => void;
}

export function parseCheckUiArgs(argv: ReadonlyArray<string>): CheckUiArgs {
  const out: CheckUiArgs = { help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined || arg === "--") continue;
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--base") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`--base requires a value (got: ${value ?? "<end>"})`);
      out.base = value;
    } else throw new Error(`Unknown flag: ${arg}`);
  }
  return out;
}

export async function runCheckUi(args: CheckUiArgs, deps: CheckUiDeps): Promise<number> {
  if (args.help) {
    deps.log(CHECK_UI_USAGE);
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
    deps.err("[polystella] astro.config.mjs is missing an `i18n` block — nothing to check.");
    return 1;
  }
  if (i18n.locales.length === 0 || !i18n.locales.includes(i18n.defaultLocale)) {
    deps.err(`[polystella] astro.config.mjs i18n.locales must include defaultLocale (${i18n.defaultLocale}).`);
    return 1;
  }

  let localeTags: LocaleTags | undefined;
  try {
    localeTags = resolveLocaleTagsConfig(await loadOptionalPolystellaConfig(deps.cwd), i18n);
  } catch (error) {
    const message = errorMessage(error);
    deps.err(message.startsWith("[polystella]") ? message : `[polystella] ${message}`);
    return 1;
  }

  const baseDir = args.base ?? DEFAULT_CATALOG_BASE;
  const result = await loadAndCheckDrift({
    rootDir: deps.cwd,
    baseDir,
    locales: i18n.locales,
    defaultLocale: i18n.defaultLocale,
    localeTags,
  });
  if (result.ok && result.messageIssues.length === 0) {
    deps.log(`[polystella] UI-strings drift check passed (${i18n.locales.length} locales, base: ${path.normalize(baseDir)}).`);
    return 0;
  }

  if (result.messageIssues.length > 0) {
    deps.err("[polystella] invalid UI-string messages:");
    deps.err(formatMessageIssues(result.messageIssues));
    deps.err("");
    deps.err("Placeholders are {{name}}; plurals are {{count, plural, one {# item} other {# items}}}.");
    deps.err("Write '' for an apostrophe directly before {{, } or # inside a plural.");
    if (result.ok) return 1;
    deps.err("");
  }

  deps.err("[polystella] UI-strings drift detected:");
  deps.err(formatDriftIssues(result.issues));
  deps.err("");
  deps.err("To resolve:");
  deps.err("  • `pnpm i18n:sync` (offline, no AI) — adds missing keys as empty strings, removes extras.");
  deps.err("  • `pnpm i18n:translate` (AI) — same as sync, then fills empty values via the configured provider.");
  deps.err("  • Or edit the locale JSON files by hand.");
  return 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
