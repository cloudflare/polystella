import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ModelSpec } from "@cloudflare/polystella-core";

import { validateGlossary } from "./glossary.js";

export interface AstroI18nConfig {
  defaultLocale: string;
  locales: string[];
}

export interface WorkersAiProviderConfig {
  kind: "workers-ai";
  accountId: string;
  apiToken: string;
  endpoint?: string | undefined;
  model: ModelSpec;
  maxTokens: number;
  batchInputTokenBudget: number;
}

export interface AnthropicProviderConfig {
  kind: "anthropic";
  apiKey: string;
  model: ModelSpec;
  maxTokens: number;
  batchInputTokenBudget: number;
}

export type CatalogProviderConfig = WorkersAiProviderConfig | AnthropicProviderConfig;
export interface GlossaryInput {
  version?: string | undefined;
  doNotTranslate?: string[] | undefined;
  preferredTranslations?: Record<string, string> | undefined;
  notes?: string | undefined;
}
export interface HttpGlossaryConfig {
  url: string;
  headers?: Record<string, string> | undefined;
}
export interface R2GlossaryConfig {
  accountId: string;
  bucket: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string | undefined;
}
export type CatalogGlossaryConfig =
  | { file: string; inline?: undefined; http?: undefined; r2?: undefined }
  | { file?: undefined; inline: Record<string, GlossaryInput>; http?: undefined; r2?: undefined }
  | { file?: undefined; inline?: undefined; http: HttpGlossaryConfig; r2?: undefined }
  | { file?: undefined; inline?: undefined; http?: undefined; r2: R2GlossaryConfig };

export interface CatalogResolvedConfig {
  defaultLocale: string;
  /** Target locales only; the default locale is excluded. */
  locales: string[];
  provider?: CatalogProviderConfig | undefined;
  glossary?: CatalogGlossaryConfig | undefined;
  prompt: { context?: string | undefined };
  concurrency: number;
  maxRetries: number;
}

export async function loadAstroI18n(cwd: string): Promise<AstroI18nConfig | undefined> {
  const candidatePath = path.resolve(cwd, "astro.config.mjs");
  let loaded: unknown;
  try {
    loaded = await import(pathToFileURL(candidatePath).href);
  } catch (error) {
    throw new Error(`failed to load ${candidatePath}: ${errorMessage(error)}`);
  }

  const module = asRecordOrUndefined(loaded);
  const exported = module?.default ?? loaded;
  const config = asRecordOrUndefined(exported);
  const i18n = asRecordOrUndefined(config?.i18n);
  if (i18n === undefined) return undefined;

  if (typeof i18n.defaultLocale !== "string" || i18n.defaultLocale.length === 0) {
    throw new Error("astro.config.mjs i18n.defaultLocale must be a non-empty string.");
  }
  if (!Array.isArray(i18n.locales) || !i18n.locales.every((locale) => typeof locale === "string" && locale.length > 0)) {
    throw new Error("astro.config.mjs i18n.locales must contain only non-empty strings.");
  }

  return { defaultLocale: i18n.defaultLocale, locales: [...i18n.locales] };
}

export async function loadPolystellaConfig(cwd: string): Promise<unknown> {
  const candidatePath = path.resolve(cwd, "polystella.config.mjs");
  try {
    const loaded: unknown = await import(pathToFileURL(candidatePath).href);
    return asRecordOrUndefined(loaded)?.default;
  } catch (error) {
    throw new Error(`failed to load ${candidatePath}: ${errorMessage(error)}`);
  }
}

/** Resolve only options used by translate-ui; unrelated integration options are ignored. */
export function resolveCatalogConfig(raw: unknown, i18n: AstroI18nConfig): CatalogResolvedConfig {
  const duplicates = i18n.locales.filter((locale, index) => i18n.locales.indexOf(locale) !== index);
  if (duplicates.length > 0) {
    throw new Error(
      `[polystella] configuration error:\nInvalid Astro \`i18n\` config:\n  • \`i18n.locales\` contains duplicates: ${[
        ...new Set(duplicates),
      ].join(", ")}.`,
    );
  }
  const config = requireRecord(raw, "<root>");
  return {
    defaultLocale: i18n.defaultLocale,
    locales: i18n.locales.filter((locale) => locale !== i18n.defaultLocale),
    provider: config.provider === undefined ? undefined : parseProvider(config.provider),
    glossary: config.glossary === undefined ? undefined : parseGlossaryConfig(config.glossary),
    prompt: parsePrompt(config.prompt),
    concurrency: parseInteger(config.concurrency, "concurrency", 4, 1),
    maxRetries: parseInteger(config.maxRetries, "maxRetries", 2, 0),
  };
}

