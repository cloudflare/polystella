import { EMPTY_GLOSSARY, type Glossary, type Translator } from "@cloudflare/polystella-core";
import { translateCatalogEntries } from "@cloudflare/polystella-core/catalog/translate";
import {
  createWorkersAIBindingTranslator,
  type WorkersAIBindingRun,
  type WorkersAIInput,
} from "@cloudflare/polystella-providers/workers-ai";
import { PluginRouteError, type KVAccess, type LogAccess, type PluginRoute, type StorageCollection } from "emdash";

import { applyCatalogOverrides, catalogOverrideId, catalogOverrideState, serializeCatalog, type CatalogOverride } from "./catalog.js";
import {
  MAX_CATALOG_KEYS,
  MAX_CONTENT_FIELDS,
  type CatalogEntryView,
  type CatalogExportResponse,
  type CatalogGenerationResponse,
  type CatalogOverrideMutationResponse,
  type CatalogRuntimeMutationResponse,
  type CatalogViewResponse,
  type CollectionPolicyResponse,
  type CollectionSettingsResponse,
  type RuntimeOverridesResponse,
  type TranslateContentResponse,
} from "./contracts.js";
import { ContentTranslationInputError, translateContentFields } from "./translate-content.js";
import type { PolystellaEmdashOptions } from "./index.js";

const ENABLED_COLLECTIONS_KEY = "settings:enabledCollections";
const MAX_TOKENS = 8192;
const MAX_LOCALE_LENGTH = 64;
const MAX_GLOSSARY_CHARACTERS = 10_000;
const MAX_INSTRUCTION_CHARACTERS = 10_000;
const MAX_OVERRIDE_CHARACTERS = 20_000;
const MAX_TOTAL_OVERRIDE_CHARACTERS = 100_000;
const MAX_CATALOG_SOURCE_CHARACTERS = 30_000;
const EMDASH_LOCALE_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

export interface PluginRouteDependencies {
  getEnv(): Promise<Record<string, unknown> | undefined>;
  now(): Date;
}

const defaultDependencies: PluginRouteDependencies = {
  async getEnv() {
    return (await import("virtual:emdash/env")).env;
  },
  now: () => new Date(),
};

