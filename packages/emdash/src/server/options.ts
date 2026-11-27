import {
  modelPriceProblem,
  resolveModelId,
  type Glossary,
  type ModelChoice,
  type ModelChoiceSpec,
  type ModelPrice,
} from "@cloudflare/polystella-core";
import {
  checkLocaleTags,
  compileIgnoreKeys,
  flattenCatalog,
  formatLocaleTagIssues,
  resolveLocaleTag,
  type CatalogSource,
  type IgnoreKey,
  type LocaleTags,
  type MessageSyntax,
} from "@cloudflare/polystella-core/catalog";
import { workersAIParamsForLocale, workersAIParamsProblem } from "@cloudflare/polystella-core/providers/workers-ai";

import { USE_CODE_DEFAULT_MODEL } from "../contracts.js";

// Same ceiling as the glossary file loader. Prompts carry only the terms a batch uses, so this is only a sanity bound.
const MAX_GLOSSARY_DEFAULT_CHARACTERS = 1_000_000;
const BLOCK_FIELD_PATH_PATTERN = /^[A-Za-z_][\w-]*(\[\])?(\.[A-Za-z_][\w-]*(\[\])?)*$/;
const EMDASH_LOCALE_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

export interface EmDashCatalogLocale {
  dictionary: CatalogSource;
  filePath: string;
}

export type EmDashWorkersAIProvider =
  | {
      kind: "workers-ai-binding";
      binding: string;
      maxTokens?: number | undefined;
      /** Stop waiting for a model reply after this many milliseconds. Default 200,000, under Workers AI's own ~236 s timeout. */
      timeoutMs?: number | undefined;
    }
  | {
      kind: "workers-ai-http";
      accountIdEnv: string;
      apiTokenEnv: string;
      endpoint?: string | undefined;
      maxTokens?: number | undefined;
      /** Stop waiting for a model reply after this many milliseconds. Default 200,000, under Workers AI's own ~236 s timeout. */
      timeoutMs?: number | undefined;
    };

export interface EmDashCatalogOptions {
  /** Regex strings matched against whole dotted keys. Matching entries are not messages: never shown, checked or translated. */
  ignoreKeys?: readonly string[] | undefined;
  /** `"polystella"` (default): `{{name}}`. `"icu"`: standard ICU MessageFormat, `{name}`. */
  messageSyntax?: MessageSyntax | undefined;
}

/** A text path inside a block, or a Markdown string at that path. */
export type BlockFieldPath = string | { path: string; format: "markdown" };

/** A code-defined glossary; `loadGlossaryDefaults` adds `source`, the YAML as written, shown to administrators only. */
export type GlossaryDefault = Glossary & { source?: string | undefined };

export interface PolystellaEmdashOptions {
  provider: EmDashWorkersAIProvider;
  catalogs: {
    defaultLocale: string;
    locales: Record<string, EmDashCatalogLocale>;
  };
  /** Same shape as `catalog` in `polystella.config.mjs`; import that file to share one block. */
  catalog?: EmDashCatalogOptions | undefined;
  models: {
    allowed: readonly string[];
    /**
     * Fallback until an administrator picks a default model in Translation settings; without it, the first allowed model.
     * Locale entries may be `{ model, enable_thinking }`, applied while the locale uses that model.
     */
    defaults?: ModelChoiceSpec | undefined;
    /** Extra Workers AI input per allowed model, such as `{ enable_thinking: false }`. */
    params?: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined;
    /** Model id → admin thinking choice → the exact input to send. Overrides the Workers AI catalog for that model. */
    reasoningInput?: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, unknown>>>>>> | undefined;
    /** USD list prices per allowed model, for the `estimatedCostUsd` of `provider_call` events. Overrides the Workers AI catalog. */
    prices?: Readonly<Record<string, ModelPrice>> | undefined;
  };
  glossaryDefaults?: Readonly<Record<string, GlossaryDefault>> | undefined;
  /** Let any letters follow a glossary term when deciding whether a batch uses it, so `Worker` matches "Workers". Default false. */
  glossaryMatchInflections?: boolean | undefined;
  rules?: readonly string[] | undefined;
  /**
   * Text paths translated inside custom Portable Text blocks, by block `_type`. `a.b` follows objects, `a[]` walks a list,
   * and a path that ends on a Portable Text array translates it too. Unlisted block types and fields are copied unchanged.
   * EmDash's own block types (`image`, `buttons`, `columns`, ...) have defaults; an entry replaces one, and `[]` turns it off.
   * `{ path, format: "markdown" }` translates a Markdown string by paragraph and list item, keeping its links and formatting.
   */
  blockFields?: Readonly<Record<string, readonly BlockFieldPath[]>> | undefined;
  /** Catalog locale → BCP 47 tag for codes `Intl` would misread (`jp` → `ja`). Unmapped locales are used as-is. */
  localeTags?: LocaleTags | undefined;
  /** Cloudflare Queue producer binding for server-side batch translation. The Worker must also export the queue consumer. */
  batchQueueBinding?: string | undefined;
}

