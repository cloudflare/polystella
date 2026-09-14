import { resolveModelId } from "@cloudflare/polystella-core";
import { PluginRouteError, type KVAccess } from "emdash";

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

const COLLECTION_POLICIES_KEY = "settings:collectionPolicies";
const TRANSLATION_SETTINGS_KEY = "settings:translation";
const MAX_COLLECTIONS = 100;
export const MAX_GLOSSARY_CHARACTERS = 10_000;
export const MAX_INSTRUCTION_CHARACTERS = 10_000;

export async function collectionSettings(options: PolystellaEmdashOptions, kv: KVAccess): Promise<CollectionSettingsResponse> {
  return {
    defaultLocale: options.catalogs.defaultLocale,
    locales: Object.keys(options.catalogs.locales).sort(),
    policies: await collectionPolicies(kv),
  };
}

export async function saveCollectionPolicies(kv: KVAccess, policies: Record<string, CollectionPolicy>): Promise<void> {
  await kv.set(COLLECTION_POLICIES_KEY, policies);
}

export async function collectionPolicies(kv: KVAccess): Promise<Record<string, CollectionPolicy>> {
  const stored = await kv.get<unknown>(COLLECTION_POLICIES_KEY);
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

export async function translationSettingsView(options: PolystellaEmdashOptions, kv: KVAccess): Promise<TranslationSettingsResponse> {
  const stored = await storedTranslationSettings(options, kv);
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
  kv: KVAccess,
  input: Record<string, unknown>,
): Promise<void> {
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

export async function storedTranslationSettings(options: PolystellaEmdashOptions, kv: KVAccess): Promise<StoredTranslationSettings> {
  const stored = await kv.get<unknown>(TRANSLATION_SETTINGS_KEY);
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

export async function runtimeLocales(options: PolystellaEmdashOptions, kv: KVAccess): Promise<string[]> {
  const configured = targetLocales(options);
  const states = await Promise.all(configured.map(async (locale) => ({ locale, enabled: await runtimeLocaleEnabled(kv, locale) })));
  return states
    .filter(({ enabled }) => enabled)
    .map(({ locale }) => locale)
    .sort();
}

export async function runtimeLocaleEnabled(kv: KVAccess, locale: string): Promise<boolean> {
  return (await kv.get<unknown>(runtimeLocaleKey(locale))) === true;
}

export function runtimeLocaleKey(locale: string): string {
  return `settings:${runtimeOverrideSettingKey(locale)}`;
}
