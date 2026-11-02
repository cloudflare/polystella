import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
    expect(middlewareSource).toMatch(/from "file:.*\/catalog\/middleware\.js"/);
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

describe("catalogAstro localeTags and message checks", () => {
  async function runSetup(options: Parameters<typeof catalogAstro>[0], files: Record<string, string>, locales: string[]) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "polystella-catalog-root-"));
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "polystella-catalog-cache-"));
    await mkdir(path.join(rootDir, "src", "i18n"), { recursive: true });
    for (const [name, contents] of Object.entries(files)) await writeFile(path.join(rootDir, "src", "i18n", name), contents, "utf8");
    const warnings: string[] = [];
    const plugins: CapturedVitePlugin[] = [];
    const middleware: CapturedMiddleware[] = [];
    const setup = catalogAstro({ baseDir: "./src/i18n", ...options }).hooks["astro:config:setup"];
    if (setup === undefined) throw new Error("missing config setup hook");
    await (setup as (ctx: unknown) => Promise<void> | void)({
      config: {
        root: pathToFileURL(rootDir + path.sep),
        cacheDir: pathToFileURL(cacheDir + path.sep),
        i18n: { defaultLocale: "en", locales },
      },
      logger: { info: () => {}, warn: (message: string) => warnings.push(message), error: () => {}, debug: () => {} },
      addMiddleware: (entry: CapturedMiddleware) => middleware.push(entry),
      updateConfig: (update: { vite?: { plugins?: CapturedVitePlugin[] } }) => {
        for (const plugin of update.vite?.plugins ?? []) plugins.push(plugin);
      },
    });
    return { warnings, plugins, middleware };
  }

  it("exposes localeTags to the virtual module and middleware", async () => {
    const { plugins, middleware } = await runSetup({ localeTags: { jp: "ja" } }, {}, ["en", "jp"]);
    const source = plugins.find((plugin) => plugin.name === "polystella:catalog")?.load?.("\0polystella:catalog");
    expect(source).toContain('export const localeTags = {"jp":"ja"}');
    const entry = middleware[0];
    if (entry === undefined) throw new Error("missing generated middleware");
    expect(await readFile(entry.entrypoint, "utf8")).toContain("  localeTags,");
  });

  it("fails on locale codes Intl does not recognise", async () => {
    await expect(runSetup({}, {}, ["en", "jp"])).rejects.toThrow(/locale "jp" uses tag "jp"/);
  });

  it("warns about invalid catalog messages without failing the build", async () => {
    const { warnings } = await runSetup(
      {},
      { "en.json": JSON.stringify({ a: "Hi {{name}}" }), "pt-BR.json": JSON.stringify({ a: "Olá {{nome}}" }) },
      ["en", "pt-BR"],
    );
    expect(warnings.join("\n")).toContain('pt-BR.json "a": missing {{name}}; {{nome}} is not in the source');
  });
});
