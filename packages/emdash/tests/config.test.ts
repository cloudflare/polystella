import { describe, expect, it } from "vitest";

import { loadGlossaryDefaults, type LoadGlossaryDefaultsOptions } from "../src/config.js";

describe("loadGlossaryDefaults", () => {
  it("loads non-file sources without a project root", async () => {
    const glossaries = await loadGlossaryDefaults({
      locales: ["pt-BR"],
      inline: {
        "pt-BR": {
          preferredTranslations: { edge: "borda" },
        },
      },
    });

    expect(glossaries["pt-BR"]?.preferredTranslations.edge).toBe("borda");
  });

  it("rejects multiple sources at runtime", async () => {
    const mixed = {
      locales: ["pt-BR"],
      file: "./{locale}.yaml",
      http: { url: "https://example.com/{locale}.yaml" },
      projectRoot: new URL("file:///tmp/"),
    } as unknown as LoadGlossaryDefaultsOptions;

    await expect(loadGlossaryDefaults(mixed)).rejects.toThrow(/exactly one/);
  });
});
