import { ApiResponseError, fetchTranslations } from "@emdash-cms/admin";

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
}

export interface BatchJobOptions {
  collection: string;
  sourceLocale: string | undefined;
  fields: readonly string[];
  updateExisting: boolean;
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
  try {
    const { translations } = await fetchTranslations(collection, job.item.id);
    const existing = findExistingTranslation(translations, job.target);
    if (existing === undefined) {
      creating = true;
      const result = await createTranslatedEntry({
        collection,
        sourceEntryId: job.item.id,
        sourceLocale: options.sourceLocale,
        locale: job.target.locale,
        fields,
      });
      return result.entry === null ? { ...job, outcome: "failed", message: result.error } : { ...job, outcome: "created", message: null };
    }
    if (!options.updateExisting) return { ...job, outcome: "skipped", message: "A translation already exists." };
    const result = await translateExistingEntry({ collection, entryId: existing.id, locale: existing.locale, fields });
    return result.entry === null ? { ...job, outcome: "failed", message: result.error } : { ...job, outcome: "updated", message: null };
  } catch (cause) {
    const changedMeanwhile = cause instanceof ApiResponseError && cause.status === 409;
    return {
      ...job,
      outcome: changedMeanwhile ? "skipped" : "failed",
      message: panelErrorMessage(cause, creating ? job.target.locale : undefined),
    };
  }
}