export const REASONING_EFFORT_PATTERN = /^[a-z][a-z_]*$/;

export interface SerializedPolystellaEmdashOptions {
  serialized: string;
}

export function validatePolystellaEmdashOptions(value: unknown): asserts value is PolystellaEmdashOptions {
  const options = readRecord(value, "options");
  rejectUnknownKeys(
    options,
    [
      "provider",
      "catalogs",
      "catalog",
      "models",
      "glossaryDefaults",
      "glossaryMatchInflections",
      "rules",
      "blockFields",
      "localeTags",
      "batchQueueBinding",
    ],
    "options",
  );
  validateProvider(options.provider);
  if (options.batchQueueBinding !== undefined) readEnvironmentName(options.batchQueueBinding, "options.batchQueueBinding");

  const ignoreKey = validateCatalogOptions(options.catalog);
  const catalogs = readRecord(options.catalogs, "options.catalogs");
  const defaultLocale = readLocale(catalogs.defaultLocale, "options.catalogs.defaultLocale");
  const locales = readRecord(catalogs.locales, "options.catalogs.locales");
  if (!Object.hasOwn(locales, defaultLocale)) fail("options.catalogs.defaultLocale must exist in options.catalogs.locales");
  if (Object.keys(locales).length === 0) fail("options.catalogs.locales must contain at least one locale");
  for (const [locale, rawCatalog] of Object.entries(locales)) {
    readLocale(locale, `options.catalogs.locales.${locale}`);
    const catalog = readRecord(rawCatalog, `options.catalogs.locales.${locale}`);
    const dictionary = readRecord(catalog.dictionary, `options.catalogs.locales.${locale}.dictionary`);
    try {
      flattenCatalog(dictionary, ignoreKey);
    } catch (error) {
      fail(`options.catalogs.locales.${locale}.dictionary is invalid: ${error instanceof Error ? error.message : "invalid catalog"}`);
    }
    const filePath = readString(catalog.filePath, `options.catalogs.locales.${locale}.filePath`);
    if (
      filePath.startsWith("/") ||
      /^[A-Za-z]:\//.test(filePath) ||
      filePath.includes("\\") ||
      filePath.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      fail(`options.catalogs.locales.${locale}.filePath must be a repository-relative path`);
    }
  }

  const models = readRecord(options.models, "options.models");
  const allowedModels = readStringArray(models.allowed, "options.models.allowed", false);
  assertUnique(allowedModels, "options.models.allowed");
  if (allowedModels.includes(USE_CODE_DEFAULT_MODEL)) {
    fail(`options.models.allowed cannot contain reserved value ${JSON.stringify(USE_CODE_DEFAULT_MODEL)}`);
  }
  const defaultModels = models.defaults === undefined ? undefined : readModelSpec(models.defaults, "options.models.defaults");
  const configuredLocales = new Set(Object.keys(locales));
  const modelParams = models.params === undefined ? {} : readRecord(models.params, "options.models.params");
  for (const [model, params] of Object.entries(modelParams)) {
    if (!allowedModels.includes(model)) fail(`options.models.params.${model} must exist in options.models.allowed`);
    const problem = workersAIParamsProblem(readRecord(params, `options.models.params.${model}`));
    if (problem !== undefined) fail(`options.models.params.${model} ${problem}`);
  }
  for (const [locale, choice] of defaultModels === undefined ? [] : modelSpecEntries(defaultModels)) {
    if (locale !== "default" && !configuredLocales.has(locale)) {
      fail(`options.models.defaults.${locale} must match a configured catalog locale`);
    }
    const model = typeof choice === "string" ? choice : choice.model;
    if (!allowedModels.includes(model)) fail(`options.models.defaults.${locale} must exist in options.models.allowed`);
    if (typeof choice === "string" || choice.enable_thinking === undefined) continue;
    const params = modelParams[model] as Readonly<Record<string, unknown>> | undefined;
    const problem = workersAIParamsProblem({ ...params, enable_thinking: choice.enable_thinking });
    if (problem !== undefined) fail(`options.models.defaults.${locale} ${problem}`);
  }
  if (models.reasoningInput !== undefined) {
    for (const [model, rawEfforts] of Object.entries(readRecord(models.reasoningInput, "options.models.reasoningInput"))) {
      if (!allowedModels.includes(model)) fail(`options.models.reasoningInput.${model} must exist in options.models.allowed`);
      const efforts = readRecord(rawEfforts, `options.models.reasoningInput.${model}`);
      for (const [effort, input] of Object.entries(efforts)) {
        const label = `options.models.reasoningInput.${model}.${effort}`;
        readReasoningEffort(effort, `${label} key`);
        const fields = readRecord(input, label);
        const problem = workersAIParamsProblem(fields);
        if (problem !== undefined) fail(`${label} ${problem}`);
        try {
          JSON.stringify(fields);
        } catch {
          fail(`${label} must be JSON-serializable`);
        }
      }
    }
  }

  if (models.prices !== undefined) {
    for (const [model, price] of Object.entries(readRecord(models.prices, "options.models.prices"))) {
      if (!allowedModels.includes(model)) fail(`options.models.prices.${model} must exist in options.models.allowed`);
      const problem = modelPriceProblem(price);
      if (problem !== undefined) fail(`options.models.prices.${model} ${problem}`);
    }
  }

  if (options.glossaryDefaults !== undefined) {
    const defaults = readRecord(options.glossaryDefaults, "options.glossaryDefaults");
    for (const [locale, glossary] of Object.entries(defaults)) {
      if (!configuredLocales.has(locale)) fail(`options.glossaryDefaults.${locale} must match a configured catalog locale`);
      const { source, ...terms } = validateGlossary(glossary, `options.glossaryDefaults.${locale}`);
      if (JSON.stringify(terms).length > MAX_GLOSSARY_DEFAULT_CHARACTERS) {
        fail(`options.glossaryDefaults.${locale} cannot exceed ${MAX_GLOSSARY_DEFAULT_CHARACTERS} characters`);
      }
      if (source !== undefined && (typeof source !== "string" || source.length > MAX_GLOSSARY_DEFAULT_CHARACTERS)) {
        fail(`options.glossaryDefaults.${locale}.source must be a string of at most ${MAX_GLOSSARY_DEFAULT_CHARACTERS} characters`);
      }
    }
  }
  if (options.glossaryMatchInflections !== undefined && typeof options.glossaryMatchInflections !== "boolean") {
    fail("options.glossaryMatchInflections must be a boolean");
  }

  if (options.rules !== undefined) readStringArray(options.rules, "options.rules", true);

  if (options.blockFields !== undefined) {
    const blockFields = readRecord(options.blockFields, "options.blockFields");
    for (const [type, paths] of Object.entries(blockFields)) {
      if (type === "block" || type === "span") fail(`options.blockFields.${type} is reserved for standard Portable Text`);
      if (!Array.isArray(paths)) fail(`options.blockFields.${type} must be an array`);
      const typePaths = paths.map((entry: unknown, index) => {
        const label = `options.blockFields.${type}[${index}]`;
        if (typeof entry === "string") return readBlockFieldPath(entry, label);
        const record = readRecord(entry, label);
        rejectUnknownKeys(record, ["path", "format"], label);
        if (record.format !== "markdown") fail(`${label}.format must be "markdown"`);
        return readBlockFieldPath(record.path, `${label}.path`);
      });
      assertUnique(typePaths, `options.blockFields.${type}`);
    }
  }

  if (options.localeTags !== undefined) {
    const localeTags = readRecord(options.localeTags, "options.localeTags");
    for (const [locale, tag] of Object.entries(localeTags)) {
      if (!configuredLocales.has(locale)) fail(`options.localeTags.${locale} must match a configured catalog locale`);
      readString(tag, `options.localeTags.${locale}`);
    }
  }
  const tagIssues = checkLocaleTags([...configuredLocales], options.localeTags as LocaleTags | undefined);
  if (tagIssues.length > 0) fail(`options.localeTags is invalid:\n${formatLocaleTagIssues(tagIssues)}`);
}

