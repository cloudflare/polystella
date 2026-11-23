import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { keptIgnoredValue, renderJsonValue, schemaFirst } from "../catalog/flatten.js";
import { detectCatalogFormat, flattenCatalog, formatNestedLocaleFile, type IgnoreKey } from "../catalog/index.js";

export { formatNestedLocaleFile, type FormatNestedLocaleFileOptions } from "../catalog/index.js";

export interface SourceLayout {
  keys: string[];
  blankBefore: Set<string>;
}

export function parseSourceLayout(rawText: string): SourceLayout {
  const keys: string[] = [];
  const blankBefore = new Set<string>();
  let lastWasEntry = false;
  let sawBlankSinceLastEntry = false;
  // Lines inside a multi-line value (an ignored inlang array) belong to the entry they continue.
  let depth = 0;
  const keyLine = /^\s+"([^"\\]|\\.)*"\s*:/;
  const keyName = /^\s+"((?:[^"\\]|\\.)*)"\s*:/;

  for (const line of rawText.split(/\r?\n/)) {
    const lineDepth = depth;
    depth += bracketDelta(line);
    if (line.trim() === "") {
      if (lastWasEntry && lineDepth === 1) sawBlankSinceLastEntry = true;
      continue;
    }
    if (lineDepth > 1) continue;
    if (keyLine.test(line)) {
      const match = keyName.exec(line);
      if (match?.[1] !== undefined) {
        let decoded: string;
        try {
          decoded = JSON.parse(`"${match[1]}"`) as string;
        } catch {
          decoded = match[1];
        }
        if (keys.length > 0 && sawBlankSinceLastEntry) blankBefore.add(decoded);
        keys.push(decoded);
        lastWasEntry = true;
        sawBlankSinceLastEntry = false;
        continue;
      }
    }
    lastWasEntry = false;
    sawBlankSinceLastEntry = false;
  }
  return { keys, blankBefore };
}

