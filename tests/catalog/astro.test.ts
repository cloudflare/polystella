import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { catalogAstro } from "../../src/catalog/astro.js";

interface CapturedMiddleware {
  entrypoint: string;
  order: "pre" | "post";
}

interface CapturedVitePlugin {
  name: string;
  resolveId?: (id: string) => string | undefined;
  load?: (id: string) => unknown;
}

describe("catalogAstro", () => {
  it("registers a catalog virtual module and generated middleware without injecting routes", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "polystella-catalog-root-"));
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "polystella-catalog-cache-"));
    const capturedMiddleware: CapturedMiddleware[] = [];
    const capturedPlugins: CapturedVitePlugin[] = [];
    const capturedRoutes: unknown[] = [];
    const integration = catalogAstro({ baseDir: "./src/i18n", noPrefixUrls: ["/api/**"] });
    const setup = integration.hooks["astro:config:setup"];
    if (setup === undefined) throw new Error("missing config setup hook");

    await (setup as (ctx: unknown) => Promise<void> | void)({
      config: {
        root: pathToFileURL(rootDir + path.sep),
        cacheDir: pathToFileURL(cacheDir + path.sep),
        i18n: {
          defaultLocale: "en-US",
          locales: ["en-US", "pt-BR"],
        },
      },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      addMiddleware: (middleware: CapturedMiddleware) => capturedMiddleware.push(middleware),
      injectRoute: (route: unknown) => capturedRoutes.push(route),
      updateConfig: (update: { vite?: { plugins?: CapturedVitePlugin[] } }) => {
        for (const plugin of update.vite?.plugins ?? []) capturedPlugins.push(plugin);
      },
    });

    const plugin = capturedPlugins.find((candidate) => candidate.name === "polystella:catalog");
    expect(plugin).toBeDefined();
    expect(plugin?.resolveId?.("polystella:catalog")).toBe("\0polystella:catalog");
    const virtualSource = plugin?.load?.("\0polystella:catalog");
    expect(virtualSource).toContain('import.meta.glob("/src/i18n/*.json"');
    expect(virtualSource).toContain('export const defaultLocale = "en-US"');
    expect(virtualSource).toContain('export const locales = ["en-US","pt-BR"]');
    expect(virtualSource).toContain('export const noPrefixUrls = ["/api/**"]');

    expect(capturedMiddleware).toHaveLength(1);
    const middleware = capturedMiddleware[0];
    if (middleware === undefined) throw new Error("missing generated middleware");
    expect(middleware.order).toBe("pre");
    expect(middleware.entrypoint).toContain("polystella-catalog");
    const middlewareSource = await readFile(middleware.entrypoint, "utf8");
    expect(middlewareSource).toContain('from "@cloudflare/polystella/catalog/middleware"');
    expect(middlewareSource).toContain('from "polystella:catalog"');
    expect(capturedRoutes).toEqual([]);
  });

  it("skips generated middleware when middleware is false", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "polystella-catalog-root-"));
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "polystella-catalog-cache-"));
    const capturedMiddleware: CapturedMiddleware[] = [];
    const integration = catalogAstro({ middleware: false, driftCheck: false });
    const setup = integration.hooks["astro:config:setup"];
    if (setup === undefined) throw new Error("missing config setup hook");

    await (setup as (ctx: unknown) => Promise<void> | void)({
      config: {
        root: pathToFileURL(rootDir + path.sep),
        cacheDir: pathToFileURL(cacheDir + path.sep),
        i18n: {
          defaultLocale: "en-US",
          locales: ["en-US", "pt-BR"],
        },
      },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      addMiddleware: (middleware: CapturedMiddleware) => capturedMiddleware.push(middleware),
      updateConfig: () => {},
    });

    expect(capturedMiddleware).toEqual([]);
  });
});
