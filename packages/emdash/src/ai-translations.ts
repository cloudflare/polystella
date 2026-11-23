export const AI_TRANSLATIONS_COLLECTION = "ai_translations";
/** EmDash object-cache namespace for flag reads; bumped on every record write. */
export const AI_TRANSLATIONS_CACHE_NAMESPACE = "plugin:polystella:ai";

/** Stored per translated entry, keyed by the entry's database id (unique per locale). */
export interface AiTranslationRecord {
  collection: string;
  entryId: string;
  /** Catalog locale code. */
  locale: string;
  model: string;
  aiTranslatedAt: string;
  /**
   * SHA-256 of each field PolyStella wrote, as saved. `null` when the saved draft couldn't be read,
   * so edits can't be detected.
   */
  fieldHashes: Record<string, string> | null;
}

/**
 * A translation patched into an open editor but not saved yet, keyed by entry id. A save that
 * changes a field from its `baseline` (the saved hash before the patch) confirms that field into
 * the {@link AiTranslationRecord}, so a save of other values, such as SEO, doesn't.
 */
export const AI_TRANSLATION_PENDING_COLLECTION = "ai_translation_pending";

export interface PendingAiTranslation extends Omit<AiTranslationRecord, "fieldHashes"> {
  fields: string[];
  baseline: Record<string, string>;
}

export function readPendingAiTranslation(value: unknown): PendingAiTranslation | null {
  if (typeof value !== "object" || value === null) return null;
  const record: Record<string, unknown> = { ...value };
  const { collection, entryId, locale, model, aiTranslatedAt, fields } = record;
  const baseline = readFieldHashes(record.baseline);
  if (
    typeof collection !== "string" ||
    typeof entryId !== "string" ||
    typeof locale !== "string" ||
    typeof model !== "string" ||
    typeof aiTranslatedAt !== "string" ||
    !Array.isArray(fields) ||
    !fields.every((field): field is string => typeof field === "string") ||
    baseline === null
  ) {
    return null;
  }
  return { collection, entryId, locale, model, aiTranslatedAt, fields, baseline };
}

export async function hashFields(data: Record<string, unknown>, fields: readonly string[]): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(fields.map(async (field) => [field, await hashValue(data[field] ?? null)] as const)));
}

/** Fields whose saved value no longer matches the hash PolyStella stored. */
export async function changedFields(data: Record<string, unknown>, hashes: Readonly<Record<string, string>>): Promise<string[]> {
  const current = await hashFields(data, Object.keys(hashes));
  return Object.keys(hashes)
    .filter((field) => current[field] !== hashes[field])
    .sort();
}

/** This run's fields, plus fields an earlier AI run wrote that nobody has changed since. */
export async function mergedFieldHashes(
  data: Record<string, unknown>,
  fields: readonly string[],
  previous: Readonly<Record<string, string>> | null,
): Promise<Record<string, string>> {
  const untouched: Record<string, string> = {};
  if (previous !== null) {
    const changed = new Set(await changedFields(data, previous));
    for (const [field, hash] of Object.entries(previous)) if (!changed.has(field)) untouched[field] = hash;
  }
  return { ...untouched, ...(await hashFields(data, fields)) };
}

export function readFieldHashes(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  return entries.every(([, hash]) => typeof hash === "string") ? Object.fromEntries(entries) : null;
}

// Independent of object key order, so a re-serialised but unchanged value keeps its hash.
async function hashValue(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableJson(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** What themes read on `entry.polystella`. */
export interface PolystellaEntryMeta {
  aiTranslated: boolean;
  aiTranslatedAt: string | null;
  aiTranslationModel: string | null;
}

export const NOT_AI_TRANSLATED: PolystellaEntryMeta = { aiTranslated: false, aiTranslatedAt: null, aiTranslationModel: null };

export function entryMeta(record: unknown): PolystellaEntryMeta {
  if (typeof record !== "object" || record === null || !("aiTranslatedAt" in record) || !("model" in record)) return NOT_AI_TRANSLATED;
  const { aiTranslatedAt, model } = record;
  if (typeof aiTranslatedAt !== "string" || typeof model !== "string") return NOT_AI_TRANSLATED;
  return { aiTranslated: true, aiTranslatedAt, aiTranslationModel: model };
}
