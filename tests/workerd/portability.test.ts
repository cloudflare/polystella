import { jsonAdapter, markdownAdapter } from "@cloudflare/polystella-adapters";
import {
  buildPrompt,
  EMPTY_GLOSSARY,
  packGroupsIntoBatches,
  parseResponse,
  translateBatch,
  type Segment,
} from "@cloudflare/polystella-core";
import { buildTranslateFn } from "@cloudflare/polystella-core/catalog";
import { extractTokens, translateCatalogEntries } from "@cloudflare/polystella-core/catalog/translate";
import { createWorkersAIBindingTranslator, createWorkersAIHttpTranslator } from "@cloudflare/polystella-providers/workers-ai";
import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

const segment: Segment = { id: "body:0", text: "Hello" };

describe("core in workerd", () => {
  it("resolves catalogs and extracts interpolation tokens", () => {
    const translate = buildTranslateFn({ greeting: "Ola, {{name}}" });

    expect(translate("greeting", { name: "Diogo" })).toBe("Ola, Diogo");
    expect(extractTokens("Ola, {{name}}")).toEqual(new Set(["name"]));
  });

  it("translates selected catalog entries", async () => {
    const result = await translateCatalogEntries({
      translator: { modelId: "test", translate: async () => "@@catalog:0@@\nOla" },
      glossary: EMPTY_GLOSSARY,
      entries: [{ key: "greeting", source: "Hello" }],
      sourceLocale: "en-US",
      targetLocale: "pt-BR",
    });

    expect(result.translations.get("greeting")).toBe("Ola");
  });

  it("builds prompts and parses marker responses", () => {
    const prompt = buildPrompt({
      segments: [segment],
      glossary: EMPTY_GLOSSARY,
      sourceLocale: "en-US",
      targetLocale: "pt-BR",
    });

    expect(prompt.systemPrompt).toContain("Brazilian Portuguese (pt-BR)");
    expect(prompt.userPrompt).toContain("@@body:0@@\nHello");
    expect(parseResponse("@@body:0@@\nOla", [segment.id]).get(segment.id)).toBe("Ola");
  });

  it("batches without losing reference identity or order", () => {
    const second: Segment = { id: "body:1", text: "World" };
    const batches = packGroupsIntoBatches([[segment], [second]], { inputTokenBudget: 4 });

    expect(batches.flat()).toEqual([segment, second]);
    expect(batches.flat()[0]).toBe(segment);
    expect(batches.flat()[1]).toBe(second);
  });

  it("retries parse failures and honors cancellation", async () => {
    let attempts = 0;
    const result = await translateBatch({
      translator: {
        modelId: "test",
        translate: async () => (++attempts === 1 ? "invalid" : "@@body:0@@\nOla"),
      },
      segments: [segment],
      glossary: EMPTY_GLOSSARY,
      sourceLocale: "en-US",
      targetLocale: "pt-BR",
      maxRetries: 1,
    });
    expect(result.get(segment.id)).toBe("Ola");
    expect(attempts).toBe(2);

    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      translateBatch({
        translator: { modelId: "test", translate: async () => "@@body:0@@\nignored" },
        segments: [segment],
        glossary: EMPTY_GLOSSARY,
        sourceLocale: "en-US",
        targetLocale: "pt-BR",
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
  });
});

describe("adapters in workerd", () => {
  it("round-trips JSON and applies a translation", () => {
    const source = '{"entry":{"title":"Hello"}}';
    const options = { sourcePath: "content/entry.json", translatableKeys: { "content/**": ["entry.title"] } };
    const parsed = jsonAdapter.parse(source);
    const segments = jsonAdapter.extractSegments(parsed, source, options);

    expect(segments).toEqual([{ id: "entry.title", text: "Hello" }]);
    const output = jsonAdapter.applyTranslations(parsed, source, new Map([["entry.title", "Ola"]]));
    expect(JSON.parse(output)).toEqual({ entry: { title: "Ola" } });
  });

  it("round-trips Remark Markdown and applies translations", () => {
    const source = "# Hello\n\nA **bold** paragraph.\n";
    const options = { sourcePath: "content/entry.md", translatableKeys: {} };
    const parsed = markdownAdapter.parse(source, options.sourcePath);
    const segments = markdownAdapter.extractSegments(parsed, source, options);

    expect(markdownAdapter.applyTranslations(parsed, source, new Map())).toBe(source);
    expect(
      markdownAdapter.applyTranslations(
        parsed,
        source,
        new Map([
          ["body:0", "Ola"],
          ["body:1", "Um paragrafo **em negrito**."],
        ]),
      ),
    ).toBe("# Ola\n\nUm paragrafo **em negrito**.\n");
    expect(segments.map(({ id }) => id)).toEqual(["body:0", "body:1"]);
  });
});

describe("Workers AI providers in workerd", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("invokes a binding callback with the documented input", async () => {
    const run = vi.fn(async () => ({ response: "Ola" }));
    const translator = createWorkersAIBindingTranslator({ modelId: "@cf/test/model", maxTokens: 64, run });

    await expect(translator.translate("system", "user")).resolves.toBe("Ola");
    expect(run).toHaveBeenCalledWith("@cf/test/model", {
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "user" },
      ],
      max_tokens: 64,
    });
  });

  it("uses a fake global fetch for the HTTP transport", async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => Response.json({ success: true, result: { response: "Ola" } }));
    vi.stubGlobal("fetch", fetchMock);
    const translator = createWorkersAIHttpTranslator({
      accountId: "account",
      apiToken: "token",
      modelId: "@cf/test/model",
      maxTokens: 64,
    });

    await expect(translator.translate("system", "user")).resolves.toBe("Ola");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.cloudflare.com/client/v4/accounts/account/ai/run/@cf/test/model");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  });
});

it("executes the no-compat Worker fixture", async () => {
  const response = await SELF.fetch("https://example.test/");
  expect(await response.json()).toEqual({
    prompt: true,
    catalog: "Ola, Diogo",
    tokens: ["name"],
    title: "Ola",
    translation: "Ola",
  });
});
