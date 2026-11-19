import { invalidateObjectCache, type SettingsAccess, type StorageCollection } from "emdash";

import { AI_TRANSLATIONS_CACHE_NAMESPACE, changedFields, readFieldHashes } from "../ai-translations.js";
import { isRecord } from "./routes/validators.js";
import { aiFlagClearsOnEdit } from "./settings-storage.js";

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