export function createPluginRoutes(
  options: PolystellaEmdashOptions,
  dependencies: PluginRouteDependencies = defaultDependencies,
): Record<string, PluginRoute> {
  return {
    "settings/collections": {
      permission: "plugins:manage",
      async handler(ctx) {
        if (ctx.request.method === "GET") return collectionSettings(options, ctx.kv);
        requireMethod(ctx.request, "PUT");
        const configured = Object.keys(options.collections);
        const enabled = readStringArray(readRecord(ctx.input, "request body").collections, "collections", true);
        if (enabled.some((collection) => !configured.includes(collection))) {
          throw PluginRouteError.badRequest("collections must be deployment-allowlisted");
        }
        const normalized = [...new Set(enabled)].sort();
        await ctx.kv.set(ENABLED_COLLECTIONS_KEY, normalized);
        return { configured: configured.sort(), enabled: normalized } satisfies CollectionSettingsResponse;
      },
    },
    policy: {
      permission: "content:edit_any",
      async handler(ctx) {
        requireMethod(ctx.request, "GET");
        const collection = readString(readRecord(ctx.input, "query").collection, "collection");
        const policy = Object.hasOwn(options.collections, collection) ? options.collections[collection] : undefined;
        const enabled = policy !== undefined && (await enabledCollections(options, ctx.kv)).includes(collection);
        return {
          enabled,
          sourceLocale: policy?.sourceLocale ?? null,
          fields: policy === undefined ? [] : [...policy.fields],
        } satisfies CollectionPolicyResponse;
      },
    },
    "translate-content": {
      permission: "content:edit_any",
      async handler(ctx) {
        requireMethod(ctx.request, "POST");
        const input = readRecord(ctx.input, "request body");
        const collection = readString(input.collection, "collection");
        const targetLocale = readLocale(input.targetLocale, "targetLocale");
        const entryId = readString(input.entryId, "entryId");
        const selectedFields = [...new Set(readStringArray(input.fields, "fields", false))];
        const policy = Object.hasOwn(options.collections, collection) ? options.collections[collection] : undefined;
        if (policy === undefined || !(await enabledCollections(options, ctx.kv)).includes(collection)) {
          throw PluginRouteError.forbidden("PolyStella is not enabled for this collection");
        }
        if (targetLocale === policy.sourceLocale) throw PluginRouteError.badRequest("targetLocale must differ from sourceLocale");
        if (selectedFields.length > MAX_CONTENT_FIELDS) {
          throw PluginRouteError.badRequest(`fields cannot contain more than ${MAX_CONTENT_FIELDS} values`);
        }
        if (selectedFields.some((field) => !policy.fields.includes(field))) {
          throw PluginRouteError.badRequest("fields must be deployment-allowlisted");
        }
        if (ctx.content === undefined) throw PluginRouteError.internal("content access is unavailable");
        const item = await ctx.content.get(collection, entryId);
        if (item === null) throw PluginRouteError.notFound("content entry not found");
        if (item.locale !== targetLocale) throw PluginRouteError.badRequest("entry locale does not match targetLocale");
        const values = Object.fromEntries(
          selectedFields.flatMap((field) => (Object.hasOwn(item.data, field) ? [[field, item.data[field]]] : [])),
        );
        if (Object.keys(values).length === 0) throw PluginRouteError.badRequest("selected fields have no saved values");

        try {
          const settings = await translationSettings(options, ctx.kv, ctx.log, dependencies);
          const result = await translateContentFields({
            values,
            translator: settings.translator,
            glossary: settings.glossary,
            sourceLocale: policy.sourceLocale,
            targetLocale,
            ...(settings.promptInstruction === undefined ? {} : { promptInstruction: settings.promptInstruction }),
            signal: ctx.request.signal,
          });
          return result satisfies TranslateContentResponse;
        } catch (error) {
          if (error instanceof ContentTranslationInputError) throw PluginRouteError.badRequest(error.message);
          throwTranslationFailure(error, ctx.log, "content");
        }
      },
    },
    catalog: {
      permission: "plugins:manage",
      async handler(ctx) {
        requireMethod(ctx.request, "GET");
        const query = readRecord(ctx.input, "query");
        const locale = query.locale === undefined ? preferredCatalogLocale(options) : readString(query.locale, "locale");
        return catalogView(options, ctx.kv, overrideStorage(ctx.storage), locale);
      },
    },
    "catalog/generate": {
      permission: "plugins:manage",
      async handler(ctx) {
        requireMethod(ctx.request, "POST");
        const input = readRecord(ctx.input, "request body");
        const locale = configuredLocale(options, readString(input.locale, "locale"));
        if (locale === options.catalogs.defaultLocale) throw PluginRouteError.badRequest("cannot translate the default locale");
        const keys = [...new Set(readStringArray(input.keys, "keys", false))];
        if (keys.length > MAX_CATALOG_KEYS) throw PluginRouteError.badRequest(`keys cannot contain more than ${MAX_CATALOG_KEYS} values`);
        const source = options.catalogs.locales[options.catalogs.defaultLocale]?.dictionary;
        if (source === undefined) throw PluginRouteError.internal("default locale dictionary is unavailable");
        const entries = keys.map((key) => {
          if (!Object.hasOwn(source, key) || source[key] === "") throw PluginRouteError.badRequest(`key "${key}" has no source value`);
          return { key, source: source[key] ?? "" };
        });
        if (entries.reduce((total, entry) => total + entry.source.length, 0) > MAX_CATALOG_SOURCE_CHARACTERS) {
          throw PluginRouteError.badRequest(`source values cannot exceed ${MAX_CATALOG_SOURCE_CHARACTERS} characters in total`);
        }
        try {
          const settings = await translationSettings(options, ctx.kv, ctx.log, dependencies);
          const result = await translateCatalogEntries({
            entries,
            translator: settings.translator,
            glossary: settings.glossary,
            sourceLocale: options.catalogs.defaultLocale,
            targetLocale: locale,
            maxRetries: 2,
            ...(settings.promptInstruction === undefined ? {} : { context: settings.promptInstruction }),
            signal: ctx.request.signal,
          });
          return {
            translations: Object.fromEntries(result.translations),
            tokenFailures: result.tokenFailures,
          } satisfies CatalogGenerationResponse;
        } catch (error) {
          throwTranslationFailure(error, ctx.log, "catalog");
        }
      },
    },
    "catalog/overrides": {
      permission: "plugins:manage",
      async handler(ctx) {
        requireMethod(ctx.request, "PUT");
        const input = readRecord(ctx.input, "request body");
        const locale = configuredLocale(options, readString(input.locale, "locale"));
        const values = Object.entries(readNullableStringRecord(input.overrides, "overrides"));
        if (values.length !== 1) throw PluginRouteError.badRequest("overrides must contain exactly one key");
        const catalog = options.catalogs.locales[locale];
        const source = options.catalogs.locales[options.catalogs.defaultLocale]?.dictionary;
        if (catalog === undefined || source === undefined) throw PluginRouteError.internal("catalog configuration is unavailable");
        const now = dependencies.now().toISOString();
        const updatedBy = ctx.user?.id ?? "api-token";
        const storage = overrideStorage(ctx.storage);
        const [key, value] = values[0] ?? [];
        if (key === undefined || value === undefined) throw PluginRouteError.badRequest("override is missing");
        if (value !== null && !Object.hasOwn(source, key) && !Object.hasOwn(catalog.dictionary, key)) {
          throw PluginRouteError.badRequest(`unknown catalog key "${key}"`);
        }
        const id = catalogOverrideId(locale, key);
        if (value !== null) {
          const maxCharacters = overrideCharacterLimit(source, catalog.dictionary);
          if (value.length > maxCharacters) {
            throw PluginRouteError.badRequest(`override cannot exceed ${maxCharacters} characters`);
          }
        }
        if (value === null) await storage.delete(id);
        else await storage.put(id, { locale, key, value, updatedAt: now, updatedBy } satisfies CatalogOverride);
        return { key } satisfies CatalogOverrideMutationResponse;
      },
    },
    "catalog/runtime": {
      permission: "plugins:manage",
      async handler(ctx) {
        requireMethod(ctx.request, "PUT");
        const input = readRecord(ctx.input, "request body");
        const locale = configuredLocale(options, readString(input.locale, "locale"));
        const enabled = readBoolean(input.enabled, "enabled");
        if (enabled) await ctx.kv.set(runtimeLocaleKey(locale), true);
        else await ctx.kv.delete(runtimeLocaleKey(locale));
        return { locale, enabled } satisfies CatalogRuntimeMutationResponse;
      },
    },
    "catalog/export": {
      permission: "plugins:manage",
      async handler(ctx) {
        requireMethod(ctx.request, "GET");
        const locale = configuredLocale(options, readString(readRecord(ctx.input, "query").locale, "locale"));
        const catalog = options.catalogs.locales[locale];
        if (catalog === undefined) throw PluginRouteError.internal("catalog configuration is unavailable");
        const overrides = usableOverrides(options, locale, await listOverrides(overrideStorage(ctx.storage), locale));
        return {
          filePath: catalog.filePath,
          filename: catalog.filePath.split("/").at(-1) ?? `${locale}.json`,
          json: serializeCatalog(locale, catalog.dictionary, overrides),
        } satisfies CatalogExportResponse;
      },
    },
    overrides: {
      public: true,
      cacheControl: "public, max-age=60, stale-while-revalidate=300",
      async handler(ctx) {
        requireMethod(ctx.request, "GET");
        const locale = configuredLocale(options, readString(readRecord(ctx.input, "query").locale, "locale"));
        if (!(await runtimeLocaleEnabled(ctx.kv, locale))) {
          return { enabled: false, overrides: {} } satisfies RuntimeOverridesResponse;
        }
        const overrides = usableOverrides(options, locale, await listOverrides(overrideStorage(ctx.storage), locale));
        return { enabled: true, overrides: applyCatalogOverrides(locale, {}, overrides) } satisfies RuntimeOverridesResponse;
      },
    },
  };
}

