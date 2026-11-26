import { POLYSTELLA_PLUGIN_ID, type BatchTranslationLink } from "./contracts.js";
import {
  MAX_BATCH_MESSAGE_CHARACTERS,
  readBatchListMessage,
  readBatchMessage,
  readTranslationLink,
  type BatchCreatePayload,
  type BatchMessage,
  type BatchUpdatePayload,
} from "./server/batch.js";

const UPDATE_RECORD_ATTEMPTS = 3;

/** The parts of a Cloudflare Queues `Message` the consumer uses. */
export interface PolystellaQueueMessage {
  readonly id: string;
  readonly body: unknown;
  ack(): void;
  retry(): void;
}

export interface PolystellaQueueBatch {
  readonly messages: readonly PolystellaQueueMessage[];
}

/** The parts of EmDash's runtime the consumer uses. */
export interface PolystellaBatchRuntime {
  handlePluginApiRoute(
    pluginId: string,
    method: string,
    path: string,
    request: Request,
  ): Promise<{ success: boolean; data?: unknown; error?: { code: string; message: string } | undefined }>;
  handleContentCreate(
    collection: string,
    body: Omit<BatchCreatePayload, "collection">,
  ): Promise<{ success: true; data?: { item: { id: string } } } | { success: false; error: { code: string; message: string } }>;
  handleContentPublish(
    collection: string,
    id: string,
  ): Promise<{ success: true } | { success: false; error?: { code: string; message: string } | undefined }>;
  handleContentGet(
    collection: string,
    id: string,
    locale?: string,
  ): Promise<
    { success: true; data?: { _rev?: string | undefined } } | { success: false; error?: { code: string; message: string } | undefined }
  >;
  handleContentUpdate(
    collection: string,
    id: string,
    body: { data: Record<string, unknown>; _rev: string; locale: string },
  ): Promise<{ success: true } | { success: false; error: { code: string; message: string } }>;
}

/**
 * Queue consumer for PolyStella batch jobs. Export it as the Worker's `queue` handler:
 * `export default { ...worker, queue: handlePolystellaBatchQueue }`.
 */
export async function handlePolystellaBatchQueue(batch: PolystellaQueueBatch): Promise<void> {
  // Loaded lazily: `emdash/middleware` only resolves inside an EmDash site build.
  const { withEmDashRuntime } = await import("emdash/middleware");
  await withEmDashRuntime((runtime) => processPolystellaBatch(batch, runtime));
}

