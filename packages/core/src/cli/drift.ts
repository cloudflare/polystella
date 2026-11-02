import { readFile } from "node:fs/promises";
import path from "node:path";

import { detectCatalogFormat, flattenCatalog, resolveLocaleTag, type CatalogFormat, type LocaleTags } from "../catalog/index.js";
import { validateMessage, validateMessageTranslation } from "../catalog/translate.js";

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

export interface MessageIssue {
  locale: string;
  key: string;
  problems: string[];
}

export interface CheckCatalogMessagesInput extends DriftCheckInput {
  localeTags?: LocaleTags | undefined;
}

/**
 * Message-syntax problems per string. The default locale is checked on its own (syntax, plural
 * branches its language never uses); other locales are checked against the default-locale string.
 */
export function checkCatalogMessages(input: CheckCatalogMessagesInput): MessageIssue[] {
  const defaultDict = input.dictionaries[input.defaultLocale] ?? {};
  const issues: MessageIssue[] = [];
  const locales = [input.defaultLocale, ...input.locales.filter((locale) => locale !== input.defaultLocale)];
  for (const locale of locales) {
    const tag = resolveLocaleTag(locale, input.localeTags);
    for (const [key, value] of Object.entries(input.dictionaries[locale] ?? {})) {
      if (value.length === 0) continue;
      const source = defaultDict[key];
      let problems: string[];
      if (locale === input.defaultLocale || source === undefined || source.length === 0) {
        problems = validateMessage(value, tag);
      } else {
        const issue = validateMessageTranslation(key, source, value, tag);
        problems =
          issue === null
            ? []
            : [
                ...issue.missing.map((name) => `missing {{${name}}}`),
                ...issue.spurious.map((name) => `{{${name}}} is not in the source`),
                ...(issue.problems ?? []),
              ];
      }
      if (problems.length > 0) issues.push({ locale, key, problems });
    }
  }
  return issues;
}

export function formatMessageIssues(issues: ReadonlyArray<MessageIssue>): string {
  return issues.map(({ locale, key, problems }) => `  • ${locale}.json "${key}": ${problems.join("; ")}`).join("\n");
}

export interface LoadAndCheckDriftOptions {
  rootDir: string;
  baseDir: string;
  locales: ReadonlyArray<string>;
  defaultLocale: string;
  localeTags?: LocaleTags | undefined;
}

/** `ok` covers key drift only; `messageIssues` lists invalid or mismatched messages separately. */
export interface LoadAndCheckDriftResult extends DriftCheckResult {
  messageIssues: MessageIssue[];
}

export async function loadAndCheckDrift(options: LoadAndCheckDriftOptions): Promise<LoadAndCheckDriftResult> {
  const dictionaries: Record<string, Record<string, string>> = {};
  const formats = new Map<string, CatalogFormat>();
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
    if (!isObject(parsed)) {
      throw new Error(
        `[polystella] UI-strings file at ${filePath} must be a JSON object — either a flat string→string map or nested groups of strings (got ${
          Array.isArray(parsed) ? "array" : typeof parsed
        }).`,
      );
    }
    dictionaries[locale] = flattenCatalog(parsed);
    formats.set(locale, detectCatalogFormat(parsed));
  }

  const defaultFormat = formats.get(options.defaultLocale);
  if (defaultFormat !== undefined) {
    const mismatched = [...formats.entries()]
      .filter(([locale, format]) => locale !== options.defaultLocale && format !== defaultFormat)
      .map(([locale]) => locale);
    if (mismatched.length > 0) {
      throw new Error(
        `[polystella] catalog format mismatch: ${options.defaultLocale}.json is ${defaultFormat}, but ${mismatched
          .map((locale) => `${locale}.json`)
          .join(", ")} ${mismatched.length === 1 ? "is" : "are"} the other format. All locale files must use the same format.`,
      );
    }
  }
  const input = { defaultLocale: options.defaultLocale, locales: options.locales, dictionaries };
  return { ...checkI18nDrift(input), messageIssues: checkCatalogMessages({ ...input, localeTags: options.localeTags }) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
