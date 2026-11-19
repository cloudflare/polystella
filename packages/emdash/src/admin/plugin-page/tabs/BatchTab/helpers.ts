import { ApiResponseError, fetchTranslations, publishContent } from "@emdash-cms/admin";

import type { BatchJobView, CollectionPolicyResponse } from "../../../../contracts.js";
import { createTranslatedEntry, translateExistingEntry } from "../../../content-translation.js";
import { panelErrorMessage } from "../../../panels/ContentEditorPanel.js";

export type BatchTargetLocale = CollectionPolicyResponse["targetLocales"][number];

export interface BatchItem {
  id: string;
  title: string;
  slug: string | null;
}

export interface BatchJob {
  item: BatchItem;
  target: BatchTargetLocale;
}

export type BatchOutcome = "created" | "updated" | "skipped" | "failed";

export interface BatchResult extends BatchJob {
  outcome: BatchOutcome;
  message: string | null;
  /** The created, updated, or already existing translation. */
  translation: { id: string; locale: string } | null;
}

export interface BatchJobOptions {
  collection: string;
  sourceLocale: string | undefined;
  fields: readonly string[];
  updateExisting: boolean;
  publish: boolean;
}

export function batchJobDone(job: BatchJobView): number {
  return job.counts.created + job.counts.skipped + job.counts.failed;
}

export function batchJobFinished(job: BatchJobView): boolean {
  return batchJobDone(job) >= job.total;
}

export function planBatchJobs(items: readonly BatchItem[], targets: readonly BatchTargetLocale[]): BatchJob[] {
  return items.flatMap((item) => targets.map((target) => ({ item, target })));
}

/** Older rows may store the catalog code ("fr-FR") instead of the Astro locale path ("fr"). */
export function findExistingTranslation<T extends { locale: string }>(
  translations: readonly T[],
  target: BatchTargetLocale,
): T | undefined {
  const candidates = new Set([target.locale.toLowerCase(), target.code.toLowerCase()]);
  return translations.find((translation) => candidates.has(translation.locale.toLowerCase()));
}

/** Target locales that at least one of the entries has no translation for. */
export async function untranslatedLocales(
  collection: string,
  itemIds: readonly string[],
  targets: readonly BatchTargetLocale[],
  concurrency: number,
): Promise<string[]> {
  const missing = new Set<string>();
  await runBatchJobs(
    itemIds,
    concurrency,
    async (id) => {
      const { translations } = await fetchTranslations(collection, id);
      for (const target of targets) {
        if (findExistingTranslation(translations, target) === undefined) missing.add(target.locale);
      }
    },
    () => missing.size === targets.length,
  );
  return targets.map(({ locale }) => locale).filter((locale) => missing.has(locale));
}

export function entryTitle(entry: { id: string; slug: string | null; data: Record<string, unknown> }): string {
  const title = entry.data.title;
  if (typeof title === "string" && title.trim().length > 0) return title;
  return entry.slug ?? entry.id;
}

/** Workers pull the next job until the list is empty or `shouldStop` turns true; in-flight jobs finish. */
export async function runBatchJobs<T>(
  jobs: readonly T[],
  concurrency: number,
  run: (job: T) => Promise<void>,
  shouldStop: () => boolean,
): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (next < jobs.length && !shouldStop()) {
      const job = jobs[next];
      next += 1;
      if (job !== undefined) await run(job);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
}

/** Never throws: every failure becomes a result row so one bad entry can't stop the batch. */
export async function runBatchJob(job: BatchJob, options: BatchJobOptions): Promise<BatchResult> {
  const { collection, fields } = options;
  let creating = false;
  let translation: BatchResult["translation"] = null;
  try {
    const { translations } = await fetchTranslations(collection, job.item.id);
    const existing = findExistingTranslation(translations, job.target);
    if (existing !== undefined) translation = { id: existing.id, locale: existing.locale };
    if (existing === undefined) {
      creating = true;
      const result = await createTranslatedEntry({
        collection,
        sourceEntryId: job.item.id,
        sourceLocale: options.sourceLocale,
        locale: job.target.locale,
        fields,
      });
      if (result.entry === null) return { ...job, outcome: "failed", message: result.error, translation };
      translation = { id: result.entry.id, locale: result.entry.locale ?? job.target.locale };
      return { ...job, outcome: "created", message: await publishIfAsked(collection, translation, options.publish), translation };
    }
    if (!options.updateExisting) return { ...job, outcome: "skipped", message: "A translation already exists.", translation };
    const result = await translateExistingEntry({ collection, entryId: existing.id, locale: existing.locale, fields });
    if (result.entry === null) return { ...job, outcome: "failed", message: result.error, translation };
    return { ...job, outcome: "updated", message: await publishIfAsked(collection, existing, options.publish), translation };
  } catch (cause) {
    const changedMeanwhile = cause instanceof ApiResponseError && cause.status === 409;
    return {
      ...job,
      outcome: changedMeanwhile ? "skipped" : "failed",
      message: panelErrorMessage(cause, creating ? job.target.locale : undefined),
      translation,
    };
  }
}

/** A failed publish leaves the saved draft in place, so it is reported on the row instead of failing it. */
async function publishIfAsked(collection: string, translation: { id: string; locale: string }, publish: boolean): Promise<string | null> {
  if (!publish) return null;
  try {
    await publishContent(collection, translation.id, { locale: translation.locale });
    return "Published.";
  } catch (cause) {
    return `Saved as a draft; publishing failed: ${panelErrorMessage(cause)}`;
  }
}
