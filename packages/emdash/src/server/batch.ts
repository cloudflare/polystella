import { PluginRouteError, type StorageCollection } from "emdash";

import type { BatchJobOutcome, BatchTranslationLink } from "../contracts.js";

// Cloudflare Queues accept at most 100 messages per sendBatch call.
const QUEUE_SEND_LIMIT = 100;
const OUTCOMES = new Set<string>(["created", "skipped", "failed"]);
export const MAX_BATCH_MESSAGE_CHARACTERS = 1000;

export interface StoredBatchJob {
  collection: string;
  /** Catalog locale codes. */
  locales: string[];
  total: number;
  status: "running" | "cancelled";
  /** Publish each created translation instead of leaving it as a draft. */
  publish: boolean;
  createdAt: string;
  createdBy: string | null;
  /** The next page of source entries for a whole-collection job; `null` once every entry is queued. */
  listing: BatchListing | null;
  /** Listing stopped at `MAX_BATCH_TRANSLATIONS`, so later entries were not queued. */
  truncated: boolean;
  /** The selected source entries; `"all"` for a whole-collection job, `null` for jobs stored before this was recorded. */
  entryIds: string[] | "all" | null;
}

export interface BatchListing {
  page: number;
  cursor: string | null;
}

/** Asks the consumer to list and queue one page of a whole-collection job. */
export interface BatchListMessage {
  kind: "list";
  jobId: string;
  page: number;
}

export interface StoredBatchResult {
  jobId: string;
  entryId: string;
  locale: string;
  outcome: BatchJobOutcome;
  message: string | null;
  /** Rows recorded before links existed have none. */
  translation: BatchTranslationLink | null;
  updatedAt: string;
}

/** One source entry × target locale. `locale` is a catalog locale code. */
export interface BatchMessage {
  jobId: string;
  entryId: string;
  locale: string;
}

/** What the queue consumer passes to `runtime.handleContentCreate`. */
export interface BatchCreatePayload {
  collection: string;
  data: Record<string, unknown>;
  slug: string | null;
  locale: string;
  translationOf: string;
  authorId?: string;
}

export interface BatchTranslateResponse {
  create: BatchCreatePayload | null;
  publish?: boolean;
}

export interface BatchQueue {
  sendBatch(messages: Array<{ body: BatchMessage | BatchListMessage }>): Promise<unknown>;
}

/** Deletes a job's result rows, then the job. The translations it created stay. */
export async function deleteBatchJob(jobs: StorageCollection, results: StorageCollection, jobId: string): Promise<void> {
  for (;;) {
    const page = await results.query({ where: { jobId }, limit: 100 });
    if (page.items.length === 0 || (await results.deleteMany(page.items.map(({ id }) => id))) === 0) break;
  }
  await jobs.delete(jobId);
}

export const BATCH_JOB_MAX_AGE_DAYS = 30;
// A few per call keeps the jobs listing fast; it is polled, so older backlogs drain over later calls.
const EXPIRED_JOBS_PER_CALL = 3;

/**
 * Deletes jobs created more than 30 days ago, whatever their status: queue messages are
 * kept for at most 14 days, so nothing can still record into them.
 */
export async function deleteExpiredBatchJobs(jobs: StorageCollection, results: StorageCollection, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - BATCH_JOB_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const expired = await jobs.query({ where: { createdAt: { lt: cutoff } }, limit: EXPIRED_JOBS_PER_CALL });
  for (const { id } of expired.items) await deleteBatchJob(jobs, results, id);
}

export function batchResultId(message: BatchMessage): string {
  return JSON.stringify([message.jobId, message.entryId, message.locale]);
}

export function readBatchListMessage(value: unknown): BatchListMessage | null {
  if (!isRecord(value) || value.kind !== "list") return null;
  const { jobId, page } = value;
  return isNonEmptyString(jobId) && Number.isSafeInteger(page) && typeof page === "number" && page >= 0
    ? { kind: "list", jobId, page }
    : null;
}