function parseProvider(value: unknown): CatalogProviderConfig {
  const provider = requireRecord(value, "provider");
  const model = parseModel(provider.model);
  const maxTokens = parseInteger(provider.maxTokens, "provider.maxTokens", 8192, 1);
  const batchInputTokenBudget = parseInteger(provider.batchInputTokenBudget, "provider.batchInputTokenBudget", 4000, 1);

  if (provider.kind === "workers-ai") {
    const endpoint = optionalUrl(provider.endpoint, "provider.endpoint");
    return {
      kind: "workers-ai",
      accountId: requireNonEmptyString(provider.accountId, "provider.accountId"),
      apiToken: requireNonEmptyString(provider.apiToken, "provider.apiToken"),
      ...(endpoint === undefined ? {} : { endpoint }),
      model,
      maxTokens,
      batchInputTokenBudget,
    };
  }
  if (provider.kind === "anthropic") {
    return {
      kind: "anthropic",
      apiKey: requireNonEmptyString(provider.apiKey, "provider.apiKey"),
      model,
      maxTokens,
      batchInputTokenBudget,
    };
  }
  throw configurationError("provider.kind", 'must be "workers-ai" or "anthropic"');
}

function parseModel(value: unknown): ModelSpec {
  if (typeof value === "string" && value.length > 0) return value;
  const models = asRecordOrUndefined(value);
  if (models === undefined || typeof models.default !== "string" || models.default.length === 0) {
    throw configurationError("provider.model", "must be a non-empty string or a locale map with a non-empty default");
  }
  for (const model of Object.values(models)) {
    if (typeof model !== "string" || model.length === 0) {
      throw configurationError("provider.model", "locale map values must be non-empty strings");
    }
  }
  return models as { default: string } & Record<string, string>;
}

function parseGlossaryConfig(value: unknown): CatalogGlossaryConfig {
  const glossary = requireRecord(value, "glossary");
  rejectUnknownKeys(glossary, ["file", "inline", "http", "r2"], "glossary");
  const sources = ["file", "inline", "http", "r2"].filter((key) => glossary[key] !== undefined);
  if (sources.length !== 1) {
    throw configurationError("glossary", "must configure exactly one of file, inline, http, or r2");
  }

  if (sources[0] === "file") return { file: requireNonEmptyString(glossary.file, "glossary.file") };
  if (sources[0] === "inline") {
    const inline = requireRecord(glossary.inline, "glossary.inline");
    const entries: Record<string, GlossaryInput> = {};
    for (const [locale, data] of Object.entries(inline)) {
      const rawEntry = asRecordOrUndefined(data);
      const entry =
        rawEntry === undefined
          ? data
          : Object.fromEntries(
              Object.entries(rawEntry).filter(([key]) => ["version", "doNotTranslate", "preferredTranslations", "notes"].includes(key)),
            );
      entries[locale] = validateGlossary(entry, `inline glossary for locale "${locale}"`);
    }
    return { inline: entries };
  }
  if (sources[0] === "http") {
    const http = requireRecord(glossary.http, "glossary.http");
    rejectUnknownKeys(http, ["url", "headers"], "glossary.http");
    const rawHeaders = http.headers === undefined ? undefined : requireRecord(http.headers, "glossary.http.headers");
    const headers =
      rawHeaders === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(rawHeaders).map(([name, headerValue]) => [
              name,
              requireNonEmptyString(headerValue, `glossary.http.headers.${name}`),
            ]),
          );
    return {
      http: {
        url: requireNonEmptyString(http.url, "glossary.http.url"),
        ...(headers === undefined ? {} : { headers }),
      },
    };
  }

  const r2 = requireRecord(glossary.r2, "glossary.r2");
  rejectUnknownKeys(r2, ["accountId", "bucket", "key", "accessKeyId", "secretAccessKey", "endpoint"], "glossary.r2");
  const endpoint = optionalUrl(r2.endpoint, "glossary.r2.endpoint");
  return {
    r2: {
      accountId: requireNonEmptyString(r2.accountId, "glossary.r2.accountId"),
      bucket: requireNonEmptyString(r2.bucket, "glossary.r2.bucket"),
      key: requireNonEmptyString(r2.key, "glossary.r2.key"),
      accessKeyId: requireNonEmptyString(r2.accessKeyId, "glossary.r2.accessKeyId"),
      secretAccessKey: requireNonEmptyString(r2.secretAccessKey, "glossary.r2.secretAccessKey"),
      ...(endpoint === undefined ? {} : { endpoint }),
    },
  };
}

function parsePrompt(value: unknown): { context?: string | undefined } {
  if (value === undefined) return {};
  const prompt = requireRecord(value, "prompt");
  if (prompt.context === undefined) return {};
  if (typeof prompt.context !== "string") throw configurationError("prompt.context", "must be a string");
  return { context: prompt.context };
}

function parseInteger(value: unknown, name: string, fallback: number, minimum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    throw configurationError(name, `must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

function optionalUrl(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  const url = requireNonEmptyString(value, name);
  try {
    new URL(url);
  } catch {
    throw configurationError(name, "must be a valid URL");
  }
  return url;
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw configurationError(name, "must be a non-empty string");
  return value;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  const record = asRecordOrUndefined(value);
  if (record === undefined) throw configurationError(name, "must be an object");
  return record;
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: ReadonlyArray<string>, path: string): void {
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw configurationError(`${path}.${unknown}`, "is not recognized");
}

function asRecordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function configurationError(path: string, message: string): Error {
  return new Error(
    `[polystella] configuration error:\nInvalid PolyStella options:\n  • ${path}: ${message}\n\nSee polystella.config.mjs and astro.config.mjs for the full reference.`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