export function serializeOptions(options: PolystellaEmdashOptions): SerializedPolystellaEmdashOptions {
  const normalized: PolystellaEmdashOptions = {
    provider:
      options.provider.kind === "workers-ai-binding"
        ? {
            kind: "workers-ai-binding",
            binding: options.provider.binding,
            ...(options.provider.maxTokens === undefined ? {} : { maxTokens: options.provider.maxTokens }),
            ...(options.provider.timeoutMs === undefined ? {} : { timeoutMs: options.provider.timeoutMs }),
          }
        : {
            kind: "workers-ai-http",
            accountIdEnv: options.provider.accountIdEnv,
            apiTokenEnv: options.provider.apiTokenEnv,
            ...(options.provider.maxTokens === undefined ? {} : { maxTokens: options.provider.maxTokens }),
            ...(options.provider.timeoutMs === undefined ? {} : { timeoutMs: options.provider.timeoutMs }),
            ...(options.provider.endpoint === undefined ? {} : { endpoint: options.provider.endpoint }),
          },
    catalogs: {
      defaultLocale: options.catalogs.defaultLocale,
      locales: Object.fromEntries(
        Object.entries(options.catalogs.locales).map(([locale, catalog]) => [
          locale,
          {
            dictionary: Object.fromEntries(Object.entries(catalog.dictionary)),
            filePath: catalog.filePath,
          },
        ]),
      ),
    },
    models: {
      allowed: [...options.models.allowed],
      ...(options.models.defaults === undefined ? {} : { defaults: structuredClone(options.models.defaults) }),
      ...(options.models.params === undefined ? {} : { params: structuredClone(options.models.params) }),
      ...(options.models.reasoningInput === undefined ? {} : { reasoningInput: structuredClone(options.models.reasoningInput) }),
      ...(options.models.prices === undefined ? {} : { prices: structuredClone(options.models.prices) }),
    },
    ...(options.glossaryDefaults === undefined
      ? {}
      : {
          glossaryDefaults: Object.fromEntries(
            Object.entries(options.glossaryDefaults).map(([locale, glossary]) => [
              locale,
              {
                version: glossary.version,
                doNotTranslate: [...glossary.doNotTranslate],
                preferredTranslations: { ...glossary.preferredTranslations },
                styleRules: glossary.styleRules.map((rule) => ({ ...rule })),
                notes: glossary.notes,
                ...(glossary.source === undefined ? {} : { source: glossary.source }),
              },
            ]),
          ),
        }),
    ...(options.glossaryMatchInflections === undefined ? {} : { glossaryMatchInflections: options.glossaryMatchInflections }),
    ...(options.rules === undefined ? {} : { rules: [...options.rules] }),
    ...(options.blockFields === undefined
      ? {}
      : { blockFields: Object.fromEntries(Object.entries(options.blockFields).map(([type, paths]) => [type, [...paths]])) }),
    ...(options.localeTags === undefined ? {} : { localeTags: { ...options.localeTags } }),
    ...(options.batchQueueBinding === undefined ? {} : { batchQueueBinding: options.batchQueueBinding }),
    ...(options.catalog === undefined
      ? {}
      : {
          catalog: {
            ...(options.catalog.ignoreKeys === undefined ? {} : { ignoreKeys: [...options.catalog.ignoreKeys] }),
            ...(options.catalog.messageSyntax === undefined ? {} : { messageSyntax: options.catalog.messageSyntax }),
          },
        }),
  };
  return { serialized: JSON.stringify(normalized) };
}

