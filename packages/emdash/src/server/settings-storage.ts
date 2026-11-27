import { PluginRouteError, type SettingsAccess } from "emdash";

import {
  MAX_COLLECTION_POLICY_FIELDS,
  MAX_MAX_TOKENS,
  MIN_MAX_TOKENS,
  type CollectionPolicy,
  type CollectionSettingsResponse,
  type CustomizationMode,
  type TranslationLocaleSettings,
  type TranslationSettingsResponse,
} from "../contracts.js";
import { glossaryTerms, isCustomizationMode, resolveInstructions, runtimeOverrideSettingKey } from "../settings.js";
import type { GlossaryDefault, PolystellaEmdashOptions } from "./options.js";
import { codeDefaultThinking, codeFallbackModel, isReasoningEffort, targetLocales } from "./options.js";
import { MAX_TOKENS } from "./routes/provider.js";
import {
  isAllowedCollectionSlug,
  isAllowedFieldSlug,
  isAllowedSubFieldSlug,
  isRecord,
  isStringArray,
  readBoolean,
  readCustomizationMode,
  readRecord,
  readString,
  readStringArray,
  readText,
} from "./routes/validators.js";

const COLLECTION_POLICIES_KEY = "collectionPolicies";
const TRANSLATION_SETTINGS_KEY = "translation";
const MAX_COLLECTIONS = 100;
export const MAX_GLOSSARY_CHARACTERS = 10_000;
export const MAX_INSTRUCTION_CHARACTERS = 10_000;

export async function collectionSettings(
  options: PolystellaEmdashOptions,
  settings: SettingsAccess,
): Promise<Omit<CollectionSettingsResponse, "localeTags">> {
  const stored = await settings.getVersioned<unknown>(COLLECTION_POLICIES_KEY);
  return {
    defaultLocale: options.catalogs.defaultLocale,
    locales: Object.keys(options.catalogs.locales).sort(),
    policies: parseCollectionPolicies(stored?.value),
    revision: stored?.revision ?? null,
  };
}

export async function saveCollectionPolicies(
  settings: SettingsAccess,
  expectedRevision: string | null,
  policies: Record<string, CollectionPolicy>,
): Promise<void> {
  await compareAndSetSetting(settings, COLLECTION_POLICIES_KEY, expectedRevision, policies);
}

export async function collectionPolicies(settings: SettingsAccess): Promise<Record<string, CollectionPolicy>> {
  return parseCollectionPolicies(await settings.get<unknown>(COLLECTION_POLICIES_KEY));
}

function parseCollectionPolicies(stored: unknown): Record<string, CollectionPolicy> {
  if (!isRecord(stored)) return {};
  const policies: Record<string, CollectionPolicy> = {};
  for (const [collection, value] of Object.entries(stored)) {
    if (
      !isAllowedCollectionSlug(collection) ||
      !isRecord(value) ||
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
      value: withSubFields([...new Set(value.fields)].sort(), storedSubFields(value.subFields)),
      writable: true,
    });
  }
  return policies;
}

function storedSubFields(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([field, subFields]) =>
      isAllowedFieldSlug(field) && isStringArray(subFields) && subFields.length > 0 && subFields.every(isAllowedSubFieldSlug)
        ? [[field, [...new Set(subFields)].sort()]]
        : [],
    ),
  );
}

/** Keeps only subfield lists for listed fields, and omits `subFields` when none remain. */
function withSubFields(fields: string[], subFields: Record<string, string[]>): CollectionPolicy {
  const kept = Object.entries(subFields).filter(([field]) => fields.includes(field));
  return kept.length === 0 ? { fields } : { fields, subFields: Object.fromEntries(kept) };
}

