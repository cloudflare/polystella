import { EMPTY_GLOSSARY, PermanentProviderError, translateBatch } from "../../src/index.js";
import { describe, expect, it, vi } from "vitest";

import { createAnthropicTranslator } from "../../src/providers/anthropic.js";
import {
  createWorkersAIBindingTranslator,
  createWorkersAIHttpTranslator,
  fetchWorkersAIModels,
  ProviderTimeoutError,
  workersAIModelPrice,
  workersAIPriceLookup,
  workersAIParamsForLocale,
  workersAIParamsProblem,
  workersAIRequestParams,
} from "../../src/providers/workers-ai.js";

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

  it("explains replies cut off at the output token limit", async () => {
    const binding = createWorkersAIBindingTranslator({
      modelId: "reasoner",
      maxTokens: 8192,
      run: vi.fn().mockResolvedValue({ choices: [{ message: { content: null, reasoning_content: "..." }, finish_reason: "length" }] }),
    });
    await expect(binding.translate("s", "u")).rejects.toThrow('model ran out of output tokens (model="reasoner", max_tokens=8192)');

    const http = createWorkersAIHttpTranslator({
      accountId: "acct",
      apiToken: "token",
      modelId: "reasoner",
      maxTokens: 512,
      fetchImpl: makeFetchStub({
        success: true,
        result: { choices: [{ message: { content: "@@a@@\nPartial" }, finish_reason: "length" }] },
      }),
    });
    await expect(http.translate("s", "u")).rejects.toThrow("max_tokens=512");
  });

  it("summarizes the first choice before the preview of an unusable reply", async () => {
    const translator = createWorkersAIBindingTranslator({
      modelId: "reasoner",
      maxTokens: 100,
      run: vi
        .fn()
        .mockResolvedValue({ choices: [{ message: { content: null, reasoning_content: "x".repeat(2000) }, finish_reason: "stop" }] }),
    });
    await expect(translator.translate("s", "u")).rejects.toThrow(
      'Raw response was:\nchoices[0]: finish_reason="stop"; message: content=null, reasoning_content=2000 chars\n{"choices"',
    );
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

describe("Workers AI request controls", () => {
  const reply = {
    choices: [{ finish_reason: "stop", message: { content: "@@a@@\nHallo", reasoning_content: "x".repeat(42) } }],
    usage: { prompt_tokens: 120, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 250 } },
  };

  it("sends model params with both transports and reports finish reason, reasoning and usage", async () => {
    const run = vi.fn(async () => reply);
    const params = { chat_template_kwargs: { enable_thinking: false } };
    const binding = createWorkersAIBindingTranslator({ modelId: "glm", maxTokens: 100, params, run });
    const reported: unknown[] = [];
    await expect(binding.translate("system", "user", undefined, (info) => reported.push(info))).resolves.toBe("@@a@@\nHallo");
    expect(run).toHaveBeenCalledWith("glm", expect.objectContaining({ ...params, max_tokens: 100 }));

    const fetchImpl = vi.fn(async () => Response.json({ success: true, result: reply }));
    const http = createWorkersAIHttpTranslator({ accountId: "a", apiToken: "t", modelId: "glm", maxTokens: 100, params, fetchImpl });
    await http.translate("system", "user", undefined, (info) => reported.push(info));
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject(params);

    const info = { finishReason: "stop", reasoningCharacters: 42, inputTokens: 120, outputTokens: 300, reasoningTokens: 250 };
    expect(reported).toEqual([info, info]);
    expect(() => createWorkersAIBindingTranslator({ modelId: "glm", maxTokens: 100, params: { max_tokens: 5 }, run })).toThrow(
      'Workers AI params cannot set "max_tokens"',
    );
  });

  it("sends enable_thinking as chat_template_kwargs.enable_thinking, the form Workers AI reads", async () => {
    const inputs: unknown[] = [];
    const run = async (_model: string, input: unknown) => (inputs.push(input), { response: "@@a@@\nHallo" });
    for (const enable_thinking of [false, true]) {
      const translator = createWorkersAIBindingTranslator({
        modelId: "deepseek",
        maxTokens: 100,
        params: { enable_thinking, chat_template_kwargs: { clear_thinking: true }, reasoning_effort: "none" },
        run,
      });
      await translator.translate("system", "user");
    }
    expect(inputs).toEqual(
      [false, true].map((enable_thinking) =>
        expect.objectContaining({
          chat_template_kwargs: { clear_thinking: true, enable_thinking },
          reasoning_effort: "none",
        }),
      ),
    );
    expect(inputs[0]).not.toHaveProperty("enable_thinking");

    const create = (params: Record<string, unknown>) => () =>
      createWorkersAIBindingTranslator({ modelId: "deepseek", maxTokens: 100, params, run });
    expect(create({ enable_thinking: "no" })).toThrow("enable_thinking must be true or false");

    const models = {
      default: { model: "deepseek", enable_thinking: false },
      "ja-JP": { model: "deepseek", enable_thinking: true },
      "ko-KR": "glm",
    };
    const params = { enable_thinking: true, reasoning_effort: "low" };
    expect(workersAIParamsForLocale(params, models, "ja-JP", "deepseek")).toEqual({ enable_thinking: true, reasoning_effort: "low" });
    expect(workersAIParamsForLocale(params, models, "de-DE", "deepseek")).toEqual({ enable_thinking: false, reasoning_effort: "low" });
    // A model picked instead of the locale's code model keeps its own params.
    expect(workersAIParamsForLocale(params, models, "de-DE", "glm")).toBe(params);
    expect(workersAIParamsForLocale(undefined, models, "ko-KR", "glm")).toBeUndefined();
    expect(create({ enable_thinking: false, chat_template_kwargs: { enable_thinking: false } })).toThrow("sets enable_thinking twice");
    expect(create({ enable_thinking: false, chat_template_kwargs: "x" })).toThrow("chat_template_kwargs must be an object");
    expect(workersAIParamsProblem({ chat_template_kwargs: { enable_thinking: false } })).toBeUndefined();
  });

  it("stops waiting after timeoutMs, aborting the HTTP request", async () => {
    const binding = createWorkersAIBindingTranslator({ modelId: "glm", maxTokens: 100, timeoutMs: 20, run: () => new Promise(() => {}) });
    await expect(binding.translate("system", "user")).rejects.toBeInstanceOf(ProviderTimeoutError);

    let aborted = false;
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(init.signal?.reason);
          });
        }),
    );
    const http = createWorkersAIHttpTranslator({ accountId: "a", apiToken: "t", modelId: "glm", maxTokens: 100, timeoutMs: 20, fetchImpl });
    await expect(http.translate("system", "user")).rejects.toThrow("[polystella] the model did not answer within 0.02 s");
    expect(aborted).toBe(true);

    const cancelled = new AbortController();
    cancelled.abort(new Error("cancelled"));
    await expect(binding.translate("system", "user", cancelled.signal)).rejects.toThrow("cancelled");
  });

  it("puts the reply info on the batch attempt event and on the error", async () => {
    const events: unknown[] = [];
    const failing = createWorkersAIBindingTranslator({
      modelId: "glm",
      maxTokens: 100,
      run: async () => ({ ...reply, choices: [{ ...reply.choices[0], message: { content: "@@" } }] }),
    });
    const batch = translateBatch({
      translator: failing,
      segments: [{ id: "a", text: "Hello" }],
      glossary: EMPTY_GLOSSARY,
      sourceLocale: "en",
      targetLocale: "de",
      onBatchAttempt: (event) => events.push(event.providerResponse),
    });
    await expect(batch).rejects.toMatchObject({ providerResponse: { finishReason: "stop", reasoningTokens: 250 } });
    expect(events).toEqual([expect.objectContaining({ outputTokens: 300 })]);
  });
});

