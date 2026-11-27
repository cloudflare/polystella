import { afterEach, describe, expect, it, vi } from "vitest";

import type { CatalogProviderConfig } from "../../src/cli/config.js";
import { createPriceLookup } from "../../src/cli/provider.js";

const catalogEntry = {
  name: "@cf/test/model",
  properties: [
    {
      property_id: "price",
      value: [
        { unit: "per M input tokens", price: 0.152, currency: "USD" },
        { unit: "per M output tokens", price: 0.5, currency: "USD" },
        { unit: "per M cached input tokens", price: 0.03, currency: "USD" },
      ],
    },
  ],
};

const workers: CatalogProviderConfig = {
  kind: "workers-ai",
  accountId: "acct",
  apiToken: "SECRET",
  model: "@cf/test/model",
  maxTokens: 8192,
  batchInputTokenBudget: 4000,
};

function stubFetch(response: () => Response) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => response());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("createPriceLookup", () => {
  it("reads the Workers AI catalog with the Bearer token and parses the price when there is no endpoint", async () => {
    const fetchMock = stubFetch(() => Response.json({ result: [catalogEntry] }));
    await expect(createPriceLookup(workers)("@cf/test/model")).resolves.toEqual({
      inputPerMillion: 0.152,
      outputPerMillion: 0.5,
      cachedInputPerMillion: 0.03,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/ai/models/search?search=%40cf%2Ftest%2Fmodel");
    expect(init?.headers).toEqual({ Authorization: "Bearer SECRET" });
  });

  it("never calls the catalog, and so never sends the token, when a custom endpoint is set", async () => {
    const fetchMock = stubFetch(() => Response.json({ result: [catalogEntry] }));
    const lookup = createPriceLookup({ ...workers, endpoint: "https://gateway.test/workers-ai" });
    await expect(lookup("@cf/test/model")).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses provider.prices with a custom endpoint, and over the catalog without one", async () => {
    const fetchMock = stubFetch(() => Response.json({ result: [catalogEntry] }));
    const prices = { "@cf/test/model": { inputPerMillion: 1, outputPerMillion: 2 } };
    await expect(createPriceLookup({ ...workers, endpoint: "https://gateway.test/workers-ai", prices })("@cf/test/model")).resolves.toBe(
      prices["@cf/test/model"],
    );
    await expect(createPriceLookup({ ...workers, prices })("@cf/test/model")).resolves.toBe(prices["@cf/test/model"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never calls the catalog for Anthropic", async () => {
    const fetchMock = stubFetch(() => Response.json({ result: [catalogEntry] }));
    const anthropic: CatalogProviderConfig = {
      kind: "anthropic",
      apiKey: "k",
      model: "claude-test",
      maxTokens: 8192,
      batchInputTokenBudget: 4000,
    };
    await expect(createPriceLookup(anthropic)("claude-test")).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a catalog failure through onError and resolves undefined", async () => {
    stubFetch(() => new Response("no", { status: 500 }));
    const onError = vi.fn();
    await expect(createPriceLookup(workers, onError)("@cf/test/model")).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(
      "@cf/test/model",
      expect.objectContaining({ message: "the Workers AI model catalog returned HTTP 500" }),
    );
  });
});
