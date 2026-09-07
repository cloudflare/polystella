import { resolveModelId, type Glossary, type ModelSpec } from "@cloudflare/polystella-core";
import type { PluginDescriptor, PluginStorageConfig, ResolvedPlugin } from "emdash";
import { definePlugin } from "emdash";

import packageManifest from "../package.json" with { type: "json" };
import { POLYSTELLA_PLUGIN_ID, USE_CODE_DEFAULT_MODEL } from "./contracts.js";
import { createPluginRoutes } from "./routes.js";

export * from "./catalog.js";

const ENTRYPOINT = "@cloudflare/polystella-emdash";
const ADMIN_ENTRY = "@cloudflare/polystella-emdash/admin";
const version = packageManifest.version;
const EMDASH_LOCALE_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

const STORAGE = {
  catalog_overrides: { indexes: ["locale"] },
} satisfies PluginStorageConfig;

const ADMIN_PAGES = [{ path: "/", label: "PolyStella" }];

export interface EmDashCatalogLocale {
  dictionary: Record<string, string>;
  filePath: string;
}

export type EmDashWorkersAIProvider =
  | {
      kind: "workers-ai-binding";
      binding: string;
      maxTokens?: number | undefined;
    }
  | {
      kind: "workers-ai-http";
      accountIdEnv: string;
      apiTokenEnv: string;
      endpoint?: string | undefined;
      maxTokens?: number | undefined;
    };

export interface PolystellaEmdashOptions {
  provider: EmDashWorkersAIProvider;
  catalogs: {
    defaultLocale: string;
    locales: Record<string, EmDashCatalogLocale>;
  };
  models: {
    allowed: readonly string[];
    defaults: ModelSpec;
  };
  glossaryDefaults?: Readonly<Record<string, Glossary>> | undefined;
  rules?: readonly string[] | undefined;
}

interface SerializedPolystellaEmdashOptions {
  serialized: string;
}

export function validatePolystellaEmdashOptions(value: unknown): asserts value is PolystellaEmdashOptions {
  const options = readRecord(value, "options");
  rejectUnknownKeys(options, ["provider", "catalogs", "models", "glossaryDefaults", "rules"], "options");
  validateProvider(options.provider);

  const catalogs = readRecord(options.catalogs, "options.catalogs");
  const defaultLocale = readLocale(catalogs.defaultLocale, "options.catalogs.defaultLocale");
  const locales = readRecord(catalogs.locales, "options.catalogs.locales");
  if (!Object.hasOwn(locales, defaultLocale)) fail("options.catalogs.defaultLocale must exist in options.catalogs.locales");
  if (Object.keys(locales).length === 0) fail("options.catalogs.locales must contain at least one locale");
  for (const [locale, rawCatalog] of Object.entries(locales)) {
    readLocale(locale, `options.catalogs.locales.${locale}`);
    const catalog = readRecord(rawCatalog, `options.catalogs.locales.${locale}`);
    const dictionary = readRecord(catalog.dictionary, `options.catalogs.locales.${locale}.dictionary`);
    for (const [key, text] of Object.entries(dictionary)) {
      if (typeof text !== "string") fail(`options.catalogs.locales.${locale}.dictionary.${key} must be a string`);
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
  const defaultModels = readModelSpec(models.defaults, "options.models.defaults");
  const configuredLocales = new Set(Object.keys(locales));
  for (const [locale, model] of modelSpecEntries(defaultModels)) {
    if (locale !== "default" && !configuredLocales.has(locale)) {
      fail(`options.models.defaults.${locale} must match a configured catalog locale`);
    }
    if (!allowedModels.includes(model)) fail(`options.models.defaults.${locale} must exist in options.models.allowed`);
  }

  if (options.glossaryDefaults !== undefined) {
    const defaults = readRecord(options.glossaryDefaults, "options.glossaryDefaults");
    for (const [locale, glossary] of Object.entries(defaults)) {
      if (!configuredLocales.has(locale)) fail(`options.glossaryDefaults.${locale} must match a configured catalog locale`);
      validateGlossary(glossary, `options.glossaryDefaults.${locale}`);
    }
  }

  if (options.rules !== undefined) readStringArray(options.rules, "options.rules", true);
}

export function polystellaEmdash(options: PolystellaEmdashOptions): PluginDescriptor<SerializedPolystellaEmdashOptions> {
  validatePolystellaEmdashOptions(options);
  return {
    id: POLYSTELLA_PLUGIN_ID,
    version,
    format: "native",
    entrypoint: ENTRYPOINT,
    adminEntry: ADMIN_ENTRY,
    adminPages: ADMIN_PAGES,
    options: serializeOptions(options),
    capabilities: ["content:read"],
    storage: STORAGE,
  };
}

export function createPlugin(runtimeOptions: SerializedPolystellaEmdashOptions): ResolvedPlugin<typeof STORAGE> {
  const options = deserializeOptions(runtimeOptions);
  return definePlugin({
    id: POLYSTELLA_PLUGIN_ID,
    version,
    capabilities: ["content:read"],
    storage: STORAGE,
    routes: createPluginRoutes(options),
    admin: { entry: ADMIN_ENTRY, pages: ADMIN_PAGES },
  });
}

export default createPlugin;

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

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) fail(`${label} cannot contain duplicates`);
}

