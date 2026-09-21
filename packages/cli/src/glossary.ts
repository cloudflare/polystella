import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { EMPTY_GLOSSARY, type Glossary, type StyleRule } from "@cloudflare/polystella-core";
import { S3mini } from "s3mini";
import { parse as parseYaml } from "yaml";

import type { CatalogGlossaryConfig } from "./config.js";

interface LoadGlossariesBaseOptions {
  signal?: AbortSignal | undefined;
  /** Inject a fetch implementation. Mainly for tests. */
  fetch?: typeof fetch | undefined;
}

type NonFileGlossaryConfig = Exclude<CatalogGlossaryConfig, { file: string }>;
type GlossaryHostConfig<T> = { locales: ReadonlyArray<string>; glossary?: T | undefined };

export type LoadGlossariesOptions = LoadGlossariesBaseOptions &
  (
    | { config: GlossaryHostConfig<CatalogGlossaryConfig>; projectRoot: URL }
    | { config: GlossaryHostConfig<NonFileGlossaryConfig>; projectRoot?: undefined }
  );

const MAX_GLOSSARY_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 100;

class PermanentGlossaryResponseError extends Error {}

export async function loadGlossaries(opts: LoadGlossariesOptions): Promise<Map<string, Glossary>> {
  const { config, projectRoot } = opts;
  if (config.glossary === undefined) return new Map();
  opts.signal?.throwIfAborted();
  assertSingleGlossarySource(config.glossary);

  const result = new Map<string, Glossary>();
  if (config.glossary.file !== undefined) {
    const template = config.glossary.file;
    requireLocalePlaceholder(template, "glossary.file");
    if (projectRoot === undefined) throw new Error("[polystella] projectRoot is required for file-based glossaries");
    const projectRootPath = fileURLToPath(projectRoot);
    for (const locale of config.locales) {
      opts.signal?.throwIfAborted();
      const absPath = path.resolve(projectRootPath, template.replaceAll("{locale}", locale));
      let raw: string;
      try {
        raw = await readFile(absPath, "utf8");
      } catch (error) {
        if (isNotFound(error)) continue;
        throw error;
      }
      result.set(locale, parseGlossaryYaml(raw, absPath));
    }
    return result;
  }

  if (config.glossary.inline !== undefined) {
    for (const [locale, data] of Object.entries(config.glossary.inline)) {
      result.set(locale, validateGlossary(data, `inline glossary for locale "${locale}"`));
    }
    return result;
  }

  if (config.glossary.http !== undefined) return loadHttpGlossaries(config.locales, config.glossary, opts);
  return loadR2Glossaries(config.locales, config.glossary, opts);
}

export function assertSingleGlossarySource(config: CatalogGlossaryConfig): void {
  const count = [config.file, config.inline, config.http, config.r2].filter((source) => source !== undefined).length;
  if (count !== 1) throw new Error("[polystella] glossary must configure exactly one of file, inline, http, or r2");
}

export function glossarySourceLabel(config: CatalogGlossaryConfig, locale: string): string {
  if (config.file !== undefined) return config.file.replaceAll("{locale}", locale);
  if (config.inline !== undefined) return "<inline>";
  if (config.http !== undefined) return safeHttpLabel(config.http.url.replaceAll("{locale}", encodeURIComponent(locale)));
  return `r2://${config.r2.bucket}/${config.r2.key.replaceAll("{locale}", locale)}`;
}

async function loadHttpGlossaries(
  locales: ReadonlyArray<string>,
  config: Extract<CatalogGlossaryConfig, { http: unknown }>,
  opts: LoadGlossariesOptions,
): Promise<Map<string, Glossary>> {
  requireLocalePlaceholder(config.http.url, "glossary.http.url");
  let headers: Headers;
  try {
    headers = new Headers(config.http.headers);
  } catch {
    throw new Error("[polystella] glossary.http.headers contains an invalid header");
  }
  const fetchImpl = createRequestFetch(opts.fetch ?? fetch, opts.signal);
  const entries = await Promise.all(
    locales.map(async (locale) => {
      const url = parseHttpGlossaryUrl(config.http.url, locale);
      const label = safeHttpLabel(url);
      let raw: string;
      try {
        raw = await fetchHttpGlossary(fetchImpl, url, headers, label, opts.signal);
      } catch (error) {
        opts.signal?.throwIfAborted();
        if (error instanceof PermanentGlossaryResponseError) throw error;
        throw new Error(`[polystella] failed to load glossary for locale "${locale}" from ${label}`);
      }
      return [locale, parseGlossaryYaml(raw, label)] as const;
    }),
  );
  return new Map(entries);
}