export function readCollectionPolicies(value: unknown): Record<string, CollectionPolicy> {
  const input = readRecord(value, "policies");
  if (Object.keys(input).length > MAX_COLLECTIONS) {
    throw PluginRouteError.badRequest(`policies cannot contain more than ${MAX_COLLECTIONS} collections`);
  }

  const policies: Record<string, CollectionPolicy> = {};
  for (const [collection, rawPolicy] of Object.entries(input).sort(([left], [right]) => left.localeCompare(right))) {
    if (!isAllowedCollectionSlug(collection))
      throw PluginRouteError.badRequest(`collection ${JSON.stringify(collection)} is not supported`);
    const policy = readRecord(rawPolicy, `policies.${collection}`);
    if (Object.hasOwn(policy, "sourceLocale")) {
      throw PluginRouteError.badRequest(`policies.${collection}.sourceLocale is controlled by deployment configuration`);
    }
    const fields = [...new Set(readStringArray(policy.fields, `policies.${collection}.fields`, false))].sort();
    if (fields.length > MAX_COLLECTION_POLICY_FIELDS) {
      throw PluginRouteError.badRequest(`policies.${collection}.fields cannot contain more than ${MAX_COLLECTION_POLICY_FIELDS} values`);
    }
    const unsupportedField = fields.find((field) => !isAllowedFieldSlug(field));
    if (unsupportedField !== undefined) {
      throw PluginRouteError.badRequest(`field ${JSON.stringify(unsupportedField)} is not supported`);
    }
    const subFields: Record<string, string[]> = {};
    if (policy.subFields !== undefined) {
      for (const [field, value] of Object.entries(readRecord(policy.subFields, `policies.${collection}.subFields`))) {
        const label = `policies.${collection}.subFields.${field}`;
        if (!fields.includes(field)) throw PluginRouteError.badRequest(`${label} needs ${JSON.stringify(field)} in fields`);
        const slugs = [...new Set(readStringArray(value, label, false))].sort();
        if (slugs.length > MAX_COLLECTION_POLICY_FIELDS) {
          throw PluginRouteError.badRequest(`${label} cannot contain more than ${MAX_COLLECTION_POLICY_FIELDS} values`);
        }
        const unsupported = slugs.find((slug) => !isAllowedSubFieldSlug(slug));
        if (unsupported !== undefined) throw PluginRouteError.badRequest(`subfield ${JSON.stringify(unsupported)} is not supported`);
        Object.defineProperty(subFields, field, { configurable: true, enumerable: true, value: slugs, writable: true });
      }
    }
    Object.defineProperty(policies, collection, {
      configurable: true,
      enumerable: true,
      value: withSubFields(fields, subFields),
      writable: true,
    });
  }
  return policies;
}

export async function translationSettingsView(
  options: PolystellaEmdashOptions,
  settings: SettingsAccess,
  /** The one locale whose glossary file text to include; the text is large, so it is sent only on request. */
  glossarySourceLocale: string | null = null,
): Promise<Omit<TranslationSettingsResponse, "localeTags">> {
  const versioned = await settings.getVersioned<unknown>(TRANSLATION_SETTINGS_KEY);
  const stored = parseTranslationSettings(options, versioned?.value);
  const locales = targetLocales(options).map((locale) => {
    const settings = stored.locales[locale];
    if (settings === undefined) throw PluginRouteError.internal(`translation settings for ${locale} are unavailable`);
    return {
      locale,
      defaultModel: codeFallbackModel(options, locale),
      model: settings.model,
      reasoning: settings.reasoning,
      defaultReasoning: codeDefaultThinking(options, locale),
      ...codeGlossaryView(options.glossaryDefaults?.[locale], locale === glossarySourceLocale),
      glossaryMode: settings.glossaryMode,
      glossaryText: settings.glossaryText,
    };
  });
  return {
    defaultLocale: options.catalogs.defaultLocale,
    revision: versioned?.revision ?? null,
    debugEnabled: stored.debugEnabled,
    maxTokens: stored.maxTokens,
    defaultMaxTokens: defaultMaxTokens(options),
    clearAiFlagOnEdit: stored.clearAiFlagOnEdit,
    translateSeoWhenPublished: stored.translateSeoWhenPublished,
    model: stored.model,
    reasoning: stored.reasoning,
    defaultModel: codeFallbackModel(options, "default"),
    allowedModels: [...options.models.allowed],
    locales,
    instructions: {
      defaultText: (options.rules ?? []).join("\n"),
      mode: stored.instructions.mode,
      text: stored.instructions.text,
    },
  };
}

