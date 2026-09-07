/**
 * UI-string sync — mechanical (no AI) reconciliation of locale JSON
 * files against the default-locale source.
 *
 * Pure functions:
 *   - `parseSourceLayout` — extract the top-level key order AND
 *     blank-line section structure from a flat JSON source file. Lets
 *     `formatLocaleFile` round-trip without churning diffs on first
 *     run.
 *   - `syncLocaleDict` — given the source dict + the locale's
 *     existing dict, produce the post-sync dict: add missing keys
 *     with `""`, drop extras, preserve existing values (empty or
 *     not). Order follows the source.
 *   - `formatLocaleFile` — render a flat dict to 2-space-indented
 *     JSON with the source's blank-line layout interleaved between
 *     keys. Always ends with a trailing newline (prettier-compatible).
 *   - `formatNestedLocaleFile` — render a flattened dict back to
 *     nested JSON, mirroring the source's group/key order and
 *     preserving the locale's own group titles.
 *
 * All disk I/O lives in `applySyncToDisk` which composes the pure
 * functions. Tests pin behaviour without writing to a tmpdir for
 * everything except the disk-wrapper itself.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { CATALOG_GROUP_TITLE_KEY, detectCatalogFormat, flattenCatalog } from "@cloudflare/polystella-core/catalog";

/**
 * Top-level key order + section-break structure recovered from the
 * source JSON text. Section breaks are blank lines between two
 * adjacent top-level entries — purely visual, ignored by JSON.parse,
 * but meaningful to humans scanning the file.
 */
export interface SourceLayout {
  /** Top-level keys in source-file order. */
  keys: string[];
  /**
   * Keys that should have a blank line immediately BEFORE them in
   * the output (i.e. the key starts a new "section"). The first key
   * is never in this set — a blank line before the first entry is
   * meaningless.
   */
  blankBefore: Set<string>;
}

/**
 * Parse the source JSON text to extract `{ keys, blankBefore }`.
 *
 * Scans lines starting with `"` at indent ≥ 1 as top-level keys.
 * Records "did the previous non-blank line *also* end a key entry,
 * with a blank line between" → that key starts a section.
 *
 * Tolerant to:
 *   - 2-space or any other indent (we re-emit 2-space regardless)
 *   - trailing commas in input (JSON5-ish authoring tolerated when
 *     reading; we always emit valid JSON)
 *   - mixed line endings (`\r\n` vs `\n`)
 *
 * Does NOT validate JSON syntax — caller is expected to also run
 * `JSON.parse` on the same text and surface that error.
 */
export function parseSourceLayout(rawText: string): SourceLayout {
  const lines = rawText.split(/\r?\n/);
  const keys: string[] = [];
  const blankBefore = new Set<string>();
  // True iff the immediately previous non-empty line was a top-level
  // entry's value line (so a blank line between us and that line is
  // a section break).
  let lastWasEntry = false;
  let sawBlankSinceLastEntry = false;

  // Top-level keys live at indent ≥ 1 (we don't care about exact
  // indent width). Nested object literals would also produce
  // `"foo": …` lines, but our schema rejects nesting so this is fine
  // in practice. If someone hand-edits a malformed nested shape, the
  // companion JSON.parse hard-fails before we get here.
  const KEY_LINE = /^\s+"([^"\\]|\\.)*"\s*:/;
  const KEY_NAME = /^\s+"((?:[^"\\]|\\.)*)"\s*:/;

  for (const line of lines) {
    if (line.trim() === "") {
      if (lastWasEntry) {
        sawBlankSinceLastEntry = true;
      }
      continue;
    }
    if (KEY_LINE.test(line)) {
      const match = KEY_NAME.exec(line);
      if (match && match[1] !== undefined) {
        // JSON string-escape decoding: keys with escaped quotes /
        // backslashes are rare in UI strings but supported for
        // correctness. We hand the matched text to JSON.parse on a
        // synthetic string literal so escape handling stays faithful.
        let decoded: string;
        try {
          decoded = JSON.parse(`"${match[1]}"`) as string;
        } catch {
          decoded = match[1];
        }
        if (keys.length > 0 && sawBlankSinceLastEntry) {
          blankBefore.add(decoded);
        }
        keys.push(decoded);
        lastWasEntry = true;
        sawBlankSinceLastEntry = false;
        continue;
      }
    }
    // Any other non-blank line (braces, comments) — we stop treating
    // the previous entry as adjacent for section-break purposes.
    lastWasEntry = false;
    sawBlankSinceLastEntry = false;
  }

  return { keys, blankBefore };
}

