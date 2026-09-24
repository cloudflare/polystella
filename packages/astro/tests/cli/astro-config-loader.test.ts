import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

// Runs core's built loader in a plain Node subprocess: under Vitest, the
// config import would go through Vite and hide the plain-Node failure.
const require = createRequire(import.meta.url);
const coreConfigModule = require.resolve("@cloudflare/polystella-core/cli/config");
const astroPackageDir = path.dirname(require.resolve("astro/package.json"));
const I18N = { defaultLocale: "en-US", locales: ["en-US", "pt-BR"] };

async function scaffoldProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "polystella-astro-config-"));
  await mkdir(path.join(dir, "node_modules"), { recursive: true });
  await symlink(astroPackageDir, path.join(dir, "node_modules", "astro"), "dir");
  for (const [relativePath, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, relativePath)), { recursive: true });
    await writeFile(path.join(dir, relativePath), contents, "utf8");
  }
  return dir;
}

async function loadI18nInNode(cwd: string): Promise<unknown> {
  const script = `const { loadAstroI18n } = await import(process.argv[1]); console.log(JSON.stringify(await loadAstroI18n(process.cwd())));`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, coreConfigModule], { cwd });
  return JSON.parse(stdout);
}

describe("loadAstroI18n", () => {
  it("falls back to Astro's Vite when the config imports a TypeScript-only package", async () => {
    const cwd = await scaffoldProject({
      "node_modules/ts-only-pkg/package.json": JSON.stringify({
        name: "ts-only-pkg",
        type: "module",
        exports: { "./static": "./src/index.ts" },
      }),
      "node_modules/ts-only-pkg/src/index.ts": `export function integration(): { name: string } { return { name: "ts-only" }; }\n`,
      "astro.config.mjs": `import { integration } from "ts-only-pkg/static";\nexport default { integrations: [integration()], i18n: ${JSON.stringify(I18N)} };\n`,
    });
    await expect(loadI18nInNode(cwd)).resolves.toEqual(I18N);
  }, 20_000);

  it("finds astro.config.ts", async () => {
    const cwd = await scaffoldProject({ "astro.config.ts": `const i18n: object = ${JSON.stringify(I18N)};\nexport default { i18n };\n` });
    await expect(loadI18nInNode(cwd)).resolves.toEqual(I18N);
  }, 20_000);
});
