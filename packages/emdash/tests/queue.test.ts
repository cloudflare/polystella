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
  create: Awaited<ReturnType<PolystellaBatchRuntime["handleContentCreate"]>> = { success: true, data: { item: { id: "entry-fr" } } },
  translated: unknown = { create: draft },
  published: Awaited<ReturnType<PolystellaBatchRuntime["handleContentPublish"]>> = { success: true },
  updated: Awaited<ReturnType<PolystellaBatchRuntime["handleContentUpdate"]>> = { success: true },
) {
  const routeCalls: Array<{ path: string; body: unknown }> = [];
  const value = {
    handlePluginApiRoute: vi.fn(async (_pluginId: string, _method: string, path: string, request: Request) => {
      const requestBody: unknown = await request.json();
      routeCalls.push({ path, body: requestBody });
      const data = typeof translated === "function" ? (translated as (body: unknown) => unknown)(requestBody) : translated;
      return { success: true, data: path === "batch/translate" ? data : { recorded: true } };
    }),
    handleContentCreate: vi.fn(async () => create),
    handleContentPublish: vi.fn(async () => published),
    handleContentGet: vi.fn(async (): Promise<Awaited<ReturnType<PolystellaBatchRuntime["handleContentGet"]>>> => ({
      success: true,
      data: { _rev: "rev-1" },
    })),
    handleContentUpdate: vi.fn(async () => updated),
  } satisfies PolystellaBatchRuntime;
  return { value, routeCalls };
}