export async function processPolystellaBatch(batch: PolystellaQueueBatch, runtime: PolystellaBatchRuntime): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processMessage(runtime, message.body);
      message.ack();
    } catch (error) {
      console.error(
        `[polystella-emdash] batch message ${message.id} failed; retrying: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      message.retry();
    }
  }
}

async function processMessage(runtime: PolystellaBatchRuntime, body: unknown): Promise<void> {
  const list = readBatchListMessage(body);
  if (list !== null) {
    await callRoute(runtime, "batch/list", list);
    return;
  }
  const message = readBatchMessage(body);
  if (message === null) {
    console.error("[polystella-emdash] dropping a malformed batch message");
    return;
  }
  let response = await callRoute(runtime, "batch/translate", message);
  const target = readRevisionTarget(response);
  if (target !== null) {
    // Read before translating, so an edit made while the model works makes the save fail instead of being overwritten.
    const current = await runtime.handleContentGet(target.collection, target.id, target.locale);
    const rev = current.success ? current.data?._rev : undefined;
    if (rev === undefined) {
      const reason = current.success ? "EmDash returned no revision token" : (current.error?.message ?? "unknown error");
      await record(runtime, message, "failed", `Could not read the existing translation: ${reason}`.slice(0, MAX_BATCH_MESSAGE_CHARACTERS));
      return;
    }
    response = await callRoute(runtime, "batch/translate", { ...message, rev });
  }
  const update = readUpdatePayload(response);
  if (update !== null) {
    await saveUpdate(runtime, message, update, response);
    return;
  }
  const create = readCreatePayload(response);
  if (create === null) return;

  const { collection, ...draft } = create;
  const created = await runtime.handleContentCreate(collection, draft);
  if (created.success) {
    const entryId = created.data?.item.id;
    if (entryId !== undefined) await recordAiTranslation(runtime, collection, entryId, message.jobId);
    const publish = isRecord(response) && response.publish === true ? await publishSaved(runtime, collection, entryId) : null;
    const translation =
      entryId === undefined ? null : { id: entryId, locale: draft.locale, slug: draft.slug, published: publish?.published === true };
    const notice = isRecord(response) && typeof response.notice === "string" ? response.notice : null;
    const detail = [notice, publish?.message ?? null].filter((part) => part !== null).join(" ");
    await record(runtime, message, "created", detail === "" ? null : detail.slice(0, MAX_BATCH_MESSAGE_CHARACTERS), translation);
  } else {
    // CONFLICT means the locale was created after the route checked, by an editor or a duplicate delivery.
    const outcome = created.error.code === "CONFLICT" ? "skipped" : "failed";
    await record(runtime, message, outcome, created.error.message.slice(0, MAX_BATCH_MESSAGE_CHARACTERS));
  }
}

async function saveUpdate(
  runtime: PolystellaBatchRuntime,
  message: BatchMessage,
  update: BatchUpdatePayload,
  response: unknown,
): Promise<void> {
  const { collection, id, locale, data, _rev, translation } = update;
  const saved = await runtime.handleContentUpdate(collection, id, { data, _rev, locale });
  if (!saved.success) {
    // CONFLICT means an editor saved the translation while it was being translated; their edit is kept.
    const conflict = saved.error.code === "CONFLICT";
    const detail = conflict ? "The translation changed while PolyStella translated it, so it was left as it was." : saved.error.message;
    await record(runtime, message, conflict ? "skipped" : "failed", detail.slice(0, MAX_BATCH_MESSAGE_CHARACTERS), translation);
    return;
  }
  await recordAiTranslation(runtime, collection, id, message.jobId);
  const publish = isRecord(response) && response.publish === true ? await publishSaved(runtime, collection, id) : null;
  const notice = isRecord(response) && typeof response.notice === "string" ? response.notice : null;
  const detail = [notice, publish?.message ?? null].filter((part) => part !== null).join(" ");
  const row = { ...translation, published: translation.published || publish?.published === true };
  // Retrying the message would read a fresh `_rev` and overwrite edits made after this save, so only the record is retried.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await record(runtime, message, "updated", detail === "" ? null : detail.slice(0, MAX_BATCH_MESSAGE_CHARACTERS), row);
      return;
    } catch (error) {
      if (attempt >= UPDATE_RECORD_ATTEMPTS) {
        console.error(
          `[polystella-emdash] saved ${id} but could not record it; the job will not finish on its own: ${error instanceof Error ? error.message : "unknown error"}`,
        );
        return;
      }
    }
  }
}

/** The draft already exists, so a failure here is logged instead of retrying the message (which would skip it). */
async function recordAiTranslation(runtime: PolystellaBatchRuntime, collection: string, entryId: string, jobId: string): Promise<void> {
  try {
    await callRoute(runtime, "ai-translation", { collection, entryId, jobId });
  } catch (error) {
    console.error(
      `[polystella-emdash] could not mark ${entryId} as AI-translated: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

/** A failed publish leaves the draft in place, so it is noted on the row rather than retried. */
async function publishSaved(
  runtime: PolystellaBatchRuntime,
  collection: string,
  id: string | undefined,
): Promise<{ published: boolean; message: string }> {
  if (id === undefined) return { published: false, message: "Saved as a draft; EmDash did not return the new entry to publish." };
  let reason: string;
  try {
    const published = await runtime.handleContentPublish(collection, id);
    if (published.success) return { published: true, message: "Published." };
    reason = published.error?.message ?? "unknown error";
  } catch (error) {
    reason = error instanceof Error ? error.message : "unknown error";
  }
  return { published: false, message: `Saved as a draft; publishing failed: ${reason}`.slice(0, MAX_BATCH_MESSAGE_CHARACTERS) };
}

async function record(
  runtime: PolystellaBatchRuntime,
  message: BatchMessage,
  outcome: string,
  detail: string | null,
  translation: BatchTranslationLink | null = null,
): Promise<void> {
  await callRoute(runtime, "batch/record", { ...message, outcome, message: detail, translation });
}

async function callRoute(runtime: PolystellaBatchRuntime, path: string, body: unknown): Promise<unknown> {
  const request = new Request("https://polystella.internal/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await runtime.handlePluginApiRoute(POLYSTELLA_PLUGIN_ID, "POST", path, request);
  if (!result.success) throw new Error(`${path} failed: ${result.error?.code ?? "UNKNOWN"} ${result.error?.message ?? ""}`.trim());
  return result.data;
}

function readRevisionTarget(value: unknown): { collection: string; id: string; locale: string } | null {
  if (!isRecord(value) || value.readRevision === undefined) return null;
  const target = value.readRevision;
  if (!isRecord(target) || typeof target.collection !== "string" || typeof target.id !== "string" || typeof target.locale !== "string") {
    throw new Error("batch/translate returned an invalid revision request");
  }
  return { collection: target.collection, id: target.id, locale: target.locale };
}

function readUpdatePayload(value: unknown): BatchUpdatePayload | null {
  if (!isRecord(value) || value.update === undefined) return null;
  const update = value.update;
  const translation = isRecord(update) ? readTranslationLink(update.translation) : null;
  if (
    !isRecord(update) ||
    translation === null ||
    typeof update.collection !== "string" ||
    typeof update.id !== "string" ||
    typeof update.locale !== "string" ||
    !isRecord(update.data) ||
    typeof update._rev !== "string"
  ) {
    throw new Error("batch/translate returned an invalid update");
  }
  return { collection: update.collection, id: update.id, locale: update.locale, data: update.data, _rev: update._rev, translation };
}

function readCreatePayload(value: unknown): BatchCreatePayload | null {
  if (!isRecord(value) || value.create === null) return null;
  const create = value.create;
  if (
    !isRecord(create) ||
    typeof create.collection !== "string" ||
    !isRecord(create.data) ||
    (create.slug !== null && typeof create.slug !== "string") ||
    typeof create.locale !== "string" ||
    typeof create.translationOf !== "string" ||
    (create.authorId !== undefined && typeof create.authorId !== "string")
  ) {
    throw new Error("batch/translate returned an invalid draft");
  }
  return {
    collection: create.collection,
    data: create.data,
    slug: create.slug,
    locale: create.locale,
    translationOf: create.translationOf,
    ...(create.authorId === undefined ? {} : { authorId: create.authorId }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
