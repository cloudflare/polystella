#!/usr/bin/env node
// @ts-check

import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const playgroundRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = path.resolve(playgroundRoot, "..", "..");
const stagingDir = path.join(playgroundRoot, ".astro", "i18n-staging");
const previewDir = path.join(playgroundRoot, "i18n-preview");
const reportPath = path.join(playgroundRoot, "i18n-r2-report.json");

const extraArgs = process.argv.slice(2);
if (extraArgs.includes("--help") || extraArgs.includes("-h")) {
  printUsage();
  process.exit(0);
}

const loadedEnvFiles = await loadEnvFiles();
const accountId = process.env.POLYSTELLA_WORKERS_AI_ACCOUNT_ID ?? process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.POLYSTELLA_WORKERS_AI_API_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
if (!accountId || !apiToken) {
  printUsage();
  console.error("\n[playground] missing Workers AI credentials.");
  console.error(
    "[playground] set POLYSTELLA_WORKERS_AI_ACCOUNT_ID and POLYSTELLA_WORKERS_AI_API_TOKEN, or CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.",
  );
  process.exit(1);
}

await rm(stagingDir, { recursive: true, force: true });
await rm(previewDir, { recursive: true, force: true });
await rm(reportPath, { force: true });

const code = await runPolystellaTranslate(extraArgs);
if (code !== 0) {
  process.exitCode = code;
} else {
  console.log(`[playground] wrote inspection copies to ${path.relative(playgroundRoot, previewDir)}/`);
  console.log(`[playground] staged files are in ${path.relative(playgroundRoot, stagingDir)}/`);
}

function printUsage() {
  console.log(`PolyStella MDX JSX Workers AI translation playground

Env files loaded automatically when present, in order:
  ../../.env
  ../../.env.local
  ./.env
  ./.env.local

Shell-provided env vars take precedence over env-file values.

Required credentials, either pair:
  POLYSTELLA_WORKERS_AI_ACCOUNT_ID=<account id>
  POLYSTELLA_WORKERS_AI_API_TOKEN=<Workers AI token>

or:
  CLOUDFLARE_ACCOUNT_ID=<account id>
  CLOUDFLARE_API_TOKEN=<Workers AI token>

Optional:
  POLYSTELLA_WORKERS_AI_MODEL=<model id>
    Default: @cf/meta/llama-3.1-8b-instruct

  POLYSTELLA_WORKERS_AI_ENDPOINT=<full endpoint URL>
    Use for AI Gateway or endpoint debugging.

  POLYSTELLA_WORKERS_AI_MAX_TOKENS=<positive integer>
    Default: 8192

  POLYSTELLA_WORKERS_AI_BATCH_INPUT_TOKEN_BUDGET=<positive integer>
    Default: 4000

Examples:
  pnpm playground:mdx-jsx:translate:workers-ai
  pnpm playground:mdx-jsx:translate:workers-ai -- --locale pt-BR --file "docs/inline-jsx.mdx"
`);
}

async function loadEnvFiles() {
  const originalKeys = new Set(Object.keys(process.env));
  const files = [
    path.join(repoRoot, ".env"),
    path.join(repoRoot, ".env.local"),
    path.join(playgroundRoot, ".env"),
    path.join(playgroundRoot, ".env.local"),
  ];
  const loaded = [];
  for (const file of files) {
    const didLoad = await loadEnvFile(file, originalKeys);
    if (didLoad) loaded.push(file);
  }
  return loaded;
}

/** @param {string} filePath @param {Set<string>} originalKeys */
async function loadEnvFile(filePath, originalKeys) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return false;
    throw err;
  }

  for (const line of raw.split(/\r?\n/u)) {
    const parsed = parseEnvLine(line);
    if (parsed === undefined) continue;
    if (originalKeys.has(parsed.key)) continue;
    process.env[parsed.key] = parsed.value;
  }
  return true;
}

/** @param {string} line */
function parseEnvLine(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return undefined;
  const withoutExport = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
  const equalsIndex = withoutExport.indexOf("=");
  if (equalsIndex <= 0) return undefined;
  const key = withoutExport.slice(0, equalsIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) return undefined;
  return { key, value: parseEnvValue(withoutExport.slice(equalsIndex + 1).trim()) };
}

/** @param {string} raw */
function parseEnvValue(raw) {
  if (raw.startsWith('"')) return parseDoubleQuotedEnvValue(raw);
  if (raw.startsWith("'")) return parseSingleQuotedEnvValue(raw);
  return stripInlineComment(raw).trim();
}

/** @param {string} raw */
function parseSingleQuotedEnvValue(raw) {
  const closing = raw.indexOf("'", 1);
  return closing < 0 ? raw.slice(1) : raw.slice(1, closing);
}

/** @param {string} raw */
function parseDoubleQuotedEnvValue(raw) {
  const closing = findClosingDoubleQuote(raw);
  const value = closing < 0 ? raw.slice(1) : raw.slice(1, closing);
  return value.replace(/\\([nrt"\\])/gu, (_match, escape) => {
    if (escape === "n") return "\n";
    if (escape === "r") return "\r";
    if (escape === "t") return "\t";
    return escape;
  });
}

/** @param {string} raw */
function findClosingDoubleQuote(raw) {
  let escaped = false;
  for (let i = 1; i < raw.length; i++) {
    const char = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') return i;
  }
  return -1;
}

/** @param {string} raw */
function stripInlineComment(raw) {
  const index = raw.search(/\s#/u);
  return index < 0 ? raw : raw.slice(0, index);
}

/** @param {string[]} forwardedArgs */
function runPolystellaTranslate(forwardedArgs) {
  return new Promise((resolve, reject) => {
    const bin = process.platform === "win32" ? "polystella.cmd" : "polystella";
    const child = spawn(bin, ["translate", "--branch", "workers-ai-mdx-jsx", "--report", "./i18n-r2-report.json", ...forwardedArgs], {
      cwd: playgroundRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        POLYSTELLA_MDX_JSX_LOADED_ENV_FILES: loadedEnvFiles.join(path.delimiter),
        POLYSTELLA_MDX_JSX_WORKERS_AI_TRANSLATE: "1",
      },
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`polystella translate terminated by ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}
