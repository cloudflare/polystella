#!/usr/bin/env node
// @ts-check

import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const playgroundRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const stagingDir = path.join(playgroundRoot, ".astro", "i18n-staging");
const previewDir = path.join(playgroundRoot, "i18n-preview");
const reportPath = path.join(playgroundRoot, "i18n-r2-report.json");

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("method not allowed");
      return;
    }

    const body = await readRequestBody(req);
    const payload = JSON.parse(body);
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const systemPrompt = readMessageContent(messages, "system");
    const userPrompt = readMessageContent(messages, "user");
    const targetLocale = parseTargetLocale(systemPrompt) ?? "unknown";
    const response = buildFakeTranslationResponse(userPrompt, targetLocale);

    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ result: { response }, success: true }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ success: false, errors: [{ message: err instanceof Error ? err.message : String(err) }] }));
  }
});

await rm(stagingDir, { recursive: true, force: true });
await rm(previewDir, { recursive: true, force: true });
await rm(reportPath, { force: true });

await listen(server);
const address = server.address();
if (address === null || typeof address === "string") {
  throw new Error("fake Workers AI server did not bind to a TCP port");
}

const endpoint = `http://127.0.0.1:${address.port}/workers-ai`;
console.log(`[playground] fake Workers AI endpoint: ${endpoint}`);

try {
  const code = await runPolystellaTranslate(endpoint);
  if (code !== 0) {
    process.exitCode = code;
  } else {
    console.log(`[playground] wrote inspection copies to ${path.relative(playgroundRoot, previewDir)}/`);
    console.log(`[playground] staged files are in ${path.relative(playgroundRoot, stagingDir)}/`);
  }
} finally {
  await close(server);
}

/** @param {http.IncomingMessage} req */
async function readRequestBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 10 * 1024 * 1024) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** @param {unknown[]} messages @param {string} role */
function readMessageContent(messages, role) {
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const candidate = /** @type {{ role?: unknown; content?: unknown }} */ (message);
    if (candidate.role === role && typeof candidate.content === "string") return candidate.content;
  }
  return "";
}

/** @param {string} systemPrompt */
function parseTargetLocale(systemPrompt) {
  const line = systemPrompt.split("\n").find((entry) => entry.startsWith("Translate from "));
  if (line === undefined) return undefined;
  const matches = [...line.matchAll(/\(([a-z]{2}(?:-[A-Z]{2})?)\)/g)];
  const last = matches.at(-1);
  return last?.[1];
}

/** @param {string} userPrompt @param {string} targetLocale */
function buildFakeTranslationResponse(userPrompt, targetLocale) {
  const blocks = [];
  const re = /^@@([^@\n]+?)@@\s*\n([\s\S]*?)(?=\n@@|$)/gm;
  let match;
  while ((match = re.exec(userPrompt)) !== null) {
    const id = match[1]?.trim();
    const sourceText = (match[2] ?? "").replace(/\n+$/u, "");
    if (id === undefined || id.length === 0) continue;
    blocks.push(`@@${id}@@\n[${targetLocale}] ${sourceText}`);
  }
  if (blocks.length === 0) throw new Error("no segment markers found in prompt");
  return blocks.join("\n\n");
}

/** @param {http.Server} serverToListen */
function listen(serverToListen) {
  return new Promise((resolve, reject) => {
    serverToListen.once("error", reject);
    serverToListen.listen(0, "127.0.0.1", () => {
      serverToListen.off("error", reject);
      resolve(undefined);
    });
  });
}

/** @param {http.Server} serverToClose */
function close(serverToClose) {
  return new Promise((resolve, reject) => {
    serverToClose.close((err) => {
      if (err) reject(err);
      else resolve(undefined);
    });
  });
}

/** @param {string} endpoint */
function runPolystellaTranslate(endpoint) {
  return new Promise((resolve, reject) => {
    const bin = process.platform === "win32" ? "polystella.cmd" : "polystella";
    const child = spawn(bin, ["translate", "--branch", "local-mdx-jsx", "--report", "./i18n-r2-report.json"], {
      cwd: playgroundRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        POLYSTELLA_MDX_JSX_LOCAL_TRANSLATE: "1",
        POLYSTELLA_MDX_JSX_FAKE_WORKERS_AI_ENDPOINT: endpoint,
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
