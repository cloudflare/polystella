import { invalidateObjectCache, type StorageCollection } from "emdash";

import { AI_TRANSLATIONS_CACHE_NAMESPACE, translatedFieldsHash } from "../ai-translations.js";
import { isRecord } from "./routes/validators.js";

/**
 * Runs after every save and publish. Removes the AI-translated flag once the translated fields
 * no longer match what PolyStella saved, so a human rewrite stops reading as AI output.
 */
export async function clearEditedAiTranslation(content: Record<string, unknown>, storage: StorageCollection | undefined): Promise<void> {
  const { id, data } = content;
  if (storage === undefined || typeof id !== "string" || !isRecord(data)) return;
  const stored = await storage.getVersioned(id);
  if (stored === null || !isRecord(stored.value)) return;
  const { fields, contentHash } = stored.value;
  if (typeof contentHash !== "string" || !Array.isArray(fields) || !fields.every((field) => typeof field === "string")) return;
  if ((await translatedFieldsHash(data, fields)) === contentHash) return;
  // Conditional, so a hook that runs late can't delete a newer AI translation's record.
  if ((await storage.compareAndDelete(id, stored.revision)).applied) invalidateObjectCache(AI_TRANSLATIONS_CACHE_NAMESPACE);
}
