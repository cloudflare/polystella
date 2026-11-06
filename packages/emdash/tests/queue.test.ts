import { describe, expect, it, vi } from "vitest";

import { processPolystellaBatch, type PolystellaBatchRuntime, type PolystellaQueueMessage } from "../src/queue.js";

const body = { jobId: "job-1", entryId: "entry-1", locale: "fr-FR" };
const draft = {
  collection: "posts",
  data: { title: "Bonjour" },
  slug: "hello",
  locale: "fr",
  translationOf: "entry-1",
  authorId: "user-1",
};

function queueMessage(value: unknown = body) {
  return { id: "message-1", body: value, ack: vi.fn<() => void>(), retry: vi.fn<() => void>() } satisfies PolystellaQueueMessage;
}

function runtime(
  create: Awaited<ReturnType<PolystellaBatchRuntime["handleContentCreate"]>> = { success: true },
  translated: unknown = { create: draft },
) {
  const routeCalls: Array<{ path: string; body: unknown }> = [];
  const value = {
    handlePluginApiRoute: vi.fn(async (_pluginId: string, _method: string, path: string, request: Request) => {
      routeCalls.push({ path, body: await request.json() });
      return { success: true, data: path === "batch/translate" ? translated : { recorded: true } };
    }),
    handleContentCreate: vi.fn(async () => create),
  } satisfies PolystellaBatchRuntime;
  return { value, routeCalls };
}

describe("PolyStella batch queue consumer", () => {
  it("creates the translated draft and records it", async () => {
    const message = queueMessage();
    const { value, routeCalls } = runtime();

    await processPolystellaBatch({ messages: [message] }, value);

    const { collection, ...createBody } = draft;
    expect(value.handleContentCreate).toHaveBeenCalledWith(collection, createBody);
    expect(routeCalls).toEqual([
      { path: "batch/translate", body },
      { path: "batch/record", body: { ...body, outcome: "created", message: null } },
    ]);
    expect(message.ack).toHaveBeenCalled();
  });

  it("records a locale created meanwhile as skipped", async () => {
    const { value, routeCalls } = runtime({ success: false, error: { code: "CONFLICT", message: "Translation already exists" } });

    await processPolystellaBatch({ messages: [queueMessage()] }, value);

    expect(routeCalls.at(-1)?.body).toMatchObject({ outcome: "skipped", message: "Translation already exists" });
  });

  it("does nothing more when the route already recorded the outcome", async () => {
    const message = queueMessage();
    const { value, routeCalls } = runtime(undefined, { create: null });

    await processPolystellaBatch({ messages: [message] }, value);

    expect(value.handleContentCreate).not.toHaveBeenCalled();
    expect(routeCalls.map(({ path }) => path)).toEqual(["batch/translate"]);
    expect(message.ack).toHaveBeenCalled();
  });

  it("retries when a route fails and drops malformed messages", async () => {
    const failing = queueMessage();
    const malformed = queueMessage({ nope: true });
    const { value } = runtime();
    value.handlePluginApiRoute.mockResolvedValueOnce({ success: false, error: { code: "INTERNAL_ERROR", message: "db down" } } as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await processPolystellaBatch({ messages: [failing, malformed] }, value);

    expect(failing.retry).toHaveBeenCalled();
    expect(failing.ack).not.toHaveBeenCalled();
    expect(malformed.ack).toHaveBeenCalled();
  });
});
