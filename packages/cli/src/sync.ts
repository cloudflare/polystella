import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SourceLayout {
  keys: string[];
  blankBefore: Set<string>;
}

export function parseSourceLayout(rawText: string): SourceLayout {
  const keys: string[] = [];
  const blankBefore = new Set<string>();
  let lastWasEntry = false;
  let sawBlankSinceLastEntry = false;
  const keyLine = /^\s+"([^"\\]|\\.)*"\s*:/;
  const keyName = /^\s+"((?:[^"\\]|\\.)*)"\s*:/;

  for (const line of rawText.split(/\r?\n/)) {
    if (line.trim() === "") {
      if (lastWasEntry) sawBlankSinceLastEntry = true;
      continue;
    }
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
}

export function formatLocaleFile(options: FormatLocaleFileOptions): string {
  const keys = Object.keys(options.dict);
  if (keys.length === 0) return "{}\n";
  const lines: string[] = ["{"];
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    if (key === undefined) continue;
    const value = options.dict[key];
    if (value === undefined) continue;
    if (index > 0 && options.layout.blankBefore.has(key)) lines.push("");
    lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)}${index === keys.length - 1 ? "" : ","}`);
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

export interface ApplySyncOptions {
  rootDir: string;
  baseDir: string;
  defaultLocale: string;
  locales: ReadonlyArray<string>;
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
  const source = parseDictionary(sourceRaw, sourcePath);
  const layout = parseSourceLayout(sourceRaw);
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
    const existing = existingRaw === undefined ? {} : parseDictionary(existingRaw, filePath);
    const sync = syncLocaleDict({ source, existing, sourceKeyOrder: layout.keys });
    const nextText = formatLocaleFile({ dict: sync.dict, layout });
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

function parseDictionary(raw: string, filePath: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`expected an object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`);
    }
    return parsed as Record<string, string>;
  } catch (error) {
    throw new Error(`[polystella] failed to parse ${filePath}: ${errorMessage(error)}`);
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