async function loadR2Glossaries(
  locales: ReadonlyArray<string>,
  config: Extract<CatalogGlossaryConfig, { r2: unknown }>,
  opts: LoadGlossariesOptions,
): Promise<Map<string, Glossary>> {
  requireLocalePlaceholder(config.r2.key, "glossary.r2.key");
  const baseEndpoint = config.r2.endpoint ?? `https://${config.r2.accountId}.r2.cloudflarestorage.com`;
  const endpoint = `${validateR2Endpoint(baseEndpoint)}/${config.r2.bucket}`;
  const s3 = new S3mini({
    accessKeyId: config.r2.accessKeyId,
    secretAccessKey: config.r2.secretAccessKey,
    endpoint,
    region: "auto",
    fetch: createRequestFetch(opts.fetch ?? fetch, opts.signal),
  });
  const entries = await Promise.all(
    locales.map(async (locale) => {
      const key = config.r2.key.replaceAll("{locale}", locale);
      const label = glossarySourceLabel(config, locale);
      let raw: string;
      try {
        raw = await fetchR2Glossary(s3, key, label, opts.signal);
      } catch (error) {
        opts.signal?.throwIfAborted();
        if (error instanceof PermanentGlossaryResponseError) throw error;
        throw new Error(`[polystella] failed to load glossary for locale "${locale}" from ${label}`);
      }
      return [locale, parseGlossaryYaml(raw, label)] as const;
    }),
  );
  return new Map(entries);
}

async function fetchHttpGlossary(
  fetchImpl: typeof fetch,
  url: URL,
  headers: Headers,
  label: string,
  signal?: AbortSignal,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchImpl(url, { headers });
      if (!response.ok) {
        const delayMs = retryDelayMs(response);
        await response.body?.cancel();
        if (isRetriableStatus(response.status) && attempt === 0) {
          await waitForRetry(delayMs, signal);
          continue;
        }
        throw new PermanentGlossaryResponseError(`[polystella] failed to load glossary from ${label}: HTTP ${response.status}`);
      }
      return await readLimitedText(response, label, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof PermanentGlossaryResponseError) throw error;
      lastError = error;
      if (attempt === 0) await waitForRetry(RETRY_DELAY_MS, signal);
    }
  }
  throw lastError;
}

async function fetchR2Glossary(s3: S3mini, key: string, label: string, signal?: AbortSignal): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await s3.getObjectResponse(key);
      if (response === null) {
        throw new PermanentGlossaryResponseError(`[polystella] failed to load glossary from ${label}: object not found`);
      }
      return await readLimitedText(response, label, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof PermanentGlossaryResponseError) throw error;
      const status = errorStatus(error);
      if (status !== undefined && !isRetriableStatus(status)) {
        throw new PermanentGlossaryResponseError(`[polystella] failed to load glossary from ${label}: HTTP ${status}`);
      }
      lastError = error;
      if (attempt === 0) await waitForRetry(RETRY_DELAY_MS, signal);
      else if (status !== undefined) {
        throw new PermanentGlossaryResponseError(`[polystella] failed to load glossary from ${label}: HTTP ${status}`);
      }
    }
  }
  throw lastError;
}

function createRequestFetch(fetchImpl: typeof fetch, signal?: AbortSignal): typeof fetch {
  return async (input, init) => fetchImpl(input, { ...init, redirect: "manual", signal: combinedRequestSignal(input, init, signal) });
}

function combinedRequestSignal(input: string | URL | Request, init: RequestInit | undefined, signal: AbortSignal | undefined): AbortSignal {
  const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
  if (input instanceof Request) signals.push(input.signal);
  if (init?.signal) signals.push(init.signal);
  if (signal) signals.push(signal);
  return AbortSignal.any(signals);
}

function isRetriableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function errorStatus(error: unknown): number | undefined {
  return error !== null && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : undefined;
}

function retryDelayMs(response: Response): number {
  const value = response.headers.get("retry-after");
  if (value === null) return RETRY_DELAY_MS;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, REQUEST_TIMEOUT_MS);
  const date = Date.parse(value);
  return Number.isNaN(date) ? RETRY_DELAY_MS : Math.min(Math.max(date - Date.now(), 0), REQUEST_TIMEOUT_MS);
}

async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) await sleep(delayMs);
  else await sleep(delayMs, undefined, { signal });
}

async function readLimitedText(response: Response, context: string, signal?: AbortSignal): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_GLOSSARY_BYTES) {
    await response.body?.cancel();
    throw new PermanentGlossaryResponseError(`[polystella] glossary at ${context} exceeds the ${MAX_GLOSSARY_BYTES}-byte limit`);
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_GLOSSARY_BYTES) {
        await reader.cancel();
        throw new PermanentGlossaryResponseError(`[polystella] glossary at ${context} exceeds the ${MAX_GLOSSARY_BYTES}-byte limit`);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function parseGlossaryYaml(raw: string, context: string): Glossary {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    throw new Error(`[polystella] failed to parse glossary YAML at ${context}: ${errorMessage(error)}`);
  }
  return validateGlossary(parsed ?? {}, context);
}

function requireLocalePlaceholder(template: string, field: string): void {
  if (!template.includes("{locale}")) throw new Error(`[polystella] ${field} must contain the "{locale}" placeholder`);
}

