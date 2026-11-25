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

export function filterCatalogGroups(groups: readonly CatalogGroup[], query: string): CatalogGroup[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...groups];
  return groups.filter(
    (group) =>
      group.key.toLowerCase().includes(needle) ||
      (group.title ?? "").toLowerCase().includes(needle) ||
      group.entries.some((entry) => entry.key.toLowerCase().includes(needle) || (entry.source ?? "").toLowerCase().includes(needle)),
  );
}

export function sourceContainsTokens(source: string | null, messageSyntax: "polystella" | "icu" = "polystella"): boolean {
  if (source === null) return false;
  return messageSyntax === "icu" ? /\{\s*[\p{L}\p{N}_]/u.test(source) : source.includes("{{");
}

/** `title` for `ai_translation_notice.title` in the `ai_translation_notice` group; the group already names the prefix. */
export function keyWithinGroup(key: string, group: string): string {
  return key.startsWith(`${group}.`) && key.length > group.length + 1 ? key.slice(group.length + 1) : key;
}
