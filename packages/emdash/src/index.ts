import type { PluginDescriptor, PluginStorageConfig, ResolvedPlugin } from "emdash";
import { definePlugin } from "emdash";

import packageManifest from "../package.json" with { type: "json" };
import { POLYSTELLA_PLUGIN_ID } from "./contracts.js";
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
} satisfies PluginStorageConfig;

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
    capabilities: ["content:read"],
    storage: STORAGE,
  };
}

export function createPlugin(runtimeOptions: { serialized: string }): ResolvedPlugin<typeof STORAGE> {
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