/** The code glossary as the admin shows it: parsed terms and, when asked, the YAML as written or, without one, the terms as JSON. */
export function codeGlossaryView(
  glossary: GlossaryDefault | undefined,
  includeSource = true,
): Pick<TranslationLocaleSettings, "defaultGlossary" | "defaultGlossarySource"> {
  if (glossary === undefined) return { defaultGlossary: null, defaultGlossarySource: null };
  const terms = glossaryTerms(glossary);
  if (!includeSource) return { defaultGlossary: terms, defaultGlossarySource: null };
  return {
    defaultGlossary: terms,
    defaultGlossarySource:
      glossary.source === undefined ? { format: "json", text: JSON.stringify(terms, null, 2) } : { format: "yaml", text: glossary.source },
  };
}

export async function saveTranslationSettings(
  options: PolystellaEmdashOptions,
  settings: SettingsAccess,
  input: Record<string, unknown>,
  /** Throws when `model` doesn't accept `effort`. */
  validateReasoning: (model: string, effort: string, label: string) => Promise<void>,
): Promise<void> {
  const expectedRevision = readRevision(input.revision);
  const debugEnabled = input.debugEnabled === undefined ? false : readBoolean(input.debugEnabled, "debugEnabled");
  const clearAiFlagOnEdit = input.clearAiFlagOnEdit === undefined ? false : readBoolean(input.clearAiFlagOnEdit, "clearAiFlagOnEdit");
  const translateSeoWhenPublished =
    input.translateSeoWhenPublished === undefined ? false : readBoolean(input.translateSeoWhenPublished, "translateSeoWhenPublished");
  const maxTokens = input.maxTokens === undefined || input.maxTokens === null ? null : input.maxTokens;
  if (maxTokens !== null && !isMaxTokens(maxTokens)) {
    throw PluginRouteError.badRequest(`maxTokens must be null or an integer from ${MIN_MAX_TOKENS} to ${MAX_MAX_TOKENS}`);
  }
  const globalModel = readModelChoice(options, input.model, input.reasoning, "");
  const localeInput = readRecord(input.locales, "locales");
  const configuredLocales = targetLocales(options);
  if (
    Object.keys(localeInput).length !== configuredLocales.length ||
    configuredLocales.some((locale) => !Object.hasOwn(localeInput, locale))
  ) {
    throw PluginRouteError.badRequest("locales must contain every configured target locale");
  }

  const values = configuredLocales.map((locale) => {
    const localeSettings = readRecord(localeInput[locale], `locales.${locale}`);
    if (localeSettings.model === undefined) throw PluginRouteError.badRequest(`locales.${locale}.model must be a string or null`);
    const { model, reasoning } = readModelChoice(options, localeSettings.model, localeSettings.reasoning, `locales.${locale}.`);
    const glossaryMode = readCustomizationMode(localeSettings.glossaryMode, `locales.${locale}.glossaryMode`);
    // Only the typed text is capped: code-defined defaults are trusted, and prompts carry only the terms a batch uses.
    const glossaryText = readText(localeSettings.glossaryText, `locales.${locale}.glossaryText`, MAX_GLOSSARY_CHARACTERS);
    return { locale, model, reasoning, glossaryMode, glossaryText };
  });

  // Only new choices are checked, so a catalog outage or a retired effort doesn't block unrelated edits.
  const previous = await storedTranslationSettings(options, settings);
  const choices = [
    { label: "reasoning", next: globalModel, before: previous },
    ...values.map((next) => ({ label: `locales.${next.locale}.reasoning`, next, before: previous.locales[next.locale] })),
  ];
  for (const { label, next, before } of choices) {
    const unchanged = before?.model === next.model && before?.reasoning === next.reasoning;
    if (next.model !== null && next.reasoning !== null && !unchanged) await validateReasoning(next.model, next.reasoning, label);
  }

  const instructionInput = readRecord(input.instructions, "instructions");
  const instructionMode = readCustomizationMode(instructionInput.mode, "instructions.mode");
  const instructionText = readText(instructionInput.text, "instructions.text", MAX_INSTRUCTION_CHARACTERS);
  if (resolveInstructions(options.rules ?? [], instructionMode, instructionText.trim()).length > MAX_INSTRUCTION_CHARACTERS) {
    throw PluginRouteError.badRequest(`effective translation instructions cannot exceed ${MAX_INSTRUCTION_CHARACTERS} characters`);
  }

  await compareAndSetSetting(settings, TRANSLATION_SETTINGS_KEY, expectedRevision, {
    debugEnabled,
    maxTokens,
    clearAiFlagOnEdit,
    translateSeoWhenPublished,
    model: globalModel.model,
    reasoning: globalModel.reasoning,
    locales: Object.fromEntries(values.map(({ locale, ...localeSettings }) => [locale, localeSettings])),
    instructions: { mode: instructionMode, text: instructionText },
  } satisfies StoredTranslationSettings);
}