describe("Workers AI model prices", () => {
  const rate = (unit: string, price: number, currency = "USD") => ({ unit, price, currency });
  const entry = (name: string, ...rates: unknown[]) => ({ name, properties: [{ property_id: "price", value: rates }] });
  const catalogEntry = entry(
    "@cf/test/model",
    rate("per M input tokens", 0.152),
    rate("per M output tokens", 0.5),
    rate("per M cached input tokens", 0.03),
  );

  it("reads the input, output and cached input rates of a catalog entry", () => {
    expect(workersAIModelPrice(catalogEntry)).toEqual({ inputPerMillion: 0.152, outputPerMillion: 0.5, cachedInputPerMillion: 0.03 });
    expect(workersAIModelPrice(entry("m", rate("per M input tokens", 1), rate("per M output tokens", 2)))).toEqual({
      inputPerMillion: 1,
      outputPerMillion: 2,
    });
  });

  it("returns undefined without both an input and an output USD rate", () => {
    expect(workersAIModelPrice(entry("m", rate("per M input tokens", 1)))).toBeUndefined();
    expect(workersAIModelPrice(entry("m", rate("per M input tokens", 1), rate("per M output tokens", 2, "EUR")))).toBeUndefined();
    expect(workersAIModelPrice(entry("m", rate("per M input tokens", 1), rate("per 1000 neurons", 2)))).toBeUndefined();
    expect(workersAIModelPrice(entry("m", rate("per M input tokens", 1), rate("per M output tokens", Number.NaN)))).toBeUndefined();
    expect(workersAIModelPrice({ name: "m", properties: [{ property_id: "context_window", value: 8000 }] })).toBeUndefined();
    expect(workersAIModelPrice({ name: "m" })).toBeUndefined();
    expect(workersAIModelPrice(undefined)).toBeUndefined();
  });

  it("reads the catalog through the binding", async () => {
    const models = vi.fn(async () => [catalogEntry]);
    await expect(fetchWorkersAIModels("@cf/test/model", { binding: { models } })).resolves.toEqual([catalogEntry]);
    expect(models).toHaveBeenCalledWith({ search: "@cf/test/model" });
    await expect(fetchWorkersAIModels("m", { binding: { models: async () => ({}) } })).rejects.toThrow("unexpected model list");
  });

  it("reads the catalog over REST with the account token", async () => {
    const fetchImpl = makeFetchStub({ result: [catalogEntry] });
    await expect(fetchWorkersAIModels("@cf/test/model", { accountId: "A/B", apiToken: "TOKEN", fetchImpl })).resolves.toEqual([
      catalogEntry,
    ]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/A%2FB/ai/models/search?search=%40cf%2Ftest%2Fmodel");
    expect(init?.headers).toEqual({ Authorization: "Bearer TOKEN" });
  });

  it("explains a failing or malformed REST catalog", async () => {
    const source = (fetchImpl: typeof fetch) => ({ accountId: "A", apiToken: "T", fetchImpl });
    await expect(fetchWorkersAIModels("m", source(makeFetchStub({}, { status: 500 })))).rejects.toThrow(
      "the Workers AI model catalog returned HTTP 500",
    );
    await expect(fetchWorkersAIModels("m", source(makeFetchStub({ result: {} })))).rejects.toThrow(
      "the Workers AI model catalog returned an unexpected response",
    );
  });

  it("looks a price up by exact model name, not by the first search hit", async () => {
    const models = async () => [entry("@cf/test/model-large", rate("per M input tokens", 9), rate("per M output tokens", 9)), catalogEntry];
    const lookup = workersAIPriceLookup({ binding: { models } });
    await expect(lookup("@cf/test/model")).resolves.toMatchObject({ inputPerMillion: 0.152 });
    await expect(lookup("@cf/other")).resolves.toBeUndefined();
  });

  it("reports cached prompt tokens from the reply", async () => {
    const reported: unknown[] = [];
    const run = async () => ({
      choices: [{ message: { content: "OK" } }],
      usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 64 } },
    });
    await createWorkersAIBindingTranslator({ modelId: "m", maxTokens: 10, run }).translate("s", "u", undefined, (info) =>
      reported.push(info),
    );
    expect(reported).toEqual([{ inputTokens: 100, cachedInputTokens: 64, outputTokens: 5 }]);
  });
});