function parseHttpGlossaryUrl(template: string, locale: string): URL {
  let url: URL;
  try {
    url = new URL(template.replaceAll("{locale}", encodeURIComponent(locale)));
  } catch {
    throw new Error("[polystella] glossary.http.url must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new Error("[polystella] glossary.http.url must be an HTTPS URL without embedded credentials");
  }
  return url;
}

function safeHttpLabel(value: string | URL): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "<http glossary>";
  }
}

function validateR2Endpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("[polystella] glossary.r2.endpoint must be a valid URL");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username !== "" || url.password !== "") {
    throw new Error("[polystella] glossary.r2.endpoint must use HTTPS (HTTP is allowed only for loopback testing)");
  }
  if (url.search !== "" || url.hash !== "") throw new Error("[polystella] glossary.r2.endpoint must not contain a query or fragment");
  return url.toString().replace(/\/$/, "");
}

export function hashGlossary(glossary: Glossary): string {
  const canonical = JSON.stringify({
    version: glossary.version,
    doNotTranslate: glossary.doNotTranslate,
    preferredTranslations: sortedRecord(glossary.preferredTranslations),
    styleRules: glossary.styleRules.map(canonicaliseStyleRule),
    notes: glossary.notes,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export const EMPTY_GLOSSARY_HASH: string = hashGlossary(EMPTY_GLOSSARY);

export function validateGlossary(raw: unknown, context: string): Glossary {
  const data = asRecord(raw);
  const issues: string[] = [];
  if (data === undefined) {
    issues.push("  • <root>: Expected object");
  }

  const value = data ?? {};
  const allowed = new Set(["version", "doNotTranslate", "preferredTranslations", "styleRules", "notes"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(`  • ${key}: Unrecognized key`);
  }

  const version = optionalString(value.version, "version", issues);
  const notes = optionalString(value.notes, "notes", issues);
  const doNotTranslate = stringArray(value.doNotTranslate, "doNotTranslate", issues);
  const preferredTranslations = stringRecord(value.preferredTranslations, "preferredTranslations", issues);
  const styleRules = parseStyleRules(value.styleRules, issues);

  if (issues.length > 0) throw new Error(`[polystella] invalid glossary at ${context}:\n${issues.join("\n")}`);
  return {
    version: version ?? "",
    doNotTranslate: Array.from(new Set(doNotTranslate)).sort(),
    preferredTranslations,
    styleRules,
    notes: notes ?? "",
  };
}

function parseStyleRules(value: unknown, issues: string[]): StyleRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push("  • styleRules: Expected array");
    return [];
  }
  const rules: StyleRule[] = [];
  for (let index = 0; index < value.length; index++) {
    const rule = asRecord(value[index]);
    if (rule === undefined) {
      issues.push(`  • styleRules.${index}: Expected object`);
      continue;
    }
    for (const key of Object.keys(rule)) {
      if (key !== "category" && key !== "instruction" && key !== "example") {
        issues.push(`  • styleRules.${index}.${key}: Unrecognized key`);
      }
    }
    const category = nonEmptyString(rule.category, `styleRules.${index}.category`, issues);
    const instruction = nonEmptyString(rule.instruction, `styleRules.${index}.instruction`, issues);
    const example = optionalNonEmptyString(rule.example, `styleRules.${index}.example`, issues);
    if (category !== undefined && instruction !== undefined) {
      rules.push({ category, instruction, ...(example === undefined ? {} : { example }) });
    }
  }
  return rules;
}

function optionalString(value: unknown, path: string, issues: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    issues.push(`  • ${path}: Expected string`);
    return undefined;
  }
  return value;
}

function optionalNonEmptyString(value: unknown, path: string, issues: string[]): string | undefined {
  if (value === undefined) return undefined;
  return nonEmptyString(value, path, issues);
}

function nonEmptyString(value: unknown, path: string, issues: string[]): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    issues.push(`  • ${path}: Expected non-empty string`);
    return undefined;
  }
  return value;
}

function stringArray(value: unknown, path: string, issues: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push(`  • ${path}: Expected array`);
    return [];
  }
  const strings: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const item = nonEmptyString(value[index], `${path}.${index}`, issues);
    if (item !== undefined) strings.push(item);
  }
  return strings;
}

function stringRecord(value: unknown, path: string, issues: string[]): Record<string, string> {
  if (value === undefined) return {};
  const record = asRecord(value);
  if (record === undefined) {
    issues.push(`  • ${path}: Expected object`);
    return {};
  }
  const strings: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    const item = nonEmptyString(entry, `${path}.${key}`, issues);
    if (item !== undefined) strings[key] = item;
  }
  return strings;
}

function canonicaliseStyleRule(rule: StyleRule): { category: string; instruction: string; example?: string } {
  return {
    category: rule.category,
    instruction: rule.instruction,
    ...(rule.example === undefined ? {} : { example: rule.example }),
  };
}

function sortedRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
