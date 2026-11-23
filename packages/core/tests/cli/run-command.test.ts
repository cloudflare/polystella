import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isCatalogCommand, runCatalogCommand } from "../../src/cli/run-command.js";

describe("catalog command dispatch", () => {
  it("preserves all three catalog command names", async () => {
    const output: string[] = [];
    const dependencies = {
      cwd: process.cwd(),
      log: (message: string) => output.push(message),
      warn: (message: string) => output.push(message),
      err: (message: string) => output.push(message),
    };

    for (const command of ["check-ui", "sync-ui", "translate-ui"] as const) {
      expect(isCatalogCommand(command)).toBe(true);
      await expect(runCatalogCommand(command, ["--help"], dependencies)).resolves.toBe(0);
    }

    expect(output.join("\n")).toContain("polystella check-ui");
    expect(output.join("\n")).toContain("polystella sync-ui");
    expect(output.join("\n")).toContain("polystella translate-ui");
  });

  it("reports an unreadable catalog with exit 1 instead of throwing", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "polystella-run-command-"));
    await mkdir(path.join(cwd, "src/content/i18n"), { recursive: true });
    await writeFile(path.join(cwd, "astro.config.mjs"), `export default { i18n: { defaultLocale: "en", locales: ["en", "de"] } };\n`);
    await writeFile(path.join(cwd, "src/content/i18n/en.json"), JSON.stringify({ plural: [{ match: {} }] }));
    const err: string[] = [];
    const dependencies = { cwd, log: () => {}, warn: () => {}, err: (message: string) => err.push(message) };

    await expect(runCatalogCommand("check-ui", [], dependencies)).resolves.toBe(1);
    expect(err.join("\n")).toMatch(/^\[polystella\] catalog value at "plural"[\s\S]*catalog\.ignoreKeys/);
  });
});