export interface SyncLocaleDictInput {
  /** Default-locale dict in canonical key order. */
  source: Record<string, string>;
  /** Existing locale dict (or `{}` if file was missing). */
  existing: Record<string, string>;
  /** Source key order (`parseSourceLayout(...).keys`). */
  sourceKeyOrder: ReadonlyArray<string>;
}

export interface SyncLocaleDictResult {
  /** Post-sync locale dict, in source-file key order. */
  dict: Record<string, string>;
  /** Keys added (value initialised to `""`). */
  added: string[];
  /** Keys removed (were in `existing`, no longer in `source`). */
  removed: string[];
}

/**
 * Pure key reconciliation. Preserves existing locale values (empty
 * or not) for any key still present in the source. New keys get `""`
 * placeholders so `translate-ui` can detect them. Extra keys are
 * dropped. Output is in source key order; existing locale's order
 * is ignored.
 */
export function syncLocaleDict(input: SyncLocaleDictInput): SyncLocaleDictResult {
  const { source, existing, sourceKeyOrder } = input;
  const result: Record<string, string> = {};
  const added: string[] = [];
  const sourceKeySet = new Set(Object.keys(source));

  for (const key of sourceKeyOrder) {
    if (!sourceKeySet.has(key)) {
      // Layout key not in the source dict — shouldn't happen since
      // the caller derives both from the same file, but defend
      // against drift by skipping.
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(existing, key)) {
      // `noUncheckedIndexedAccess` + `existing[key]` = `string |
      // undefined`. We just proved presence with `hasOwnProperty`, so
      // an `undefined` here would mean the input dict has a literal
      // undefined value — invalid per schema. Coerce to "" to keep
      // the output well-typed.
      const value = existing[key];
      result[key] = value ?? "";
    } else {
      result[key] = "";
      added.push(key);
    }
  }

  // Keys present in the source dict but missing from the layout
  // (also shouldn't happen). Append in object-key order, no section
  // break — author can rearrange manually if it matters.
  for (const key of Object.keys(source)) {
    if (Object.prototype.hasOwnProperty.call(result, key)) continue;
    if (Object.prototype.hasOwnProperty.call(existing, key)) {
      const value = existing[key];
      result[key] = value ?? "";
    } else {
      result[key] = "";
      added.push(key);
    }
  }

  // Extras: keys in existing locale that the source no longer has.
  const removed: string[] = [];
  for (const key of Object.keys(existing)) {
    if (!sourceKeySet.has(key)) removed.push(key);
  }

  // Deterministic ordering for reporting (the dict itself is ordered
  // by source layout).
  added.sort();
  removed.sort();

  return { dict: result, added, removed };
}

export interface FormatLocaleFileOptions {
  /** Dict to render, in the order returned by `syncLocaleDict`. */
  dict: Record<string, string>;
  /** Section-break layout from `parseSourceLayout`. */
  layout: SourceLayout;
}

/**
 * Render a dict to 2-space-indented JSON with blank-line section
 * breaks inserted between adjacent keys whose successor is in
 * `layout.blankBefore`. Always ends with `\n`.
 *
 * Format compatibility with prettier:
 *   - 2-space indent, space after `:`
 *   - no trailing commas
 *   - trailing newline
 *   - keys quoted with `"`; values escaped via `JSON.stringify`
 *
 * Prettier's JSON parser does NOT preserve blank lines, so running
 * `prettier --write` against a synced file WILL collapse the section
 * breaks. We accept that: prettier is invoked manually (not by the
 * hook), and the section breaks survive across normal edits and
 * subsequent `sync-ui` runs.
 */