function validateProvider(value: unknown): void {
  const provider = readRecord(value, "options.provider");
  const maxTokens = provider.maxTokens;
  if (maxTokens !== undefined && (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens <= 0)) {
    fail("options.provider.maxTokens must be a positive integer");
  }
  if (provider.kind === "workers-ai-binding") {
    rejectUnknownKeys(provider, ["kind", "binding", "maxTokens"], "options.provider");
    readEnvironmentName(provider.binding, "options.provider.binding");
    return;
  }
  if (provider.kind === "workers-ai-http") {
    rejectUnknownKeys(provider, ["kind", "accountIdEnv", "apiTokenEnv", "maxTokens", "endpoint"], "options.provider");
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

function readModelSpec(value: unknown, label: string): ModelSpec {
  if (typeof value === "string") return readString(value, label);
  const models = readRecord(value, label);
  readString(models.default, `${label}.default`);
  for (const [locale, model] of Object.entries(models)) {
    if (locale !== "default") readLocale(locale, `${label} key`);
    readString(model, `${label}.${locale}`);
  }
  return models as { default: string } & Record<string, string>;
}

function modelSpecEntries(models: ModelSpec): Array<[string, string]> {
  return typeof models === "string" ? [["default", models]] : Object.entries(models);
}

function validateGlossary(value: unknown, label: string): void {
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
}

function readStringValue(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`${label} must be a string`);
  return value;
}

function serializeOptions(options: PolystellaEmdashOptions): SerializedPolystellaEmdashOptions {
  const normalized: PolystellaEmdashOptions = {
    provider:
      options.provider.kind === "workers-ai-binding"
        ? {
            kind: "workers-ai-binding",
            binding: options.provider.binding,
            ...(options.provider.maxTokens === undefined ? {} : { maxTokens: options.provider.maxTokens }),
          }
        : {
            kind: "workers-ai-http",
            accountIdEnv: options.provider.accountIdEnv,
            apiTokenEnv: options.provider.apiTokenEnv,
            ...(options.provider.maxTokens === undefined ? {} : { maxTokens: options.provider.maxTokens }),
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
      defaults: typeof options.models.defaults === "string" ? options.models.defaults : { ...options.models.defaults },
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
              },
            ]),
          ),
        }),
    ...(options.rules === undefined ? {} : { rules: [...options.rules] }),
  };
  return { serialized: JSON.stringify(normalized) };
}

function deserializeOptions(runtimeOptions: unknown): PolystellaEmdashOptions {
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

function fail(message: string): never {
  throw new Error(`[polystella-emdash] ${message}`);
}
