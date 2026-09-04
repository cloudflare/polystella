export const POLYSTELLA_API_BASE = "/_emdash/api/plugins/polystella";
export const MAX_CONTENT_FIELDS = 25;
export const MAX_CATALOG_KEYS = 100;

export interface CollectionSettingsResponse {
  configured: string[];
  enabled: string[];
}

export interface CollectionPolicyResponse {
  enabled: boolean;
  sourceLocale: string | null;
  fields: string[];
}

export interface TranslateContentResponse {
  patch: Record<string, unknown>;
  batchCount: number;
}

export interface CatalogLocaleSummary {
  locale: string;
  filePath: string;
  runtimeEnabled: boolean;
}

export interface CatalogEntryView {
  key: string;
  source: string | null;
  deployed: string | null;
  override: string | null;
  state: "active" | "synced" | "missing" | null;
}

export interface CatalogViewResponse {
  defaultLocale: string;
  locale: string;
  locales: CatalogLocaleSummary[];
  entries: CatalogEntryView[];
}

export interface CatalogGenerationResponse {
  translations: Record<string, string>;
  tokenFailures: Array<{ key: string; missing: string[]; spurious: string[] }>;
}

export interface CatalogOverrideMutationResponse {
  key: string;
}

export interface CatalogRuntimeMutationResponse {
  locale: string;
  enabled: boolean;
}

export interface CatalogExportResponse {
  filePath: string;
  filename: string;
  json: string;
}

export interface RuntimeOverridesResponse {
  enabled: boolean;
  overrides: Record<string, string>;
}