async function collectionSettings(options: PolystellaEmdashOptions, kv: KVAccess): Promise<CollectionSettingsResponse> {
  return { configured: Object.keys(options.collections).sort(), enabled: await enabledCollections(options, kv) };
}

function overrideStorage(storage: Record<string, StorageCollection | undefined>): StorageCollection {
  const collection = storage.catalog_overrides;
  if (collection === undefined) throw PluginRouteError.internal("catalog override storage is unavailable");
  return collection;
}

async function enabledCollections(options: PolystellaEmdashOptions, kv: KVAccess): Promise<string[]> {
  const configured = Object.keys(options.collections);
  const stored = await kv.get<unknown>(ENABLED_COLLECTIONS_KEY);
  if (stored === null) return configured.sort();
  return readStoredStringArray(stored, ENABLED_COLLECTIONS_KEY)
    .filter((collection) => configured.includes(collection))
    .sort();
}

async function runtimeLocales(options: PolystellaEmdashOptions, kv: KVAccess): Promise<string[]> {
  const configured = Object.keys(options.catalogs.locales);
  const states = await Promise.all(configured.map(async (locale) => ({ locale, enabled: await runtimeLocaleEnabled(kv, locale) })));
  return states
    .filter(({ enabled }) => enabled)
    .map(({ locale }) => locale)
    .sort();
}

