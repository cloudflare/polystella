import { POLYSTELLA_PLUGIN_ID } from "./contracts.js";
import { MAX_BATCH_MESSAGE_CHARACTERS, readBatchMessage, type BatchCreatePayload, type BatchMessage } from "./server/batch.js";

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
  const message = readBatchMessage(body);
  if (message === null) {
    console.error("[polystella-emdash] dropping a malformed batch message");
    return;
  }
  const create = readCreatePayload(await callRoute(runtime, "batch/translate", message));
  if (create === null) return;

  const { collection, ...draft } = create;
  const created = await runtime.handleContentCreate(collection, draft);
  if (created.success) {
    await record(runtime, message, "created", null);
  } else {
    // CONFLICT means the locale was created after the route checked, by an editor or a duplicate delivery.
    const outcome = created.error.code === "CONFLICT" ? "skipped" : "failed";
    await record(runtime, message, outcome, created.error.message.slice(0, MAX_BATCH_MESSAGE_CHARACTERS));
  }
}

async function record(runtime: PolystellaBatchRuntime, message: BatchMessage, outcome: string, detail: string | null): Promise<void> {
  await callRoute(runtime, "batch/record", { ...message, outcome, message: detail });
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
