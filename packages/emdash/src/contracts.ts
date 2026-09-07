export const POLYSTELLA_PLUGIN_ID = "polystella";
export const POLYSTELLA_API_BASE = "/_emdash/api/plugins/polystella";
export const MAX_CONTENT_FIELDS = 25;
export const MAX_CATALOG_KEYS = 100;
export const MAX_COLLECTION_POLICY_FIELDS = 100;
export const USE_CODE_DEFAULT_MODEL = "__polystella_code_default__";

export type CustomizationMode = "default" | "append" | "replace";

export interface CollectionPolicy {
  sourceLocale: string;
  fields: string[];
}

export interface CollectionSettingsResponse {
  defaultLocale: string;
  locales: string[];
  policies: Record<string, CollectionPolicy>;
}

export interface CollectionPolicyResponse {
  enabled: boolean;
  sourceLocale: string | null;
  fields: string[];
}

export interface TranslationLocaleSettings {
  locale: string;
  defaultModel: string;
  model: string | null;
  defaultGlossary: string;
  glossaryMode: CustomizationMode;
  glossaryText: string;
}

export interface TranslationSettingsResponse {
  debugEnabled: boolean;
  allowedModels: string[];
  locales: TranslationLocaleSettings[];
  instructions: {
    defaultText: string;
    mode: CustomizationMode;
    text: string;
  };
}

export interface TranslationDebugAttempt {
  attempt: number;
  durationMs: number;
  systemPrompt: string;
  userPrompt: string;
  response: string | null;
  translations: Record<string, string> | null;
  error: string | null;
}

export interface TranslationDebugBatch {
  batch: number;
  segmentCount: number;
  segmentIds: string[];
  segmentLabels: string[];
  sourceCharacters: number;
  estimatedInputTokens: number;
  attempts: TranslationDebugAttempt[];
}

export interface TranslationDebugTrace {
  id: string;
  operation: "content" | "catalog";
  provider: "workers-ai-binding" | "workers-ai-http";
  model: string;
  maxOutputTokens: number;
  inputTokenBudget: number;
  maxSegmentsPerBatch: number | null;
  sourceLocale: string;
  targetLocale: string;
  batchCount: number;
  providerCallCount: number;
  durationMs: number;
  error: string | null;
  validationIssues: string[];
  batches: TranslationDebugBatch[];
}

export type TranslateContentResponse =
  | { patch: Record<string, unknown>; batchCount: number; debug?: TranslationDebugTrace | undefined }
  | { patch: null; batchCount: number; error: string; debug: TranslationDebugTrace };

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

export type CatalogGenerationResponse =
  | {
      translations: Record<string, string>;
      tokenFailures: Array<{ key: string; missing: string[]; spurious: string[] }>;
      debug?: TranslationDebugTrace | undefined;
    }
  | { translations: null; tokenFailures: []; error: string; debug: TranslationDebugTrace };

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
