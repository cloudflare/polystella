import { translateSegments, type Glossary, type Segment, type Translator } from "@cloudflare/polystella-core";
import type { CatalogSource, IgnoreKey, MessageSyntax } from "@cloudflare/polystella-core/catalog";
import { workersAIRequestParams } from "@cloudflare/polystella-core/providers/workers-ai";
import {
  DEFAULT_UI_STRING_BATCH_SIZE,
  formatTokenValidationIssue,
  translateCatalogEntries,
  validateMessage,
  validateMessageTranslation,
} from "@cloudflare/polystella-core/catalog/translate";
import {
  getI18nConfig,
  invalidateObjectCache,
  PluginRouteError,
  type CollectionSchemaInfo,
  type LogAccess,
  type PluginContentItem,
  type PluginRoute,
  type RouteContext,
  type SettingsAccess,
  type StorageCollection,
} from "emdash";

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
  isSeoField,
  MAX_SANDBOX_CHARACTERS,
  MAX_BATCH_TRANSLATIONS,
  MAX_JOB_INSTRUCTION_CHARACTERS,
  MAX_MAX_TOKENS,
  MIN_MAX_TOKENS,
  type AiTranslationStatus,
  type BatchJobOutcome,
  type BatchJobSettings,
  type BatchJobEntriesResponse,
  type BatchJobResultsResponse,
  type BatchJobsResponse,
  type BatchTranslationLink,
  type BatchJobView,
  type CatalogClearSyncedResponse,
  type ModelReasoningResponse,
  type CatalogEntryView,
  type CatalogExportResponse,
  type CatalogGenerationResponse,
  type CatalogOverrideMutationResponse,
  type CatalogRuntimeMutationResponse,
  type CatalogViewResponse,
  type CollectionPolicy,
  type CollectionPolicyResponse,
  type RuntimeOverridesResponse,
  type TranslateContentResponse,
  type TranslationSandboxResponse,
} from "../../contracts.js";
import { invalidateRuntimeOverrides } from "../../runtime-cache.js";
import {
  batchPartsId,
  batchQueue,
  batchResultId,
  enqueueBatchMessages,
  MAX_BATCH_MESSAGE_CHARACTERS,
  parseStoredJob,
  parseStoredParts,
  parseStoredResult,
  readBatchJob,
  deleteBatchJob,
  deleteExpiredBatchJobs,
  readBatchListMessage,
  readBatchMessage,
  readTranslationLink,
  recordBatchResult,
  type BatchMessage,
  type BatchTranslateResponse,
  type BatchUpdatePayload,
  type StoredBatchJob,
  type StoredBatchParts,
} from "../batch.js";
import {
  AI_TRANSLATIONS_CACHE_NAMESPACE,
  AI_TRANSLATION_PENDING_COLLECTION,
  AI_TRANSLATIONS_COLLECTION,
  changedFields,
  hashFields,
  mergedFieldHashes,
  readFieldHashes,
  type AiTranslationRecord,
  readPendingAiTranslation,
  type PendingAiTranslation,
} from "../../ai-translations.js";
import { resolveGlossary, resolveInstructions, runtimeOverrideSettingKey } from "../../settings.js";
import type { PolystellaEmdashOptions } from "../options.js";
import { catalogIgnoreKey, catalogMessageSyntax, localeTag, targetLocales } from "../options.js";
import { reasoningCapability, type ReasoningCapability } from "../reasoning.js";
import {
  collectionPolicies,
  collectionSettings,
  defaultMaxTokens,
  effectiveModelChoice,
  isMaxTokens,
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
import {
  applyContentTranslations,
  ContentTranslationInputError,
  planContentTranslation,
  samePageLinksNotice,
  translateContentPart,
  unlistedBlocksNotice,
  type ContentPlan,
} from "../translate-content.js";
import {
  catalogSegmentLabel,
  contentSegmentLabel,
  createTranslationDebugCollector,
  type TranslationDebugCollector,
} from "./debug-collector.js";
import { throwTranslationFailure, translationFailureMessage } from "./failures.js";
import { createTranslator, translatorParams, type PluginRouteDependencies } from "./provider.js";
import {
  isRecord,
  readBoolean,
  readLocale,
  readNullableStringRecord,
  readRecord,
  readString,
  readStringArray,
  readText,
} from "./validators.js";

export type { PluginRouteDependencies };

const MAX_CATALOG_SOURCE_CHARACTERS = 30_000;
const RECENT_BATCH_JOBS = 10;
const BATCH_RESULTS_PAGE_SIZE = 50;
const BATCH_LIST_PAGE_SIZE = 100;
const ADMIN_ROLE = 50;
// A translation already running when its job was cancelled still saves; its row says so.
const FINISHED_AFTER_CANCEL = "Finished after the job was cancelled.";
const TRANSLATABLE_FIELD_TYPES = new Set(["string", "text", "portableText", "blocks"]);
const MAX_ENTRY_ID_LENGTH = 128;
const TRANSLATABLE_SUBFIELD_TYPES = new Set(["string", "text", "image"]);

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
  const ignoreKey = catalogIgnoreKey(inputOptions);
  const options = flattenEmdashCatalogs(inputOptions, ignoreKey);
  const messageSyntax = catalogMessageSyntax(inputOptions);
  const sourceContentLocale = () => contentLocale(options.catalogs.defaultLocale, dependencies);
  // Read per request: EmDash may set up its i18n config after the routes are created.
  const localeTags = () => adminLocaleTags(options, dependencies);
  return {
    "settings/collections": {
      permission: "plugins:manage",
      methods: ["GET", "PUT"],
      async handler(ctx) {
        if (ctx.request.method === "GET") return { ...(await collectionSettings(options, ctx.settings)), localeTags: localeTags() };
        const input = readRecord(ctx.input, "request body");
        const revision = readRevision(input.revision);
        await saveCollectionPolicies(ctx.settings, revision, readCollectionPolicies(input.policies));
        return { ...(await collectionSettings(options, ctx.settings)), localeTags: localeTags() };
      },
    },
    "settings/translation": {
      permission: "plugins:manage",
      methods: ["GET", "PUT"],
      async handler(ctx) {
        if (ctx.request.method === "GET") return { ...(await translationSettingsView(options, ctx.settings)), localeTags: localeTags() };
        const env = await dependencies.getEnv();
        await saveTranslationSettings(options, ctx.settings, readRecord(ctx.input, "request body"), async (model, effort, label) => {
          const capability = await readReasoningCapability(options, env, model, dependencies, ctx.log);
          if (capability?.has(effort) !== true) throw PluginRouteError.badRequest(`${label} is not a thinking effort ${model} accepts`);
        });
        return { ...(await translationSettingsView(options, ctx.settings)), localeTags: localeTags() };
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
          sourceLocale: policy !== undefined ? contentLocale(options.catalogs.defaultLocale, dependencies) : null,
          targetLocales:
            policy === undefined ? [] : targetLocales(options).map((code) => ({ locale: contentLocale(code, dependencies), code })),
          fields: policy === undefined ? [] : [...policy.fields],
          subFields: policy?.subFields ?? {},
          translateSeoWhenPublished: (await storedTranslationSettings(options, ctx.settings)).translateSeoWhenPublished,
          localeTags: localeTags(),
        } satisfies CollectionPolicyResponse;
      },
    },
    "models/reasoning": {
      permission: "plugins:manage",
      methods: ["GET"],
      async handler(ctx) {
        const model = readString(readRecord(ctx.input, "query").model, "model");
        if (!options.models.allowed.includes(model)) throw PluginRouteError.badRequest("model must be allowed by deployment configuration");
        try {
          const capability = await readReasoningCapability(options, await dependencies.getEnv(), model, dependencies, ctx.log);
          return { efforts: capability === null ? null : [...capability.keys()] } satisfies ModelReasoningResponse;
        } catch (error) {
          if (!(error instanceof PluginRouteError)) throw error;
          return { efforts: null, error: error.message } satisfies ModelReasoningResponse;
        }
      },
    },
    // Called after the admin (or the queue consumer) saves AI-translated content. The server derives locale and model itself.
    "ai-translation": {
      permission: "content:edit_any",
      methods: ["POST"],
      async handler(ctx) {
        const { collection, entryId, item, storage, fields, meta } = await aiTranslationInput(ctx, options, dependencies);
        const data = await savedEntryData(contentAccess(ctx), collection, item);
        const previous = readFieldHashes(recordValue(await storage.get(entryId)).fieldHashes);
        const record: AiTranslationRecord = {
          ...meta,
          fieldHashes: data === null ? null : await mergedFieldHashes(data, fields, previous),
        };
        await storage.put(entryId, record);
        invalidateObjectCache(AI_TRANSLATIONS_CACHE_NAMESPACE);
        return { recorded: true };
      },
    },
    // Sent just before the panel patches the open editor (or `cancel` after a refused patch). A later save that
    // changes one of these fields from its `baseline` confirms it into the AI-translated record.
    "ai-translation/pending": {
      permission: "content:edit_any",
      methods: ["POST"],
      async handler(ctx) {
        const { collection, entryId, item, fields, meta, input } = await aiTranslationInput(ctx, options, dependencies);
        const cancel = input.cancel === undefined ? false : readBoolean(input.cancel, "cancel");
        const pending = ctx.storage[AI_TRANSLATION_PENDING_COLLECTION];
        if (pending === undefined) throw PluginRouteError.internal("pending AI translation storage is unavailable");
        const stored = await pending.getVersioned(entryId);
        const previous = readPendingAiTranslation(stored?.value);
        let next: PendingAiTranslation | null;
        let added: string[] = [];
        if (cancel) {
          const remaining = previous?.fields.filter((field) => !fields.includes(field)) ?? [];
          next = previous === null || remaining.length === 0 ? null : { ...previous, fields: remaining };
        } else {
          const data = await savedEntryData(contentAccess(ctx), collection, item);
          if (data === null) throw PluginRouteError.internal("the saved draft could not be read");
          added = fields.filter((field) => !(previous?.fields.includes(field) ?? false));
          next = {
            ...meta,
            fields: [...(previous?.fields ?? []), ...added],
            baseline: { ...previous?.baseline, ...(await hashFields(data, added)) },
          };
        }
        const result =
          stored === null
            ? next === null
              ? { applied: true }
              : await pending.compareAndSet(entryId, null, next)
            : next === null
              ? await pending.compareAndDelete(entryId, stored.revision)
              : await pending.compareAndSet(entryId, stored.revision, next);
        if (!result.applied) throw PluginRouteError.conflict("Another translation of this entry is being recorded. Try again.");
        // A refused patch cancels only these, so an earlier unsaved translation of the same field stays pending.
        return { recorded: true, added };
      },
    },
    // For the editor panel: whether the entry is flagged, and which AI-written fields were changed since.
    "ai-translation/status": {
      permission: "content:edit_any",
      methods: ["GET"],
      async handler(ctx) {
        const { collection, item, storage, entryId } = await aiTranslationTarget(ctx, readRecord(ctx.input, "query"));
        const value = await storage.get(entryId);
        if (value === null)
          return { aiTranslated: false, aiTranslatedAt: null, model: null, editedFields: null } satisfies AiTranslationStatus;
        const record = recordValue(value);
        const hashes = readFieldHashes(record.fieldHashes);
        const data = hashes === null ? null : await savedEntryData(contentAccess(ctx), collection, item);
        return {
          aiTranslated: true,
          aiTranslatedAt: typeof record.aiTranslatedAt === "string" ? record.aiTranslatedAt : null,
          model: typeof record.model === "string" ? record.model : null,
          editedFields: hashes === null || data === null ? null : await changedFields(data, hashes),
        } satisfies AiTranslationStatus;
      },
    },
    // An editor keeps the flag (the saved text becomes the new baseline) or removes it.
    "ai-translation/review": {
      permission: "content:edit_any",
      methods: ["POST"],
      async handler(ctx) {
        const input = readRecord(ctx.input, "request body");
        const action = input.action;
        if (action !== "keep" && action !== "remove") throw PluginRouteError.badRequest("action must be keep or remove");
        const { collection, item, storage, entryId } = await aiTranslationTarget(ctx, input);
        const stored = await storage.getVersioned(entryId);
        if (stored === null) throw PluginRouteError.notFound("entry is not flagged as AI-translated");
        let applied: boolean;
        if (action === "remove") {
          applied = (await storage.compareAndDelete(entryId, stored.revision)).applied;
        } else {
          const record = recordValue(stored.value);
          const fields = Object.keys(readFieldHashes(record.fieldHashes) ?? {});
          const data = await savedEntryData(contentAccess(ctx), collection, item);
          if (data === null) throw PluginRouteError.internal("the saved draft could not be read");
          applied = (await storage.compareAndSet(entryId, stored.revision, { ...record, fieldHashes: await hashFields(data, fields) }))
            .applied;
        }
        if (!applied) throw PluginRouteError.conflict("The AI-translated flag changed meanwhile. Reload and try again.");
        invalidateObjectCache(AI_TRANSLATIONS_CACHE_NAMESPACE);
        return { reviewed: true };
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
          const targetLocale = configuredTargetLocale(
            options,
            catalogLocale(options, readLocale(input.targetLocale, "targetLocale"), dependencies),
          );
          const entryId = readString(input.entryId, "entryId");
          const selectedFields = [...new Set(readStringArray(input.fields, "fields", false))];
          const policy = await enabledCollectionPolicy(ctx.settings, collection);
          if (selectedFields.length > MAX_CONTENT_FIELDS) {
            throw PluginRouteError.badRequest(`fields cannot contain more than ${MAX_CONTENT_FIELDS} values`);
          }
          const dataFields = selectedFields.filter((field) => !isSeoField(field));
          if (dataFields.some((field) => !policy.fields.includes(field))) {
            throw PluginRouteError.badRequest("fields must be enabled in PolyStella collection settings");
          }
          const schema = await collectionSchema(ctx, collection);
          const untranslatableField = dataFields.find((slug) => !isTranslatableField(schema, policy, slug));
          if (untranslatableField !== undefined) {
            throw PluginRouteError.badRequest(`field "${untranslatableField}" is not a translatable text field in the collection schema`);
          }
          const seoSelected = dataFields.length < selectedFields.length;
          if (seoSelected && !schema.hasSeo) throw PluginRouteError.badRequest("the collection has no SEO fields");
          const { item, isSourceEntry, values } = await loadTranslationSource(
            ctx,
            options,
            dependencies,
            collection,
            entryId,
            targetLocale,
            selectedFields,
          );
          // Only the open editor takes SEO text: a created draft gets `data` only.
          if (seoSelected && isSourceEntry) throw PluginRouteError.badRequest("SEO fields are translated only on a target-locale entry");
          // EmDash saves patched SEO text at once, so on a published or scheduled entry it would go live unreviewed.
          if (
            seoSelected &&
            item.status !== "draft" &&
            !(await storedTranslationSettings(options, ctx.settings)).translateSeoWhenPublished
          ) {
            throw PluginRouteError.badRequest(
              "SEO fields of a published or scheduled entry can't be translated; an administrator can allow it in Translation settings",
            );
          }

          // Model and token choices are an administrator's, as in Translation settings.
          if (input.settings !== undefined && input.settings !== null && (ctx.user?.role ?? 0) < ADMIN_ROLE) {
            throw PluginRouteError.forbidden("only administrators can change translation settings for a run");
          }
          const jobSettings = await readJobSettingsInput(input.settings, options, await dependencies.getEnv(), dependencies, ctx.log);
          const settings = await translationSettings(options, targetLocale, ctx.settings, ctx.log, dependencies, jobSettings);
          if (settings.debugEnabled && (ctx.user?.role ?? 0) >= ADMIN_ROLE) {
            debug = createTranslationDebugCollector({
              operation: "content",
              provider: options.provider.kind,
              model: settings.translator.modelId,
              requestInput: settings.requestInput,
              maxOutputTokens: settings.maxTokens,
              maxSegmentsPerBatch: null,
              sourceLocale: options.catalogs.defaultLocale,
              targetLocale,
              labelSegment: (id) => contentSegmentLabel(id, Object.keys(values)),
            });
          }
          const plan = await planContentTranslation({
            values,
            repeaterSubFields: repeaterSubFields(schema, policy, dataFields),
            blockFields: options.blockFields,
            blocksFieldSlugs: blocksFieldSlugs(schema),
          });
          const part = input.part === undefined ? 0 : readPartIndex(input.part, plan.parts.length);
          const translations = part === 0 ? new Map<string, string>() : readEarlierParts(input, plan);
          const onValidationIssue =
            debug === undefined ? undefined : (segmentIds: string[], message: string) => debug?.markValidationIssue(message, segmentIds);
          translationStarted = true;
          const result = await translateContentPart(plan, part, {
            translator: settings.translator,
            glossary: settings.glossary,
            matchInflections: settings.matchInflections,
            sourceLocale: localeTag(options, options.catalogs.defaultLocale),
            targetLocale: localeTag(options, targetLocale),
            ...(settings.promptInstruction === undefined ? {} : { promptInstruction: settings.promptInstruction }),
            ...(debug === undefined ? {} : { onBatchAttempt: debug.record, onValidationIssue }),
            signal: ctx.request.signal,
          });
          for (const [id, text] of result.translations) translations.set(id, text);
          const next =
            part + 1 < plan.parts.length
              ? {
                  part: part + 1,
                  partCount: plan.parts.length,
                  fingerprint: plan.fingerprint,
                  translations: Object.fromEntries(translations),
                }
              : null;
          const patch = next === null ? applyContentTranslations(plan, translations, onValidationIssue) : null;
          const trace = debug === undefined ? {} : { debug: debug.finish(result.batchCount) };
          if (patch === null && next !== null)
            return { patch, batchCount: result.batchCount, next, ...trace } satisfies TranslateContentResponse;
          if (patch === null) throw new Error("[polystella-emdash] no patch for the last part");
          const notice = contentNotice(plan, patch);
          return {
            patch,
            batchCount: result.batchCount,
            ...(notice === null ? {} : { notice }),
            ...trace,
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
        const view = await catalogView(
          options,
          ctx.settings,
          overrideStorage(ctx.storage),
          locale,
          inputOptions.catalogs.locales[inputOptions.catalogs.defaultLocale]?.dictionary,
          ignoreKey,
        );
        return { ...view, localeTags: localeTags() } satisfies CatalogViewResponse;
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
              requestInput: settings.requestInput,
              maxOutputTokens: settings.maxTokens,
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
            matchInflections: settings.matchInflections,
            sourceLocale: localeTag(options, options.catalogs.defaultLocale),
            targetLocale: localeTag(options, locale),
            maxRetries: 2,
            messageSyntax,
            ...(settings.promptInstruction === undefined ? {} : { context: settings.promptInstruction }),
            ...(debug === undefined ? {} : { onBatchAttempt: debug.record, onRetry: ({ error }) => debug?.markLastAttemptError(error) }),
            signal: ctx.request.signal,
          });
          if (debug !== undefined) {
            for (const failure of result.tokenFailures) {
              const { key } = failure;
              const message = formatTokenValidationIssue(failure);
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
          const problem = overrideMessageProblem(key, source[key], value, localeTag(options, locale), messageSyntax);
          if (problem !== undefined) throw PluginRouteError.badRequest(`override is not a valid message: ${problem}`);
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
          json: serializeCatalog(
            locale,
            catalog.dictionary,
            overrides,
            inputOptions.catalogs.locales[locale]?.dictionary,
            ignoreKey,
            inputOptions.catalogs.locales[inputOptions.catalogs.defaultLocale]?.dictionary,
          ),
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
          const settings = await translationSettings(options, targetLocale, ctx.settings, ctx.log, dependencies, { model });
          if (settings.debugEnabled && (ctx.user?.role ?? 0) >= ADMIN_ROLE) {
            debug = createTranslationDebugCollector({
              operation: "sandbox",
              provider: options.provider.kind,
              model: settings.translator.modelId,
              requestInput: settings.requestInput,
              maxOutputTokens: settings.maxTokens,
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
            matchInflections: settings.matchInflections,
            sourceLocale: localeTag(options, options.catalogs.defaultLocale),
            targetLocale: localeTag(options, targetLocale),
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
    "batch/jobs": {
      permission: "plugins:manage",
      methods: ["GET"],
      async handler(ctx) {
        const { jobs, results } = batchStorage(ctx.storage);
        try {
          await deleteExpiredBatchJobs(jobs, results, dependencies.now());
        } catch (error) {
          // Cleanup retries on the next listing; it must not hide the jobs.
          ctx.log.warn("PolyStella could not delete expired batch jobs", { error: error instanceof Error ? error.message : String(error) });
        }
        const page = await jobs.query({ orderBy: { createdAt: "desc" }, limit: RECENT_BATCH_JOBS });
        const views = await Promise.all(
          page.items.flatMap(({ id, data }) => {
            const job = parseStoredJob(data);
            return job === null ? [] : [batchJobView(results, id, job)];
          }),
        );
        return { queueEnabled: options.batchQueueBinding !== undefined, jobs: views, localeTags: localeTags() } satisfies BatchJobsResponse;
      },
    },
    "batch/start": {
      permission: "plugins:manage",
      methods: ["POST"],
      async handler(ctx) {
        const input = readRecord(ctx.input, "request body");
        const collection = readString(input.collection, "collection");
        const locales = [
          ...new Set(
            readStringArray(input.locales, "locales", false).map((locale) =>
              configuredTargetLocale(options, catalogLocale(options, readLocale(locale, "locales"), dependencies)),
            ),
          ),
        ];
        const publish = input.publish === undefined ? false : readBoolean(input.publish, "publish");
        const updateExisting = input.updateExisting === undefined ? false : readBoolean(input.updateExisting, "updateExisting");
        const selectedIds = input.entryIds === undefined ? undefined : [...new Set(readStringArray(input.entryIds, "entryIds", false))];
        if (selectedIds?.some((id) => id.length > MAX_ENTRY_ID_LENGTH) === true) {
          throw PluginRouteError.badRequest(`entryIds cannot be longer than ${MAX_ENTRY_ID_LENGTH} characters`);
        }
        await enabledCollectionPolicy(ctx.settings, collection);
        const env = await dependencies.getEnv();
        const queue = batchQueue(options.batchQueueBinding, env);
        const settings = await readJobSettingsInput(input.settings, options, env, dependencies, ctx.log);
        if (selectedIds === undefined) {
          const first = await contentAccess(ctx).list(collection, { where: { locale: sourceContentLocale() }, limit: 1 });
          if (first.items.length === 0) throw PluginRouteError.badRequest("the collection has no source entries to translate");
        } else if (selectedIds.length > Math.floor(MAX_BATCH_TRANSLATIONS / locales.length)) {
          throw tooManyBatchTranslations();
        }

        const { jobs, results } = batchStorage(ctx.storage);
        const jobId = crypto.randomUUID();
        const job: StoredBatchJob = {
          collection,
          locales,
          total: (selectedIds?.length ?? 0) * locales.length,
          status: "running",
          publish,
          updateExisting,
          createdAt: dependencies.now().toISOString(),
          createdBy: ctx.user?.id ?? null,
          // A whole collection is listed by the queue, a page at a time, so this request stays small.
          listing: selectedIds === undefined ? { page: 0, cursor: null } : null,
          truncated: false,
          entryIds: selectedIds ?? "all",
          settings,
          retryOf: null,
        };
        await jobs.put(jobId, job);
        await enqueueBatchMessages(
          queue,
          selectedIds === undefined
            ? [{ kind: "list", jobId, page: 0 }]
            : selectedIds.flatMap((entryId) => locales.map((locale) => ({ jobId, entryId, locale }))),
        );
        return batchJobView(results, jobId, job);
      },
    },
    "batch/cancel": {
      permission: "plugins:manage",
      methods: ["POST"],
      async handler(ctx) {
        const jobId = readString(readRecord(ctx.input, "request body").jobId, "jobId");
        const { jobs, results } = batchStorage(ctx.storage);
        const job = await updateBatchJobStatus(jobs, jobId, "cancelled");
        return batchJobView(results, jobId, job);
      },
    },
    "batch/retry": {
      permission: "plugins:manage",
      methods: ["POST"],
      // Starts a new job for the failed rows, and with `redo` the translations the job wrote, so each attempt keeps its settings.
      async handler(ctx) {
        const input = readRecord(ctx.input, "request body");
        const jobId = readString(input.jobId, "jobId");
        const redo = input.redo === undefined ? false : readBoolean(input.redo, "redo");
        const env = await dependencies.getEnv();
        const queue = batchQueue(options.batchQueueBinding, env);
        const settings = await readJobSettingsInput(input.settings, options, env, dependencies, ctx.log);
        const { jobs, results } = batchStorage(ctx.storage);
        const original = await readBatchJob(jobs, jobId);
        if (original === null) throw PluginRouteError.notFound("batch job not found");
        if ((await batchJobView(results, jobId, original)).status === "running") {
          throw PluginRouteError.conflict("Cancel the job before retrying it, or wait for it to finish.");
        }
        const retryId = crypto.randomUUID();
        const messages: BatchMessage[] = [];
        const recorded = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await results.query({ where: { jobId }, limit: 100, ...(cursor === undefined ? {} : { cursor }) });
          for (const { data } of page.items) {
            const row = parseStoredResult(data);
            if (row === null) continue;
            recorded.add(JSON.stringify([row.entryId, row.locale]));
            const message = { jobId: retryId, entryId: row.entryId, locale: row.locale };
            if (row.outcome === "failed") messages.push(message);
            // Rows recorded before links existed can't say which translation to redo.
            else if (redo && row.outcome !== "skipped" && row.translation !== null) messages.push({ ...message, redo: row.translation.id });
          }
          cursor = page.hasMore ? page.cursor : undefined;
        } while (cursor !== undefined);
        // A cancel drops queued messages without a row, so those translations never ran.
        if (original.status === "cancelled" && Array.isArray(original.entryIds)) {
          for (const entryId of original.entryIds) {
            for (const locale of original.locales) {
              if (!recorded.has(JSON.stringify([entryId, locale]))) messages.push({ jobId: retryId, entryId, locale });
            }
          }
        }
        if (messages.length === 0 && original.listing === null) throw PluginRouteError.badRequest("this job has nothing to retry");
        const job: StoredBatchJob = {
          collection: original.collection,
          locales: original.locales,
          total: messages.length,
          status: "running",
          publish: original.publish,
          updateExisting: original.updateExisting,
          createdAt: dependencies.now().toISOString(),
          createdBy: ctx.user?.id ?? original.createdBy,
          // A job cancelled while listing hands the rest of the collection to its retry.
          listing: original.listing === null ? null : { page: 0, cursor: original.listing.cursor },
          truncated: false,
          entryIds: original.listing === null ? [...new Set(messages.map(({ entryId }) => entryId))] : "all",
          settings,
          retryOf: jobId,
        };
        await jobs.put(retryId, job);
        await enqueueBatchMessages(queue, [
          ...messages,
          ...(job.listing === null ? [] : [{ kind: "list" as const, jobId: retryId, page: 0 }]),
        ]);
        return batchJobView(results, retryId, job);
      },
    },
    // Removes a finished or cancelled job and its result rows from the jobs list. Translations it created stay.
    "batch/delete": {
      permission: "plugins:manage",
      methods: ["POST"],
      async handler(ctx) {
        const jobId = readString(readRecord(ctx.input, "request body").jobId, "jobId");
        const { jobs, results } = batchStorage(ctx.storage);
        const job = await readBatchJob(jobs, jobId);
        if (job === null) throw PluginRouteError.notFound("batch job not found");
        const view = await batchJobView(results, jobId, job);
        if (view.status === "running") {
          throw PluginRouteError.conflict("Cancel the job before removing it, or wait for it to finish.");
        }
        await deleteBatchJob(jobs, results, jobId);
        return { deleted: true };
      },
    },
    // Called by the queue consumer: queues one page of a whole-collection job, then the next page.
    "batch/list": {
      permission: "plugins:manage",
      methods: ["POST"],
      async handler(ctx) {
        const message = readBatchListMessage(ctx.input);
        if (message === null) throw PluginRouteError.badRequest("invalid batch list message");
        const { jobs } = batchStorage(ctx.storage);
        const queue = batchQueue(options.batchQueueBinding, await dependencies.getEnv());
        const content = contentAccess(ctx);
        // Retries only when another write (cancel, retry, a duplicate delivery) changed the job meanwhile.
        for (let attempt = 0; attempt < 3; attempt++) {
          const stored = await jobs.getVersioned(message.jobId);
          const job = stored === null ? null : parseStoredJob(stored.value);
          if (stored === null || job === null || job.status === "cancelled" || job.listing === null || message.page < job.listing.page) {
            return { listed: false };
          }
          // The previous page's job update hasn't landed yet; the queue redelivers this message.
          if (message.page > job.listing.page) throw PluginRouteError.conflict("an earlier page of this job is still being listed");
          const { cursor } = job.listing;
          const page = await content.list(job.collection, {
            where: { locale: sourceContentLocale() },
            limit: BATCH_LIST_PAGE_SIZE,
            ...(cursor === null ? {} : { cursor }),
          });
          const room = Math.max(0, Math.floor((MAX_BATCH_TRANSLATIONS - job.total) / job.locales.length));
          const entries = page.items.slice(0, room);
          const truncated = entries.length < page.items.length;
          const nextCursor = !truncated && page.hasMore && page.cursor !== undefined ? page.cursor : null;
          // Queued before the job update: a duplicate message is harmless, a lost page is not.
          await enqueueBatchMessages(queue, [
            ...entries.flatMap((entry) => job.locales.map((locale) => ({ jobId: message.jobId, entryId: entry.id, locale }))),
            ...(nextCursor === null ? [] : [{ kind: "list" as const, jobId: message.jobId, page: message.page + 1 }]),
          ]);
          const next: StoredBatchJob = {
            ...job,
            total: job.total + entries.length * job.locales.length,
            listing: nextCursor === null ? null : { page: message.page + 1, cursor: nextCursor },
            truncated,
          };
          if ((await jobs.compareAndSet(message.jobId, stored.revision, next)).applied) return { listed: true };
        }
        throw PluginRouteError.conflict("The batch job kept changing while its entries were listed.");
      },
    },
    // Called by the queue consumer through `withEmDashRuntime`; returns the draft to create or the update to save.
    "batch/translate": {
      permission: "plugins:manage",
      methods: ["POST"],
      async handler(ctx) {
        const message = readBatchMessage(ctx.input);
        if (message === null) throw PluginRouteError.badRequest("invalid batch message");
        const { jobs, results } = batchStorage(ctx.storage);
        const job = await readBatchJob(jobs, message.jobId);
        if (job === null || job.status === "cancelled" || !job.locales.includes(message.locale)) {
          return { create: null } satisfies BatchTranslateResponse;
        }
        const previous = parseStoredResult(await results.get(batchResultId(message)));
        if (previous !== null && previous.outcome !== "failed") return { create: null } satisfies BatchTranslateResponse;

        const record = async (
          outcome: BatchJobOutcome,
          detail: string | null,
          translation: BatchTranslationLink | null = null,
        ): Promise<BatchTranslateResponse> => {
          await recordBatchResult(results, message, outcome, detail, dependencies.now(), translation);
          return { create: null };
        };
        try {
          const collection = job.collection;
          const policy = await enabledCollectionPolicy(ctx.settings, collection);
          const schema = await collectionSchema(ctx, collection);
          const fields = policy.fields.filter((slug) => isTranslatableField(schema, policy, slug)).slice(0, MAX_CONTENT_FIELDS);
          if (fields.length === 0) return await record("failed", "No translatable fields are enabled for this collection.");
          const part = message.part ?? 0;
          const stored = part > 0 ? parseStoredParts(await results.get(batchPartsId(message))) : null;
          // A redelivered message for a part that already ran has nothing left to do.
          if (stored !== null && stored.part !== part) return { create: null } satisfies BatchTranslateResponse;
          const rev = part > 0 ? stored?.rev : message.rev;
          const siblings = await ctx.content?.getTranslations?.(collection, message.entryId);
          const existing = siblings?.translations.find((sibling) => sameContentLocale(sibling.locale, message.locale, dependencies));
          const existingLink: BatchTranslationLink | null =
            existing === undefined
              ? null
              : {
                  id: existing.id,
                  locale: existing.locale ?? contentLocale(message.locale, dependencies),
                  slug: existing.slug,
                  published: existing.status === "published",
                };
          if (message.redo !== undefined) {
            if (existingLink?.id !== message.redo) {
              if (part > 0) await results.delete(batchPartsId(message));
              return await record("skipped", "The translation this job created no longer exists, so it was not redone.", existingLink);
            }
            if (part > 0 && stored?.rev === undefined) return await record("failed", SOURCE_CHANGED);
            if (rev === undefined) {
              return {
                create: null,
                readRevision: { collection, id: existingLink.id, locale: existingLink.locale },
              } satisfies BatchTranslateResponse;
            }
            // Checked after the consumer read `_rev` and on every part: an earlier edit shows here, a later one conflicts on save.
            const problem = await redoProblem(ctx, collection, message.redo);
            if (problem !== null) {
              if (part > 0) await results.delete(batchPartsId(message));
              return await record("skipped", problem, existingLink);
            }
          } else if (existingLink !== null) {
            if (job.updateExisting && part > 0 && stored === null) return await record("failed", SOURCE_CHANGED);
            // A translation that appeared after part 0 of a create was made by someone else, so it is left alone.
            if (!job.updateExisting || (part > 0 && rev === undefined)) {
              if (part > 0) await results.delete(batchPartsId(message));
              return await record("skipped", "A translation already exists.", existingLink);
            }
            if (rev === undefined) {
              return {
                create: null,
                readRevision: { collection, id: existingLink.id, locale: existingLink.locale },
              } satisfies BatchTranslateResponse;
            }
          }
          const { sourceItem, values } = await loadTranslationSource(
            ctx,
            options,
            dependencies,
            collection,
            message.entryId,
            message.locale,
            fields,
          );
          if (sourceItem.id !== message.entryId) return await record("failed", "The entry is not in the source locale.");
          const plan = await planContentTranslation({
            values,
            repeaterSubFields: repeaterSubFields(schema, policy, fields),
            blockFields: options.blockFields,
            blocksFieldSlugs: blocksFieldSlugs(schema),
          });
          const translations = new Map<string, string>();
          if (part > 0) {
            if (stored === null || stored.fingerprint !== plan.fingerprint || part >= plan.parts.length) {
              await results.delete(batchPartsId(message));
              return await record("failed", SOURCE_CHANGED);
            }
            for (const [id, text] of Object.entries(stored.translations)) translations.set(id, text);
          }
          const settings = await translationSettings(options, message.locale, ctx.settings, ctx.log, dependencies, job.settings);
          const result = await translateContentPart(plan, part, {
            translator: settings.translator,
            glossary: settings.glossary,
            matchInflections: settings.matchInflections,
            sourceLocale: localeTag(options, options.catalogs.defaultLocale),
            targetLocale: localeTag(options, message.locale),
            ...(settings.promptInstruction === undefined ? {} : { promptInstruction: settings.promptInstruction }),
            signal: ctx.request.signal,
          });
          for (const [id, text] of result.translations) translations.set(id, text);
          if (part + 1 < plan.parts.length) {
            const { jobId, entryId, locale, redo: redoId } = message;
            const next: StoredBatchParts = {
              jobId,
              entryId,
              locale,
              part: part + 1,
              fingerprint: plan.fingerprint,
              translations: Object.fromEntries(translations),
              ...(existingLink === null || rev === undefined ? {} : { rev }),
            };
            await results.put(batchPartsId(message), next);
            await enqueueBatchMessages(batchQueue(options.batchQueueBinding, await dependencies.getEnv()), [
              { jobId, entryId, locale, part: part + 1, ...(redoId === undefined ? {} : { redo: redoId }) },
            ]);
            return { create: null } satisfies BatchTranslateResponse;
          }
          const patch = applyContentTranslations(plan, translations);
          if (part > 0) await results.delete(batchPartsId(message));
          const notice = contentNotice(plan, patch);
          if (existingLink !== null && rev !== undefined) {
            return {
              create: null,
              update: { collection, id: existingLink.id, locale: existingLink.locale, data: patch, _rev: rev, translation: existingLink },
              publish: job.publish,
              ...(notice === null ? {} : { notice }),
            } satisfies BatchTranslateResponse;
          }
          return {
            create: {
              collection,
              data: { ...sourceItem.data, ...patch },
              slug: sourceItem.slug,
              locale: contentLocale(message.locale, dependencies),
              translationOf: sourceItem.id,
              ...(job.createdBy === null ? {} : { authorId: job.createdBy }),
            },
            publish: job.publish,
            ...(notice === null ? {} : { notice }),
          } satisfies BatchTranslateResponse;
        } catch (error) {
          const failure = batchFailureMessage(error, ctx.log);
          await results.delete(batchPartsId(message));
          return await record("failed", failure);
        }
      },
    },
    // Called by the queue consumer once it has saved (or failed to save) the translation.
    "batch/record": {
      permission: "plugins:manage",
      methods: ["POST"],
      async handler(ctx) {
        const input = readRecord(ctx.input, "request body");
        const message = readBatchMessage(input);
        if (message === null) throw PluginRouteError.badRequest("invalid batch message");
        const outcome = input.outcome;
        if (outcome !== "created" && outcome !== "updated" && outcome !== "skipped" && outcome !== "failed") {
          throw PluginRouteError.badRequest("outcome must be created, updated, skipped, or failed");
        }
        const detail = input.message === null ? null : readText(input.message, "message", MAX_BATCH_MESSAGE_CHARACTERS);
        const translation = input.translation === undefined || input.translation === null ? null : readTranslationLink(input.translation);
        if (input.translation !== undefined && input.translation !== null && translation === null) {
          throw PluginRouteError.badRequest("translation must have id, locale, slug, and published");
        }
        const { jobs, results } = batchStorage(ctx.storage);
        // A message still in flight when its job was removed must not leave a row nothing lists.
        const job = await readBatchJob(jobs, message.jobId);
        if (job === null) return { recorded: false };
        // A duplicate delivery hits a conflict after the first copy saved; the saved row stays.
        const previous = parseStoredResult(await results.get(batchResultId(message)));
        if (outcome === "skipped" && (previous?.outcome === "created" || previous?.outcome === "updated")) return { recorded: false };
        const note = job.status === "cancelled" && outcome !== "skipped" ? FINISHED_AFTER_CANCEL : null;
        const recordedDetail = note === null ? detail : detail === null ? note : `${note} ${detail}`;
        await recordBatchResult(results, message, outcome, recordedDetail, dependencies.now(), translation);
        return { recorded: true };
      },
    },
    "batch/results": {
      permission: "plugins:manage",
      methods: ["GET"],
      async handler(ctx) {
        const query = readRecord(ctx.input, "query");
        const jobId = readString(query.jobId, "jobId");
        const cursor = query.cursor === undefined ? undefined : readString(query.cursor, "cursor");
        const outcome = query.outcome;
        if (outcome !== undefined && outcome !== "created" && outcome !== "updated" && outcome !== "skipped" && outcome !== "failed") {
          throw PluginRouteError.badRequest("outcome must be created, updated, skipped, or failed");
        }
        const { jobs, results } = batchStorage(ctx.storage);
        const job = await readBatchJob(jobs, jobId);
        if (job === null) throw PluginRouteError.notFound("batch job not found");
        const page = await results.query({
          where: { jobId, ...(outcome === undefined ? {} : { outcome }) },
          limit: BATCH_RESULTS_PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        });
        const rows = page.items.flatMap(({ data }) => {
          const row = parseStoredResult(data);
          return row === null ? [] : [row];
        });
        const titles = await sourceTitles(
          ctx,
          job.collection,
          rows.map(({ entryId }) => entryId),
        );
        return {
          results: rows.map((row) => ({
            entryId: row.entryId,
            title: titles.get(row.entryId)?.title ?? row.entryId,
            locale: row.locale,
            outcome: row.outcome,
            message: row.message,
            translation: row.translation,
          })),
          nextCursor: page.hasMore && page.cursor !== undefined ? page.cursor : null,
        } satisfies BatchJobResultsResponse;
      },
    },
    // The entries a selected-entries job was started for, a page at a time.
    "batch/entries": {
      permission: "plugins:manage",
      methods: ["GET"],
      async handler(ctx) {
        const query = readRecord(ctx.input, "query");
        const jobId = readString(query.jobId, "jobId");
        const offset = query.cursor === undefined ? 0 : Number(readString(query.cursor, "cursor"));
        if (!Number.isSafeInteger(offset) || offset < 0) throw PluginRouteError.badRequest("cursor is invalid");
        const job = await readBatchJob(batchStorage(ctx.storage).jobs, jobId);
        if (job === null) throw PluginRouteError.notFound("batch job not found");
        const ids = Array.isArray(job.entryIds) ? job.entryIds.slice(offset, offset + BATCH_RESULTS_PAGE_SIZE) : [];
        const titles = await sourceTitles(ctx, job.collection, ids);
        const next = offset + ids.length;
        return {
          entries: ids.map((id) => {
            const source = titles.get(id);
            return { id, title: source?.title ?? id, locale: source?.locale ?? null, deleted: source === undefined };
          }),
          nextCursor: Array.isArray(job.entryIds) && next < job.entryIds.length ? String(next) : null,
        } satisfies BatchJobEntriesResponse;
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

/** Source titles for one page of result rows; a deleted entry falls back to its id. */
async function sourceTitles(
  ctx: RouteContext,
  collection: string,
  entryIds: readonly string[],
): Promise<Map<string, { title: string; locale: string | null }>> {
  const unique = [...new Set(entryIds)];
  const items = await Promise.all(unique.map((id) => ctx.content?.get(collection, id) ?? Promise.resolve(null)));
  const titles = new Map<string, { title: string; locale: string | null }>();
  for (const [index, item] of items.entries()) {
    const id = unique[index];
    if (item === null || id === undefined) continue;
    const title = item.data.title;
    titles.set(id, { title: typeof title === "string" && title.trim().length > 0 ? title : (item.slug ?? id), locale: item.locale });
  }
  return titles;
}

function batchStorage(storage: Record<string, StorageCollection | undefined>): { jobs: StorageCollection; results: StorageCollection } {
  const jobs = storage.batch_jobs;
  const results = storage.batch_results;
  if (jobs === undefined || results === undefined) throw PluginRouteError.internal("batch job storage is unavailable");
  return { jobs, results };
}

/** What EmDash's save hooks see: live data with any draft revision merged over it. `null` if the draft can't be read. */
async function savedEntryData(
  content: NonNullable<RouteContext["content"]>,
  collection: string,
  item: PluginContentItem,
): Promise<Record<string, unknown> | null> {
  const draftId = item.draftRevisionId;
  if (draftId === undefined || draftId === null) return item.data;
  const revision = await content.getRevision?.(collection, item.id, draftId);
  if (revision === undefined || revision === null) return null;
  return { ...item.data, ...Object.fromEntries(Object.entries(revision.data).filter(([key]) => !key.startsWith("_"))) };
}

/** Why a retry must leave a translation an earlier job wrote alone: published, scheduled, or edited since; `null` to redo it. */
async function redoProblem(ctx: RouteContext, collection: string, translationId: string): Promise<string | null> {
  const content = contentAccess(ctx);
  const item = await content.get(collection, translationId);
  if (item === null) return "The translation this job created no longer exists, so it was not redone.";
  if (item.status !== "draft") return "The translation is published or scheduled, so it was not redone.";
  const hashes = readFieldHashes(recordValue(await ctx.storage[AI_TRANSLATIONS_COLLECTION]?.get(translationId)).fieldHashes);
  const data = hashes === null ? null : await savedEntryData(content, collection, item);
  if (hashes === null || data === null) return "PolyStella can't tell whether the translation was edited, so it was not redone.";
  if ((await changedFields(data, hashes)).length > 0) return "The translation was edited after PolyStella wrote it, so it was not redone.";
  return null;
}

async function aiTranslationTarget(ctx: RouteContext, input: Record<string, unknown>) {
  const collection = readString(input.collection, "collection");
  const entryId = readString(input.entryId, "entryId");
  const policy = await enabledCollectionPolicy(ctx.settings, collection);
  const item = await contentAccess(ctx).get(collection, entryId);
  if (item === null) throw PluginRouteError.notFound("content entry not found");
  const storage = ctx.storage[AI_TRANSLATIONS_COLLECTION];
  if (storage === undefined) throw PluginRouteError.internal("AI translation storage is unavailable");
  return { collection, entryId, item, policy, storage };
}

/** Shared input of the two routes that record an AI translation. The server derives locale and model itself. */
async function aiTranslationInput(ctx: RouteContext, options: PolystellaEmdashOptions, dependencies: PluginRouteDependencies) {
  const input = readRecord(ctx.input, "request body");
  const target = await aiTranslationTarget(ctx, input);
  const { policy, item } = target;
  // The queue translates every enabled field, so it sends none.
  const fields = input.fields === undefined ? policy.fields : [...new Set(readStringArray(input.fields, "fields", false))];
  if (fields.some((field) => !policy.fields.includes(field)))
    throw PluginRouteError.badRequest("fields must be enabled for the collection");
  if (item.locale === null) throw PluginRouteError.badRequest("entry has no locale");
  const locale = configuredTargetLocale(options, catalogLocale(options, item.locale, dependencies));
  const stored = await storedTranslationSettings(options, ctx.settings);
  const meta = {
    collection: target.collection,
    entryId: target.entryId,
    locale,
    model: (await runModelOverride(ctx, input, options)) ?? effectiveModelChoice(options, stored, locale).model,
    aiTranslatedAt: dependencies.now().toISOString(),
  };
  return { ...target, input, fields, meta };
}

/** What an editor should check by hand in a finished translation, or `null`. */
function contentNotice(plan: ContentPlan, patch: Record<string, unknown>): string | null {
  const notices = [unlistedBlocksNotice(plan), samePageLinksNotice(patch)].filter((notice) => notice !== null);
  return notices.length === 0 ? null : notices.join(" ");
}

/** The model a batch run chose: the queue sends its `jobId`, an administrator's browser run sends `model`. */
async function runModelOverride(
  ctx: RouteContext,
  input: Record<string, unknown>,
  options: PolystellaEmdashOptions,
): Promise<string | null> {
  if (input.jobId !== undefined) {
    const job = await readBatchJob(batchStorage(ctx.storage).jobs, readString(input.jobId, "jobId"));
    return job?.settings?.model ?? null;
  }
  if (input.model === undefined) return null;
  const model = readString(input.model, "model");
  if ((ctx.user?.role ?? 0) < ADMIN_ROLE) throw PluginRouteError.forbidden("only administrators can choose the model of a run");
  if (!options.models.allowed.includes(model)) throw PluginRouteError.badRequest("model must be allowed by deployment configuration");
  return model;
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function contentAccess(ctx: RouteContext): NonNullable<RouteContext["content"]> {
  if (ctx.content === undefined) throw PluginRouteError.internal("content access is unavailable");
  return ctx.content;
}

function tooManyBatchTranslations(): PluginRouteError {
  return PluginRouteError.badRequest(
    `a batch job cannot contain more than ${MAX_BATCH_TRANSLATIONS} translations; select fewer entries or locales`,
  );
}

async function updateBatchJobStatus(jobs: StorageCollection, jobId: string, status: StoredBatchJob["status"]): Promise<StoredBatchJob> {
  const stored = await jobs.getVersioned(jobId);
  const job = stored === null ? null : parseStoredJob(stored.value);
  if (stored === null || job === null) throw PluginRouteError.notFound("batch job not found");
  const next: StoredBatchJob = { ...job, status };
  if (!(await jobs.compareAndSet(jobId, stored.revision, next)).applied) {
    throw PluginRouteError.conflict("The batch job changed. Reload and try again.");
  }
  return next;
}

async function batchJobView(results: StorageCollection, id: string, job: StoredBatchJob): Promise<BatchJobView> {
  const countOutcome = (outcome: BatchJobOutcome) => results.count({ jobId: id, outcome });
  const [created, updated, skipped, failed] = await Promise.all([
    countOutcome("created"),
    countOutcome("updated"),
    countOutcome("skipped"),
    countOutcome("failed"),
  ]);
  return {
    id,
    collection: job.collection,
    locales: job.locales,
    total: job.total,
    settings: job.settings,
    retryOf: job.retryOf,
    status:
      job.status === "cancelled"
        ? "cancelled"
        : job.listing === null && created + updated + skipped + failed >= job.total
          ? "finished"
          : "running",
    publish: job.publish,
    updateExisting: job.updateExisting,
    createdAt: job.createdAt,
    listing: job.listing !== null,
    truncated: job.truncated,
    entryCount: Array.isArray(job.entryIds) ? job.entryIds.length : job.entryIds,
    counts: { created, updated, skipped, failed },
  };
}

function batchFailureMessage(error: unknown, log: LogAccess): string {
  if (error instanceof PluginRouteError || error instanceof ContentTranslationInputError) return error.message;
  // Rethrows aborts, so the queue retries the message.
  return translationFailureMessage(error, log, "batch");
}

async function enabledCollectionPolicy(settings: SettingsAccess, collection: string): Promise<CollectionPolicy> {
  const policies = await collectionPolicies(settings);
  const policy = Object.hasOwn(policies, collection) ? policies[collection] : undefined;
  if (policy === undefined) throw PluginRouteError.forbidden("PolyStella is not enabled for this collection");
  return policy;
}

async function collectionSchema(ctx: RouteContext, collection: string): Promise<CollectionSchemaInfo> {
  if (ctx.schema === undefined) throw PluginRouteError.internal("schema access is unavailable");
  const schema = await ctx.schema.getCollection(collection);
  if (schema === null) throw PluginRouteError.notFound("collection not found");
  return schema;
}

const SOURCE_CHANGED = "The source entry changed while it was being translated. Start the translation again.";

function readPartIndex(value: unknown, partCount: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value >= partCount) {
    throw PluginRouteError.badRequest(`part must be an integer from 0 to ${partCount - 1}`);
  }
  return value;
}

/** Translations of earlier parts, sent back by the browser; only valid for the same source text. */
function readEarlierParts(input: Record<string, unknown>, plan: ContentPlan): Map<string, string> {
  if (input.fingerprint !== plan.fingerprint) throw PluginRouteError.conflict(SOURCE_CHANGED);
  const ids = new Set(plan.segments.map(({ id }) => id));
  const translations = new Map<string, string>();
  for (const [id, text] of Object.entries(readRecord(input.translations, "translations"))) {
    if (!ids.has(id) || typeof text !== "string")
      throw PluginRouteError.badRequest("translations must map this entry's segment ids to text");
    translations.set(id, text);
  }
  return translations;
}

function blocksFieldSlugs(schema: CollectionSchemaInfo): string[] {
  return schema.fields.filter((field) => field.type === "blocks").map((field) => field.slug);
}

function isTranslatableField(schema: CollectionSchemaInfo, policy: CollectionPolicy, slug: string): boolean {
  const field = schema.fields.find((candidate) => candidate.slug === slug);
  if (field === undefined || !field.translatable) return false;
  return field.type === "repeater" ? translatableSubFields(schema, policy, slug).length > 0 : TRANSLATABLE_FIELD_TYPES.has(field.type);
}

/** The policy's subfields for a repeater that the schema still has with a text or image type. */
function translatableSubFields(schema: CollectionSchemaInfo, policy: CollectionPolicy, slug: string): string[] {
  const field = schema.fields.find((candidate) => candidate.slug === slug);
  const chosen = policy.subFields !== undefined && Object.hasOwn(policy.subFields, slug) ? policy.subFields[slug] : undefined;
  if (field?.type !== "repeater" || chosen === undefined) return [];
  const supported = new Set(
    (field.validation?.subFields ?? []).filter((subField) => TRANSLATABLE_SUBFIELD_TYPES.has(subField.type)).map(({ slug }) => slug),
  );
  return chosen.filter((subField) => supported.has(subField));
}

function repeaterSubFields(schema: CollectionSchemaInfo, policy: CollectionPolicy, fields: readonly string[]): Record<string, string[]> {
  return Object.fromEntries(
    fields.flatMap((slug) => {
      const subFields = translatableSubFields(schema, policy, slug);
      return subFields.length === 0 ? [] : [[slug, subFields]];
    }),
  );
}

async function loadTranslationSource(
  ctx: RouteContext,
  options: PolystellaEmdashOptions,
  dependencies: PluginRouteDependencies,
  collection: string,
  entryId: string,
  targetLocale: string,
  fields: readonly string[],
): Promise<{ item: PluginContentItem; isSourceEntry: boolean; sourceItem: PluginContentItem; values: Record<string, unknown> }> {
  if (ctx.content === undefined) throw PluginRouteError.internal("content access is unavailable");
  const item = await ctx.content.get(collection, entryId);
  if (item === null) throw PluginRouteError.notFound("content entry not found");
  // A source-locale entry is translated directly so the panel can create a missing locale.
  const isSourceEntry = sameContentLocale(item.locale, options.catalogs.defaultLocale, dependencies);
  if (!isSourceEntry && !sameContentLocale(item.locale, targetLocale, dependencies)) {
    throw PluginRouteError.badRequest("entry locale must match targetLocale or the source locale");
  }
  let sourceItem = item;
  if (!isSourceEntry) {
    const siblings = await ctx.content.getTranslations?.(collection, entryId);
    const sourceId = siblings?.translations.find((sibling) =>
      sameContentLocale(sibling.locale, options.catalogs.defaultLocale, dependencies),
    )?.id;
    sourceItem = (sourceId === undefined ? null : await ctx.content.get(collection, sourceId)) ?? item;
  }
  const values = Object.fromEntries(
    fields.flatMap((field) => {
      if (!isSeoField(field)) return Object.hasOwn(sourceItem.data, field) ? [[field, sourceItem.data[field]]] : [];
      const text = field === "seo.title" ? sourceItem.seo?.title : sourceItem.seo?.description;
      return typeof text === "string" && text.trim().length > 0 ? [[field, text]] : [];
    }),
  );
  if (Object.keys(values).length === 0) throw PluginRouteError.badRequest("selected fields have no saved values");
  return { item, isSourceEntry, sourceItem, values };
}

function overrideMessageProblem(
  key: string,
  source: string | undefined,
  value: string,
  tag: string,
  syntax: MessageSyntax,
): string | undefined {
  if (source === undefined || source.length === 0) {
    const problems = validateMessage(value, tag, syntax);
    return problems.length === 0 ? undefined : problems.join("; ");
  }
  const issue = validateMessageTranslation(key, source, value, tag, syntax);
  return issue === null ? undefined : formatTokenValidationIssue(issue);
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
  ignoreKey?: IgnoreKey | undefined,
): Promise<Omit<CatalogViewResponse, "localeTags">> {
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
    groups: catalogGroupTitles(source, ignoreKey),
    entries,
    messageSyntax: catalogMessageSyntax(options),
  };
}

async function translationSettings(
  options: PolystellaEmdashOptions,
  locale: string,
  settings: SettingsAccess,
  log: LogAccess,
  dependencies: PluginRouteDependencies,
  overrides: Partial<BatchJobSettings> | null = null,
): Promise<{
  translator: Translator;
  glossary: Glossary;
  matchInflections: boolean;
  debugEnabled: boolean;
  maxTokens: number;
  promptInstruction?: string | undefined;
  /** For the debug trace: the extra Workers AI input each request carries. */
  requestInput: Readonly<Record<string, unknown>> | null;
}> {
  const [storedSettings, env] = await Promise.all([storedTranslationSettings(options, settings), dependencies.getEnv()]);
  const stored = storedSettings.locales[locale];
  if (stored === undefined) throw PluginRouteError.internal(`translation settings for ${locale} are unavailable`);
  const choice = effectiveModelChoice(options, storedSettings, locale);
  const modelOverride = overrides?.model ?? null;
  // A job's stored model may have been removed from the deployment since it started.
  if (modelOverride !== null && !options.models.allowed.includes(modelOverride)) {
    throw PluginRouteError.badRequest(`model ${modelOverride} is no longer allowed by deployment configuration`);
  }
  const model = modelOverride ?? choice.model;
  if (stored.glossaryText.length > MAX_GLOSSARY_CHARACTERS) {
    throw PluginRouteError.badRequest(`glossary text for ${locale} cannot exceed ${MAX_GLOSSARY_CHARACTERS} characters`);
  }
  const glossary = resolveGlossary(options.glossaryDefaults?.[locale], stored.glossaryMode, stored.glossaryText.trim());
  const configuredInstruction = resolveInstructions(
    options.rules ?? [],
    storedSettings.instructions.mode,
    storedSettings.instructions.text.trim(),
  );
  if (configuredInstruction.length > MAX_INSTRUCTION_CHARACTERS) {
    throw PluginRouteError.badRequest(`translation instructions cannot exceed ${MAX_INSTRUCTION_CHARACTERS} characters`);
  }
  const promptInstruction = [configuredInstruction, overrides?.instructions?.trim() ?? ""].filter((text) => text.length > 0).join("\n");
  const maxTokens = overrides?.maxTokens ?? storedSettings.maxTokens ?? defaultMaxTokens(options);
  // An admin's thinking choice goes with the model they picked; the code default comes from `models.params`.
  const effort = overrides?.reasoning ?? (model === choice.model ? choice.reasoning : null);
  const thinking = await reasoningInput(options, env, model, effort, dependencies, log);
  const translator = createTranslator(options, env, model, locale, log, dependencies, maxTokens, thinking);
  return {
    translator,
    requestInput: workersAIRequestParams(translatorParams(options, model, locale, thinking)) ?? null,
    glossary,
    matchInflections: options.glossaryMatchInflections === true,
    debugEnabled: storedSettings.debugEnabled,
    maxTokens,
    ...(promptInstruction.length === 0 ? {} : { promptInstruction }),
  };
}

/** Settings an administrator chose for a job; `null` when they change nothing. */
async function readJobSettingsInput(
  value: unknown,
  options: PolystellaEmdashOptions,
  env: Record<string, unknown> | undefined,
  dependencies: PluginRouteDependencies,
  log: LogAccess,
): Promise<BatchJobSettings | null> {
  if (value === undefined || value === null) return null;
  const input = readRecord(value, "settings");
  const model = input.model === undefined || input.model === null ? null : readString(input.model, "settings.model");
  if (model !== null && !options.models.allowed.includes(model)) {
    throw PluginRouteError.badRequest("settings.model must be allowed by deployment configuration");
  }
  const reasoning = input.reasoning === undefined || input.reasoning === null ? null : readString(input.reasoning, "settings.reasoning");
  if (reasoning !== null) {
    if (model === null) throw PluginRouteError.badRequest("settings.reasoning needs settings.model");
    const capability = await readReasoningCapability(options, env, model, dependencies, log);
    if (capability?.has(reasoning) !== true)
      throw PluginRouteError.badRequest(`settings.reasoning is not a thinking effort ${model} accepts`);
  }
  const maxTokens = input.maxTokens === undefined || input.maxTokens === null ? null : input.maxTokens;
  if (maxTokens !== null && !isMaxTokens(maxTokens)) {
    throw PluginRouteError.badRequest(`settings.maxTokens must be null or an integer from ${MIN_MAX_TOKENS} to ${MAX_MAX_TOKENS}`);
  }
  const instructions =
    input.instructions === undefined ? "" : readText(input.instructions, "settings.instructions", MAX_JOB_INSTRUCTION_CHARACTERS).trim();
  if (model === null && maxTokens === null && instructions.length === 0) return null;
  return { model, reasoning, maxTokens, instructions };
}

/** Catalog failures become a 503 so callers can tell them apart from "no switch". */
async function readReasoningCapability(
  options: PolystellaEmdashOptions,
  env: Record<string, unknown> | undefined,
  model: string,
  dependencies: PluginRouteDependencies,
  log: LogAccess,
): Promise<ReasoningCapability | null> {
  try {
    return await reasoningCapability(options, env, model, dependencies);
  } catch (error) {
    log.warn("PolyStella could not read the Workers AI model catalog", {
      model,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new PluginRouteError("MODEL_CATALOG_UNAVAILABLE", "PolyStella could not read this model's thinking options from Workers AI", 503);
  }
}

/** Fails soft: a translation runs with the model's default thinking rather than not at all. */
async function reasoningInput(
  options: PolystellaEmdashOptions,
  env: Record<string, unknown> | undefined,
  model: string,
  effort: string | null,
  dependencies: PluginRouteDependencies,
  log: LogAccess,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  if (effort === null) return undefined;
  try {
    const input = (await readReasoningCapability(options, env, model, dependencies, log))?.get(effort);
    if (input === undefined) log.warn("PolyStella ignored a thinking effort the model does not accept", { model, effort });
    return input;
  } catch {
    return undefined;
  }
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

// EmDash 1.3 stamps new content with the Astro locale path ("fr"); catalogs use codes ("fr-FR").
function contentLocale(locale: string, dependencies: PluginRouteDependencies): string {
  const aliases = dependencies.localeAliases?.() ?? getI18nConfig()?.localeAliases ?? {};
  const lower = locale.toLowerCase();
  return Object.entries(aliases).find(([code]) => code.toLowerCase() === lower)?.[1] ?? locale;
}

function sameContentLocale(left: string | null, right: string, dependencies: PluginRouteDependencies): boolean {
  return left !== null && contentLocale(left, dependencies).toLowerCase() === contentLocale(right, dependencies).toLowerCase();
}

function adminLocaleTags(options: PolystellaEmdashOptions, dependencies: PluginRouteDependencies): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const code of Object.keys(options.catalogs.locales)) {
    const tag = localeTag(options, code);
    if (tag === code) continue;
    tags[code.toLowerCase()] = tag;
    tags[contentLocale(code, dependencies).toLowerCase()] = tag;
  }
  return tags;
}

// ponytail: first matching code wins when one Astro path lists several catalog codes.
function catalogLocale(options: PolystellaEmdashOptions, locale: string, dependencies: PluginRouteDependencies): string {
  if (Object.hasOwn(options.catalogs.locales, locale)) return locale;
  return Object.keys(options.catalogs.locales).find((candidate) => sameContentLocale(candidate, locale, dependencies)) ?? locale;
}
