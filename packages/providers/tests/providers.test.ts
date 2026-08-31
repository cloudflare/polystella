import { EMPTY_GLOSSARY, PermanentProviderError, translateBatch } from "@cloudflare/polystella-core";
import { describe, expect, it, vi } from "vitest";

import { createAnthropicTranslator } from "../src/anthropic.js";
import { createWorkersAIBindingTranslator, createWorkersAIHttpTranslator } from "../src/workers-ai.js";

function makeFetchStub(body: unknown, init: { status?: number; statusText?: string; rawText?: string } = {}) {
  const responseBody = init.rawText ?? JSON.stringify(body);
  return vi.fn().mockResolvedValue(
    new Response(responseBody, {
      status: init.status ?? 200,
      statusText: init.statusText ?? "OK",
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function createWorkersHttp(fetchImpl: typeof fetch) {
  return createWorkersAIHttpTranslator({
    accountId: "ACCT",
    apiToken: "TOKEN",
    modelId: "@cf/test/model",
    maxTokens: 8192,
    fetchImpl,
  });
}

describe("Workers AI HTTP translator", () => {
  it("sends the exact endpoint, authorization, chat messages, max tokens, and signal", async () => {
    const fetchImpl = makeFetchStub({ result: { response: "OK" }, success: true });
    const translator = createWorkersHttp(fetchImpl);
    const controller = new AbortController();
    await translator.translate("system", "user", controller.signal);

    expect(translator.modelId).toBe("@cf/test/model");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/ACCT/ai/run/@cf/test/model");
    expect(init).toMatchObject({ method: "POST", signal: controller.signal });
    expect(init?.headers).toEqual({ Authorization: "Bearer TOKEN", "Content-Type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "user" },
      ],
      max_tokens: 8192,
    });
  });

  it("uses a custom endpoint", async () => {
    const fetchImpl = makeFetchStub({ result: { response: "OK" } });
    const translator = createWorkersAIHttpTranslator({
      accountId: "ignored",
      apiToken: "TOKEN",
      modelId: "model",
      maxTokens: 10,
      endpoint: "https://gateway.example/run",
      fetchImpl,
    });
    await translator.translate("s", "u");
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://gateway.example/run");
  });

  it.each([
    ["legacy", { result: { response: "legacy", choices: [{ message: { content: "chat" } }] } }, "legacy"],
    ["result choices", { result: { choices: [{ message: { content: "chat" } }] } }, "chat"],
    ["top-level choices", { choices: [{ message: { content: "flat" } }] }, "flat"],
    ["parsed object", { result: { response: { title: "Translated" } } }, '{"title":"Translated"}'],
  ])("normalizes the %s response shape", async (_name, body, expected) => {
    expect(await createWorkersHttp(makeFetchStub(body)).translate("s", "u")).toBe(expected);
  });

  it("reports API envelopes with success false", async () => {
    const translator = createWorkersHttp(makeFetchStub({ success: false, errors: [{ message: "bad" }] }));
    await expect(translator.translate("s", "u")).rejects.toThrow(/Workers AI returned errors.*bad/);
  });

  it("previews unexpected response envelopes", async () => {
    const translator = createWorkersHttp(makeFetchStub({ result: { response: 42 }, extra: "x".repeat(900) }));
    await expect(translator.translate("s", "u")).rejects.toThrow(/none of result\.response.*"response":42.*truncated, total length/s);
  });

  it.each([400, 401, 403, 404, 422])("classifies HTTP %s as permanent", async (status) => {
    const translator = createWorkersHttp(makeFetchStub({}, { status, statusText: "Failure", rawText: "details" }));
    const error = await translator.translate("s", "u").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PermanentProviderError);
    expect(error).toMatchObject({ message: expect.stringContaining(`${status} Failure\ndetails`) });
  });

  it.each([429, 503])("leaves HTTP %s retriable", async (status) => {
    const translator = createWorkersHttp(makeFetchStub({}, { status, statusText: "Retry" }));
    const error = await translator.translate("s", "u").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PermanentProviderError);
  });
});

describe("Workers AI binding translator", () => {
  it("passes the exact model and input object to the binding callback", async () => {
    const run = vi.fn().mockResolvedValue("OK");
    const translator = createWorkersAIBindingTranslator({ modelId: "@cf/binding/model", maxTokens: 4096, run });
    expect(await translator.translate("system", "user")).toBe("OK");
    expect(run).toHaveBeenCalledWith("@cf/binding/model", {
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "user" },
      ],
      max_tokens: 4096,
    });
  });

  it.each([
    ["direct string", "translated", "translated"],
    ["direct object", { title: "Translated" }, '{"title":"Translated"}'],
    ["response string", { response: "translated" }, "translated"],
    ["response object", { response: { title: "Translated" } }, '{"title":"Translated"}'],
    ["choices string", { choices: [{ message: { content: "translated" } }] }, "translated"],
    ["choices object", { choices: [{ message: { content: { title: "Translated" } } }] }, '{"title":"Translated"}'],
  ])("normalizes a %s", async (_name, response, expected) => {
    const translator = createWorkersAIBindingTranslator({
      modelId: "model",
      maxTokens: 100,
      run: vi.fn().mockResolvedValue(response),
    });
    expect(await translator.translate("s", "u")).toBe(expected);
  });

  it("rejects a pre-aborted signal without invoking the binding", async () => {
    const run = vi.fn().mockResolvedValue("ignored");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const translator = createWorkersAIBindingTranslator({ modelId: "model", maxTokens: 100, run });
    await expect(translator.translate("s", "u", controller.signal)).rejects.toThrow("cancelled");
    expect(run).not.toHaveBeenCalled();
  });

  it("checks cancellation after binding inference without claiming in-flight cancellation", async () => {
    const controller = new AbortController();
    const run = vi.fn().mockImplementation(async () => {
      controller.abort(new Error("cancelled after inference"));
      return "ignored";
    });
    const translator = createWorkersAIBindingTranslator({ modelId: "model", maxTokens: 100, run });
    await expect(translator.translate("s", "u", controller.signal)).rejects.toThrow("cancelled after inference");
    expect(run).toHaveBeenCalledOnce();
  });

  it("leaves binding callback errors unchanged", async () => {
    const failure = new Error("binding failure");
    const translator = createWorkersAIBindingTranslator({
      modelId: "model",
      maxTokens: 100,
      run: vi.fn().mockRejectedValue(failure),
    });
    await expect(translator.translate("s", "u")).rejects.toBe(failure);
  });

  it("includes a preview for unsupported binding responses", async () => {
    const translator = createWorkersAIBindingTranslator({
      modelId: "model",
      maxTokens: 100,
      run: vi.fn().mockResolvedValue(42),
    });
    await expect(translator.translate("s", "u")).rejects.toThrow(/unexpected Workers AI binding response shape.*42/s);
  });
});

