import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { compileIgnoreKeys, type IgnoreKey } from "../catalog/flatten.js";
import { assertLocaleTags, parseLocaleTags, type LocaleTags } from "../catalog/locale-tags.js";
import { DEFAULT_MESSAGE_SYNTAX, type MessageSyntax } from "../catalog/message.js";
import { modelPriceProblem, type ModelChoice, type ModelChoiceSpec, type ModelPrice, type ModelSpec } from "../index.js";
import { workersAIParamsProblem } from "../providers/workers-ai.js";

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
  /** Locale entries may be `{ model, enable_thinking }`. */
  model: ModelChoiceSpec;
  maxTokens: number;
  batchInputTokenBudget: number;
  /** Extra Workers AI input per model id, as in the EmDash plugin's `models.params`. */
  params?: Record<string, Record<string, unknown>> | undefined;
  /** USD list prices per model id; they win over the Workers AI catalog's. */
  prices?: Record<string, ModelPrice> | undefined;
}

export interface AnthropicProviderConfig {
  kind: "anthropic";
  apiKey: string;
  model: ModelSpec;
  maxTokens: number;
  batchInputTokenBudget: number;
  /** USD list prices per model id, for cost estimates. */
  prices?: Record<string, ModelPrice> | undefined;
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
export type CatalogGlossaryConfig = (
  | { file: string; inline?: undefined; http?: undefined; r2?: undefined }
  | { file?: undefined; inline: Record<string, GlossaryInput>; http?: undefined; r2?: undefined }
  | { file?: undefined; inline?: undefined; http: HttpGlossaryConfig; r2?: undefined }
  | { file?: undefined; inline?: undefined; http?: undefined; r2: R2GlossaryConfig }
) & {
  /** Let any letters follow a term when deciding whether a batch uses it. See `GlossaryMatchOptions`. */
  matchInflections?: boolean | undefined;
};

export interface CatalogResolvedConfig {
  defaultLocale: string;
  /** Target locales only; the default locale is excluded. */
  locales: string[];
  provider?: CatalogProviderConfig | undefined;
  glossary?: CatalogGlossaryConfig | undefined;
  prompt: { context?: string | undefined };
  concurrency: number;
  maxRetries: number;
  /** Site locale code → BCP 47 tag, covering the default locale too. */
  localeTags?: LocaleTags | undefined;
}

const ASTRO_CONFIG_FILES = ["astro.config.mjs", "astro.config.js", "astro.config.ts", "astro.config.mts"];

type RunnerImport = (moduleId: string, inlineConfig: Record<string, unknown>) => Promise<unknown>;

/** Returns the Astro config's default export, found and loaded the way Astro does. */
export async function loadAstroConfig(cwd: string): Promise<unknown> {
  const configPath = ASTRO_CONFIG_FILES.map((file) => path.resolve(cwd, file)).find((file) => existsSync(file));
  if (configPath === undefined) {
    throw new Error(`no Astro config found in ${cwd} (looked for ${ASTRO_CONFIG_FILES.join(", ")})`);
  }

  let loaded: unknown;
  try {
    loaded = await import(pathToFileURL(configPath).href);
  } catch (nodeError) {
    // Mirrors Astro's loadConfigWithVite: configs importing TypeScript-only packages load only through Vite.
    loaded = await importWithAstroVite(cwd, configPath, nodeError);
  }
  const module = asRecordOrUndefined(loaded);
  return module?.default ?? loaded;
}

async function importWithAstroVite(cwd: string, configPath: string, nodeError: unknown): Promise<unknown> {
  let runnerImport: RunnerImport;
  try {
    // Use the Vite copy Astro itself loads configs with; PolyStella doesn't depend on Vite directly.
    const astroManifest = createRequire(path.join(cwd, "package.json")).resolve("astro/package.json");
    const vite = asRecordOrUndefined(await import(pathToFileURL(createRequire(astroManifest).resolve("vite")).href));
    if (typeof vite?.runnerImport !== "function") throw new Error("Astro's Vite does not export runnerImport");
    runnerImport = vite.runnerImport as RunnerImport;
  } catch (viteLookupError) {
    throw new Error(
      `failed to load ${configPath}: ${errorMessage(nodeError)}\n` +
        `The Vite fallback is unavailable (${errorMessage(viteLookupError)}); install astro in this project to enable it.`,
    );
  }

  try {
    const result = await runnerImport(configPath, { root: cwd, logLevel: "error", resolve: { tsconfigPaths: true } });
    return asRecordOrUndefined(result)?.module;
  } catch (viteError) {
    throw new Error(`failed to load ${configPath} with Node (${errorMessage(nodeError)}) or Vite (${errorMessage(viteError)})`);
  }
}

export async function loadAstroI18n(cwd: string): Promise<AstroI18nConfig | undefined> {
  const config = asRecordOrUndefined(await loadAstroConfig(cwd));
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
  let loaded: unknown;
  try {
    loaded = await import(pathToFileURL(candidatePath).href);
  } catch (nodeError) {
    if (!existsSync(candidatePath)) throw new Error(`failed to load ${candidatePath}: ${errorMessage(nodeError)}`);
    // Astro loads astro.config.mjs (and so a config it imports) through Vite; match that here.
    loaded = await importWithAstroVite(cwd, candidatePath, nodeError);
  }
  return asRecordOrUndefined(loaded)?.default;
}

/** Like `loadPolystellaConfig`, but `undefined` when `polystella.config.mjs` does not exist. */
export async function loadOptionalPolystellaConfig(cwd: string): Promise<unknown> {
  return existsSync(path.resolve(cwd, "polystella.config.mjs")) ? loadPolystellaConfig(cwd) : undefined;
}

/** Validated `localeTags` from a raw config; reads nothing else, so offline checks need no credentials. */
export function resolveLocaleTagsConfig(raw: unknown, i18n: AstroI18nConfig): LocaleTags | undefined {
  const localeTags = parseLocaleTags(asRecordOrUndefined(raw)?.localeTags, "polystella");
  assertLocaleTags(i18n.locales, localeTags, "polystella");
  return localeTags;
}

/** The `catalog` block of `polystella.config.mjs`. */
export interface CatalogOptions {
  /** `catalog.ignoreKeys` as written, for generated code. */
  ignoreKeys: string[];
  /** `ignoreKeys` compiled; `undefined` when there are none. */
  ignoreKey?: IgnoreKey | undefined;
  messageSyntax: MessageSyntax;
}

/** `catalog` options from `cwd`'s `polystella.config.mjs`; defaults when the file doesn't exist. */
export async function loadCatalogOptions(cwd: string): Promise<CatalogOptions> {
  let raw: unknown;
  try {
    raw = await loadOptionalPolystellaConfig(cwd);
  } catch (error) {
    throw new Error(`[polystella] ${errorMessage(error)}`);
  }
  return resolveCatalogOptions(raw);
}

/** Validated `catalog` block from a raw config; `raw` is `undefined` when there is no config file. */
export function resolveCatalogOptions(raw: unknown): CatalogOptions {
  const value = asRecordOrUndefined(raw)?.catalog;
  if (value === undefined) return { ignoreKeys: [], messageSyntax: DEFAULT_MESSAGE_SYNTAX };
  const catalog = requireRecord(value, "catalog");
  rejectUnknownKeys(catalog, ["ignoreKeys", "messageSyntax"], "catalog");
  const messageSyntax = catalog.messageSyntax ?? DEFAULT_MESSAGE_SYNTAX;
  if (messageSyntax !== "polystella" && messageSyntax !== "icu") {
    throw configurationError("catalog.messageSyntax", 'must be "polystella" or "icu"');
  }
  const ignoreKeys = catalog.ignoreKeys ?? [];
  if (!Array.isArray(ignoreKeys) || !ignoreKeys.every((pattern): pattern is string => typeof pattern === "string" && pattern.length > 0)) {
    throw configurationError("catalog.ignoreKeys", "must be an array of non-empty regular expression strings (not RegExp objects)");
  }
  try {
    return { ignoreKeys, ignoreKey: compileIgnoreKeys(ignoreKeys), messageSyntax };
  } catch (error) {
    throw configurationError("catalog.ignoreKeys", `contains an invalid regular expression: ${errorMessage(error)}`);
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
  const localeTags = resolveLocaleTagsConfig(config, i18n);
  return {
    defaultLocale: i18n.defaultLocale,
    locales: i18n.locales.filter((locale) => locale !== i18n.defaultLocale),
    provider: config.provider === undefined ? undefined : parseProvider(config.provider),
    glossary: config.glossary === undefined ? undefined : parseGlossaryConfig(config.glossary),
    prompt: parsePrompt(config.prompt),
    concurrency: parseInteger(config.concurrency, "concurrency", 4, 1),
    maxRetries: parseInteger(config.maxRetries, "maxRetries", 2, 0),
    ...(localeTags === undefined ? {} : { localeTags }),
  };
}

function parseProvider(value: unknown): CatalogProviderConfig {
  const provider = requireRecord(value, "provider");
  const maxTokens = parseInteger(provider.maxTokens, "provider.maxTokens", 8192, 1);
  const batchInputTokenBudget = parseInteger(provider.batchInputTokenBudget, "provider.batchInputTokenBudget", 4000, 1);
  const prices = parsePrices(provider.prices);

  if (provider.kind === "workers-ai") {
    const endpoint = optionalUrl(provider.endpoint, "provider.endpoint");
    const model = parseModel(provider.model, true);
    const params = parseWorkersAIParams(provider.params);
    for (const [locale, choice] of typeof model === "string" ? [] : Object.entries(model)) {
      if (typeof choice === "string" || choice.enable_thinking === undefined) continue;
      const problem = workersAIParamsProblem({ ...params?.[choice.model], enable_thinking: choice.enable_thinking });
      if (problem !== undefined) throw configurationError(`provider.model.${locale}`, problem);
    }
    return {
      kind: "workers-ai",
      accountId: requireNonEmptyString(provider.accountId, "provider.accountId"),
      apiToken: requireNonEmptyString(provider.apiToken, "provider.apiToken"),
      ...(endpoint === undefined ? {} : { endpoint }),
      model,
      maxTokens,
      batchInputTokenBudget,
      ...(params === undefined ? {} : { params }),
      ...(prices === undefined ? {} : { prices }),
    };
  }
  if (provider.kind === "anthropic") {
    return {
      kind: "anthropic",
      apiKey: requireNonEmptyString(provider.apiKey, "provider.apiKey"),
      model: parseModel(provider.model, false) as ModelSpec,
      maxTokens,
      batchInputTokenBudget,
      ...(prices === undefined ? {} : { prices }),
    };
  }
  throw configurationError("provider.kind", 'must be "workers-ai" or "anthropic"');
}

function parsePrices(value: unknown): Record<string, ModelPrice> | undefined {
  if (value === undefined) return undefined;
  const prices: Record<string, ModelPrice> = {};
  for (const [model, price] of Object.entries(requireRecord(value, "provider.prices"))) {
    const problem = modelPriceProblem(price);
    if (problem !== undefined) throw configurationError(`provider.prices.${model}`, problem);
    prices[model] = price as ModelPrice;
  }
  return prices;
}

function parseWorkersAIParams(value: unknown): Record<string, Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  const params: Record<string, Record<string, unknown>> = {};
  for (const [model, modelParams] of Object.entries(requireRecord(value, "provider.params"))) {
    const record = requireRecord(modelParams, `provider.params.${model}`);
    const problem = workersAIParamsProblem(record);
    if (problem !== undefined) throw configurationError(`provider.params.${model}`, problem);
    params[model] = record;
  }
  return params;
}

function parseModel(value: unknown, allowChoices: boolean): ModelChoiceSpec {
  if (typeof value === "string" && value.length > 0) return value;
  const models = asRecordOrUndefined(value);
  if (models === undefined || models.default === undefined) {
    throw configurationError("provider.model", "must be a non-empty string or a locale map with a non-empty default");
  }
  for (const [locale, choice] of Object.entries(models)) parseModelChoice(choice, `provider.model.${locale}`, allowChoices);
  return models as { default: ModelChoice } & Record<string, ModelChoice>;
}

function parseModelChoice(value: unknown, label: string, allowChoices: boolean): void {
  if (typeof value === "string" && value.length > 0) return;
  const choice = asRecordOrUndefined(value);
  if (!allowChoices || choice === undefined) throw configurationError(label, "must be a non-empty model id string");
  rejectUnknownKeys(choice, ["model", "enable_thinking"], label);
  requireNonEmptyString(choice.model, `${label}.model`);
  if (choice.enable_thinking !== undefined && typeof choice.enable_thinking !== "boolean") {
    throw configurationError(`${label}.enable_thinking`, "must be true or false");
  }
}

function parseGlossaryConfig(value: unknown): CatalogGlossaryConfig {
  const glossary = requireRecord(value, "glossary");
  rejectUnknownKeys(glossary, ["file", "inline", "http", "r2", "matchInflections"], "glossary");
  const source = parseGlossarySource(glossary);
  if (glossary.matchInflections === undefined) return source;
  if (typeof glossary.matchInflections !== "boolean") throw configurationError("glossary.matchInflections", "must be a boolean");
  return { ...source, matchInflections: glossary.matchInflections };
}

function parseGlossarySource(glossary: Record<string, unknown>): CatalogGlossaryConfig {
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
