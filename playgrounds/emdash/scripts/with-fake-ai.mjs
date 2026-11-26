#!/usr/bin/env node
// @ts-check
// Usage: node scripts/with-fake-ai.mjs [command...]
// Runs the command next to a fake Workers AI endpoint unless POLYSTELLA_AI=real (see .env.example). With no command, it only serves.
// Each segment is echoed back as "[<locale>] <source text>", which proves the plumbing, not translation quality.
// POLYSTELLA_FAKE_AI_DELAY_MS slows every reply, so running jobs can be watched. POLYSTELLA_FAKE_AI_MIN_TOKENS makes the
// fake cut a reply off, like a model out of output tokens, whenever the request's max_tokens is below it.

import { spawn } from "node:child_process";
import http from "node:http";

import { linkSharedEnv } from "./link-shared-env.mjs";

// Link .env before the options load, because they read it.
const linked = linkSharedEnv();
if (linked === "linked") console.log("[playground] linked .env to the primary checkout's playgrounds/emdash/.env");
if (linked === "failed") console.warn("[playground] could not link .env to the primary checkout; copy the file by hand if you need it");
const { fakeAiEndpoint, useFakeAi } = await import("../polystella.options.mjs");
console.log(useFakeAi ? "[playground] AI: fake (local, free)" : "[playground] AI: REAL Workers AI. Requests cost money.");

const command = process.argv.slice(2);
const server = useFakeAi ? await startFakeAi() : undefined;

if (command.length > 0) {
  const child = spawn(command[0] ?? "", command.slice(1), { stdio: "inherit" });
  for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"])) process.on(signal, () => child.kill(signal));
  child.on("close", (code) => {
    server?.close();
    process.exit(code ?? 1);
  });
}

async function startFakeAi() {
  const url = new URL(fakeAiEndpoint);
  const fake = http.createServer(async (req, res) => {
    try {
      if (req.method !== "POST") {
        res.writeHead(405).end("method not allowed");
        return;
      }
      const payload = JSON.parse(await readBody(req));
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const delay = Number(process.env.POLYSTELLA_FAKE_AI_DELAY_MS ?? 0);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const minTokens = Number(process.env.POLYSTELLA_FAKE_AI_MIN_TOKENS ?? 0);
      if (typeof payload.max_tokens === "number" && payload.max_tokens < minTokens) {
        const choices = [{ index: 0, finish_reason: "length", message: { role: "assistant", content: "" } }];
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ result: { choices }, success: true }));
        return;
      }
      const response = fakeTranslation(readContent(messages, "user"), targetLocale(readContent(messages, "system")));
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ result: { response }, success: true }));
    } catch (error) {
      // The details stay in this console; the client gets a fixed message.
      console.error("[playground] fake Workers AI could not handle a request:", error);
      const invalidJson = error instanceof SyntaxError;
      const message = invalidJson ? "request body is not valid JSON" : "the fake Workers AI failed; see its console";
      res.writeHead(invalidJson ? 400 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, errors: [{ message }] }));
    }
  });
  const started = await new Promise((resolve, reject) => {
    fake.once("error", (error) => (/** @type {NodeJS.ErrnoException} */ (error).code === "EADDRINUSE" ? resolve(false) : reject(error)));
    fake.listen(Number(url.port), url.hostname, () => resolve(true));
  });
  if (!started) {
    console.log(`[playground] ${url.host} is already in use; assuming a fake Workers AI is running there`);
    return undefined;
  }
  console.log(`[playground] fake Workers AI endpoint: ${fakeAiEndpoint}`);
  return fake;
}

/** @param {http.IncomingMessage} req */
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** @param {unknown[]} messages @param {string} role */
function readContent(messages, role) {
  for (const message of messages) {
    const candidate = /** @type {{ role?: unknown; content?: unknown }} */ (message);
    if (candidate.role === role && typeof candidate.content === "string") return candidate.content;
  }
  return "";
}

/** @param {string} systemPrompt */
function targetLocale(systemPrompt) {
  const line = systemPrompt.split("\n").find((entry) => entry.startsWith("Translate from "));
  return [...(line ?? "").matchAll(/\(([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*)\)/g)].at(-1)?.[1] ?? "unknown";
}

/** @param {string} userPrompt @param {string} locale */
function fakeTranslation(userPrompt, locale) {
  const blocks = [];
  for (const match of userPrompt.matchAll(/^@@([^@\n]+?)@@\s*\n([\s\S]*?)(?=\n@@|$)/gm)) {
    const id = match[1]?.trim();
    if (id) blocks.push(`@@${id}@@\n[${locale}] ${fillPluralCategories((match[2] ?? "").replace(/\n+$/u, ""), locale)}`);
  }
  if (blocks.length === 0) throw new Error("no segment markers found in prompt");
  return blocks.join("\n\n");
}

/** Adds the target locale's missing plural branches (copied from `other`) so Arabic-style plurals validate. */
function fillPluralCategories(text, locale) {
  const start = text.search(/\{\{\w+, plural,/);
  if (start === -1) return text;
  let depth = 0;
  let end = -1;
  for (let index = start; index < text.length && end === -1; index++) {
    if (text[index] === "{") depth++;
    else if (text[index] === "}" && --depth === 0) end = index;
  }
  const otherBody = /\bother\s*\{((?:[^{}]|\{[^{}]*\})*)\}/.exec(text.slice(start, end))?.[1];
  if (end === -1 || otherBody === undefined) return text;
  const missing = new Intl.PluralRules(locale)
    .resolvedOptions()
    .pluralCategories.filter((category) => !new RegExp(`\\b${category}\\s*\\{`).test(text.slice(start, end)));
  return `${text.slice(0, end - 1)}${missing.map((category) => ` ${category} {${otherBody}}`).join("")}${text.slice(end - 1)}`;
}
