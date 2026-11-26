import type { CatalogEntryView, CatalogGroupView } from "../../../../contracts.js";
import type { CatalogGroup } from "../../../types.js";

export function catalogOverrideChanged(originalValue: string | null, enabled: boolean, value: string): boolean {
  return enabled ? value !== originalValue : originalValue !== null;
}

export function groupCatalogEntries(entries: readonly CatalogEntryView[], groups: readonly CatalogGroupView[]): CatalogGroup[] {
  const titleByKey = new Map(groups.map((group) => [group.key, group.title]));
  const grouped = new Map<string, CatalogEntryView[]>();
  for (const entry of entries) {
    const key = entry.key.split(".", 1)[0] ?? entry.key;
    const list = grouped.get(key);
    if (list === undefined) grouped.set(key, [entry]);
    else list.push(entry);
  }
  return [...grouped]
    .map(([key, groupEntries]) => ({ key, title: titleByKey.get(key) ?? null, entries: groupEntries }))
    .sort((a, b) => (a.title ?? a.key).localeCompare(b.title ?? b.key, undefined, { sensitivity: "base" }));
}

/** A group whose key or title matches keeps every entry; otherwise only its matching entries stay. */
export function filterCatalogGroups(groups: readonly CatalogGroup[], query: string): CatalogGroup[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...groups];
  return groups.flatMap((group) => {
    if (group.key.toLowerCase().includes(needle) || (group.title ?? "").toLowerCase().includes(needle)) return [group];
    const entries = group.entries.filter(
      (entry) => entry.key.toLowerCase().includes(needle) || (entry.source ?? "").toLowerCase().includes(needle),
    );
    return entries.length === 0 ? [] : [{ ...group, entries }];
  });
}

/** "a, b, c, d, e and 3 more". */
export function listKeys(keys: readonly string[], max = 5): string {
  return keys.length <= max ? keys.join(", ") : `${keys.slice(0, max).join(", ")} and ${keys.length - max} more`;
}

export function shortenText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Why some catalog actions are disabled right now, in one line; `null` when nothing needs explaining. */
export function catalogActionHint({
  unsaved,
  selected,
  isDefaultLocale,
  hasSynced,
}: {
  unsaved: number;
  selected: number;
  isDefaultLocale: boolean;
  hasSynced: boolean;
}): string | null {
  const hints = [
    unsaved > 0 ? "Save or discard your changes to switch locale, export, clear, or apply overrides." : null,
    isDefaultLocale
      ? "This is the source locale, so nothing can be generated; pick another locale."
      : selected === 0
        ? "Select keys to generate."
        : null,
    unsaved === 0 && !hasSynced ? "No synced overrides to clear." : null,
  ].filter((hint) => hint !== null);
  return hints.length === 0 ? null : hints.join(" ");
}

export function sourceContainsTokens(source: string | null, messageSyntax: "polystella" | "icu" = "polystella"): boolean {
  if (source === null) return false;
  return messageSyntax === "icu" ? /\{\s*[\p{L}\p{N}_]/u.test(source) : source.includes("{{");
}

/** `title` for `ai_translation_notice.title` in the `ai_translation_notice` group; the group already names the prefix. */
export function keyWithinGroup(key: string, group: string): string {
  return key.startsWith(`${group}.`) && key.length > group.length + 1 ? key.slice(group.length + 1) : key;
}
