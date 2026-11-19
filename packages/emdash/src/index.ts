import type { PluginCapability, PluginDescriptor, PluginStorageConfig, ResolvedPlugin } from "emdash";
import { definePlugin } from "emdash";

import packageManifest from "../package.json" with { type: "json" };
import { AI_TRANSLATIONS_COLLECTION } from "./ai-translations.js";
import { POLYSTELLA_PLUGIN_ID } from "./contracts.js";
import { clearEditedAiTranslation } from "./server/ai-translation-hooks.js";
import { createPluginRoutes } from "./server/routes/routes.js";
import { deserializeOptions, serializeOptions, validatePolystellaEmdashOptions, type PolystellaEmdashOptions } from "./server/options.js";

export {
  applyCatalogOverrides,
  catalogOverrideId,
  catalogOverrideState,
  serializeCatalog,
  type CatalogOverride,
  type CatalogOverrideState,
} from "./catalog.js";
export {
  type EmDashCatalogLocale,
  type EmDashWorkersAIProvider,
  type PolystellaEmdashOptions,
  validatePolystellaEmdashOptions,
} from "./server/options.js";

const ENTRYPOINT = "@cloudflare/polystella-emdash";
const ADMIN_ENTRY = "@cloudflare/polystella-emdash/admin";
const version = packageManifest.version;

const STORAGE = {
  catalog_overrides: { indexes: ["locale"] },
  batch_jobs: { indexes: ["createdAt"] },
  batch_results: { indexes: ["jobId", "outcome"] },
  [AI_TRANSLATIONS_COLLECTION]: { indexes: ["locale"] },
} satisfies PluginStorageConfig;

// `content:revisions:read` lets the AI-translated flag fingerprint an unpublished draft.
const CAPABILITIES: PluginCapability[] = ["content:read", "content:revisions:read", "schema:read"];

const ADMIN_PAGES = [{ path: "/", label: "PolyStella" }];

export function polystellaEmdash(options: PolystellaEmdashOptions): PluginDescriptor<{ serialized: string }> {
  validatePolystellaEmdashOptions(options);
  return {
    id: POLYSTELLA_PLUGIN_ID,
    version,
    format: "native",
    entrypoint: ENTRYPOINT,
    adminEntry: ADMIN_ENTRY,
    adminPages: ADMIN_PAGES,
    options: serializeOptions(options),
    capabilities: CAPABILITIES,
    storage: STORAGE,
  };
}

export function createPlugin(runtimeOptions: { serialized: string }): ResolvedPlugin<typeof STORAGE> {
  const options = deserializeOptions(runtimeOptions);
  return definePlugin({
    id: POLYSTELLA_PLUGIN_ID,
    version,
    capabilities: CAPABILITIES,
    storage: STORAGE,
    routes: createPluginRoutes(options),
    admin: { entry: ADMIN_ENTRY, pages: ADMIN_PAGES },
    hooks: {
      "content:afterSave": (event, ctx) => clearEditedAiTranslation(event.content, ctx.storage[AI_TRANSLATIONS_COLLECTION], ctx.settings),
      // A restored revision skips the save hooks, so it is checked when published.
      "content:afterPublish": (event, ctx) =>
        clearEditedAiTranslation(event.content, ctx.storage[AI_TRANSLATIONS_COLLECTION], ctx.settings),
    },
  });
}

export default createPlugin;
