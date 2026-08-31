#!/usr/bin/env tsx
/** Compile the local public-package example with the workspace compiler. */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const DOCS_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPOSITORY_ROOT = path.join(DOCS_ROOT, "..");
const EXAMPLE_CONFIG = path.join(DOCS_ROOT, "examples", "direct-packages", "tsconfig.json");
const tsc = fileURLToPath(import.meta.resolve("typescript/bin/tsc"));

function main(): void {
  const result = spawnSync(process.execPath, [tsc, "--noEmit", "-p", EXAMPLE_CONFIG], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    throw new Error("failed to start TypeScript for direct-packages compilation", { cause: result.error });
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    throw new Error(`direct-packages failed to compile:\n${output}`);
  }
  console.log("[check-examples] direct-packages compiled with tsc.");
}

try {
  main();
} catch (err) {
  console.error("[check-examples] failed:", err);
  process.exitCode = 1;
}
