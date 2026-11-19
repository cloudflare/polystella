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
