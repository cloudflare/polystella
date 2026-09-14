export type CatalogFormat = "flat" | "nested";

export interface CatalogSource {
  readonly [key: string]: string | CatalogSource;
}

/**
 * Reserved metadata key inside nested groups. Holds a display title
 * for the group that "equipped readers" (tooling, editors) can read
 * straight from the JSON. Skipped during flattening, so it never
 * becomes a `t()` key and never participates in drift or AI
 * translation. In flat files it is an ordinary key — there are no
 * groups there.
 */
export const CATALOG_GROUP_TITLE_KEY = "i18n_group_title";

/**
 * `"nested"` iff any top-level value is an object; otherwise
 * `"flat"`. Callers validate that `value` is an object first.
 */
export function detectCatalogFormat(value: unknown): CatalogFormat {
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) return "nested";
  }
  return "flat";
}

/**
 * Flatten a catalog JSON value to a dotted-key `Record<string, string>`.
 * Flat files pass through unchanged (their keys are already the
 * canonical dotted form). Nested groups recurse with `.`-joined
 * prefixes; `i18n_group_title` inside a group is skipped.
 *
 * Throws on non-string leaves (numbers, arrays, null) and on key
 * collisions (a flat key duplicating a nested path).
 */
export function flattenCatalog(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("[polystella] catalog file must be a JSON object.");
  }
  const flat: Record<string, string> = {};
  const walk = (node: Record<string, unknown>, prefix: string): void => {
    for (const [key, entry] of Object.entries(node)) {
      if (key === CATALOG_GROUP_TITLE_KEY && prefix.length > 0 && typeof entry === "string") continue;
      const path = prefix.length > 0 ? `${prefix}.${key}` : key;
      if (typeof entry === "string") {
        if (Object.hasOwn(flat, path)) {
          throw new Error(`[polystella] catalog key "${path}" is defined more than once (nested group and flat key collide).`);
        }
        Object.defineProperty(flat, path, { configurable: true, enumerable: true, value: entry, writable: true });
      } else if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
        walk(entry as Record<string, unknown>, path);
      } else {
        throw new Error(
          `[polystella] catalog value at "${path}" must be a string or an object of strings (got ${Array.isArray(entry) ? "array" : typeof entry}).`,
        );
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
}

export function formatNestedLocaleFile(options: FormatNestedLocaleFileOptions): string {
  const blocks: string[] = [];
  let scalarLines: string[] = [];
  const flushScalars = (): void => {
    if (scalarLines.length > 0) blocks.push(scalarLines.join(",\n"));
    scalarLines = [];
  };
  for (const [groupKey, groupValue] of Object.entries(options.source)) {
    if (typeof groupValue === "string") {
      const value = options.dict[groupKey];
      if (value !== undefined) scalarLines.push(`  ${JSON.stringify(groupKey)}: ${JSON.stringify(value)}`);
      continue;
    }
    if (!isObject(groupValue)) continue;
    flushScalars();
    const existingValue = options.existing?.[groupKey];
    const existingGroup = isObject(existingValue) ? existingValue : undefined;
    const rendered = renderNestedGroup(groupKey, groupKey, groupValue, existingGroup, options.dict, "  ");
    if (rendered.length > 0) blocks.push(rendered.join("\n"));
  }
  flushScalars();
  if (blocks.length === 0) return "{}\n";
  return `{\n${blocks.join(",\n\n")}\n}\n`;
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
  const lines = [`${indent}${JSON.stringify(key)}: {`];
  const existingTitle = existing?.[CATALOG_GROUP_TITLE_KEY];
  const title =
    typeof existingTitle === "string"
      ? existingTitle
      : typeof node[CATALOG_GROUP_TITLE_KEY] === "string"
        ? node[CATALOG_GROUP_TITLE_KEY]
        : undefined;
  if (title !== undefined) lines.push(`${inner}${JSON.stringify(CATALOG_GROUP_TITLE_KEY)}: ${JSON.stringify(title)},`);

  const entries: string[] = [];
  for (const [childKey, childValue] of Object.entries(node)) {
    if (childKey === CATALOG_GROUP_TITLE_KEY) continue;
    const childPath = `${path}.${childKey}`;
    if (typeof childValue === "string") {
      const value = dict[childPath];
      if (value !== undefined) entries.push(`${inner}${JSON.stringify(childKey)}: ${JSON.stringify(value)}`);
    } else if (isObject(childValue)) {
      const existingChild = existing?.[childKey];
      const nested = renderNestedGroup(childKey, childPath, childValue, isObject(existingChild) ? existingChild : undefined, dict, inner);
      if (nested.length > 0) entries.push(nested.join("\n"));
    }
  }
  if (entries.length === 0) return [];
  lines.push(entries.join(",\n"), `${indent}}`);
  return lines;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
