import {
  DEFAULT_INPUT_TOKEN_BUDGET,
  resolveModelId,
  type Glossary,
  type TranslateBatchAttemptEvent,
  type Translator,
} from "@cloudflare/polystella-core";
import { DEFAULT_UI_STRING_BATCH_SIZE, translateCatalogEntries } from "@cloudflare/polystella-core/catalog/translate";
import {
  createWorkersAIBindingTranslator,
  createWorkersAIHttpTranslator,
  type WorkersAIBindingRun,
  type WorkersAIInput,
} from "@cloudflare/polystella-providers/workers-ai";
import {
  PluginRouteError,
  RESERVED_COLLECTION_SLUGS,
  RESERVED_FIELD_SLUGS,
  type KVAccess,
  type LogAccess,
  type PluginRoute,
  type StorageCollection,
} from "emdash";

import { applyCatalogOverrides, catalogOverrideId, catalogOverrideState, serializeCatalog, type CatalogOverride } from "./catalog.js";
import {
  MAX_CATALOG_KEYS,
  MAX_COLLECTION_POLICY_FIELDS,
  MAX_CONTENT_FIELDS,
  type CollectionPolicy,
  type CatalogEntryView,
  type CatalogExportResponse,
  type CatalogGenerationResponse,
  type CatalogOverrideMutationResponse,
  type CatalogRuntimeMutationResponse,
  type CatalogViewResponse,
  type CollectionPolicyResponse,
  type CollectionSettingsResponse,
  type CustomizationMode,
  type RuntimeOverridesResponse,
  type TranslationSettingsResponse,
  type TranslationDebugBatch,
  type TranslationDebugTrace,
  type TranslateContentResponse,
} from "./contracts.js";
import { ContentTranslationInputError, translateContentFields } from "./translate-content.js";
import type { PolystellaEmdashOptions } from "./index.js";
import { invalidateRuntimeOverrides } from "./runtime-cache.js";
import { isCustomizationMode, resolveGlossary, resolveInstructions, runtimeOverrideSettingKey } from "./settings.js";

const COLLECTION_POLICIES_KEY = "settings:collectionPolicies";
const TRANSLATION_SETTINGS_KEY = "settings:translation";
const MAX_TOKENS = 8192;
const MAX_LOCALE_LENGTH = 64;
const MAX_COLLECTIONS = 100;
const MAX_GLOSSARY_CHARACTERS = 10_000;
const MAX_INSTRUCTION_CHARACTERS = 10_000;
const MAX_OVERRIDE_CHARACTERS = 20_000;
const MAX_TOTAL_OVERRIDE_CHARACTERS = 100_000;
const MAX_CATALOG_SOURCE_CHARACTERS = 30_000;
const ADMIN_ROLE = 50;
const EMDASH_LOCALE_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;
const EMDASH_SLUG_PATTERN = /^[a-z][a-z0-9_]*$/;

export interface PluginRouteDependencies {
  getEnv(): Promise<Record<string, unknown> | undefined>;
  now(): Date;
  fetchImpl?: typeof fetch | undefined;
}

