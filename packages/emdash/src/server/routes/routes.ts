import { resolveModelId, translateSegments, type Glossary, type Segment, type Translator } from "@cloudflare/polystella-core";
import type { CatalogSource } from "@cloudflare/polystella-core/catalog";
import { DEFAULT_UI_STRING_BATCH_SIZE, translateCatalogEntries } from "@cloudflare/polystella-core/catalog/translate";
import { PluginRouteError, type LogAccess, type PluginRoute, type SettingsAccess, type StorageCollection } from "emdash";

import {
  applyCatalogOverrides,
  catalogGroupTitles,
  catalogOverrideId,
  catalogOverrideState,
  flattenEmdashCatalogs,
  listOverrides,
  overrideCharacterLimit,
  parseOverride,
  serializeCatalog,
  usableOverrides,
  type CatalogOverride,
  type FlatPolystellaEmdashOptions,
} from "../../catalog.js";
import {
  MAX_CATALOG_KEYS,
  MAX_CONTENT_FIELDS,
  MAX_SANDBOX_CHARACTERS,
  type CatalogClearSyncedResponse,
  type CatalogEntryView,
  type CatalogExportResponse,
  type CatalogGenerationResponse,
  type CatalogOverrideMutationResponse,
  type CatalogRuntimeMutationResponse,
  type CatalogViewResponse,
  type CollectionPolicyResponse,
  type RuntimeOverridesResponse,
  type TranslateContentResponse,
  type TranslationSandboxResponse,
} from "../../contracts.js";
import { invalidateRuntimeOverrides } from "../../runtime-cache.js";
import { resolveGlossary, resolveInstructions, runtimeOverrideSettingKey } from "../../settings.js";
import type { PolystellaEmdashOptions } from "../options.js";
import { targetLocales } from "../options.js";
import {
  collectionPolicies,
  collectionSettings,
  readCollectionPolicies,
  readRevision,
  runtimeLocaleEnabled,
  runtimeLocales,
  saveCollectionPolicies,
  saveTranslationSettings,
  storedTranslationSettings,
  translationSettingsView,
  MAX_GLOSSARY_CHARACTERS,
  MAX_INSTRUCTION_CHARACTERS,
} from "../settings-storage.js";
import { ContentTranslationInputError, translateContentFields } from "../translate-content.js";
import {
  catalogSegmentLabel,
  contentSegmentLabel,
  createTranslationDebugCollector,
  type TranslationDebugCollector,
} from "./debug-collector.js";
import { throwTranslationFailure, translationFailureMessage } from "./failures.js";
import { createTranslator, MAX_TOKENS, type PluginRouteDependencies } from "./provider.js";
import { readBoolean, readLocale, readNullableStringRecord, readRecord, readString, readStringArray, readText } from "./validators.js";

export type { PluginRouteDependencies };

const MAX_CATALOG_SOURCE_CHARACTERS = 30_000;
const ADMIN_ROLE = 50;
const TRANSLATABLE_FIELD_TYPES = new Set(["string", "text", "portableText"]);

const defaultDependencies: PluginRouteDependencies = {
  async getEnv() {
    return (await import("virtual:emdash/env")).env ?? process.env;
  },
  now: () => new Date(),
};

