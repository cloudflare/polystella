import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { CatalogGlossaryConfig } from "../../src/cli/config.js";
import {
  assertSingleGlossarySource,
  glossarySourceLabel,
  hashGlossary,
  loadGlossaries,
  loadGlossariesWithSources,
} from "../../src/cli/glossary.js";

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

  it("keeps each fetched glossary's YAML text outside the glossary", async () => {
    const yaml = "# comment\nnotes: kept\n";
    const config = { locales: ["pt-BR"], glossary: { http: { url: "https://example.com/{locale}.yaml" } } };
    const fetchImpl: typeof fetch = async () => new Response(yaml);

    const loaded = await loadGlossariesWithSources({ config, fetch: fetchImpl });
    const plain = await loadGlossaries({ config, fetch: fetchImpl });

    expect(loaded.get("pt-BR")?.source).toBe(yaml);
    expect(plain.get("pt-BR")).not.toHaveProperty("source");
    expect(loaded.get("pt-BR")?.glossary).toEqual(plain.get("pt-BR"));
  });

  it("keeps file and R2 YAML text exactly, comments and all, and none for inline glossaries", async () => {
    const yaml = "# top comment\r\nversion: v1  # trailing\r\nnotes: kept\r\n";
    const directory = await mkdtemp(path.join(tmpdir(), "polystella-glossary-"));
    try {
      await writeFile(path.join(directory, "pt-BR.yaml"), yaml);
      const config = { locales: ["pt-BR", "ja-JP"], glossary: { file: "./{locale}.yaml" } };
      const projectRoot = pathToFileURL(`${directory}/`);
      const loaded = await loadGlossariesWithSources({ config, projectRoot });
      const plain = await loadGlossaries({ config, projectRoot });
      expect([...loaded.keys()]).toEqual(["pt-BR"]);
      expect(loaded.get("pt-BR")?.source).toBe(yaml);
      expect(loaded.get("pt-BR")?.glossary).toEqual(plain.get("pt-BR"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    const inline = await loadGlossariesWithSources({
      config: { locales: ["pt-BR"], glossary: { inline: { "pt-BR": { notes: "n" } } } },
    });
    expect(inline.get("pt-BR")).not.toHaveProperty("source");
    expect(inline.get("pt-BR")?.glossary.notes).toBe("n");

    const r2 = await loadGlossariesWithSources({
      config: {
        locales: ["pt-BR"],
        glossary: { r2: { accountId: "a", bucket: "b", key: "{locale}.yaml", accessKeyId: "k", secretAccessKey: "s" } },
      },
      fetch: async () => new Response("# from R2\nnotes: r2\n"),
    });
    expect(r2.get("pt-BR")?.source).toBe("# from R2\nnotes: r2\n");
    expect((await loadGlossariesWithSources({ config: { locales: ["pt-BR"] } })).size).toBe(0);
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