/** An allowed model or `null`, and a thinking effort that only goes with a model. `prefix` names the fields in errors. */
function readModelChoice(
  options: PolystellaEmdashOptions,
  rawModel: unknown,
  rawReasoning: unknown,
  prefix: string,
): { model: string | null; reasoning: string | null } {
  const model = rawModel === undefined || rawModel === null ? null : readString(rawModel, `${prefix}model`);
  if (model !== null && !options.models.allowed.includes(model)) {
    throw PluginRouteError.badRequest(`${prefix}model must be allowed by deployment configuration`);
  }
  const reasoning =
    model === null || rawReasoning === undefined || rawReasoning === null ? null : readString(rawReasoning, `${prefix}reasoning`);
  if (reasoning !== null && !isReasoningEffort(reasoning)) throw PluginRouteError.badRequest(`${prefix}reasoning is invalid`);
  return { model, reasoning };
}

/** Revisions are opaque host tokens; `null` means "I saw no stored value". */
export function readRevision(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw PluginRouteError.badRequest("revision must be null or a non-empty string of at most 128 characters");
  }
  return value;
}

async function compareAndSetSetting(settings: SettingsAccess, key: string, expectedRevision: string | null, value: unknown): Promise<void> {
  const result = await settings.compareAndSet(key, expectedRevision, value);
  if (!result.applied) {
    throw PluginRouteError.conflict("Settings changed since you loaded them. Reload and apply your changes again.");
  }
}

export interface StoredLocaleSettings {
  model: string | null;
  /** Thinking effort for the overridden `model`; `null` uses the model's default. Always `null` without a model override. */
  reasoning: string | null;
  glossaryMode: CustomizationMode;
  glossaryText: string;
}

export interface StoredTranslationSettings {
  debugEnabled: boolean;
  maxTokens: number | null;
  /** Remove the AI-translated flag as soon as an AI-written field is saved with other text. */
  clearAiFlagOnEdit: boolean;
  /** EmDash saves a patched SEO title or description at once, so on a published entry it goes live before review. */
  translateSeoWhenPublished: boolean;
  /** The administrator's default model for every locale without its own; `null` uses the code fallback. */
  model: string | null;
  /** Thinking effort for `model`; always `null` without one. */
  reasoning: string | null;
  locales: Record<string, StoredLocaleSettings>;
  instructions: { mode: CustomizationMode; text: string };
}

