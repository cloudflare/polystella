import {
  cachedQuery,
  getEmDashCollection,
  getEmDashEntry,
  getRequestContext,
  hashString,
  PluginStorageRepository,
  type CollectionFilter,
  type CollectionResult,
  type ContentEntry,
  type EntryResult,
  type InferCollectionData,
  type SelectableReferences,
  type SelectedReferences,
} from "emdash";

import {
  AI_TRANSLATIONS_CACHE_NAMESPACE,
  AI_TRANSLATIONS_COLLECTION,
  entryMeta,
  NOT_AI_TRANSLATED,
  type PolystellaEntryMeta,
} from "./ai-translations.js";
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
  const flags = await loadFlags([entryId]);
  return { ...result, entry: { ...result.entry, polystella: flagFor(flags, entryId) } };
}

/** `getEmDashCollection` plus `entry.polystella` on every entry, read and cached as one unit per page. */
export async function getEnrichedCollection<T extends string, D = InferCollectionData<T>>(
  type: T,
  filter?: CollectionFilter,
): Promise<EnrichedCollectionResult<D>> {
  const result = await getEmDashCollection<T, D>(type, filter);
  const flags = await loadFlags(result.entries.map(databaseId));
  return { ...result, entries: result.entries.map((entry) => ({ ...entry, polystella: flagFor(flags, databaseId(entry)) })) };
}

/** `entry.id` is the slug; EmDash keeps the database id on `entry.data.id`. */
function databaseId(entry: { id: string; data: unknown }): string {
  const data = entry.data;
  return typeof data === "object" && data !== null && "id" in data && typeof data.id === "string" ? data.id : entry.id;
}

type Flags = Record<string, PolystellaEntryMeta>;

const requestReads = new WeakMap<object, Map<string, Promise<Flags>>>();

function flagFor(flags: Flags, id: string): PolystellaEntryMeta {
  return Object.hasOwn(flags, id) ? (flags[id] ?? NOT_AI_TRANSLATED) : NOT_AI_TRANSLATED;
}

/** One read per request and cache key: a single entry is keyed by its id, a page of entries by a hash of its ids. */
async function loadFlags(entryIds: readonly string[]): Promise<Flags> {
  const ids = [...new Set(entryIds)].sort();
  const [first] = ids;
  if (first === undefined) return {};
  // KV keys are capped at 512 bytes, so lists are hashed.
  const key = ids.length === 1 ? `entry:${first}` : `list:${await hashString(ids.join(","))}`;
  const request = getRequestContext();
  let reads = request === undefined ? undefined : requestReads.get(request);
  if (request !== undefined && reads === undefined) {
    reads = new Map();
    requestReads.set(request, reads);
  }
  const pending = reads?.get(key);
  if (pending !== undefined) return pending;
  const read = readFlags(key, ids);
  reads?.set(key, read);
  return read;
}

async function readFlags(key: string, ids: string[]): Promise<Flags> {
  try {
    // A failed load throws before `cachedQuery` stores anything, so errors are never cached.
    return await cachedQuery<Flags>({
      namespace: AI_TRANSLATIONS_CACHE_NAMESPACE,
      key,
      load: async () => {
        // Loaded lazily: `emdash/runtime` only resolves inside an EmDash site build.
        const { getDb } = await import("emdash/runtime");
        const storage = new PluginStorageRepository<unknown>(await getDb(), POLYSTELLA_PLUGIN_ID, AI_TRANSLATIONS_COLLECTION, ["locale"]);
        const records = await storage.getMany(ids);
        return Object.fromEntries(ids.map((id) => [id, entryMeta(records.get(id))]));
      },
    });
  } catch (error) {
    // A missing flag must never break the page; entries read as not AI-translated.
    console.error(
      `[polystella-emdash] AI translation flags unavailable; treating entries as human-written (${error instanceof Error ? error.name : typeof error})`,
    );
    return {};
  }
}
