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
