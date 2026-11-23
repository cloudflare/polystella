export type CatalogFormat = "flat" | "nested";

export interface CatalogSource {
  readonly [key: string]: string | CatalogSource;
}

/** True for a dotted catalog key (or group path) that is not a message. */
export type IgnoreKey = (key: string) => boolean;

/**
 * Reserved metadata key inside nested groups. Holds a display title
 * for the group that "equipped readers" (tooling, editors) can read
 * straight from the JSON. Skipped during flattening, so it never
 * becomes a `t()` key and never participates in drift or AI
 * translation. In flat files it is an ordinary key — there are no
 * groups there.
 */
export const CATALOG_GROUP_TITLE_KEY = "i18n_group_title";

/** inlang adds a top-level `$schema`; when ignored, writers copy it from the source into targets that lack it. */
const SCHEMA_KEY = "$schema";

/**
 * Compile `catalog.ignoreKeys` regex strings into one predicate. Each
 * pattern must match the whole dotted key. Throws on an invalid pattern.
 */
export function compileIgnoreKeys(patterns: ReadonlyArray<string>): IgnoreKey | undefined {
  if (patterns.length === 0) return undefined;
  const regexes = patterns.map((pattern) => {
    // Compiling it alone first rejects a pattern like `a)|(.*` that would escape the wrapper.
    new RegExp(pattern);
    return new RegExp(`^(?:${pattern})$`);
  });
  return (key) => regexes.some((regex) => regex.test(key));
}

/**
 * `"nested"` iff any top-level value is an object; otherwise
 * `"flat"`. Ignored keys don't count. Callers validate that `value`
 * is an object first.
 */
export function detectCatalogFormat(value: unknown, ignoreKey?: IgnoreKey | undefined): CatalogFormat {
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (ignoreKey?.(key) === true) continue;
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) return "nested";
  }
  return "flat";
}

/**
 * Flatten a catalog JSON value to a dotted-key `Record<string, string>`.
 * Flat files pass through unchanged (their keys are already the
 * canonical dotted form). Nested groups recurse with `.`-joined
 * prefixes; `i18n_group_title` inside a group is skipped, and so is
 * any key or group path `ignoreKey` matches, whatever its value.
 *
 * Throws on non-string leaves (numbers, arrays, null) and on key
 * collisions (a flat key duplicating a nested path).
 */
export function flattenCatalog(value: unknown, ignoreKey?: IgnoreKey | undefined): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("[polystella] catalog file must be a JSON object.");
  }
  const flat: Record<string, string> = {};
  const walk = (node: Record<string, unknown>, prefix: string): void => {
    for (const [key, entry] of Object.entries(node)) {
      if (key === CATALOG_GROUP_TITLE_KEY && prefix.length > 0 && typeof entry === "string") continue;
      const path = prefix.length > 0 ? `${prefix}.${key}` : key;
      if (ignoreKey?.(path) === true) continue;
      if (typeof entry === "string") {
        if (Object.hasOwn(flat, path)) {
          throw new Error(`[polystella] catalog key "${path}" is defined more than once (nested group and flat key collide).`);
        }
        Object.defineProperty(flat, path, { configurable: true, enumerable: true, value: entry, writable: true });
      } else if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
        walk(entry as Record<string, unknown>, path);
      } else if (Array.isArray(entry)) {
        throw new Error(
          `[polystella] catalog value at "${path}" must be a string or an object of strings (got array). An inlang variant message? Add its key to catalog.ignoreKeys.`,
        );
      } else {
        throw new Error(`[polystella] catalog value at "${path}" must be a string or an object of strings (got ${typeof entry}).`);
      }
    }
  };
  walk(value as Record<string, unknown>, "");
  return flat;
}

export interface FormatNestedLocaleFileOptions {
  dict: Record<string, string>;
  source: Record<string, unknown>;
  existing?: Record<string, unknown> | undefined;
  /** Matching entries are kept from `existing` verbatim and never created (except a top-level `$schema`). */
  ignoreKey?: IgnoreKey | undefined;
}

export function formatNestedLocaleFile(options: FormatNestedLocaleFileOptions): string {
  const blocks: string[] = [];
  let scalarLines: string[] = [];
  const flushScalars = (): void => {
    if (scalarLines.length > 0) blocks.push(scalarLines.join(",\n"));
    scalarLines = [];
  };
  for (const key of schemaFirst(entryKeys(options.source, options.existing), options.ignoreKey)) {
    const rendered = renderEntry(key, key, options.source, options.existing, options.dict, "  ", options.ignoreKey);
    if (rendered === undefined) continue;
    if (!rendered.group) {
      scalarLines.push(rendered.text);
      continue;
    }
    flushScalars();
    blocks.push(rendered.text);
  }
  flushScalars();
  if (blocks.length === 0) return "{}\n";
  return `{\n${blocks.join(",\n\n")}\n}\n`;
}

