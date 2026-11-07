import { PluginRouteError, type StorageCollection } from "emdash";

import type { BatchJobOutcome } from "../contracts.js";

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
  createdAt: string;
  createdBy: string | null;
}

// shortcut: job and result rows are never deleted; add a cleanup route or cron once sites run many large jobs.
export interface StoredBatchResult {
  jobId: string;
  entryId: string;
  locale: string;
  outcome: BatchJobOutcome;
  message: string | null;
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
}

export interface BatchQueue {
  sendBatch(messages: Array<{ body: BatchMessage }>): Promise<unknown>;
}

export function batchResultId(message: BatchMessage): string {
  return JSON.stringify([message.jobId, message.entryId, message.locale]);
}

export function readBatchMessage(value: unknown): BatchMessage | null {
  if (!isRecord(value)) return null;
  const { jobId, entryId, locale } = value;
  return isNonEmptyString(jobId) && isNonEmptyString(entryId) && isNonEmptyString(locale) ? { jobId, entryId, locale } : null;
}

export function parseStoredJob(value: unknown): StoredBatchJob | null {
  if (!isRecord(value)) return null;
  const { collection, locales, total, status, createdAt, createdBy } = value;
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
  return { collection, locales, total, status, createdAt, createdBy };
}

export function parseStoredResult(value: unknown): StoredBatchResult | null {
  if (!isRecord(value)) return null;
  const { jobId, entryId, locale, outcome, message, updatedAt } = value;
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
  return { jobId, entryId, locale, outcome: outcome as BatchJobOutcome, message, updatedAt };
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
): Promise<void> {
  const row: StoredBatchResult = { ...message, outcome, message: detail, updatedAt: now.toISOString() };
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

export async function enqueueBatchMessages(queue: BatchQueue, messages: readonly BatchMessage[]): Promise<void> {
  for (let start = 0; start < messages.length; start += QUEUE_SEND_LIMIT) {
    await queue.sendBatch(messages.slice(start, start + QUEUE_SEND_LIMIT).map((body) => ({ body })));
  }
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
