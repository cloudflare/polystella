import { describe, expect, it } from "vitest";

import { isCatalogCommand, runCatalogCommand } from "../src/run-command.js";

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
});
