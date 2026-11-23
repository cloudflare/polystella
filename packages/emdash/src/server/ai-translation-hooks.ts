import { invalidateObjectCache, type SettingsAccess, type StorageCollection } from "emdash";

import {
  AI_TRANSLATIONS_CACHE_NAMESPACE,
  changedFields,
  hashFields,
  readFieldHashes,
  readPendingAiTranslation,
  type AiTranslationRecord,
} from "../ai-translations.js";
import { isRecord } from "./routes/validators.js";
import { aiFlagClearsOnEdit } from "./settings-storage.js";

// A patch nobody saved within an hour is dropped, so a much later edit can't confirm it.
const PENDING_TTL_MS = 60 * 60 * 1000;

/**
 * Runs after every save, before {@link clearEditedAiTranslation}. Confirms each pending field the
 * save changed from its baseline, hashing it as saved, and keeps the rest pending.
 */
export async function confirmPendingAiTranslation(
  content: Record<string, unknown>,
  pending: StorageCollection | undefined,
  storage: StorageCollection | undefined,
  now: Date = new Date(),
): Promise<void> {
  const { id, data } = content;
  if (pending === undefined || storage === undefined || typeof id !== "string" || !isRecord(data)) return;
  const stored = await pending.getVersioned(id);
  if (stored === null) return;
  const record = readPendingAiTranslation(stored.value);
  if (record === null || !(now.getTime() - Date.parse(record.aiTranslatedAt) <= PENDING_TTL_MS)) {
    await pending.compareAndDelete(id, stored.revision);
    return;
  }
  // A co-editing room's save may hold only the fields it changed.
  const present = record.fields.filter((field) => Object.hasOwn(data, field));
  const current = await hashFields(data, present);
  const confirmed = present.filter((field) => current[field] !== record.baseline[field]);
  if (confirmed.length === 0) return;
  const remaining = record.fields.filter((field) => !confirmed.includes(field));
  // Conditional, so two saves at once confirm a field only once.
  const result =
    remaining.length === 0
      ? await pending.compareAndDelete(id, stored.revision)
      : await pending.compareAndSet(id, stored.revision, { ...record, fields: remaining });
  if (!result.applied) return;
  const previous = await storage.get(id);
  const { fields: _fields, baseline: _baseline, ...meta } = record;
  // Earlier hashes stay, even of edited or missing fields, so the edit check that runs next still sees edits.
  const previousHashes = isRecord(previous) ? readFieldHashes(previous.fieldHashes) : null;
  await storage.put(id, {
    ...meta,
    fieldHashes: { ...previousHashes, ...(await hashFields(data, confirmed)) },
  } satisfies AiTranslationRecord);
  invalidateObjectCache(AI_TRANSLATIONS_CACHE_NAMESPACE);
}

/**
 * Runs after every save and publish. When the administrator opted in, removes the AI-translated
 * flag once an AI-written field is saved with other text.
 */
export async function clearEditedAiTranslation(
  content: Record<string, unknown>,
  storage: StorageCollection | undefined,
  settings: SettingsAccess,
): Promise<void> {
  const { id, data } = content;
  if (storage === undefined || typeof id !== "string" || !isRecord(data)) return;
  const stored = await storage.getVersioned(id);
  if (stored === null || !isRecord(stored.value)) return;
  const hashes = readFieldHashes(stored.value.fieldHashes);
  if (hashes === null || (await changedFields(data, hashes)).length === 0) return;
  if (!(await aiFlagClearsOnEdit(settings))) return;
  // Conditional, so a hook that runs late can't delete a newer AI translation's record.
  if ((await storage.compareAndDelete(id, stored.revision)).applied) invalidateObjectCache(AI_TRANSLATIONS_CACHE_NAMESPACE);
}