/**
 * Value an ignored entry keeps: the target's own, else (for a
 * top-level `$schema` only) the source's. `undefined` drops it.
 */
export function keptIgnoredValue(
  key: string,
  path: string,
  source: Record<string, unknown> | undefined,
  existing: Record<string, unknown> | undefined,
): unknown {
  if (existing !== undefined && Object.hasOwn(existing, key)) return existing[key];
  return path === SCHEMA_KEY && source !== undefined && Object.hasOwn(source, key) ? source[key] : undefined;
}

/** Any JSON value as 2-space-indented text whose continuation lines start at `indent`. */
export function renderJsonValue(value: unknown, indent: string): string {
  return JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
}

/** Puts an ignored top-level `$schema` first, where inlang writes it. */
export function schemaFirst(keys: ReadonlyArray<string>, ignoreKey: IgnoreKey | undefined): string[] {
  const unique = [...new Set(keys)];
  return ignoreKey?.(SCHEMA_KEY) === true && unique.includes(SCHEMA_KEY)
    ? [SCHEMA_KEY, ...unique.filter((key) => key !== SCHEMA_KEY)]
    : unique;
}

/** Source keys in order, then target-only keys (kept only when they hold ignored entries). */
function entryKeys(source: Record<string, unknown> | undefined, existing: Record<string, unknown> | undefined): string[] {
  const keys = Object.keys(source ?? {});
  for (const key of Object.keys(existing ?? {})) {
    if (source === undefined || !Object.hasOwn(source, key)) keys.push(key);
  }
  return keys;
}

function renderEntry(
  key: string,
  path: string,
  source: Record<string, unknown> | undefined,
  existing: Record<string, unknown> | undefined,
  dict: Record<string, string>,
  indent: string,
  ignoreKey: IgnoreKey | undefined,
): { text: string; group: boolean } | undefined {
  if (ignoreKey?.(path) === true) {
    const kept = keptIgnoredValue(key, path, source, existing);
    return kept === undefined ? undefined : { text: `${indent}${JSON.stringify(key)}: ${renderJsonValue(kept, indent)}`, group: false };
  }
  const inSource = source !== undefined && Object.hasOwn(source, key);
  const sourceValue = inSource ? source[key] : undefined;
  if (typeof sourceValue === "string") {
    const value = Object.hasOwn(dict, path) ? dict[path] : undefined;
    return value === undefined ? undefined : { text: `${indent}${JSON.stringify(key)}: ${JSON.stringify(value)}`, group: false };
  }
  const existingValue = existing !== undefined && Object.hasOwn(existing, key) ? existing[key] : undefined;
  const sourceGroup = isObject(sourceValue) ? sourceValue : undefined;
  const existingGroup = isObject(existingValue) ? existingValue : undefined;
  if (sourceGroup === undefined && (inSource || existingGroup === undefined)) return undefined;
  const rendered = renderNestedGroup(key, path, sourceGroup, existingGroup, dict, indent, ignoreKey);
  return rendered.length === 0 ? undefined : { text: rendered.join("\n"), group: true };
}

function renderNestedGroup(
  key: string,
  path: string,
  node: Record<string, unknown> | undefined,
  existing: Record<string, unknown> | undefined,
  dict: Record<string, string>,
  indent: string,
  ignoreKey: IgnoreKey | undefined,
): string[] {
  const inner = `${indent}  `;
  const lines = [`${indent}${JSON.stringify(key)}: {`];
  const existingTitle = existing?.[CATALOG_GROUP_TITLE_KEY];
  const sourceTitle = node?.[CATALOG_GROUP_TITLE_KEY];
  const title = typeof existingTitle === "string" ? existingTitle : typeof sourceTitle === "string" ? sourceTitle : undefined;
  if (title !== undefined) lines.push(`${inner}${JSON.stringify(CATALOG_GROUP_TITLE_KEY)}: ${JSON.stringify(title)},`);

  const entries: string[] = [];
  for (const childKey of entryKeys(node, existing)) {
    if (childKey === CATALOG_GROUP_TITLE_KEY) continue;
    const rendered = renderEntry(childKey, `${path}.${childKey}`, node, existing, dict, inner, ignoreKey);
    if (rendered !== undefined) entries.push(rendered.text);
  }
  if (entries.length === 0) return [];
  lines.push(entries.join(",\n"), `${indent}}`);
  return lines;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
