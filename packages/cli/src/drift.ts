import { readFile } from "node:fs/promises";
import path from "node:path";

export interface DriftIssue {
  locale: string;
  missing: string[];
  extra: string[];
  emptyPlaceholders: string[];
  missingFile: boolean;
}

export interface DriftCheckInput {
  defaultLocale: string;
  locales: ReadonlyArray<string>;
  dictionaries: Record<string, Record<string, string>>;
}

export interface DriftCheckResult {
  ok: boolean;
  issues: DriftIssue[];
}

export function checkI18nDrift(input: DriftCheckInput): DriftCheckResult {
  const defaultDict = input.dictionaries[input.defaultLocale];
  if (defaultDict === undefined) return { ok: true, issues: [] };

  const defaultKeys = new Set(Object.keys(defaultDict));
  const issues: DriftIssue[] = [];
  for (const locale of input.locales) {
    if (locale === input.defaultLocale) continue;
    const localeDict = input.dictionaries[locale];
    if (localeDict === undefined) {
      issues.push({
        locale,
        missing: [...defaultKeys].sort(),
        extra: [],
        emptyPlaceholders: [],
        missingFile: true,
      });
      continue;
    }

    const localeKeys = new Set(Object.keys(localeDict));
    const missing = [...defaultKeys].filter((key) => !localeKeys.has(key)).sort();
    const extra = [...localeKeys].filter((key) => !defaultKeys.has(key)).sort();
    const emptyPlaceholders = [...defaultKeys]
      .filter((key) => {
        if (!localeKeys.has(key)) return false;
        const sourceValue = defaultDict[key];
        const localeValue = localeDict[key];
        return sourceValue !== undefined && sourceValue.length > 0 && (localeValue === undefined || localeValue.length === 0);
      })
      .sort();
    if (missing.length > 0 || extra.length > 0 || emptyPlaceholders.length > 0) {
      issues.push({ locale, missing, extra, emptyPlaceholders, missingFile: false });
    }
  }
  return { ok: issues.length === 0, issues };
}

export function formatDriftIssues(issues: ReadonlyArray<DriftIssue>): string {
  const lines: string[] = [];
  for (const issue of issues) {
    if (issue.missingFile) {
      lines.push(`  • ${issue.locale}: file is missing. Create it and copy these keys (values are placeholders for translation):`);
      for (const key of issue.missing) lines.push(`      "${key}": ""`);
      continue;
    }
    if (issue.missing.length > 0) lines.push(`  • Missing keys in ${issue.locale}.json: ${issue.missing.join(", ")}`);
    if (issue.extra.length > 0) {
      lines.push(`  • Extra keys in ${issue.locale}.json (not in default-locale file): ${issue.extra.join(", ")}`);
    }
    if (issue.emptyPlaceholders.length > 0) {
      lines.push(`  • Empty placeholders in ${issue.locale}.json (synced but untranslated): ${issue.emptyPlaceholders.join(", ")}`);
    }
  }
  return lines.join("\n");
}

export interface LoadAndCheckDriftOptions {
  rootDir: string;
  baseDir: string;
  locales: ReadonlyArray<string>;
  defaultLocale: string;
}

export async function loadAndCheckDrift(options: LoadAndCheckDriftOptions): Promise<DriftCheckResult> {
  const dictionaries: Record<string, Record<string, string>> = {};
  for (const locale of options.locales) {
    const filePath = path.resolve(options.rootDir, options.baseDir, `${locale}.json`);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`[polystella] failed to parse UI-strings JSON at ${filePath}: ${errorMessage(error)}`);
    }
    if (!isRecord(parsed)) {
      throw new Error(
        `[polystella] UI-strings file at ${filePath} must be a JSON object of string→string entries (got ${
          Array.isArray(parsed) ? "array" : typeof parsed
        }).`,
      );
    }
    dictionaries[locale] = parsed;
  }
  return checkI18nDrift({
    defaultLocale: options.defaultLocale,
    locales: options.locales,
    dictionaries,
  });
}

function isRecord(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