describe("Anthropic translator", () => {
  function createAnthropic(fetchImpl: typeof fetch) {
    return createAnthropicTranslator({ apiKey: "KEY", modelId: "claude-test", maxTokens: 8192, fetchImpl });
  }

  it("sends the documented endpoint, headers, body, and signal", async () => {
    const fetchImpl = makeFetchStub({ content: [{ type: "text", text: "OK" }] });
    const controller = new AbortController();
    const translator = createAnthropic(fetchImpl);
    await translator.translate("system", "user", controller.signal);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init).toMatchObject({ method: "POST", signal: controller.signal });
    expect(init?.headers).toEqual({
      "x-api-key": "KEY",
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "claude-test",
      max_tokens: 8192,
      system: "system",
      messages: [{ role: "user", content: "user" }],
    });
  });

  it("returns the first text content block", async () => {
    const translator = createAnthropic(
      makeFetchStub({
        content: [
          { type: "tool_use", id: "x" },
          { type: "text", text: "translated" },
        ],
      }),
    );
    expect(await translator.translate("s", "u")).toBe("translated");
  });

  it("rejects responses without text content", async () => {
    const translator = createAnthropic(makeFetchStub({ content: [{ type: "tool_use", id: "x" }] }));
    await expect(translator.translate("s", "u")).rejects.toThrow(/unexpected Anthropic response shape/);
  });

  it("rejects a malformed first text block instead of skipping to a later one", async () => {
    const translator = createAnthropic(
      makeFetchStub({
        content: [
          { type: "text", text: 42 },
          { type: "text", text: "later" },
        ],
      }),
    );
    await expect(translator.translate("s", "u")).rejects.toThrow(/unexpected Anthropic response shape/);
  });

  it("uses the canonical core permanent error", async () => {
    const translator = createAnthropic(makeFetchStub({}, { status: 401, statusText: "Unauthorized" }));
    await expect(translator.translate("s", "u")).rejects.toBeInstanceOf(PermanentProviderError);
  });
});

describe("core retry integration", () => {
  const translationInput = {
    segments: [{ id: "body:0", text: "Hello" }],
    glossary: EMPTY_GLOSSARY,
    sourceLocale: "en-US",
    targetLocale: "pt-BR",
    maxRetries: 2,
    retryMinTimeoutMs: 0,
  };

  it("makes one attempt for a provider 401", async () => {
    const fetchImpl = makeFetchStub({}, { status: 401, statusText: "Unauthorized" });
    await expect(translateBatch({ ...translationInput, translator: createWorkersHttp(fetchImpl) })).rejects.toThrow(/401/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("lets a provider 503 consume the core retry budget", async () => {
    const fetchImpl = makeFetchStub({}, { status: 503, statusText: "Unavailable" });
    await expect(translateBatch({ ...translationInput, translator: createWorkersHttp(fetchImpl) })).rejects.toThrow(/503/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
