import { resolveModelId } from "@cloudflare/polystella-core";
import { PluginRouteError, type SettingsAccess } from "emdash";

import {
  MAX_COLLECTION_POLICY_FIELDS,
  type CollectionPolicy,
  type CollectionSettingsResponse,
  type CustomizationMode,
  type TranslationSettingsResponse,
} from "../contracts.js";
import { isCustomizationMode, resolveGlossary, resolveInstructions, runtimeOverrideSettingKey } from "../settings.js";
import type { PolystellaEmdashOptions } from "./options.js";
import { targetLocales } from "./options.js";
import {
  isAllowedCollectionSlug,
  isAllowedFieldSlug,
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

export async function collectionSettings(options: PolystellaEmdashOptions, settings: SettingsAccess): Promise<CollectionSettingsResponse> {
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
      value: { fields: [...new Set(value.fields)].sort() },
      writable: true,
    });
  }
  return policies;
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
    Object.defineProperty(policies, collection, {
      configurable: true,
      enumerable: true,
      value: { fields },
      writable: true,
    });
  }
  return policies;
}

export async function translationSettingsView(
  options: PolystellaEmdashOptions,
  settings: SettingsAccess,
): Promise<TranslationSettingsResponse> {
  const versioned = await settings.getVersioned<unknown>(TRANSLATION_SETTINGS_KEY);
  const stored = parseTranslationSettings(options, versioned?.value);
  const locales = targetLocales(options).map((locale) => {
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
    defaultLocale: options.catalogs.defaultLocale,
    revision: versioned?.revision ?? null,
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

export async function saveTranslationSettings(
  options: PolystellaEmdashOptions,
  settings: SettingsAccess,
  input: Record<string, unknown>,
): Promise<void> {
  const expectedRevision = readRevision(input.revision);
  const debugEnabled = input.debugEnabled === undefined ? false : readBoolean(input.debugEnabled, "debugEnabled");
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
    const rawModel = localeSettings.model;
    const model = rawModel === null ? null : readString(rawModel, `locales.${locale}.model`);
    if (model !== null && !options.models.allowed.includes(model)) {
      throw PluginRouteError.badRequest(`locales.${locale}.model must be allowed by deployment configuration`);
    }
    const glossaryMode = readCustomizationMode(localeSettings.glossaryMode, `locales.${locale}.glossaryMode`);
    const glossaryText = readText(localeSettings.glossaryText, `locales.${locale}.glossaryText`, MAX_GLOSSARY_CHARACTERS);
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

  await compareAndSetSetting(settings, TRANSLATION_SETTINGS_KEY, expectedRevision, {
    debugEnabled,
    locales: Object.fromEntries(values.map(({ locale, ...localeSettings }) => [locale, localeSettings])),
    instructions: { mode: instructionMode, text: instructionText },
  } satisfies StoredTranslationSettings);
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
  glossaryMode: CustomizationMode;
  glossaryText: string;
}

export interface StoredTranslationSettings {
  debugEnabled: boolean;
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