/** `catalog.ignoreKeys` compiled; `undefined` when there are none. */
export function catalogIgnoreKey(options: Pick<PolystellaEmdashOptions, "catalog">): IgnoreKey | undefined {
  return compileIgnoreKeys(options.catalog?.ignoreKeys ?? []);
}

export function catalogMessageSyntax(options: Pick<PolystellaEmdashOptions, "catalog">): MessageSyntax {
  return options.catalog?.messageSyntax ?? "polystella";
}

function validateCatalogOptions(value: unknown): IgnoreKey | undefined {
  if (value === undefined) return undefined;
  const catalog = readRecord(value, "options.catalog");
  rejectUnknownKeys(catalog, ["ignoreKeys", "messageSyntax"], "options.catalog");
  if (catalog.messageSyntax !== undefined && catalog.messageSyntax !== "polystella" && catalog.messageSyntax !== "icu") {
    fail('options.catalog.messageSyntax must be "polystella" or "icu"');
  }
  const ignoreKeys = catalog.ignoreKeys ?? [];
  if (!Array.isArray(ignoreKeys) || !ignoreKeys.every((pattern): pattern is string => typeof pattern === "string" && pattern.length > 0)) {
    fail("options.catalog.ignoreKeys must be an array of non-empty regular expression strings (not RegExp objects)");
  }
  try {
    return compileIgnoreKeys(ignoreKeys);
  } catch (error) {
    fail(`options.catalog.ignoreKeys contains an invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function deserializeOptions(runtimeOptions: unknown): PolystellaEmdashOptions {
  const serialized = readString(readRecord(runtimeOptions, "runtime options").serialized, "runtime options.serialized");
  let options: unknown;
  try {
    options = JSON.parse(serialized);
  } catch {
    fail("runtime options.serialized must contain valid JSON");
  }
  validatePolystellaEmdashOptions(options);
  return options;
}

export function localeTag(options: Pick<PolystellaEmdashOptions, "localeTags">, locale: string): string {
  return resolveLocaleTag(locale, options.localeTags);
}

export function targetLocales(options: PolystellaEmdashOptions): string[] {
  return Object.keys(options.catalogs.locales)
    .filter((locale) => locale !== options.catalogs.defaultLocale)
    .sort();
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) fail(`${label} must be a non-empty trimmed string`);
  return value;
}

function readLocale(value: unknown, label: string): string {
  const locale = readString(value, label);
  if (locale.length > 64 || !EMDASH_LOCALE_PATTERN.test(locale)) fail(`${label} must be a valid EmDash locale`);
  return locale;
}

function readStringArray(value: unknown, label: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) fail(`${label} must be a non-empty string array`);
  return value.map((item, index) => readString(item, `${label}[${index}]`));
}

function readBlockFieldPath(value: unknown, label: string): string {
  const path = readString(value, label);
  if (!BLOCK_FIELD_PATH_PATTERN.test(path)) fail(`${label} must look like "title", "cta.label" or "cards[].title"`);
  return path;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) fail(`${label} cannot contain duplicates`);
}

function validateProvider(value: unknown): void {
  const provider = readRecord(value, "options.provider");
  for (const key of ["maxTokens", "timeoutMs"]) {
    const value = provider[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value <= 0)) {
      fail(`options.provider.${key} must be a positive integer`);
    }
  }
  if (provider.kind === "workers-ai-binding") {
    rejectUnknownKeys(provider, ["kind", "binding", "maxTokens", "timeoutMs"], "options.provider");
    readEnvironmentName(provider.binding, "options.provider.binding");
    return;
  }
  if (provider.kind === "workers-ai-http") {
    rejectUnknownKeys(provider, ["kind", "accountIdEnv", "apiTokenEnv", "maxTokens", "timeoutMs", "endpoint"], "options.provider");
    readEnvironmentName(provider.accountIdEnv, "options.provider.accountIdEnv");
    readEnvironmentName(provider.apiTokenEnv, "options.provider.apiTokenEnv");
    if (provider.endpoint !== undefined) {
      const endpoint = readString(provider.endpoint, "options.provider.endpoint");
      try {
        new URL(endpoint);
      } catch {
        fail("options.provider.endpoint must be a valid URL");
      }
    }
    return;
  }
  fail('options.provider.kind must be "workers-ai-binding" or "workers-ai-http"');
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) fail(`${label}.${unknown} is not supported`);
}

function readEnvironmentName(value: unknown, label: string): string {
  const name = readString(value, label);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail(`${label} must be a valid environment binding name`);
  return name;
}

function readModelSpec(value: unknown, label: string): ModelChoiceSpec {
  if (typeof value === "string") return readString(value, label);
  const models = readRecord(value, label);
  if (models.default === undefined) fail(`${label}.default is required`);
  for (const [locale, choice] of Object.entries(models)) {
    if (locale !== "default") readLocale(locale, `${label} key`);
    if (typeof choice === "string") {
      readString(choice, `${label}.${locale}`);
      continue;
    }
    const entry = readRecord(choice, `${label}.${locale}`);
    rejectUnknownKeys(entry, ["model", "enable_thinking"], `${label}.${locale}`);
    readString(entry.model, `${label}.${locale}.model`);
    if (entry.enable_thinking !== undefined && typeof entry.enable_thinking !== "boolean") {
      fail(`${label}.${locale}.enable_thinking must be true or false`);
    }
  }
  return models as { default: ModelChoice } & Record<string, ModelChoice>;
}

function readReasoningEffort(value: unknown, label: string): string {
  const effort = readString(value, label);
  if (!isReasoningEffort(effort)) fail(`${label} must be a lowercase effort name such as "none" or "high"`);
  return effort;
}

/** The model a locale uses when no administrator picked one: `models.defaults`, else the first allowed model. */
export function codeFallbackModel(options: PolystellaEmdashOptions, locale: string): string {
  const { defaults, allowed } = options.models;
  // `allowed` is validated non-empty.
  return defaults === undefined ? (allowed[0] ?? "") : resolveModelId(defaults, locale);
}

/** `models.params` for `model`, with the `enable_thinking` a `models.defaults` locale entry sets while it uses that model. */
export function codeModelParams(
  options: PolystellaEmdashOptions,
  model: string,
  locale: string,
): Readonly<Record<string, unknown>> | undefined {
  const params = options.models.params?.[model];
  return options.models.defaults === undefined ? params : workersAIParamsForLocale(params, options.models.defaults, locale, model);
}

/** The thinking the code sets for a locale's fallback model, for display; `null` when the code leaves it to the model. */
export function codeDefaultThinking(options: PolystellaEmdashOptions, locale: string): string | null {
  const model = codeFallbackModel(options, locale);
  const params = codeModelParams(options, model, locale);
  if (typeof params?.reasoning_effort === "string") return params.reasoning_effort;
  const kwargs = params?.chat_template_kwargs;
  const enabled = params?.enable_thinking ?? (isPlainRecord(kwargs) ? kwargs.enable_thinking : undefined);
  return enabled === false ? "none" : enabled === true ? "on" : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isReasoningEffort(value: string): boolean {
  return value.length <= 32 && REASONING_EFFORT_PATTERN.test(value);
}

function modelSpecEntries(models: ModelChoiceSpec): Array<[string, ModelChoice]> {
  return typeof models === "string" ? [["default", models]] : Object.entries(models);
}

function validateGlossary(value: unknown, label: string): Record<string, unknown> {
  const glossary = readRecord(value, label);
  readStringValue(glossary.version, `${label}.version`);
  readStringArray(glossary.doNotTranslate, `${label}.doNotTranslate`, true);
  const preferred = readRecord(glossary.preferredTranslations, `${label}.preferredTranslations`);
  for (const [term, translation] of Object.entries(preferred)) readString(translation, `${label}.preferredTranslations.${term}`);
  const rules = glossary.styleRules;
  if (!Array.isArray(rules)) fail(`${label}.styleRules must be an array`);
  for (const [index, rawRule] of rules.entries()) {
    const rule = readRecord(rawRule, `${label}.styleRules[${index}]`);
    readString(rule.category, `${label}.styleRules[${index}].category`);
    readString(rule.instruction, `${label}.styleRules[${index}].instruction`);
    if (rule.example !== undefined) readString(rule.example, `${label}.styleRules[${index}].example`);
  }
  readStringValue(glossary.notes, `${label}.notes`);
  return glossary;
}

function readStringValue(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`${label} must be a string`);
  return value;
}

function fail(message: string): never {
  throw new Error(`[polystella-emdash] ${message}`);
}
