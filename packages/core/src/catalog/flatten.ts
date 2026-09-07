export type CatalogFormat = "flat" | "nested";

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
        flat[path] = entry;
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
