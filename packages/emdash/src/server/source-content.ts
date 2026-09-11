import { ContentRepository, type ContentItem } from "emdash";
import { getDb } from "emdash/runtime";

export async function findSourceContentItem(collection: string, targetId: string, sourceLocale: string): Promise<ContentItem | null> {
  try {
    const db = await getDb();
    const repository = new ContentRepository(db);
    const target = await repository.findById(collection, targetId);
    if (target === null || target.translationGroup === null) return null;
    const siblings = await repository.findTranslations(collection, target.translationGroup);
    return siblings.find((item) => item.locale === sourceLocale) ?? null;
  } catch {
    return null;
  }
}