const defaultDependencies: PluginRouteDependencies = {
  async getEnv() {
    return (await import("virtual:emdash/env")).env ?? process.env;
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
        const policies = readCollectionPolicies(options, readRecord(ctx.input, "request body").policies);
        await ctx.kv.set(COLLECTION_POLICIES_KEY, policies);
        return collectionSettings(options, ctx.kv);
      },
    },
    "settings/translation": {
      permission: "plugins:manage",
      async handler(ctx) {
        if (ctx.request.method === "GET") return translationSettingsView(options, ctx.kv);
        requireMethod(ctx.request, "PUT");
        await saveTranslationSettings(options, ctx.kv, readRecord(ctx.input, "request body"));
        return translationSettingsView(options, ctx.kv);
      },
    },
    policy: {
      permission: "content:edit_any",
      async handler(ctx) {
        requireMethod(ctx.request, "GET");
        const collection = readString(readRecord(ctx.input, "query").collection, "collection");
        const policies = await collectionPolicies(options, ctx.kv);
        const policy = Object.hasOwn(policies, collection) ? policies[collection] : undefined;
        return {
          enabled: policy !== undefined,
          sourceLocale: policy?.sourceLocale ?? null,
          fields: policy === undefined ? [] : [...policy.fields],
        } satisfies CollectionPolicyResponse;
      },
    },
    "translate-content": {
      permission: "content:edit_any",
      async handler(ctx) {
        let translationStarted = false;
        let debug: TranslationDebugCollector | undefined;
        try {
          requireMethod(ctx.request, "POST");
          const input = readRecord(ctx.input, "request body");
          const collection = readString(input.collection, "collection");
          const targetLocale = configuredLocale(options, readLocale(input.targetLocale, "targetLocale"));
          const entryId = readString(input.entryId, "entryId");
          const selectedFields = [...new Set(readStringArray(input.fields, "fields", false))];
          const policies = await collectionPolicies(options, ctx.kv);
          const policy = Object.hasOwn(policies, collection) ? policies[collection] : undefined;
          if (policy === undefined) {
            throw PluginRouteError.forbidden("PolyStella is not enabled for this collection");
          }
          if (targetLocale === policy.sourceLocale) throw PluginRouteError.badRequest("targetLocale must differ from sourceLocale");
          if (selectedFields.length > MAX_CONTENT_FIELDS) {
            throw PluginRouteError.badRequest(`fields cannot contain more than ${MAX_CONTENT_FIELDS} values`);
          }
          if (selectedFields.some((field) => !policy.fields.includes(field))) {
            throw PluginRouteError.badRequest("fields must be enabled in PolyStella collection settings");
          }
          if (ctx.content === undefined) throw PluginRouteError.internal("content access is unavailable");
          const item = await ctx.content.get(collection, entryId);
          if (item === null) throw PluginRouteError.notFound("content entry not found");
          if (item.locale !== targetLocale) throw PluginRouteError.badRequest("entry locale does not match targetLocale");
          const values = Object.fromEntries(
            selectedFields.flatMap((field) => (Object.hasOwn(item.data, field) ? [[field, item.data[field]]] : [])),
          );
          if (Object.keys(values).length === 0) throw PluginRouteError.badRequest("selected fields have no saved values");

          const settings = await translationSettings(options, targetLocale, ctx.kv, ctx.log, dependencies);
          if (settings.debugEnabled && (ctx.user?.role ?? 0) >= ADMIN_ROLE) {
            debug = createTranslationDebugCollector({
              operation: "content",
              provider: options.provider.kind,
              model: settings.translator.modelId,
              maxOutputTokens: options.provider.maxTokens ?? MAX_TOKENS,
              maxSegmentsPerBatch: null,
              sourceLocale: policy.sourceLocale,
              targetLocale,
              labelSegment: (id) => contentSegmentLabel(id, Object.keys(values)),
            });
          }
          translationStarted = true;
          const result = await translateContentFields({
            values,
            translator: settings.translator,
            glossary: settings.glossary,
            sourceLocale: policy.sourceLocale,
            targetLocale,
            ...(settings.promptInstruction === undefined ? {} : { promptInstruction: settings.promptInstruction }),
            ...(debug === undefined
              ? {}
              : {
                  onBatchAttempt: debug.record,
                  onValidationIssue: (segmentIds, message) => debug?.markValidationIssue(message, segmentIds),
                }),
            signal: ctx.request.signal,
          });
          return {
            ...result,
            ...(debug === undefined ? {} : { debug: debug.finish(result.batchCount) }),
          } satisfies TranslateContentResponse;
        } catch (error) {
          if (error instanceof ContentTranslationInputError) throw PluginRouteError.badRequest(error.message);
          if (debug !== undefined && translationStarted) {
            const message = translationFailureMessage(error, ctx.log, "content", true, debug.id);
            const trace = debug.finish(undefined, message);
            return { patch: null, batchCount: trace.batchCount, error: message, debug: trace } satisfies TranslateContentResponse;
          }
          throwTranslationFailure(error, ctx.log, "content", translationStarted);
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
        let debug: TranslationDebugCollector | undefined;
        try {
          const settings = await translationSettings(options, locale, ctx.kv, ctx.log, dependencies);
          if (settings.debugEnabled) {
            debug = createTranslationDebugCollector({
              operation: "catalog",
              provider: options.provider.kind,
              model: settings.translator.modelId,
              maxOutputTokens: options.provider.maxTokens ?? MAX_TOKENS,
              maxSegmentsPerBatch: DEFAULT_UI_STRING_BATCH_SIZE,
              sourceLocale: options.catalogs.defaultLocale,
              targetLocale: locale,
              labelSegment: (id) => catalogSegmentLabel(id, entries),
            });
          }
          const result = await translateCatalogEntries({
            entries,
            translator: settings.translator,
            glossary: settings.glossary,
            sourceLocale: options.catalogs.defaultLocale,
            targetLocale: locale,
            maxRetries: 2,
            ...(settings.promptInstruction === undefined ? {} : { context: settings.promptInstruction }),
            ...(debug === undefined ? {} : { onBatchAttempt: debug.record, onRetry: ({ error }) => debug?.markLastAttemptError(error) }),
            signal: ctx.request.signal,
          });
          if (debug !== undefined) {
            for (const { key, missing, spurious } of result.tokenFailures) {
              const message = `${key}: missing [${missing.join(", ")}], spurious [${spurious.join(", ")}]`;
              const segmentIndex = entries.findIndex((entry) => entry.key === key);
              debug.markValidationIssue(message, segmentIndex === -1 ? [] : [`catalog:${segmentIndex}`]);
            }
          }
          return {
            translations: Object.fromEntries(result.translations),
            tokenFailures: result.tokenFailures,
            ...(debug === undefined ? {} : { debug: debug.finish(result.batchCount) }),
          } satisfies CatalogGenerationResponse;
        } catch (error) {
          if (debug !== undefined) {
            const message = translationFailureMessage(error, ctx.log, "catalog", true, debug.id);
            return {
              translations: null,
              tokenFailures: [],
              error: message,
              debug: debug.finish(undefined, message),
            } satisfies CatalogGenerationResponse;
          }
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
        invalidateRuntimeOverrides(locale);
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
        invalidateRuntimeOverrides(locale);
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
  return {
    defaultLocale: options.catalogs.defaultLocale,
    locales: Object.keys(options.catalogs.locales).sort(),
    policies: await collectionPolicies(options, kv),
  };
}

function overrideStorage(storage: Record<string, StorageCollection | undefined>): StorageCollection {
  const collection = storage.catalog_overrides;
  if (collection === undefined) throw PluginRouteError.internal("catalog override storage is unavailable");
  return collection;
}

async function collectionPolicies(options: PolystellaEmdashOptions, kv: KVAccess): Promise<Record<string, CollectionPolicy>> {
  const stored = await kv.get<unknown>(COLLECTION_POLICIES_KEY);
  if (!isRecord(stored)) return {};
  const policies: Record<string, CollectionPolicy> = {};
  for (const [collection, value] of Object.entries(stored)) {
    if (
      !isAllowedCollectionSlug(collection) ||
      !isRecord(value) ||
      typeof value.sourceLocale !== "string" ||
      !Object.hasOwn(options.catalogs.locales, value.sourceLocale) ||
      !isStringArray(value.fields) ||
      value.fields.length === 0 ||
      value.fields.length > MAX_COLLECTION_POLICY_FIELDS ||
      value.fields.some((field) => !isAllowedFieldSlug(field))
    ) {
      continue;
    }
    Object.defineProperty(policies, collection, {
      configurable: true,
      enumerable: true,
      value: { sourceLocale: value.sourceLocale, fields: [...new Set(value.fields)].sort() },
      writable: true,
    });
  }
  return policies;
}

function readCollectionPolicies(options: PolystellaEmdashOptions, value: unknown): Record<string, CollectionPolicy> {
  const input = readRecord(value, "policies");
  if (Object.keys(input).length > MAX_COLLECTIONS) {
    throw PluginRouteError.badRequest(`policies cannot contain more than ${MAX_COLLECTIONS} collections`);
  }

  const policies: Record<string, CollectionPolicy> = {};
  for (const [collection, rawPolicy] of Object.entries(input).sort(([left], [right]) => left.localeCompare(right))) {
    if (!isAllowedCollectionSlug(collection))
      throw PluginRouteError.badRequest(`collection ${JSON.stringify(collection)} is not supported`);
    const policy = readRecord(rawPolicy, `policies.${collection}`);
    const sourceLocale = readLocale(policy.sourceLocale, `policies.${collection}.sourceLocale`);
    if (!Object.hasOwn(options.catalogs.locales, sourceLocale)) {
      throw PluginRouteError.badRequest(`policies.${collection}.sourceLocale must be a configured locale`);
    }
    const fields = [...new Set(readStringArray(policy.fields, `policies.${collection}.fields`, false))].sort();
    if (fields.length > MAX_COLLECTION_POLICY_FIELDS) {
      throw PluginRouteError.badRequest(`policies.${collection}.fields cannot contain more than ${MAX_COLLECTION_POLICY_FIELDS} values`);
    }
    const unsupportedField = fields.find((field) => !isAllowedFieldSlug(field));
    if (unsupportedField !== undefined) {
      throw PluginRouteError.badRequest(`field ${JSON.stringify(unsupportedField)} is not supported`);
    }
    Object.defineProperty(policies, collection, {
      configurable: true,
      enumerable: true,
      value: { sourceLocale, fields },
      writable: true,
    });
  }
  return policies;
}

async function translationSettingsView(options: PolystellaEmdashOptions, kv: KVAccess): Promise<TranslationSettingsResponse> {
  const stored = await storedTranslationSettings(options, kv);
  const locales = Object.keys(options.catalogs.locales)
    .sort()
    .map((locale) => {
      const settings = stored.locales[locale];
      if (settings === undefined) throw PluginRouteError.internal(`translation settings for ${locale} are unavailable`);
      const defaultGlossary = options.glossaryDefaults?.[locale];
      return {
        locale,
        defaultModel: resolveModelId(options.models.defaults, locale),
        model: settings.model,
        defaultGlossary: defaultGlossary === undefined ? "" : JSON.stringify(defaultGlossary, null, 2),
        glossaryMode: settings.glossaryMode,
        glossaryText: settings.glossaryText,
      };
    });
  return {
    debugEnabled: stored.debugEnabled,
    allowedModels: [...options.models.allowed],
    locales,
    instructions: {
      defaultText: (options.rules ?? []).join("\n"),
      mode: stored.instructions.mode,
      text: stored.instructions.text,
    },
  };
}

async function saveTranslationSettings(options: PolystellaEmdashOptions, kv: KVAccess, input: Record<string, unknown>): Promise<void> {
  const debugEnabled = input.debugEnabled === undefined ? false : readBoolean(input.debugEnabled, "debugEnabled");
  const localeInput = readRecord(input.locales, "locales");
  const configuredLocales = Object.keys(options.catalogs.locales).sort();
  if (
    Object.keys(localeInput).length !== configuredLocales.length ||
    configuredLocales.some((locale) => !Object.hasOwn(localeInput, locale))
  ) {
    throw PluginRouteError.badRequest("locales must contain every configured locale");
  }

  const values = configuredLocales.map((locale) => {
    const settings = readRecord(localeInput[locale], `locales.${locale}`);
    const rawModel = settings.model;
    const model = rawModel === null ? null : readString(rawModel, `locales.${locale}.model`);
    if (model !== null && !options.models.allowed.includes(model)) {
      throw PluginRouteError.badRequest(`locales.${locale}.model must be allowed by deployment configuration`);
    }
    const glossaryMode = readCustomizationMode(settings.glossaryMode, `locales.${locale}.glossaryMode`);
    const glossaryText = readText(settings.glossaryText, `locales.${locale}.glossaryText`, MAX_GLOSSARY_CHARACTERS);
    if (
      JSON.stringify(resolveGlossary(options.glossaryDefaults?.[locale], glossaryMode, glossaryText.trim())).length >
      MAX_GLOSSARY_CHARACTERS
    ) {
      throw PluginRouteError.badRequest(`effective glossary for ${locale} cannot exceed ${MAX_GLOSSARY_CHARACTERS} characters`);
    }
    return { locale, model, glossaryMode, glossaryText };
  });

  const instructionInput = readRecord(input.instructions, "instructions");
  const instructionMode = readCustomizationMode(instructionInput.mode, "instructions.mode");
  const instructionText = readText(instructionInput.text, "instructions.text", MAX_INSTRUCTION_CHARACTERS);
  if (resolveInstructions(options.rules ?? [], instructionMode, instructionText.trim()).length > MAX_INSTRUCTION_CHARACTERS) {
    throw PluginRouteError.badRequest(`effective translation instructions cannot exceed ${MAX_INSTRUCTION_CHARACTERS} characters`);
  }

  await kv.set(TRANSLATION_SETTINGS_KEY, {
    debugEnabled,
    locales: Object.fromEntries(values.map(({ locale, ...settings }) => [locale, settings])),
    instructions: { mode: instructionMode, text: instructionText },
  } satisfies StoredTranslationSettings);
}

interface StoredLocaleSettings {
  model: string | null;
  glossaryMode: CustomizationMode;
  glossaryText: string;
}

interface StoredTranslationSettings {
  debugEnabled: boolean;
  locales: Record<string, StoredLocaleSettings>;
  instructions: { mode: CustomizationMode; text: string };
}

async function storedTranslationSettings(options: PolystellaEmdashOptions, kv: KVAccess): Promise<StoredTranslationSettings> {
  const stored = await kv.get<unknown>(TRANSLATION_SETTINGS_KEY);
  const storedRoot = isRecord(stored) ? stored : {};
  const storedLocales = isRecord(storedRoot.locales) ? storedRoot.locales : {};
  const storedInstructions = isRecord(storedRoot.instructions) ? storedRoot.instructions : {};
  const locales = Object.fromEntries(
    Object.keys(options.catalogs.locales).map((locale) => {
      const localeSettings = isRecord(storedLocales[locale]) ? storedLocales[locale] : {};
      const storedModel = localeSettings.model;
      const storedMode = localeSettings.glossaryMode;
      const storedText = localeSettings.glossaryText;
      return [
        locale,
        {
          model: typeof storedModel === "string" && options.models.allowed.includes(storedModel) ? storedModel : null,
          glossaryMode: isCustomizationMode(storedMode) ? storedMode : "default",
          glossaryText: typeof storedText === "string" ? storedText : "",
        },
      ];
    }),
  );
  const instructionText = typeof storedInstructions.text === "string" ? storedInstructions.text : "";
  return {
    debugEnabled: storedRoot.debugEnabled === true,
    locales,
    instructions: {
      mode: isCustomizationMode(storedInstructions.mode)
        ? storedInstructions.mode
        : instructionText.trim().length > 0
          ? "append"
          : "default",
      text: instructionText,
    },
  };
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
  return `settings:${runtimeOverrideSettingKey(locale)}`;
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

export async function listOverrides(storage: StorageCollection, locale: string): Promise<CatalogOverride[]> {
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

export function usableOverrides(
  options: { catalogs: { defaultLocale: string; locales: Record<string, { dictionary: Record<string, string> }> } },
  locale: string,
  overrides: readonly CatalogOverride[],
): CatalogOverride[] {
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
  locale: string,
  kv: KVAccess,
  log: LogAccess,
  dependencies: PluginRouteDependencies,
): Promise<{ translator: Translator; glossary: Glossary; debugEnabled: boolean; promptInstruction?: string | undefined }> {
  const [storedSettings, env] = await Promise.all([storedTranslationSettings(options, kv), dependencies.getEnv()]);
  const stored = storedSettings.locales[locale];
  if (stored === undefined) throw PluginRouteError.internal(`translation settings for ${locale} are unavailable`);
  const deploymentModel = resolveModelId(options.models.defaults, locale);
  const model = stored.model ?? deploymentModel;
  const glossary = resolveGlossary(options.glossaryDefaults?.[locale], stored.glossaryMode, stored.glossaryText.trim());
  const promptInstruction = resolveInstructions(
    options.rules ?? [],
    storedSettings.instructions.mode,
    storedSettings.instructions.text.trim(),
  );
  if (JSON.stringify(glossary).length > MAX_GLOSSARY_CHARACTERS) {
    throw PluginRouteError.badRequest(`effective glossary cannot exceed ${MAX_GLOSSARY_CHARACTERS} characters`);
  }
  if (promptInstruction.length > MAX_INSTRUCTION_CHARACTERS) {
    throw PluginRouteError.badRequest(`translation instructions cannot exceed ${MAX_INSTRUCTION_CHARACTERS} characters`);
  }
  return {
    translator: createTranslator(options, env, model, log, dependencies),
    glossary,
    debugEnabled: storedSettings.debugEnabled,
    ...(promptInstruction.length === 0 ? {} : { promptInstruction }),
  };
}

function createTranslator(
  options: PolystellaEmdashOptions,
  env: Record<string, unknown> | undefined,
  modelId: string,
  log: LogAccess,
  dependencies: PluginRouteDependencies,
): Translator {
  const provider = options.provider;
  if (provider.kind === "workers-ai-binding") {
    const binding = env?.[provider.binding];
    if (!isWorkersAIBinding(binding)) {
      log.error("PolyStella Workers AI binding is unavailable", { binding: provider.binding });
      throw new PluginRouteError("AI_BINDING_UNAVAILABLE", "PolyStella's Workers AI binding is unavailable", 503);
    }
    return createWorkersAIBindingTranslator({
      modelId,
      maxTokens: provider.maxTokens ?? MAX_TOKENS,
      run: workersRun(binding),
    });
  }

  const accountId = environmentCredential(env, provider.accountIdEnv);
  const apiToken = environmentCredential(env, provider.apiTokenEnv);
  if (accountId === undefined || apiToken === undefined) {
    log.error("PolyStella Workers AI HTTP credentials are unavailable", {
      accountIdEnv: provider.accountIdEnv,
      apiTokenEnv: provider.apiTokenEnv,
    });
    throw new PluginRouteError("AI_CREDENTIALS_UNAVAILABLE", "PolyStella's Workers AI credentials are unavailable", 503);
  }
  return createWorkersAIHttpTranslator({
    accountId,
    apiToken,
    modelId,
    maxTokens: provider.maxTokens ?? MAX_TOKENS,
    ...(provider.endpoint === undefined ? {} : { endpoint: provider.endpoint }),
    ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
  });
}

function environmentCredential(env: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = env?.[name];
  return typeof value === "string" && value.length > 0 && value.trim() === value ? value : undefined;
}

function workersRun(binding: WorkersAIBinding): WorkersAIBindingRun {
  return async (modelId, input) => await binding.run(modelId, input);
}

interface TranslationDebugCollector {
  id: string;
  record(event: TranslateBatchAttemptEvent): void;
  markLastAttemptError(error: unknown): void;
  markValidationIssue(message: string, segmentIds: string[]): void;
  finish(batchCount?: number, error?: string): TranslationDebugTrace;
}

interface TranslationDebugCollectorOptions {
  operation: TranslationDebugTrace["operation"];
  provider: TranslationDebugTrace["provider"];
  model: string;
  maxOutputTokens: number;
  maxSegmentsPerBatch: number | null;
  sourceLocale: string;
  targetLocale: string;
  labelSegment(id: string): string;
}

function createTranslationDebugCollector(options: TranslationDebugCollectorOptions): TranslationDebugCollector {
  const startedAt = performance.now();
  const id = crypto.randomUUID();
  const batches: TranslationDebugBatch[] = [];
  const batchesBySegments = new Map<string, TranslationDebugBatch>();
  const validationIssues: string[] = [];

  return {
    id,
    record(event) {
      const key = event.segments.map(({ id }) => id).join("\0");
      let batch = batchesBySegments.get(key);
      if (batch === undefined) {
        batch = {
          batch: batches.length + 1,
          segmentCount: event.segments.length,
          segmentIds: event.segments.map(({ id }) => id),
          segmentLabels: event.segments.map(({ id }) => options.labelSegment(id)),
          sourceCharacters: event.sourceCharacters,
          estimatedInputTokens: event.estimatedInputTokens,
          attempts: [],
        };
        batches.push(batch);
        batchesBySegments.set(key, batch);
      }
      batch.attempts.push({
        attempt: batch.attempts.length + 1,
        durationMs: Math.round(event.durationMs),
        systemPrompt: event.systemPrompt,
        userPrompt: event.userPrompt,
        response: event.response ?? null,
        translations: event.translations === undefined ? null : Object.fromEntries(event.translations),
        error: event.error === undefined ? null : publicTranslationFailure(event.error),
      });
    },
    markLastAttemptError(error) {
      const attempt = batches.at(-1)?.attempts.at(-1);
      if (attempt !== undefined && attempt.error === null) attempt.error = publicTranslationFailure(error);
    },
    markValidationIssue(message, segmentIds) {
      if (!validationIssues.includes(message)) validationIssues.push(message);
      const batch = batches.find((candidate) => segmentIds.some((id) => candidate.segmentIds.includes(id)));
      const attempt = batch?.attempts.at(-1);
      if (attempt !== undefined && attempt.error === null) attempt.error = message;
    },
    finish(batchCount = batches.length, error) {
      return {
        id,
        operation: options.operation,
        provider: options.provider,
        model: options.model,
        maxOutputTokens: options.maxOutputTokens,
        inputTokenBudget: DEFAULT_INPUT_TOKEN_BUDGET,
        maxSegmentsPerBatch: options.maxSegmentsPerBatch,
        sourceLocale: options.sourceLocale,
        targetLocale: options.targetLocale,
        batchCount,
        providerCallCount: batches.reduce((total, batch) => total + batch.attempts.length, 0),
        durationMs: Math.round(performance.now() - startedAt),
        error: error ?? null,
        validationIssues,
        batches,
      };
    },
  };
}

function contentSegmentLabel(id: string, fields: string[]): string {
  const match = /^field:(\d+)(?::block:(\d+):span:(\d+))?$/.exec(id);
  if (match === null) return id;
  const field = fields[Number(match[1])];
  if (field === undefined) return id;
  return match[2] === undefined ? field : `${field} (block ${match[2]}, span ${match[3]})`;
}

function catalogSegmentLabel(id: string, entries: ReadonlyArray<{ key: string }>): string {
  const match = /^catalog:(\d+)$/.exec(id);
  return match === null ? id : (entries[Number(match[1])]?.key ?? id);
}

function throwTranslationFailure(error: unknown, log: LogAccess, operation: string, exposeReason = true): never {
  const message = translationFailureMessage(error, log, operation, exposeReason);
  throw new PluginRouteError("TRANSLATION_FAILED", message, 502);
}

function translationFailureMessage(
  error: unknown,
  log: LogAccess,
  operation: string,
  exposeReason = true,
  diagnosticId: string = crypto.randomUUID(),
): string {
  if (error instanceof PluginRouteError || (error instanceof Error && error.name === "AbortError")) throw error;
  const message = exposeReason ? publicTranslationFailure(error) : "PolyStella translation failed";
  log.error("PolyStella translation failed", {
    diagnosticId,
    operation,
    errorType: error instanceof Error ? error.name : typeof error,
    message,
  });
  return `${message} (Diagnostic ID: ${diagnosticId})`;
}

function publicTranslationFailure(error: unknown): string {
  if (!(error instanceof Error)) return "PolyStella translation failed";
  const firstLine = error.message.split("\n", 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) return "PolyStella translation failed";
  if (!safeTranslationFailure(firstLine)) return "PolyStella translation failed";
  return firstLine.length > 500 ? `${firstLine.slice(0, 500)}...` : firstLine;
}

function safeTranslationFailure(message: string): boolean {
  return (
    message.startsWith("[polystella] no segment markers in the model response.") ||
    message.startsWith("[polystella] model omitted segment ") ||
    message.startsWith("[polystella] model returned an empty translation for segment ") ||
    /^\[polystella\] Workers AI request failed: \d{3}(?: [A-Za-z ]+)?$/.test(message) ||
    message.startsWith("[polystella] unexpected Workers AI response shape ") ||
    message.startsWith("[polystella] unexpected Workers AI binding response shape ") ||
    message.startsWith("[polystella] token-preservation validation failed for ") ||
    message.startsWith("[polystella-emdash] missing translation for internal segment ") ||
    message.startsWith("[polystella-emdash] translation changed placeholder tokens in field ")
  );
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

function readText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") throw PluginRouteError.badRequest(`${label} must be a string`);
  if (value.length > maxLength) throw PluginRouteError.badRequest(`${label} cannot exceed ${maxLength} characters`);
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

function readCustomizationMode(value: unknown, label: string): CustomizationMode {
  if (!isCustomizationMode(value)) throw PluginRouteError.badRequest(`${label} must be default, append, or replace`);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string");
}

function isAllowedCollectionSlug(value: string): boolean {
  return value.length <= 63 && EMDASH_SLUG_PATTERN.test(value) && !RESERVED_COLLECTION_SLUGS.some((reserved) => reserved === value);
}

function isAllowedFieldSlug(value: string): boolean {
  return value.length <= 63 && EMDASH_SLUG_PATTERN.test(value) && !RESERVED_FIELD_SLUGS.some((reserved) => reserved === value);
}

function readStoredRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw PluginRouteError.internal(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function readStoredString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) throw PluginRouteError.internal(`${label} is invalid`);
  return value;
}