describe("Anthropic translator", () => {
  function createAnthropic(fetchImpl: typeof fetch) {
    return createAnthropicTranslator({ apiKey: "KEY", modelId: "claude-test", maxTokens: 8192, fetchImpl });
  }

  it("explains replies cut off at the output token limit", async () => {
    const translator = createAnthropic(makeFetchStub({ content: [{ type: "text", text: "@@a@@\nPart" }], stop_reason: "max_tokens" }));
    await expect(translator.translate("s", "u")).rejects.toThrow('model ran out of output tokens (model="claude-test", max_tokens=8192)');
  });

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

  it("reports the whole prompt as input, with cache reads as the cached part", async () => {
    const reported: unknown[] = [];
    const translator = createAnthropic(
      makeFetchStub({
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, cache_read_input_tokens: 70, cache_creation_input_tokens: 20, output_tokens: 5 },
      }),
    );
    await translator.translate("s", "u", undefined, (info) => reported.push(info));
    expect(reported).toEqual([{ finishReason: "end_turn", inputTokens: 100, cachedInputTokens: 70, outputTokens: 5 }]);
  });

  it("omits cached tokens when nothing was read from the cache, and tokens the reply lacks", async () => {
    const reported: unknown[] = [];
    const withUsage = createAnthropic(
      makeFetchStub({ content: [{ type: "text", text: "OK" }], usage: { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 5 } }),
    );
    await withUsage.translate("s", "u", undefined, (info) => reported.push(info));
    await createAnthropic(makeFetchStub({ content: [{ type: "text", text: "OK" }] })).translate("s", "u", undefined, (info) =>
      reported.push(info),
    );
    expect(reported).toEqual([{ inputTokens: 10, outputTokens: 5 }, {}]);
  });

  it("reports tokens even when the reply is cut off at the output limit", async () => {
    const reported: unknown[] = [];
    const translator = createAnthropic(
      makeFetchStub({ content: [], stop_reason: "max_tokens", usage: { input_tokens: 10, output_tokens: 8192 } }),
    );
    await expect(translator.translate("s", "u", undefined, (info) => reported.push(info))).rejects.toThrow("ran out of output tokens");
    expect(reported).toEqual([{ finishReason: "max_tokens", inputTokens: 10, outputTokens: 8192 }]);
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

describe("workersAIRequestParams", () => {
  it("moves a top-level enable_thinking into chat_template_kwargs, keeping other kwargs", () => {
    expect(workersAIRequestParams({ enable_thinking: false, temperature: 0.2 })).toEqual({
      temperature: 0.2,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(workersAIRequestParams({ enable_thinking: true, chat_template_kwargs: { clear_thinking: true } })).toEqual({
      chat_template_kwargs: { clear_thinking: true, enable_thinking: true },
    });
  });

  it("passes params without enable_thinking through, and undefined as undefined", () => {
    const params = { chat_template_kwargs: { enable_thinking: false } };
    expect(workersAIRequestParams(params)).toBe(params);
    expect(workersAIRequestParams(undefined)).toBeUndefined();
  });

  it("throws on params that set enable_thinking twice", () => {
    expect(() => workersAIRequestParams({ enable_thinking: true, chat_template_kwargs: { enable_thinking: false } })).toThrow(
      "[polystella] Workers AI params",
    );
  });
});