describe("PolyStella batch queue consumer", () => {
  it("hands list messages to the listing route", async () => {
    const list = { kind: "list", jobId: "job-1", page: 2 };
    const message = queueMessage(list);
    const { value, routeCalls } = runtime();

    await processPolystellaBatch({ messages: [message] }, value);

    expect(routeCalls).toEqual([{ path: "batch/list", body: list }]);
    expect(message.ack).toHaveBeenCalled();
  });

  it("creates the translated draft and records it", async () => {
    const message = queueMessage();
    const { value, routeCalls } = runtime();

    await processPolystellaBatch({ messages: [message] }, value);

    const { collection, ...createBody } = draft;
    expect(value.handleContentCreate).toHaveBeenCalledWith(collection, createBody);
    expect(routeCalls).toEqual([
      { path: "batch/translate", body },
      { path: "ai-translation", body: { collection: "posts", entryId: "entry-fr", jobId: "job-1" } },
      {
        path: "batch/record",
        body: {
          ...body,
          outcome: "created",
          message: null,
          translation: { id: "entry-fr", locale: "fr", slug: "hello", published: false },
        },
      },
    ]);
    expect(message.ack).toHaveBeenCalled();
    expect(value.handleContentPublish).not.toHaveBeenCalled();
  });

  it("publishes the created entry when the job asks, and notes a failed publish", async () => {
    const published = runtime(undefined, { create: draft, publish: true });
    await processPolystellaBatch({ messages: [queueMessage()] }, published.value);
    expect(published.value.handleContentPublish).toHaveBeenCalledWith("posts", "entry-fr");
    expect(published.routeCalls.map(({ path }) => path)).toEqual(["batch/translate", "ai-translation", "batch/record"]);
    expect(published.routeCalls.at(-1)?.body).toMatchObject({
      outcome: "created",
      message: "Published.",
      translation: { id: "entry-fr", published: true },
    });

    const refused = runtime(undefined, { create: draft, publish: true }, { success: false, error: { code: "X", message: "slug taken" } });
    const message = queueMessage();
    await processPolystellaBatch({ messages: [message] }, refused.value);
    expect(refused.routeCalls.at(-1)?.body).toMatchObject({
      outcome: "created",
      message: "Saved as a draft; publishing failed: slug taken",
    });
    expect(message.ack).toHaveBeenCalled();
  });

  it("records the route's notice with the created row", async () => {
    const { value, routeCalls } = runtime(undefined, { create: draft, publish: true, notice: "Review 1 same-page link (#…) by hand." });
    await processPolystellaBatch({ messages: [queueMessage()] }, value);
    expect(routeCalls.at(-1)?.body).toMatchObject({ outcome: "created", message: "Review 1 same-page link (#…) by hand. Published." });
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

  describe("updating existing translations", () => {
    const link = { id: "entry-fr", locale: "fr", slug: "hello", published: true };
    const update = { collection: "posts", id: "entry-fr", locale: "fr", data: { title: "Bonjour" }, _rev: "rev-1", translation: link };
    // The route asks for the existing translation's revision first, then translates with it.
    const twoStep = (response: Record<string, unknown>) => (requestBody: unknown) =>
      typeof requestBody === "object" && requestBody !== null && "rev" in requestBody
        ? response
        : { create: null, readRevision: { collection: "posts", id: "entry-fr", locale: "fr" } };

    it("reads the revision before translating, saves with it, and records the row as updated", async () => {
      const message = queueMessage();
      const { value, routeCalls } = runtime(undefined, twoStep({ create: null, update, publish: true }));

      await processPolystellaBatch({ messages: [message] }, value);

      expect(value.handleContentGet).toHaveBeenCalledWith("posts", "entry-fr", "fr");
      expect(value.handleContentUpdate).toHaveBeenCalledWith("posts", "entry-fr", {
        data: { title: "Bonjour" },
        _rev: "rev-1",
        locale: "fr",
      });
      expect(value.handleContentPublish).toHaveBeenCalledWith("posts", "entry-fr");
      expect(routeCalls).toEqual([
        { path: "batch/translate", body },
        { path: "batch/translate", body: { ...body, rev: "rev-1" } },
        { path: "ai-translation", body: { collection: "posts", entryId: "entry-fr", jobId: "job-1" } },
        { path: "batch/record", body: { ...body, outcome: "updated", message: "Published.", translation: link } },
      ]);
      expect(message.ack).toHaveBeenCalled();
    });

    it("skips a translation an editor changed meanwhile, and fails one whose revision can't be read", async () => {
      const conflict = runtime(undefined, twoStep({ create: null, update }), undefined, {
        success: false,
        error: { code: "CONFLICT", message: "version conflict" },
      });
      await processPolystellaBatch({ messages: [queueMessage()] }, conflict.value);
      expect(conflict.routeCalls.map(({ path }) => path)).toEqual(["batch/translate", "batch/translate", "batch/record"]);
      expect(conflict.routeCalls.at(-1)?.body).toMatchObject({ outcome: "skipped", translation: link });

      const unreadable = runtime(undefined, twoStep({ create: null, update }));
      unreadable.value.handleContentGet.mockResolvedValueOnce({ success: false, error: { code: "NOT_FOUND", message: "gone" } });
      await processPolystellaBatch({ messages: [queueMessage()] }, unreadable.value);
      expect(unreadable.value.handleContentUpdate).not.toHaveBeenCalled();
      expect(unreadable.routeCalls.at(-1)?.body).toMatchObject({
        outcome: "failed",
        message: "Could not read the existing translation: gone",
      });
    });

    it("retries only the record after a saved update, so a redelivery can't overwrite later edits", async () => {
      const message = queueMessage();
      const { value, routeCalls } = runtime(undefined, twoStep({ create: null, update }));
      const route = value.handlePluginApiRoute.getMockImplementation();
      let recordFailures = 1;
      value.handlePluginApiRoute.mockImplementation(async (pluginId, method, path, request) => {
        if (path === "batch/record" && recordFailures > 0) {
          recordFailures -= 1;
          routeCalls.push({ path, body: await request.json() });
          return { success: false, data: { code: "INTERNAL_ERROR", message: "db down" } };
        }
        if (route === undefined) throw new Error("missing mock");
        return route(pluginId, method, path, request);
      });

      await processPolystellaBatch({ messages: [message] }, value);

      expect(value.handleContentUpdate).toHaveBeenCalledTimes(1);
      expect(routeCalls.filter(({ path }) => path === "batch/record")).toHaveLength(2);
      expect(message.ack).toHaveBeenCalled();
      expect(message.retry).not.toHaveBeenCalled();
    });
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
