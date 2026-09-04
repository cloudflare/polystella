import type { PluginAdminConfig, PluginDescriptor, PluginStorageConfig, ResolvedPlugin } from "emdash";
import { definePlugin, RESERVED_COLLECTION_SLUGS, RESERVED_FIELD_SLUGS } from "emdash";

import packageManifest from "../package.json" with { type: "json" };
import { createPluginRoutes } from "./routes.js";

export * from "./catalog.js";

const PLUGIN_ID = "polystella";
const ENTRYPOINT = "@cloudflare/polystella-emdash";
const ADMIN_ENTRY = "@cloudflare/polystella-emdash/admin";
const version = packageManifest.version;
const EMDASH_SLUG_PATTERN = /^[a-z][a-z0-9_]*$/;
const EMDASH_LOCALE_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

const STORAGE = {
  catalog_overrides: { indexes: ["locale"] },
} satisfies PluginStorageConfig;

const ADMIN_PAGES = [
  { path: "/catalog", label: "Catalog" },
  { path: "/settings", label: "Settings" },
];

export interface EmDashCollectionPolicy {
  sourceLocale: string;
  fields: readonly string[];
}

export interface EmDashCatalogLocale {
  dictionary: Record<string, string>;
  filePath: string;
}

export interface PolystellaEmdashOptions {
  aiBinding: string;
  collections: Record<string, EmDashCollectionPolicy>;
  catalogs: {
    defaultLocale: string;
    locales: Record<string, EmDashCatalogLocale>;
  };
  models: {
    allowed: readonly string[];
    default: string;
  };
  rules?: readonly string[] | undefined;
}

interface SerializedPolystellaEmdashOptions {
  serialized: string;
}

export function validatePolystellaEmdashOptions(value: unknown): asserts value is PolystellaEmdashOptions {
  const options = readRecord(value, "options");
  const binding = readString(options.aiBinding, "options.aiBinding");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding)) fail("options.aiBinding must be a valid Workers binding name");

  const collections = readRecord(options.collections, "options.collections");
  for (const [collection, rawPolicy] of Object.entries(collections)) {
    assertEmdashSlug(collection, `options.collections.${collection}`);
    if (RESERVED_COLLECTION_SLUGS.some((reserved) => reserved === collection)) {
      fail(`options.collections.${collection} is reserved by EmDash`);
    }
    const policy = readRecord(rawPolicy, `options.collections.${collection}`);
    readLocale(policy.sourceLocale, `options.collections.${collection}.sourceLocale`);
    const fields = readStringArray(policy.fields, `options.collections.${collection}.fields`, false);
    for (const [index, field] of fields.entries()) {
      assertEmdashSlug(field, `options.collections.${collection}.fields[${index}]`);
      if (RESERVED_FIELD_SLUGS.some((reserved) => reserved === field)) {
        fail(`options.collections.${collection}.fields[${index}] is reserved by EmDash`);
      }
    }
    assertUnique(fields, `options.collections.${collection}.fields`);
  }

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
  const defaultModel = readString(models.default, "options.models.default");
  if (!allowedModels.includes(defaultModel)) fail("options.models.default must exist in options.models.allowed");

  if (options.rules !== undefined) readStringArray(options.rules, "options.rules", true);
}

export function polystellaEmdash(options: PolystellaEmdashOptions): PluginDescriptor<SerializedPolystellaEmdashOptions> {
  validatePolystellaEmdashOptions(options);
  return {
    id: PLUGIN_ID,
    version,
    format: "native",
    entrypoint: ENTRYPOINT,
    adminEntry: ADMIN_ENTRY,
    adminPages: ADMIN_PAGES,
    options: serializeOptions(options),
    capabilities: ["content:read"],
    storage: STORAGE,
    settingsSchema: createSettingsSchema(options),
  };
}

export function createPlugin(runtimeOptions: SerializedPolystellaEmdashOptions): ResolvedPlugin<typeof STORAGE> {
  const options = deserializeOptions(runtimeOptions);
  return definePlugin({
    id: PLUGIN_ID,
    version,
    capabilities: ["content:read"],
    storage: STORAGE,
    routes: createPluginRoutes(options),
    admin: { entry: ADMIN_ENTRY, pages: ADMIN_PAGES, settingsSchema: createSettingsSchema(options) },
  });
}

export default createPlugin;

function createSettingsSchema(options: PolystellaEmdashOptions): NonNullable<PluginAdminConfig["settingsSchema"]> {
  return {
    model: {
      type: "select",
      label: "Translation model",
      options: options.models.allowed.map((model) => ({ value: model, label: model })),
      default: options.models.default,
    },
    glossary: {
      type: "string",
      label: "Glossary",
      description: "Terms and preferred translations supplied to the model.",
      multiline: true,
      default: "",
    },
    instructions: {
      type: "string",
      label: "Additional instructions",
      description: "Translation guidance applied after deployment-locked rules.",
      multiline: true,
      default: "",
    },
  };
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

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) fail(`${label} cannot contain duplicates`);
}

function assertEmdashSlug(value: string, label: string): void {
  if (value.length > 63 || !EMDASH_SLUG_PATTERN.test(value)) {
    fail(`${label} must match /^[a-z][a-z0-9_]*$/ and contain at most 63 characters`);
  }
}

function serializeOptions(options: PolystellaEmdashOptions): SerializedPolystellaEmdashOptions {
  const normalized: PolystellaEmdashOptions = {
    aiBinding: options.aiBinding,
    collections: Object.fromEntries(
      Object.entries(options.collections).map(([collection, policy]) => [
        collection,
        { sourceLocale: policy.sourceLocale, fields: [...policy.fields] },
      ]),
    ),
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
    models: { allowed: [...options.models.allowed], default: options.models.default },
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