export function formatLocaleFile(opts: FormatLocaleFileOptions): string {
  const { dict, layout } = opts;
  const keys = Object.keys(dict);
  if (keys.length === 0) return "{}\n";

  const lines: string[] = ["{"];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === undefined) continue;
    const value = dict[key];
    if (value === undefined) continue;
    if (i > 0 && layout.blankBefore.has(key)) {
      lines.push("");
    }
    const isLast = i === keys.length - 1;
    const comma = isLast ? "" : ",";
    lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)}${comma}`);
  }
  lines.push("}");
  return lines.join("\n") + "\n";
}

export interface FormatNestedLocaleFileOptions {
  /** Flattened dict to render (dotted keys). */
  dict: Record<string, string>;
  /** Source nested JSON object: group order, key order, and group titles. */
  source: Record<string, unknown>;
  /** Existing locale JSON (pre-sync). Its group titles are preserved
   * when present; the source's fill in otherwise. */
  existing?: Record<string, unknown> | undefined;
}

/**
 * Render a flattened dict back to nested JSON using the source
 * file's structure: groups in source order, keys in source order,
 * blank line before each top-level group. Group titles come from the
 * existing locale file when it has one (hand-authored titles are
 * preserved), otherwise from the source — they are metadata, not
 * translated. 2-space indent, trailing newline, prettier-compatible.
 *
 * Groups that end up with no keys (e.g. only a group title) are
 * omitted. Keys in `dict` that belong to no source group are ignored
 * — the caller's sync step guarantees they don't exist.
 */
export function formatNestedLocaleFile(opts: FormatNestedLocaleFileOptions): string {
  const { dict, source, existing } = opts;
  const groupLines: string[] = [];
  for (const [groupKey, groupValue] of Object.entries(source)) {
    if (groupValue === null || typeof groupValue !== "object" || Array.isArray(groupValue)) continue;
    const existingGroup =
      existing !== undefined && typeof existing[groupKey] === "object" && existing[groupKey] !== null && !Array.isArray(existing[groupKey])
        ? (existing[groupKey] as Record<string, unknown>)
        : undefined;
    const rendered = renderNestedGroup(groupKey, groupKey, groupValue as Record<string, unknown>, existingGroup, dict, "  ");
    if (rendered.length === 0) continue;
    groupLines.push(rendered.join("\n"));
  }
  if (groupLines.length === 0) return "{}\n";
  return ["{", groupLines.join(",\n\n"), "}"].join("\n") + "\n";
}

function renderNestedGroup(
  key: string,
  path: string,
  node: Record<string, unknown>,
  existing: Record<string, unknown> | undefined,
  dict: Record<string, string>,
  indent: string,
): string[] {
  const inner = `${indent}  `;
  const lines: string[] = [`${indent}${JSON.stringify(key)}: {`];
  const title =
    existing !== undefined && typeof existing[CATALOG_GROUP_TITLE_KEY] === "string"
      ? existing[CATALOG_GROUP_TITLE_KEY]
      : typeof node[CATALOG_GROUP_TITLE_KEY] === "string"
        ? node[CATALOG_GROUP_TITLE_KEY]
        : undefined;
  if (title !== undefined) {
    lines.push(`${inner}${JSON.stringify(CATALOG_GROUP_TITLE_KEY)}: ${JSON.stringify(title)},`);
  }
  const entries: string[] = [];
  for (const [childKey, childValue] of Object.entries(node)) {
    if (childKey === CATALOG_GROUP_TITLE_KEY) continue;
    const childPath = `${path}.${childKey}`;
    if (typeof childValue === "string") {
      const value = dict[childPath];
      if (value === undefined) continue;
      entries.push(`${inner}${JSON.stringify(childKey)}: ${JSON.stringify(value)}`);
    } else if (childValue !== null && typeof childValue === "object" && !Array.isArray(childValue)) {
      const existingChild =
        existing !== undefined &&
        typeof existing[childKey] === "object" &&
        existing[childKey] !== null &&
        !Array.isArray(existing[childKey])
          ? (existing[childKey] as Record<string, unknown>)
          : undefined;
      const nested = renderNestedGroup(childKey, childPath, childValue as Record<string, unknown>, existingChild, dict, inner);
      if (nested.length > 0) entries.push(nested.join("\n"));
    }
  }
  if (entries.length === 0) return [];
  lines.push(entries.join(",\n"));
  lines.push(`${indent}}`);
  return lines;
}

export interface ApplySyncOptions {
  /** Absolute project root. */
  rootDir: string;
  /** Relative to `rootDir` (e.g. `"./src/content/i18n"`). */
  baseDir: string;
  defaultLocale: string;
  /** Full locale set INCLUDING `defaultLocale`. */
  locales: ReadonlyArray<string>;
}

export interface ApplySyncLocaleResult {
  locale: string;
  added: string[];
  removed: string[];
  /** True iff the file's bytes changed and were written. */
  changed: boolean;
  /** Final on-disk path (informational). */
  filePath: string;
  /** True iff the locale file didn't exist before this run. */
  created: boolean;
}

export interface ApplySyncResult {
  /** Per-locale outcomes. Default locale is always present, but
   *  always reports zero changes since sync never edits the source. */
  results: ApplySyncLocaleResult[];
  /** True iff anything was added, removed, or created. */
  changed: boolean;
}

/**
 * Disk-bound wrapper. Loads the default-locale file, parses layout,
 * iterates non-default locales applying `syncLocaleDict` + writing
 * back via `formatLocaleFile`. Missing locale files are created.
 *
 * Throws on:
 *   - missing default-locale file (no source of truth)
 *   - malformed JSON in any file
 */
export async function applySyncToDisk(opts: ApplySyncOptions): Promise<ApplySyncResult> {
  const sourcePath = path.resolve(opts.rootDir, opts.baseDir, `${opts.defaultLocale}.json`);
  let sourceRaw: string;
  try {
    sourceRaw = await readFile(sourcePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `[polystella] default-locale UI-strings file not found at ${sourcePath}. Create it (even as \`{}\`) before running sync-ui.`,
      );
    }
    throw err;
  }

  let sourceParsed: Record<string, unknown>;
  try {
    const parsed = JSON.parse(sourceRaw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`expected an object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`);
    }
    sourceParsed = parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(`[polystella] failed to parse ${sourcePath}: ${(err as Error).message}`);
  }

  const sourceFormat = detectCatalogFormat(sourceParsed);
  const sourceDict = flattenCatalog(sourceParsed);
  // Flat files keep their blank-line section layout; nested files
  // take order from the parsed object (group order, key order).
  const layout = sourceFormat === "flat" ? parseSourceLayout(sourceRaw) : undefined;
  const sourceKeyOrder = layout !== undefined ? layout.keys : Object.keys(sourceDict);

  const results: ApplySyncLocaleResult[] = [];
  let anyChanged = false;

  for (const locale of opts.locales) {
    const filePath = path.resolve(opts.rootDir, opts.baseDir, `${locale}.json`);
    if (locale === opts.defaultLocale) {
      // The source is never edited by sync; report it as
      // pass-through so the summary is complete.
      results.push({
        locale,
        added: [],
        removed: [],
        changed: false,
        filePath,
        created: false,
      });
      continue;
    }

    let existingRaw: string | undefined;
    let created = false;
    try {
      existingRaw = await readFile(filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        existingRaw = undefined;
        created = true;
      } else {
        throw err;
      }
    }

    let existingDict: Record<string, string>;
    let existingParsed: Record<string, unknown> | undefined;
    if (existingRaw === undefined) {
      existingDict = {};
    } else {
      try {
        const parsed = JSON.parse(existingRaw) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error(`expected an object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`);
        }
        existingParsed = parsed as Record<string, unknown>;
        // Flattening normalises either format, so a locale file in
        // the "wrong" format still reconciles and is rewritten in
        // the source's format.
        existingDict = flattenCatalog(parsed);
      } catch (err) {
        throw new Error(`[polystella] failed to parse ${filePath}: ${(err as Error).message}`);
      }
    }

    const sync = syncLocaleDict({
      source: sourceDict,
      existing: existingDict,
      sourceKeyOrder,
    });

    const nextText =
      sourceFormat === "nested" || layout === undefined
        ? formatNestedLocaleFile({ dict: sync.dict, source: sourceParsed, existing: existingParsed })
        : formatLocaleFile({ dict: sync.dict, layout });
    // Only write when the on-disk bytes would change; keeps `git
    // status` clean on no-op runs.
    const changed = created || existingRaw !== nextText;
    if (changed) {
      await writeFile(filePath, nextText, "utf8");
      anyChanged = true;
    }

    results.push({
      locale,
      added: sync.added,
      removed: sync.removed,
      changed,
      filePath,
      created,
    });
  }

  return { results, changed: anyChanged };
}

/**
 * Human-readable summary of an `ApplySyncResult` for CLI output.
 * Returns an empty string when nothing changed. Layout-only changes
 * (key set unchanged, but byte-equality fails) are reported as
 * "reformatted" so operators understand why the diff exists.
 */
export function formatSyncSummary(result: ApplySyncResult): string {
  const lines: string[] = [];
  for (const r of result.results) {
    if (!r.changed) continue;
    const tag = r.created ? "created" : "updated";
    const parts: string[] = [];
    if (r.added.length > 0) parts.push(`+${r.added.length} added`);
    if (r.removed.length > 0) parts.push(`-${r.removed.length} removed`);
    if (parts.length === 0 && !r.created) parts.push("reformatted (layout only)");
    if (parts.length === 0) parts.push("no key changes");
    lines.push(`  • ${r.locale} (${tag}): ${parts.join(", ")}`);
    for (const key of r.added) {
      lines.push(`      + ${key}`);
    }
    for (const key of r.removed) {
      lines.push(`      - ${key}`);
    }
  }
  return lines.join("\n");
}
