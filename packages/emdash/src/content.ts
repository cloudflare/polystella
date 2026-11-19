import {
  getEmDashCollection,
  getEmDashEntry,
  PluginStorageRepository,
  type CollectionFilter,
  type CollectionResult,
  type ContentEntry,
  type EntryResult,
  type InferCollectionData,
  type SelectableReferences,
  type SelectedReferences,
} from "emdash";

import { AI_TRANSLATIONS_COLLECTION, entryMeta, type PolystellaEntryMeta } from "./ai-translations.js";
import { POLYSTELLA_PLUGIN_ID } from "./contracts.js";

export { NOT_AI_TRANSLATED, type PolystellaEntryMeta } from "./ai-translations.js";

export type EnrichedEntry<E> = E & { polystella: PolystellaEntryMeta };

export type EnrichedEntryResult<D, R> = Omit<EntryResult<D, R>, "entry"> & { entry: EnrichedEntry<ContentEntry<D, R>> | null };

export type EnrichedCollectionResult<D> = Omit<CollectionResult<D>, "entries"> & { entries: Array<EnrichedEntry<ContentEntry<D>>> };

/** `getEmDashEntry` plus `entry.polystella`, which says whether PolyStella's AI wrote the entry. */
export async function getEnrichedEntry<T extends string, D = InferCollectionData<T>, S extends SelectableReferences<T> = {}>(
  type: T,
  id: string,
  options?: { locale?: string; references?: S },
): Promise<EnrichedEntryResult<D, SelectedReferences<T, S>>> {
  const result = await getEmDashEntry<T, D, S>(type, id, options);
  if (result.entry === null) return { ...result, entry: null };
  const entryId = databaseId(result.entry);
  const records = await loadAiTranslations([entryId]);
  return { ...result, entry: { ...result.entry, polystella: entryMeta(records.get(entryId)) } };
}

/** `getEmDashCollection` plus `entry.polystella` on every entry, read in one storage query per page. */
export async function getEnrichedCollection<T extends string, D = InferCollectionData<T>>(
  type: T,
  filter?: CollectionFilter,
): Promise<EnrichedCollectionResult<D>> {
  const result = await getEmDashCollection<T, D>(type, filter);
  const records = await loadAiTranslations(result.entries.map(databaseId));
  return { ...result, entries: result.entries.map((entry) => ({ ...entry, polystella: entryMeta(records.get(databaseId(entry))) })) };
}

/** `entry.id` is the slug; EmDash keeps the database id on `entry.data.id`. */
function databaseId(entry: { id: string; data: unknown }): string {
  const data = entry.data;
  return typeof data === "object" && data !== null && "id" in data && typeof data.id === "string" ? data.id : entry.id;
}

// shortcut: one uncached read per call; add per-request dedupe or `cachedQuery` if pages call this many times.
async function loadAiTranslations(ids: string[]): Promise<Map<string, unknown>> {
  if (ids.length === 0) return new Map();
  try {
    // Loaded lazily: `emdash/runtime` only resolves inside an EmDash site build.
    const { getDb } = await import("emdash/runtime");
    const storage = new PluginStorageRepository<unknown>(await getDb(), POLYSTELLA_PLUGIN_ID, AI_TRANSLATIONS_COLLECTION, ["locale"]);
    return await storage.getMany(ids);
  } catch (error) {
    // A missing flag must never break the page; entries read as not AI-translated.
    console.error(
      `[polystella-emdash] AI translation flags unavailable; treating entries as human-written (${error instanceof Error ? error.name : typeof error})`,
    );
    return new Map();
  }
}