function bracketDelta(line: string): number {
  let delta = 0;
  let inString = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (inString) {
      if (char === "\\") index++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{" || char === "[") delta++;
    else if (char === "}" || char === "]") delta--;
  }
  return delta;
}

export interface SyncLocaleDictInput {
  source: Record<string, string>;
  existing: Record<string, string>;
  sourceKeyOrder: ReadonlyArray<string>;
}

export interface SyncLocaleDictResult {
  dict: Record<string, string>;
  added: string[];
  removed: string[];
}

export function syncLocaleDict(input: SyncLocaleDictInput): SyncLocaleDictResult {
  const result: Record<string, string> = {};
  const added: string[] = [];
  const sourceKeySet = new Set(Object.keys(input.source));

  for (const key of input.sourceKeyOrder) {
    if (!sourceKeySet.has(key)) continue;
    if (Object.hasOwn(input.existing, key)) result[key] = input.existing[key] ?? "";
    else {
      result[key] = "";
      added.push(key);
    }
  }
  for (const key of Object.keys(input.source)) {
    if (Object.hasOwn(result, key)) continue;
    if (Object.hasOwn(input.existing, key)) result[key] = input.existing[key] ?? "";
    else {
      result[key] = "";
      added.push(key);
    }
  }
  const removed = Object.keys(input.existing).filter((key) => !sourceKeySet.has(key));
  added.sort();
  removed.sort();
  return { dict: result, added, removed };
}

export interface FormatLocaleFileOptions {
  dict: Record<string, string>;
  layout: SourceLayout;
  source?: Record<string, unknown> | undefined;
  existing?: Record<string, unknown> | undefined;
  /** Matching entries are kept from `existing` verbatim and never created (except a top-level `$schema`). */
  ignoreKey?: IgnoreKey | undefined;
}

/** Entries follow the source layout's key order; target-only ignored entries go last. */
export function formatLocaleFile(options: FormatLocaleFileOptions): string {
  const rendered = new Map<string, string>();
  const candidates = [...options.layout.keys, ...Object.keys(options.dict), ...Object.keys(options.existing ?? {})];
  for (const key of schemaFirst(candidates, options.ignoreKey)) {
    if (options.ignoreKey?.(key) === true) {
      const kept = keptIgnoredValue(key, key, options.source, options.existing);
      if (kept !== undefined) rendered.set(key, renderJsonValue(kept, "  "));
    } else if (Object.hasOwn(options.dict, key)) rendered.set(key, JSON.stringify(options.dict[key]));
  }
  const entries = [...rendered];
  if (entries.length === 0) return "{}\n";
  const lines: string[] = ["{"];
  for (const [index, [key, value]] of entries.entries()) {
    if (index > 0 && options.layout.blankBefore.has(key)) lines.push("");
    lines.push(`  ${JSON.stringify(key)}: ${value}${index === entries.length - 1 ? "" : ","}`);
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

export interface ApplySyncOptions {
  rootDir: string;
  baseDir: string;
  defaultLocale: string;
  locales: ReadonlyArray<string>;
  /** From `catalog.ignoreKeys`: matching entries are never synced and stay untouched in target files. */
  ignoreKey?: IgnoreKey | undefined;
}

export interface ApplySyncLocaleResult {
  locale: string;
  added: string[];
  removed: string[];
  changed: boolean;
  filePath: string;
  created: boolean;
}

export interface ApplySyncResult {
  results: ApplySyncLocaleResult[];
  changed: boolean;
}

export async function applySyncToDisk(options: ApplySyncOptions): Promise<ApplySyncResult> {
  const sourcePath = path.resolve(options.rootDir, options.baseDir, `${options.defaultLocale}.json`);
  let sourceRaw: string;
  try {
    sourceRaw = await readFile(sourcePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(
        `[polystella] default-locale UI-strings file not found at ${sourcePath}. Create it (even as \`{}\`) before running sync-ui.`,
      );
    }
    throw error;
  }
  const sourceParsed = parseCatalog(sourceRaw, sourcePath);
  const { ignoreKey } = options;
  const sourceFormat = detectCatalogFormat(sourceParsed, ignoreKey);
  const source = flattenCatalogAtPath(sourceParsed, sourcePath, ignoreKey);
  const layout = sourceFormat === "flat" ? parseSourceLayout(sourceRaw) : undefined;
  const sourceKeyOrder = layout?.keys ?? Object.keys(source);
  const results: ApplySyncLocaleResult[] = [];
  let changed = false;

  for (const locale of options.locales) {
    const filePath = path.resolve(options.rootDir, options.baseDir, `${locale}.json`);
    if (locale === options.defaultLocale) {
      results.push({ locale, added: [], removed: [], changed: false, filePath, created: false });
      continue;
    }
    let existingRaw: string | undefined;
    try {
      existingRaw = await readFile(filePath, "utf8");
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const created = existingRaw === undefined;
    const existingParsed = existingRaw === undefined ? undefined : parseCatalog(existingRaw, filePath);
    const existing = existingParsed === undefined ? {} : flattenCatalogAtPath(existingParsed, filePath, ignoreKey);
    const sync = syncLocaleDict({ source, existing, sourceKeyOrder });
    const files = { dict: sync.dict, source: sourceParsed, existing: existingParsed, ignoreKey };
    const nextText =
      sourceFormat === "nested" || layout === undefined ? formatNestedLocaleFile(files) : formatLocaleFile({ ...files, layout });
    const localeChanged = created || existingRaw !== nextText;
    if (localeChanged) {
      await writeFile(filePath, nextText, "utf8");
      changed = true;
    }
    results.push({ locale, added: sync.added, removed: sync.removed, changed: localeChanged, filePath, created });
  }
  return { results, changed };
}

export function formatSyncSummary(result: ApplySyncResult): string {
  const lines: string[] = [];
  for (const locale of result.results) {
    if (!locale.changed) continue;
    const parts: string[] = [];
    if (locale.added.length > 0) parts.push(`+${locale.added.length} added`);
    if (locale.removed.length > 0) parts.push(`-${locale.removed.length} removed`);
    if (parts.length === 0 && !locale.created) parts.push("reformatted (layout only)");
    if (parts.length === 0) parts.push("no key changes");
    lines.push(`  • ${locale.locale} (${locale.created ? "created" : "updated"}): ${parts.join(", ")}`);
    for (const key of locale.added) lines.push(`      + ${key}`);
    for (const key of locale.removed) lines.push(`      - ${key}`);
  }
  return lines.join("\n");
}

function parseCatalog(raw: string, filePath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) {
      throw new Error(`expected an object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`);
    }
    return parsed;
  } catch (error) {
    throw new Error(`[polystella] failed to parse ${filePath}: ${errorMessage(error)}`);
  }
}

function flattenCatalogAtPath(
  catalog: Record<string, unknown>,
  filePath: string,
  ignoreKey: IgnoreKey | undefined,
): Record<string, string> {
  try {
    return flattenCatalog(catalog, ignoreKey);
  } catch (error) {
    throw new Error(`[polystella] failed to parse ${filePath}: ${errorMessage(error)}`);
  }
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