async function runtimeLocaleEnabled(kv: KVAccess, locale: string): Promise<boolean> {
  return (await kv.get<unknown>(runtimeLocaleKey(locale))) === true;
}

function runtimeLocaleKey(locale: string): string {
  return `settings:runtimeOverride:${locale}`;
}

async function catalogView(
  options: PolystellaEmdashOptions,
  kv: KVAccess,
  storage: StorageCollection,
  locale: string,
): Promise<CatalogViewResponse> {
  const catalog = options.catalogs.locales[configuredLocale(options, locale)];
  const source = options.catalogs.locales[options.catalogs.defaultLocale]?.dictionary;
  if (catalog === undefined || source === undefined) throw PluginRouteError.internal("catalog configuration is unavailable");
  const [storedOverrides, enabledLocales] = await Promise.all([listOverrides(storage, locale), runtimeLocales(options, kv)]);
  const overrides = usableOverrides(options, locale, storedOverrides);
  const overrideByKey = new Map(overrides.map((override) => [override.key, override]));
  const keys = [...new Set([...Object.keys(source), ...Object.keys(catalog.dictionary), ...overrideByKey.keys()])].sort();
  const entries: CatalogEntryView[] = keys.map((key) => {
    const override = overrideByKey.get(key);
    return {
      key,
      source: Object.hasOwn(source, key) ? (source[key] ?? null) : null,
      deployed: Object.hasOwn(catalog.dictionary, key) ? (catalog.dictionary[key] ?? null) : null,
      override: override?.value ?? null,
      state: override === undefined ? null : catalogOverrideState(catalog.dictionary, override),
    };
  });
  return {
    defaultLocale: options.catalogs.defaultLocale,
    locale,
    locales: Object.entries(options.catalogs.locales)
      .map(([code, value]) => ({ locale: code, filePath: value.filePath, runtimeEnabled: enabledLocales.includes(code) }))
      .sort((left, right) => left.locale.localeCompare(right.locale)),
    entries,
  };
}

