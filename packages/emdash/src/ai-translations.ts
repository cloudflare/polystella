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
  /** The collection's translatable fields when the record was written. */
  fields: string[];
  /** `translatedFieldsHash` of those fields as saved; `null` when the saved draft couldn't be read, which disables auto-clearing. */
  contentHash: string | null;
}

/** SHA-256 of the given fields' saved values, independent of object key order. */
export async function translatedFieldsHash(data: Record<string, unknown>, fields: readonly string[]): Promise<string> {
  const values = [...fields].sort().map((field) => [field, data[field] ?? null]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableJson(values)));
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
