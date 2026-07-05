import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseAuditMdxArgs, runAuditMdx } from "../../src/cli/audit-mdx.js";

async function makeProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "polystella-audit-mdx-"));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, contents, "utf8");
  }
  return dir;
}

function baseFiles(polystellaConfig: string): Record<string, string> {
  return {
    "astro.config.mjs": `export default { i18n: { defaultLocale: "en-US", locales: ["en-US", "pt-BR"] } };\n`,
    "polystella.config.mjs": polystellaConfig,
    "content/docs/page.mdx": [
      'import Callout from "../../components/Callout.astro";',
      "",
      '<Callout title="Beta notice" type="warning" />',
      "<Callout title={`Hello ${name}`} />",
      "",
    ].join("\n"),
  };
}

describe("audit-mdx CLI", () => {
  it("parses flags", () => {
    expect(parseAuditMdxArgs(["--json", "--file", "docs/*.mdx"])).toEqual({ json: true, help: false, file: "docs/*.mdx" });
  });

  it("reports unconfigured component props and expression props", async () => {
    const cwd = await makeProject(baseFiles(`export default { sourceDir: "./content", include: ["**/*.mdx"] };\n`));
    const lines: string[] = [];

    const code = await runAuditMdx(
      { json: false, help: false },
      {
        cwd,
        log: (msg) => lines.push(msg),
        err: (msg) => lines.push(msg),
      },
    );

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("unconfigured-component-prop");
    expect(lines.join("\n")).toContain("unsupported-expression-prop");
    expect(lines.join("\n")).toContain("Callout.title");
  });

  it("does not report component props configured in markdown.mdx.components", async () => {
    const cwd = await makeProject(
      baseFiles(
        `export default { sourceDir: "./content", include: ["**/*.mdx"], markdown: { mdx: { components: { Callout: { props: ["title"] } } } } };\n`,
      ),
    );
    const lines: string[] = [];

    await runAuditMdx(
      { json: false, help: false },
      {
        cwd,
        log: (msg) => lines.push(msg),
        err: (msg) => lines.push(msg),
      },
    );

    expect(lines.join("\n")).not.toContain("unconfigured-component-prop");
    expect(lines.join("\n")).toContain("unsupported-expression-prop");
  });

  it("emits JSON output", async () => {
    const cwd = await makeProject(baseFiles(`export default { sourceDir: "./content", include: ["**/*.mdx"] };\n`));
    const lines: string[] = [];

    await runAuditMdx(
      { json: true, help: false },
      {
        cwd,
        log: (msg) => lines.push(msg),
        err: (msg) => lines.push(msg),
      },
    );

    const parsed = JSON.parse(lines.join("\n")) as { findings: unknown[] };
    expect(parsed.findings.length).toBeGreaterThan(0);
  });

  it("reports unannotated static data and unsupported static-data shapes", async () => {
    const cwd = await makeProject({
      "astro.config.mjs": `export default { i18n: { defaultLocale: "en-US", locales: ["en-US", "pt-BR"] } };\n`,
      "polystella.config.mjs": `export default { sourceDir: "./content", include: ["**/*.mdx"] };\n`,
      "content/docs/static.mdx": [
        'export const cards = [{ title: "Read the guide", icon: "book" }];',
        'export const weird = /** @polystella translate title, description */ [',
        '  { ...shared, ["title"]: "Computed title", title: `Hello ${name}`, description: ok ? "Yes please" : "No thanks" },',
        "];",
        "",
      ].join("\n"),
    });
    const lines: string[] = [];

    const code = await runAuditMdx(
      { json: false, help: false },
      {
        cwd,
        log: (msg) => lines.push(msg),
        err: (msg) => lines.push(msg),
      },
    );

    const output = lines.join("\n");
    expect(code).toBe(0);
    expect(output).toContain("unannotated-static-data");
    expect(output).toContain("unsupported-static-data-shape");
    expect(output).toContain("spread syntax");
    expect(output).toContain("computed key");
    expect(output).toContain("template literal");
    expect(output).toContain("conditional expression");
  });

  it("honours @polystella ignore comments", async () => {
    const cwd = await makeProject({
      "astro.config.mjs": `export default { i18n: { defaultLocale: "en-US", locales: ["en-US", "pt-BR"] } };\n`,
      "polystella.config.mjs": `export default { sourceDir: "./content", include: ["**/*.mdx"] };\n`,
      "content/docs/page.mdx": [
        'import Callout from "../../components/Callout.astro";',
        "",
        "{/* @polystella ignore */}",
        '<Callout title="Ignored title" />',
        "",
        '<Callout title="Reported title" />',
        "",
      ].join("\n"),
    });
    const lines: string[] = [];

    await runAuditMdx(
      { json: false, help: false },
      {
        cwd,
        log: (msg) => lines.push(msg),
        err: (msg) => lines.push(msg),
      },
    );

    const output = lines.join("\n");
    expect(output).not.toContain("Ignored title");
    expect(output).toContain("Reported title");
  });

  it("reports opaque custom component children that may need a children rule", async () => {
    const cwd = await makeProject({
      "astro.config.mjs": `export default { i18n: { defaultLocale: "en-US", locales: ["en-US", "pt-BR"] } };\n`,
      "polystella.config.mjs": `export default { sourceDir: "./content", include: ["**/*.mdx"] };\n`,
      "content/docs/page.mdx": [
        'import Mystery from "../../components/Mystery.astro";',
        "",
        "<Mystery>",
        "This copy might be hidden by the component.",
        "</Mystery>",
        "",
      ].join("\n"),
    });
    const lines: string[] = [];

    await runAuditMdx(
      { json: false, help: false },
      {
        cwd,
        log: (msg) => lines.push(msg),
        err: (msg) => lines.push(msg),
      },
    );

    const output = lines.join("\n");
    expect(output).toContain("opaque-component-children");
    expect(output).toContain("Mystery");
    expect(output).toContain("children: true");
  });

  it("does not report opaque children when the component has children: true", async () => {
    const cwd = await makeProject({
      "astro.config.mjs": `export default { i18n: { defaultLocale: "en-US", locales: ["en-US", "pt-BR"] } };\n`,
      "polystella.config.mjs": `export default { sourceDir: "./content", include: ["**/*.mdx"], markdown: { mdx: { components: { Mystery: { children: true } } } } };\n`,
      "content/docs/page.mdx": [
        'import Mystery from "../../components/Mystery.astro";',
        "",
        "<Mystery>",
        "This copy is configured for traversal.",
        "</Mystery>",
        "",
      ].join("\n"),
    });
    const lines: string[] = [];

    await runAuditMdx(
      { json: false, help: false },
      {
        cwd,
        log: (msg) => lines.push(msg),
        err: (msg) => lines.push(msg),
      },
    );

    expect(lines.join("\n")).not.toContain("opaque-component-children");
  });
});