function readListing(value: unknown): BatchListing | null {
  if (!isRecord(value)) return null;
  const { page, cursor } = value;
  if (typeof page !== "number" || !Number.isSafeInteger(page) || page < 0 || (cursor !== null && typeof cursor !== "string")) return null;
  return { page, cursor };
}

export function readBatchMessage(value: unknown): BatchMessage | null {
  if (!isRecord(value)) return null;
  const { jobId, entryId, locale } = value;
  return isNonEmptyString(jobId) && isNonEmptyString(entryId) && isNonEmptyString(locale) ? { jobId, entryId, locale } : null;
}

export function parseStoredJob(value: unknown): StoredBatchJob | null {
  if (!isRecord(value)) return null;
  const { collection, locales, total, status, publish, createdAt, createdBy, listing, truncated, entryIds } = value;
  if (
    !isNonEmptyString(collection) ||
    !Array.isArray(locales) ||
    !locales.every(isNonEmptyString) ||
    typeof total !== "number" ||
    (status !== "running" && status !== "cancelled") ||
    typeof createdAt !== "string" ||
    (createdBy !== null && typeof createdBy !== "string")
  ) {
    return null;
  }
  // Jobs stored before `publish` existed created drafts.
  return {
    collection,
    locales,
    total,
    status,
    publish: publish === true,
    createdAt,
    createdBy,
    listing: readListing(listing),
    truncated: truncated === true,
    entryIds: entryIds === "all" ? "all" : Array.isArray(entryIds) && entryIds.every(isNonEmptyString) ? entryIds : null,
  };
}

export function parseStoredResult(value: unknown): StoredBatchResult | null {
  if (!isRecord(value)) return null;
  const { jobId, entryId, locale, outcome, message, translation, updatedAt } = value;
  if (
    !isNonEmptyString(jobId) ||
    !isNonEmptyString(entryId) ||
    !isNonEmptyString(locale) ||
    typeof outcome !== "string" ||
    !OUTCOMES.has(outcome) ||
    (message !== null && typeof message !== "string") ||
    typeof updatedAt !== "string"
  ) {
    return null;
  }
  return { jobId, entryId, locale, outcome: outcome as BatchJobOutcome, message, translation: readTranslationLink(translation), updatedAt };
}

export async function readBatchJob(storage: StorageCollection, jobId: string): Promise<StoredBatchJob | null> {
  return parseStoredJob(await storage.get(jobId));
}

export async function recordBatchResult(
  storage: StorageCollection,
  message: BatchMessage,
  outcome: BatchJobOutcome,
  detail: string | null,
  now: Date,
  translation: BatchTranslationLink | null = null,
): Promise<void> {
  const row: StoredBatchResult = { ...message, outcome, message: detail, translation, updatedAt: now.toISOString() };
  await storage.put(batchResultId(message), row);
}

export function batchQueue(binding: string | undefined, env: Record<string, unknown> | undefined): BatchQueue {
  if (binding === undefined) throw PluginRouteError.badRequest("server-side batch translation is not configured (batchQueueBinding)");
  const queue = env?.[binding];
  if (!isBatchQueue(queue)) {
    throw new PluginRouteError("BATCH_QUEUE_UNAVAILABLE", "PolyStella's batch queue binding is unavailable", 503);
  }
  return queue;
}

export async function enqueueBatchMessages(queue: BatchQueue, messages: ReadonlyArray<BatchMessage | BatchListMessage>): Promise<void> {
  for (let start = 0; start < messages.length; start += QUEUE_SEND_LIMIT) {
    await queue.sendBatch(messages.slice(start, start + QUEUE_SEND_LIMIT).map((body) => ({ body })));
  }
}

export function readTranslationLink(value: unknown): BatchTranslationLink | null {
  if (!isRecord(value)) return null;
  const { id, locale, slug, published } = value;
  if (!isNonEmptyString(id) || !isNonEmptyString(locale) || (slug !== null && typeof slug !== "string") || typeof published !== "boolean") {
    return null;
  }
  return { id, locale, slug, published };
}

function isBatchQueue(value: unknown): value is BatchQueue {
  return typeof value === "object" && value !== null && "sendBatch" in value && typeof value.sendBatch === "function";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
