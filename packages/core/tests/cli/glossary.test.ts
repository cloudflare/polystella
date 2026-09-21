import { describe, expect, it, vi } from "vitest";

import type { CatalogGlossaryConfig } from "../../src/cli/config.js";
import { assertSingleGlossarySource, glossarySourceLabel, hashGlossary, loadGlossaries } from "../../src/cli/glossary.js";

describe("external glossaries", () => {
  it("loads one HTTP glossary per configured locale", async () => {
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      requested.push(request.url);
      expect(request.headers.get("authorization")).toBe("Bearer test-token");
      const locale = request.url.includes("pt-BR") ? "pt-BR" : "ja-JP";
      return new Response(`notes: ${locale}\npreferredTranslations:\n  edge: ${locale}-edge`);
    };

    const glossaries = await loadGlossaries({
      config: {
        locales: ["pt-BR", "ja-JP"],
        glossary: {
          http: {
            url: "https://example.com/glossaries/{locale}.yaml",
            headers: { Authorization: "Bearer test-token" },
          },
        },
      },
      fetch: fetchImpl,
    });

    expect(requested.sort()).toEqual(["https://example.com/glossaries/ja-JP.yaml", "https://example.com/glossaries/pt-BR.yaml"]);
    expect(glossaries.get("pt-BR")?.preferredTranslations.edge).toBe("pt-BR-edge");
    expect(glossaries.get("ja-JP")?.notes).toBe("ja-JP");
  });

  it("retries one transient HTTP failure", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("notes: recovered"));

    const glossaries = await loadGlossaries({
      config: { locales: ["pt-BR"], glossary: { http: { url: "https://example.com/{locale}.yaml" } } },
      fetch: fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(glossaries.get("pt-BR")?.notes).toBe("recovered");
  });

  it("retries when the HTTP response body fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("connection reset"));
          },
        }),
      );
    });
    fetchImpl.mockResolvedValueOnce(new Response("notes: recovered body"));

    const glossaries = await loadGlossaries({
      config: { locales: ["pt-BR"], glossary: { http: { url: "https://example.com/{locale}.yaml" } } },
      fetch: fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(glossaries.get("pt-BR")?.notes).toBe("recovered body");
  });

  it("fails on missing remote files without leaking URL secrets", async () => {
    const promise = loadGlossaries({
      config: {
        locales: ["pt-BR"],
        glossary: { http: { url: "https://example.com/{locale}.yaml?token=do-not-log" } },
      },
      fetch: async () => new Response("missing", { status: 404 }),
    });

    await expect(promise).rejects.toThrow(/HTTP 404/);
    await expect(promise).rejects.not.toThrow(/do-not-log/);
  });

  it("requires HTTPS and a locale placeholder", async () => {
    await expect(
      loadGlossaries({
        config: { locales: ["pt-BR"], glossary: { http: { url: "http://example.com/{locale}.yaml" } } },
        fetch: async () => new Response("notes: unused"),
      }),
    ).rejects.toThrow(/HTTPS/);
    await expect(
      loadGlossaries({
        config: { locales: ["pt-BR"], glossary: { http: { url: "https://example.com/glossary.yaml" } } },
      }),
    ).rejects.toThrow(/{locale}/);
  });

  it("rejects oversized remote glossaries", async () => {
    await expect(
      loadGlossaries({
        config: { locales: ["pt-BR"], glossary: { http: { url: "https://example.com/{locale}.yaml" } } },
        fetch: async () => new Response("", { headers: { "content-length": "1048577" } }),
      }),
    ).rejects.toThrow(/1048576-byte limit/);
  });

  it("forwards cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      loadGlossaries({
        config: { locales: ["pt-BR"], glossary: { http: { url: "https://example.com/{locale}.yaml" } } },
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/i);
  });

  it("loads and signs private R2 glossary requests", async () => {
    const requests: Request[] = [];
    const glossaries = await loadGlossaries({
      config: {
        locales: ["pt-BR"],
        glossary: {
          r2: {
            accountId: "account-id",
            bucket: "shared-glossaries",
            key: "locales/{locale}.yaml",
            accessKeyId: "access-key",
            secretAccessKey: "secret-key",
          },
        },
      },
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response("notes: from R2");
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain("/shared-glossaries/locales/pt-BR.yaml");
    expect(requests[0]?.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(glossaries.get("pt-BR")?.notes).toBe("from R2");
  });

  it("retries R2 5xx once and does not retry permanent 4xx", async () => {
    const r2 = {
      accountId: "account-id",
      bucket: "shared-glossaries",
      key: "locales/{locale}.yaml",
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
    } as const;
    const transientFetch = vi.fn<typeof fetch>().mockImplementation(async () => new Response("unavailable", { status: 503 }));
    await expect(loadGlossaries({ config: { locales: ["pt-BR"], glossary: { r2 } }, fetch: transientFetch })).rejects.toThrow(/HTTP 503/);
    expect(transientFetch).toHaveBeenCalledTimes(2);

    const permanentFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response("forbidden", { status: 403 }));
    await expect(loadGlossaries({ config: { locales: ["pt-BR"], glossary: { r2 } }, fetch: permanentFetch })).rejects.toThrow(/HTTP 403/);
    expect(permanentFetch).toHaveBeenCalledTimes(1);
  });

  it("enforces exactly one source at the shared loader boundary", () => {
    const mixed = {
      file: "./{locale}.yaml",
      http: { url: "https://example.com/{locale}.yaml" },
    } as unknown as CatalogGlossaryConfig;
    expect(() => assertSingleGlossarySource(mixed)).toThrow(/exactly one/);
  });

  it("hashes identical glossary content equally across source types", async () => {
    const yaml = "doNotTranslate:\n  - Workers\n  - Cloudflare\nnotes: shared";
    const http = await loadGlossaries({
      config: { locales: ["pt-BR"], glossary: { http: { url: "https://example.com/{locale}.yaml" } } },
      fetch: async () => new Response(yaml),
    });
    const inline = await loadGlossaries({
      config: {
        locales: ["pt-BR"],
        glossary: { inline: { "pt-BR": { doNotTranslate: ["Workers", "Cloudflare"], notes: "shared" } } },
      },
    });

    expect(hashGlossary(http.get("pt-BR")!)).toBe(hashGlossary(inline.get("pt-BR")!));
  });

  it("redacts HTTP source labels and describes R2 keys", () => {
    expect(glossarySourceLabel({ http: { url: "https://user:pass@example.com/{locale}.yaml?token=secret#part" } }, "pt-BR")).toBe(
      "https://example.com/pt-BR.yaml",
    );
    expect(
      glossarySourceLabel(
        {
          r2: {
            accountId: "account-id",
            bucket: "shared-glossaries",
            key: "locales/{locale}.yaml",
            accessKeyId: "access-key",
            secretAccessKey: "secret-key",
          },
        },
        "pt-BR",
      ),
    ).toBe("r2://shared-glossaries/locales/pt-BR.yaml");
  });
});