export function createPluginRoutes(
  inputOptions: PolystellaEmdashOptions,
  dependencies: PluginRouteDependencies = defaultDependencies,
): Record<string, PluginRoute> {
  const options = flattenEmdashCatalogs(inputOptions);
  return {
    "settings/collections": {
      permission: "plugins:manage",
      methods: ["GET", "PUT"],
      async handler(ctx) {
        if (ctx.request.method === "GET") return collectionSettings(options, ctx.settings);
        const input = readRecord(ctx.input, "request body");
        const revision = readRevision(input.revision);
        await saveCollectionPolicies(ctx.settings, revision, readCollectionPolicies(input.policies));
        return collectionSettings(options, ctx.settings);
      },
    },
    "settings/translation": {
      permission: "plugins:manage",
      methods: ["GET", "PUT"],
      async handler(ctx) {
        if (ctx.request.method === "GET") return translationSettingsView(options, ctx.settings);
        await saveTranslationSettings(options, ctx.settings, readRecord(ctx.input, "request body"));
        return translationSettingsView(options, ctx.settings);
      },
    },
    policy: {
      permission: "content:edit_any",
      methods: ["GET"],
      async handler(ctx) {
        const collection = readString(readRecord(ctx.input, "query").collection, "collection");
        const policies = await collectionPolicies(ctx.settings);
        const policy = Object.hasOwn(policies, collection) ? policies[collection] : undefined;
        return {
          enabled: policy !== undefined,
          sourceLocale: policy !== undefined ? options.catalogs.defaultLocale : null,
          fields: policy === undefined ? [] : [...policy.fields],
        } satisfies CollectionPolicyResponse;
      },
    },
    "translate-content": {
      permission: "content:edit_any",
      methods: ["POST"],
      async handler(ctx) {
        let translationStarted = false;
        let debug: TranslationDebugCollector | undefined;
        try {
          const input = readRecord(ctx.input, "request body");
          const collection = readString(input.collection, "collection");
          const targetLocale = configuredTargetLocale(options, readLocale(input.targetLocale, "targetLocale"));
          const entryId = readString(input.entryId, "entryId");
          const selectedFields = [...new Set(readStringArray(input.fields, "fields", false))];
          const policies = await collectionPolicies(ctx.settings);
          const policy = Object.hasOwn(policies, collection) ? policies[collection] : undefined;
          if (policy === undefined) {
            throw PluginRouteError.forbidden("PolyStella is not enabled for this collection");
          }
          if (selectedFields.length > MAX_CONTENT_FIELDS) {
            throw PluginRouteError.badRequest(`fields cannot contain more than ${MAX_CONTENT_FIELDS} values`);
          }
          if (selectedFields.some((field) => !policy.fields.includes(field))) {
            throw PluginRouteError.badRequest("fields must be enabled in PolyStella collection settings");
          }
          if (ctx.schema === undefined) throw PluginRouteError.internal("schema access is unavailable");
          const collectionSchema = await ctx.schema.getCollection(collection);
          if (collectionSchema === null) throw PluginRouteError.notFound("collection not found");
          const untranslatableField = selectedFields.find((slug) => {
            const field = collectionSchema.fields.find((candidate) => candidate.slug === slug);
            return field === undefined || !field.translatable || !TRANSLATABLE_FIELD_TYPES.has(field.type);
          });
          if (untranslatableField !== undefined) {
            throw PluginRouteError.badRequest(`field "${untranslatableField}" is not a translatable text field in the collection schema`);
          }
          if (ctx.content === undefined) throw PluginRouteError.internal("content access is unavailable");
          const item = await ctx.content.get(collection, entryId);
          if (item === null) throw PluginRouteError.notFound("content entry not found");
          if (item.locale !== targetLocale) throw PluginRouteError.badRequest("entry locale does not match targetLocale");
          const siblings = await ctx.content.getTranslations?.(collection, entryId);
          const sourceId = siblings?.translations.find((sibling) => sibling.locale === options.catalogs.defaultLocale)?.id;
          const sourceItem = (sourceId === undefined ? null : await ctx.content.get(collection, sourceId)) ?? item;
          const values = Object.fromEntries(
            selectedFields.flatMap((field) => (Object.hasOwn(sourceItem.data, field) ? [[field, sourceItem.data[field]]] : [])),
          );
          if (Object.keys(values).length === 0) throw PluginRouteError.badRequest("selected fields have no saved values");

          const settings = await translationSettings(options, targetLocale, ctx.settings, ctx.log, dependencies);
          if (settings.debugEnabled && (ctx.user?.role ?? 0) >= ADMIN_ROLE) {
            debug = createTranslationDebugCollector({
              operation: "content",
              provider: options.provider.kind,
              model: settings.translator.modelId,
              maxOutputTokens: options.provider.maxTokens ?? MAX_TOKENS,
              maxSegmentsPerBatch: null,
              sourceLocale: options.catalogs.defaultLocale,
              targetLocale,
              labelSegment: (id) => contentSegmentLabel(id, Object.keys(values)),
            });
          }
          translationStarted = true;
          const result = await translateContentFields({
            values,
            translator: settings.translator,
            glossary: settings.glossary,
            sourceLocale: options.catalogs.defaultLocale,
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
      methods: ["GET"],
      async handler(ctx) {
        const query = readRecord(ctx.input, "query");
        const locale = query.locale === undefined ? preferredCatalogLocale(options) : readString(query.locale, "locale");
        return catalogView(
          options,
          ctx.settings,
          overrideStorage(ctx.storage),
          locale,
          inputOptions.catalogs.locales[inputOptions.catalogs.defaultLocale]?.dictionary,
        );
      },
    },
    "catalog/generate": {
      permission: "plugins:manage",
      methods: ["POST"],
      async handler(ctx) {
        const input = readRecord(ctx.input, "request body");
        const locale = configuredTargetLocale(options, readString(input.locale, "locale"));
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
          const settings = await translationSettings(options, locale, ctx.settings, ctx.log, dependencies);
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
      methods: ["PUT"],
      async handler(ctx) {
        const input = readRecord(ctx.input, "request body");
        const locale = configuredTargetLocale(options, readString(input.locale, "locale"));
        const values = Object.entries(readNullableStringRecord(input.overrides, "overrides"));
        if (values.length !== 1) throw PluginRouteError.badRequest("overrides must contain exactly one key");
        if (input.expected !== null && typeof input.expected !== "string") {
          throw PluginRouteError.badRequest("expected must be the override value you last loaded, or null");
        }
        const expected = input.expected;
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
        const stored = await storage.getVersioned(id);
        const current = stored === null ? undefined : parseOverride(stored.value);
        // Unusable rows are hidden from the catalog view, so the editor saw them as "no override".
        const visibleValue = current === undefined ? null : (usableOverrides(options, locale, [current])[0]?.value ?? null);
        if (visibleValue !== expected) throw overrideConflict(key);
        if (value !== null) {
          const override = { locale, key, value, updatedAt: now, updatedBy } satisfies CatalogOverride;
          if (!(await storage.compareAndSet(id, stored?.revision ?? null, override)).applied) throw overrideConflict(key);
        } else if (stored !== null && !(await storage.compareAndDelete(id, stored.revision)).applied) {
          throw overrideConflict(key);
        }
        invalidateRuntimeOverrides(locale);
        return { key } satisfies CatalogOverrideMutationResponse;
      },
    },
    "catalog/clear-synced": {
      permission: "plugins:manage",
      methods: ["POST"],
      async handler(ctx) {
        const locale = configuredTargetLocale(options, readString(readRecord(ctx.input, "request body").locale, "locale"));
        const catalog = options.catalogs.locales[locale];
        if (catalog === undefined) throw PluginRouteError.internal("catalog configuration is unavailable");
        const storage = overrideStorage(ctx.storage);
        const synced = (await listOverrides(storage, locale)).filter(
          (override) => catalogOverrideState(catalog.dictionary, override) === "synced",
        );
        const cleared: string[] = [];
        const skipped: string[] = [];
        // ponytail: one read + one conditional delete per key; batch if catalogs grow past a few hundred synced keys.
        for (const { key } of synced) {
          const id = catalogOverrideId(locale, key);
          const stored = await storage.getVersioned(id);
          const stillSynced = stored !== null && catalogOverrideState(catalog.dictionary, parseOverride(stored.value)) === "synced";
          const deleted = stillSynced && (await storage.compareAndDelete(id, stored.revision)).applied;
          (deleted ? cleared : skipped).push(key);
        }
        if (cleared.length > 0) invalidateRuntimeOverrides(locale);
        return { locale, cleared, skipped } satisfies CatalogClearSyncedResponse;
      },
    },
    "catalog/runtime": {
      permission: "plugins:manage",
      methods: ["PUT"],
      async handler(ctx) {
        const input = readRecord(ctx.input, "request body");
        const locale = configuredTargetLocale(options, readString(input.locale, "locale"));
        const enabled = readBoolean(input.enabled, "enabled");
        if (enabled) await ctx.settings.set(runtimeOverrideSettingKey(locale), true);
        else await ctx.settings.delete(runtimeOverrideSettingKey(locale));
        invalidateRuntimeOverrides(locale);
        return { locale, enabled } satisfies CatalogRuntimeMutationResponse;
      },
    },
    "catalog/export": {
      permission: "plugins:manage",
      methods: ["GET"],
      async handler(ctx) {
        const locale = configuredTargetLocale(options, readString(readRecord(ctx.input, "query").locale, "locale"));
        const catalog = options.catalogs.locales[locale];
        if (catalog === undefined) throw PluginRouteError.internal("catalog configuration is unavailable");
        const overrides = usableOverrides(options, locale, await listOverrides(overrideStorage(ctx.storage), locale));
        return {
          filePath: catalog.filePath,
          filename: catalog.filePath.split("/").at(-1) ?? `${locale}.json`,
          json: serializeCatalog(locale, catalog.dictionary, overrides, inputOptions.catalogs.locales[locale]?.dictionary),
        } satisfies CatalogExportResponse;
      },
    },
    "translation-sandbox": {
      permission: "plugins:manage",
      methods: ["POST"],
      async handler(ctx) {
        let translationStarted = false;
        let debug: TranslationDebugCollector | undefined;
        try {
          const input = readRecord(ctx.input, "request body");
          const text = readText(input.text, "text", MAX_SANDBOX_CHARACTERS);
          if (text.length === 0) throw PluginRouteError.badRequest("text must not be empty");
          const targetLocale = configuredTargetLocale(options, readLocale(input.targetLocale, "targetLocale"));
          const model = readString(input.model, "model");
          if (!options.models.allowed.includes(model)) {
            throw PluginRouteError.badRequest("model must be allowed by deployment configuration");
          }
          const settings = await translationSettings(options, targetLocale, ctx.settings, ctx.log, dependencies, model);
          if (settings.debugEnabled && (ctx.user?.role ?? 0) >= ADMIN_ROLE) {
            debug = createTranslationDebugCollector({
              operation: "sandbox",
              provider: options.provider.kind,
              model: settings.translator.modelId,
              maxOutputTokens: options.provider.maxTokens ?? MAX_TOKENS,
              maxSegmentsPerBatch: null,
              sourceLocale: options.catalogs.defaultLocale,
              targetLocale,
              labelSegment: () => "text",
            });
          }
          const segment: Segment = { id: "sandbox:0", text };
          translationStarted = true;
          const result = await translateSegments({
            translator: settings.translator,
            segments: [segment],
            glossary: settings.glossary,
            sourceLocale: options.catalogs.defaultLocale,
            targetLocale,
            ...(settings.promptInstruction === undefined ? {} : { promptInstruction: settings.promptInstruction }),
            ...(debug === undefined ? {} : { onBatchAttempt: debug.record }),
            signal: ctx.request.signal,
          });
          const translation = result.translations.get(segment.id);
          if (translation === undefined) {
            const message = "[polystella-emdash] missing translation for sandbox text";
            if (debug !== undefined) debug.markValidationIssue(message, [segment.id]);
            throw new Error(message);
          }
          return {
            translation,
            ...(debug === undefined ? {} : { debug: debug.finish(result.batchCount) }),
          } satisfies TranslationSandboxResponse;
        } catch (error) {
          if (debug !== undefined && translationStarted) {
            const message = translationFailureMessage(error, ctx.log, "sandbox", true, debug.id);
            const trace = debug.finish(undefined, message);
            return { translation: null, error: message, debug: trace } satisfies TranslationSandboxResponse;
          }
          throwTranslationFailure(error, ctx.log, "sandbox", translationStarted);
        }
      },
    },
    overrides: {
      public: true,
      cacheControl: "public, max-age=60, stale-while-revalidate=300",
      methods: ["GET"],
      async handler(ctx) {
        const locale = configuredTargetLocale(options, readString(readRecord(ctx.input, "query").locale, "locale"));
        if (!(await runtimeLocaleEnabled(ctx.settings, locale))) {
          return { enabled: false, overrides: {} } satisfies RuntimeOverridesResponse;
        }
        const overrides = usableOverrides(options, locale, await listOverrides(overrideStorage(ctx.storage), locale));
        return { enabled: true, overrides: applyCatalogOverrides(locale, {}, overrides) } satisfies RuntimeOverridesResponse;
      },
    },
  };
}

function overrideConflict(key: string): PluginRouteError {
  return PluginRouteError.conflict(`Override for "${key}" changed since you loaded it. Reload the catalog and try again.`);
}

function overrideStorage(storage: Record<string, StorageCollection | undefined>): StorageCollection {
  const collection = storage.catalog_overrides;
  if (collection === undefined) throw PluginRouteError.internal("catalog override storage is unavailable");
  return collection;
}

async function catalogView(
  options: FlatPolystellaEmdashOptions,
  settings: SettingsAccess,
  storage: StorageCollection,
  locale: string,
  source?: CatalogSource | undefined,
): Promise<CatalogViewResponse> {
  const catalog = options.catalogs.locales[configuredTargetLocale(options, locale)];
  const flatSource = options.catalogs.locales[options.catalogs.defaultLocale]?.dictionary;
  if (catalog === undefined || flatSource === undefined || source === undefined)
    throw PluginRouteError.internal("catalog configuration is unavailable");
  const [storedOverrides, enabledLocales] = await Promise.all([listOverrides(storage, locale), runtimeLocales(options, settings)]);
  const overrides = usableOverrides(options, locale, storedOverrides);
  const overrideByKey = new Map(overrides.map((override) => [override.key, override]));
  const keys = [...new Set([...Object.keys(flatSource), ...Object.keys(catalog.dictionary), ...overrideByKey.keys()])].sort();
  const entries: CatalogEntryView[] = keys.map((key) => {
    const override = overrideByKey.get(key);
    return {
      key,
      source: Object.hasOwn(flatSource, key) ? (flatSource[key] ?? null) : null,
      deployed: Object.hasOwn(catalog.dictionary, key) ? (catalog.dictionary[key] ?? null) : null,
      override: override?.value ?? null,
      state: override === undefined ? null : catalogOverrideState(catalog.dictionary, override),
    };
  });
  return {
    defaultLocale: options.catalogs.defaultLocale,
    locale,
    locales: targetLocales(options)
      .map((code) => {
        const value = options.catalogs.locales[code];
        if (value === undefined) throw PluginRouteError.internal(`catalog for ${code} is unavailable`);
        return { locale: code, filePath: value.filePath, runtimeEnabled: enabledLocales.includes(code) };
      })
      .sort((left, right) => left.locale.localeCompare(right.locale)),
    groups: catalogGroupTitles(source),
    entries,
  };
}

async function translationSettings(
  options: PolystellaEmdashOptions,
  locale: string,
  settings: SettingsAccess,
  log: LogAccess,
  dependencies: PluginRouteDependencies,
  modelOverride?: string | undefined,
): Promise<{ translator: Translator; glossary: Glossary; debugEnabled: boolean; promptInstruction?: string | undefined }> {
  const [storedSettings, env] = await Promise.all([storedTranslationSettings(options, settings), dependencies.getEnv()]);
  const stored = storedSettings.locales[locale];
  if (stored === undefined) throw PluginRouteError.internal(`translation settings for ${locale} are unavailable`);
  const deploymentModel = resolveModelId(options.models.defaults, locale);
  const model = modelOverride ?? stored.model ?? deploymentModel;
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

function preferredCatalogLocale(options: PolystellaEmdashOptions): string {
  const locale = targetLocales(options)[0];
  if (locale === undefined) throw PluginRouteError.badRequest("no target locales are configured");
  return locale;
}

function configuredLocale(options: PolystellaEmdashOptions, locale: string): string {
  if (!Object.hasOwn(options.catalogs.locales, locale)) throw PluginRouteError.notFound(`unknown locale "${locale}"`);
  return locale;
}

function configuredTargetLocale(options: PolystellaEmdashOptions, locale: string): string {
  const configured = configuredLocale(options, locale);
  if (configured === options.catalogs.defaultLocale) throw PluginRouteError.badRequest("locale must be a translation target");
  return configured;
}