export async function storedTranslationSettings(
  options: PolystellaEmdashOptions,
  settings: SettingsAccess,
): Promise<StoredTranslationSettings> {
  return parseTranslationSettings(options, await settings.get<unknown>(TRANSLATION_SETTINGS_KEY));
}

function parseTranslationSettings(options: PolystellaEmdashOptions, stored: unknown): StoredTranslationSettings {
  const storedRoot = isRecord(stored) ? stored : {};
  const storedLocales = isRecord(storedRoot.locales) ? storedRoot.locales : {};
  const storedInstructions = isRecord(storedRoot.instructions) ? storedRoot.instructions : {};
  const locales = Object.fromEntries(
    targetLocales(options).map((locale) => {
      const localeSettings = isRecord(storedLocales[locale]) ? storedLocales[locale] : {};
      const storedMode = localeSettings.glossaryMode;
      const storedText = localeSettings.glossaryText;
      return [
        locale,
        {
          ...parseModelChoice(options, localeSettings),
          glossaryMode: isCustomizationMode(storedMode) ? storedMode : "default",
          glossaryText: typeof storedText === "string" ? storedText : "",
        },
      ];
    }),
  );
  const instructionText = typeof storedInstructions.text === "string" ? storedInstructions.text : "";
  return {
    debugEnabled: storedRoot.debugEnabled === true,
    maxTokens: isMaxTokens(storedRoot.maxTokens) ? storedRoot.maxTokens : null,
    clearAiFlagOnEdit: storedRoot.clearAiFlagOnEdit === true,
    translateSeoWhenPublished: storedRoot.translateSeoWhenPublished === true,
    ...parseModelChoice(options, storedRoot),
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

/** A model the deployment no longer allows is dropped, with its thinking. */
function parseModelChoice(
  options: PolystellaEmdashOptions,
  stored: Record<string, unknown>,
): { model: string | null; reasoning: string | null } {
  const { model, reasoning } = stored;
  if (typeof model !== "string" || !options.models.allowed.includes(model)) return { model: null, reasoning: null };
  return { model, reasoning: typeof reasoning === "string" ? reasoning : null };
}

/** The model and admin thinking choice a locale translates with: its own override, the admin default, then the code fallback. */
export function effectiveModelChoice(
  options: PolystellaEmdashOptions,
  stored: StoredTranslationSettings,
  locale: string,
): { model: string; reasoning: string | null } {
  const own = stored.locales[locale];
  if (own !== undefined && own.model !== null) return { model: own.model, reasoning: own.reasoning };
  if (stored.model !== null) return { model: stored.model, reasoning: stored.reasoning };
  return { model: codeFallbackModel(options, locale), reasoning: null };
}

/** For save hooks, which only need this one setting. */
export async function aiFlagClearsOnEdit(settings: SettingsAccess): Promise<boolean> {
  const stored = await settings.get<unknown>(TRANSLATION_SETTINGS_KEY);
  return isRecord(stored) && stored.clearAiFlagOnEdit === true;
}

export function defaultMaxTokens(options: PolystellaEmdashOptions): number {
  return options.provider.maxTokens ?? MAX_TOKENS;
}

export function isMaxTokens(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_MAX_TOKENS && value <= MAX_MAX_TOKENS;
}

export async function runtimeLocales(options: PolystellaEmdashOptions, settings: SettingsAccess): Promise<string[]> {
  const configured = targetLocales(options);
  const states = await Promise.all(configured.map(async (locale) => ({ locale, enabled: await runtimeLocaleEnabled(settings, locale) })));
  return states
    .filter(({ enabled }) => enabled)
    .map(({ locale }) => locale)
    .sort();
}

export async function runtimeLocaleEnabled(settings: SettingsAccess, locale: string): Promise<boolean> {
  return (await settings.get<unknown>(runtimeOverrideSettingKey(locale))) === true;
}