async function listOverrides(storage: StorageCollection, locale: string): Promise<CatalogOverride[]> {
  const overrides: CatalogOverride[] = [];
  let cursor: string | undefined;
  do {
    const page = await storage.query({ where: { locale }, limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    for (const item of page.items) {
      const override = parseOverride(item.data);
      if (override.locale !== locale) throw PluginRouteError.internal("catalog override locale index is invalid");
      overrides.push(override);
    }
    if (!page.hasMore) break;
    if (page.cursor === undefined) throw PluginRouteError.internal("override pagination cursor is missing");
    cursor = page.cursor;
  } while (true);
  return overrides.sort((left, right) => left.key.localeCompare(right.key));
}

function usableOverrides(options: PolystellaEmdashOptions, locale: string, overrides: readonly CatalogOverride[]): CatalogOverride[] {
  const source = options.catalogs.locales[options.catalogs.defaultLocale]?.dictionary;
  const catalog = options.catalogs.locales[locale]?.dictionary;
  if (source === undefined || catalog === undefined) throw PluginRouteError.internal("catalog configuration is unavailable");
  const allowed = new Set([...Object.keys(source), ...Object.keys(catalog)]);
  const maxCharacters = overrideCharacterLimit(source, catalog);
  return overrides.filter((override) => allowed.has(override.key) && override.value.length <= maxCharacters);
}

function overrideCharacterLimit(source: Record<string, string>, catalog: Record<string, string>): number {
  const keyCount = new Set([...Object.keys(source), ...Object.keys(catalog)]).size;
  return Math.min(MAX_OVERRIDE_CHARACTERS, Math.floor(MAX_TOTAL_OVERRIDE_CHARACTERS / Math.max(1, keyCount)));
}

function parseOverride(value: unknown): CatalogOverride {
  const record = readStoredRecord(value, "catalog override");
  return {
    locale: readStoredString(record.locale, "catalog override locale"),
    key: readStoredString(record.key, "catalog override key"),
    value: readStoredString(record.value, "catalog override value", true),
    updatedAt: readStoredString(record.updatedAt, "catalog override updatedAt"),
    updatedBy: readStoredString(record.updatedBy, "catalog override updatedBy"),
  };
}

async function translationSettings(
  options: PolystellaEmdashOptions,
  kv: KVAccess,
  log: LogAccess,
  dependencies: PluginRouteDependencies,
): Promise<{ translator: Translator; glossary: Glossary; promptInstruction?: string | undefined }> {
  const [storedModel, storedGlossary, storedInstructions, env] = await Promise.all([
    kv.get<unknown>("settings:model"),
    kv.get<unknown>("settings:glossary"),
    kv.get<unknown>("settings:instructions"),
    dependencies.getEnv(),
  ]);
  const model = typeof storedModel === "string" && options.models.allowed.includes(storedModel) ? storedModel : options.models.default;
  const binding = env?.[options.aiBinding];
  if (!isWorkersAIBinding(binding)) {
    log.error("PolyStella Workers AI binding is unavailable", { binding: options.aiBinding });
    throw new PluginRouteError("AI_BINDING_UNAVAILABLE", "PolyStella's Workers AI binding is unavailable", 503);
  }
  const glossaryText = typeof storedGlossary === "string" ? storedGlossary.trim() : "";
  const instructions = typeof storedInstructions === "string" ? storedInstructions.trim() : "";
  const promptInstruction = [...(options.rules ?? []), instructions].filter((value) => value.length > 0).join("\n");
  if (glossaryText.length > MAX_GLOSSARY_CHARACTERS) {
    throw PluginRouteError.badRequest(`glossary cannot exceed ${MAX_GLOSSARY_CHARACTERS} characters`);
  }
  if (promptInstruction.length > MAX_INSTRUCTION_CHARACTERS) {
    throw PluginRouteError.badRequest(`translation instructions cannot exceed ${MAX_INSTRUCTION_CHARACTERS} characters`);
  }
  return {
    translator: createWorkersAIBindingTranslator({
      modelId: model,
      maxTokens: MAX_TOKENS,
      run: workersRun(binding),
    }),
    glossary: { ...EMPTY_GLOSSARY, notes: glossaryText },
    ...(promptInstruction.length === 0 ? {} : { promptInstruction }),
  };
}

function workersRun(binding: WorkersAIBinding): WorkersAIBindingRun {
  return async (modelId, input) => await binding.run(modelId, input);
}

function throwTranslationFailure(error: unknown, log: LogAccess, operation: string): never {
  if (error instanceof PluginRouteError || (error instanceof Error && error.name === "AbortError")) throw error;
  log.error("PolyStella translation failed", {
    operation,
    errorType: error instanceof Error ? error.name : typeof error,
  });
  throw PluginRouteError.internal("PolyStella translation failed");
}

interface WorkersAIBinding {
  run(modelId: string, input: WorkersAIInput): unknown;
}

function isWorkersAIBinding(value: unknown): value is WorkersAIBinding {
  return typeof value === "object" && value !== null && "run" in value && typeof value.run === "function";
}

function preferredCatalogLocale(options: PolystellaEmdashOptions): string {
  return (
    Object.keys(options.catalogs.locales).find((locale) => locale !== options.catalogs.defaultLocale) ?? options.catalogs.defaultLocale
  );
}

function configuredLocale(options: PolystellaEmdashOptions, locale: string): string {
  if (!Object.hasOwn(options.catalogs.locales, locale)) throw PluginRouteError.notFound(`unknown locale "${locale}"`);
  return locale;
}

function requireMethod(request: Request, expected: string): void {
  if (request.method !== expected) throw new PluginRouteError("METHOD_NOT_ALLOWED", `${expected} required`, 405);
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw PluginRouteError.badRequest(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw PluginRouteError.badRequest(`${label} must be a non-empty string`);
  return value;
}

function readLocale(value: unknown, label: string): string {
  const locale = readString(value, label);
  if (locale.length > MAX_LOCALE_LENGTH || !EMDASH_LOCALE_PATTERN.test(locale)) {
    throw PluginRouteError.badRequest(`${label} must be a valid EmDash locale`);
  }
  return locale;
}

function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw PluginRouteError.badRequest(`${label} must be a boolean`);
  return value;
}

function readStringArray(value: unknown, label: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw PluginRouteError.badRequest(`${label} must be ${allowEmpty ? "a" : "a non-empty"} string array`);
  }
  return value.map((item, index) => readString(item, `${label}[${index}]`));
}

function readNullableStringRecord(value: unknown, label: string): Record<string, string | null> {
  const record = readRecord(value, label);
  const output: Record<string, string | null> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "string" && item !== null) throw PluginRouteError.badRequest(`${label}.${key} must be a string or null`);
    Object.defineProperty(output, key, { configurable: true, enumerable: true, value: item, writable: true });
  }
  return output;
}

function readStoredRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw PluginRouteError.internal(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function readStoredString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) throw PluginRouteError.internal(`${label} is invalid`);
  return value;
}

function readStoredStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw PluginRouteError.internal(`${label} is invalid`);
  return [...new Set(value)].sort();
}
