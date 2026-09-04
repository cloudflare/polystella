#!/usr/bin/env tsx
/** Check that the exports table exactly matches all public manifests. */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DOCS_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PACKAGE_MANIFESTS = [
  { owner: "Core", directory: "core" },
  { owner: "Adapters", directory: "adapters" },
  { owner: "Providers", directory: "providers" },
  { owner: "CLI", directory: "cli" },
  { owner: "EmDash", directory: "emdash" },
  { owner: "Astro", directory: "astro" },
  { owner: "Astro", directory: "polystella" },
] as const;
const EXPORTS_PAGE = path.join(DOCS_ROOT, "src", "content", "docs", "reference", "exports.md");

interface PackageJson {
  name: string;
  exports?: Record<string, unknown>;
}

interface DocumentedExport {
  owner: string;
  importPath: string;
  example: string;
}

function parseExportsTable(content: string): DocumentedExport[] {
  const lines = content.split("\n");
  const headerIndex = lines.findIndex((line) => {
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    return cells.join("|") === "Owner|Path|Purpose|Example";
  });
  if (headerIndex < 0) throw new Error("exports page has no Owner/Path/Purpose/Example table");

  const rows: DocumentedExport[] = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== 4) throw new Error(`invalid exports table row: ${line}`);
    const [owner, pathCell, , exampleCell] = cells;
    const importPath = pathCell?.match(/^`([^`]+)`$/)?.[1];
    const example = exampleCell?.match(/^`([^`]+)`$/)?.[1];
    if (!owner || !importPath || !example) throw new Error(`invalid exports table row: ${line}`);
    rows.push({ owner, importPath, example });
  }
  return rows;
}

async function main(): Promise<void> {
  const actual = new Map<string, string>();
  for (const packageInfo of PACKAGE_MANIFESTS) {
    const manifestPath = path.join(DOCS_ROOT, "..", "packages", packageInfo.directory, "package.json");
    const pkg = JSON.parse(await readFile(manifestPath, "utf8")) as PackageJson;
    if (!pkg.exports || typeof pkg.exports !== "object") throw new Error(`${pkg.name} has no \`exports\` map`);
    for (const key of Object.keys(pkg.exports)) {
      const importPath = key === "." ? pkg.name : `${pkg.name}${key.slice(1)}`;
      actual.set(importPath, packageInfo.owner);
    }
  }

  const documented = parseExportsTable(await readFile(EXPORTS_PAGE, "utf8"));
  const documentedPaths = documented.map(({ importPath }) => importPath);
  const duplicates = documentedPaths.filter((importPath, index) => documentedPaths.indexOf(importPath) !== index);
  const missing = [...actual.keys()].filter((importPath) => !documentedPaths.includes(importPath));
  const extra = documentedPaths.filter((importPath) => !actual.has(importPath));
  const badOwners = documented.filter(({ owner, importPath }) => actual.get(importPath) !== owner);
  const badExamples = documented.filter(
    ({ importPath, example }) =>
      !example.includes(`from "${importPath}"`) &&
      !example.includes(`import "${importPath}"`) &&
      !example.includes(`types="${importPath}"`),
  );

  const errors = [
    ...duplicates.map((value) => `duplicate: ${value}`),
    ...missing.map((value) => `missing: ${value}`),
    ...extra.map((value) => `extra: ${value}`),
    ...badOwners.map(({ importPath, owner }) => `wrong owner: ${importPath} (${owner})`),
    ...badExamples.map(({ importPath }) => `missing import/reference example: ${importPath}`),
  ];
  if (errors.length > 0) throw new Error(`exports table does not match manifests:\n${errors.map((error) => `  - ${error}`).join("\n")}`);

  console.log(`[check-exports] ${documented.length} export paths exactly documented with examples.`);
}

main().catch((err) => {
  console.error("[check-exports] failed:", err);
  process.exitCode = 1;
});
