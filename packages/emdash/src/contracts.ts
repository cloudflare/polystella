import type { Glossary, TokenUsage } from "@cloudflare/polystella-core";

export const POLYSTELLA_PLUGIN_ID = "polystella";
export const POLYSTELLA_API_BASE = "/_emdash/api/plugins/polystella";
export const MAX_CONTENT_FIELDS = 25;
export const MAX_CATALOG_KEYS = 100;
export const MAX_COLLECTION_POLICY_FIELDS = 100;
export const MAX_SANDBOX_CHARACTERS = 30_000;
export const USE_CODE_DEFAULT_MODEL = "__polystella_code_default__";
export const MIN_MAX_TOKENS = 256;
export const MAX_MAX_TOKENS = 131_072;

export type CustomizationMode = "default" | "append" | "replace";

export interface CollectionPolicy {
  fields: string[];
  /** Repeater field slug → the subfields PolyStella translates. Other subfields are copied from the source row. */
  subFields?: Record<string, string[]> | undefined;
}

/** For responses the admin names locales from: lowercased catalog code or content locale → the BCP 47 tag `localeTags` maps it to. */
export interface WithLocaleTags {
  localeTags: Record<string, string>;
}

export interface CollectionSettingsResponse extends WithLocaleTags {
  defaultLocale: string;
  locales: string[];
  policies: Record<string, CollectionPolicy>;
  /** Host revision of the stored policies; send it back on PUT. `null` when nothing is stored. */
  revision: string | null;
}

export interface CollectionPolicyResponse extends WithLocaleTags {
  enabled: boolean;
  sourceLocale: string | null;
  /** `locale` is how EmDash stores new content (Astro path); older rows may use the catalog `code`. */
  targetLocales: Array<{ locale: string; code: string }>;
  fields: string[];
  subFields: Record<string, string[]>;
  /** Whether the panel may translate `seo.title` and `seo.description` on a published entry. */
  translateSeoWhenPublished: boolean;
}

/** EmDash editor-draft keys for an entry's SEO text. Not collection fields, so not part of a collection policy. */
export const SEO_FIELDS = ["seo.title", "seo.description"] as const;
export type SeoField = (typeof SEO_FIELDS)[number];

export function isSeoField(field: string): field is SeoField {
  return (SEO_FIELDS as readonly string[]).includes(field);
}

export interface TranslationLocaleSettings {
  locale: string;
  /** The code fallback for this locale, used when neither it nor the settings pick a model. */
  defaultModel: string;
  model: string | null;
  /** Thinking effort for the overridden model; `null` uses the model's default. */
  reasoning: string | null;
  /** Thinking the code sets for `defaultModel`, from `models.defaults` / `models.params`; `null` when unset. */
  defaultReasoning: string | null;
  /** The code-defined glossary; `null` when the code sets none for this locale. */
  defaultGlossary: Glossary | null;
  /** The code glossary's text: its YAML file as written, else the parsed glossary as JSON. */
  defaultGlossarySource: { format: "yaml" | "json"; text: string } | null;
  glossaryMode: CustomizationMode;
  glossaryText: string;
}

export interface ModelReasoningResponse {
  /** Efforts the model accepts (`"none"` turns thinking off); `null` when it has no switch. */
  efforts: string[] | null;
  /** Set when the Workers AI catalog couldn't be read. */
  error?: string | undefined;
}

export interface AiTranslationStatus {
  aiTranslated: boolean;
  aiTranslatedAt: string | null;
  model: string | null;
  /** AI-written fields changed since the flag was set or last kept; `null` when that can't be checked. */
  editedFields: string[] | null;
}

export interface TranslationSettingsResponse extends WithLocaleTags {
  defaultLocale: string;
  /** Host revision of the stored settings; send it back on PUT. `null` when nothing is stored. */
  revision: string | null;
  debugEnabled: boolean;
  /** Administrator override for the model's output token limit; `null` uses `defaultMaxTokens`. */
  maxTokens: number | null;
  /** From deployment configuration (`provider.maxTokens`) or PolyStella's built-in default. */
  defaultMaxTokens: number;
  /** Off by default: edited AI text keeps its flag until an editor keeps or removes it in the panel. */
  clearAiFlagOnEdit: boolean;
  /** Off by default: SEO text is translated only on entries that aren't published. */
  translateSeoWhenPublished: boolean;
  /** The administrator's default model for every language without its own; `null` uses `defaultModel`. */
  model: string | null;
  /** Thinking effort for `model`; `null` uses the model's default. */
  reasoning: string | null;
  /** The code fallback: `models.defaults`, else the first allowed model. */
  defaultModel: string;
  allowedModels: string[];
  locales: TranslationLocaleSettings[];
  instructions: {
    defaultText: string;
    mode: CustomizationMode;
    text: string;
  };
}

/** Token counts summed over one translation's model calls, retries included. */
export interface TranslationUsage extends TokenUsage {
  /** List-price estimate in USD, not an invoice; absent when the model's price is unknown or no call reported tokens. */
  estimatedCostUsd?: number | undefined;
}

/** `total` plus `usage`. The cost stays unknown once either side used tokens without a price. */
export function addTranslationUsage(
  total: TranslationUsage | undefined,
  usage: TranslationUsage | undefined,
): TranslationUsage | undefined {
  if (usage === undefined) return total;
  if (total === undefined) return usage;
  const unpriced = (value: TranslationUsage) => value.calls > value.unreportedCalls && value.estimatedCostUsd === undefined;
  const costs = [total.estimatedCostUsd, usage.estimatedCostUsd].filter((cost) => cost !== undefined);
  return {
    calls: total.calls + usage.calls,
    inputTokens: total.inputTokens + usage.inputTokens,
    cachedInputTokens: total.cachedInputTokens + usage.cachedInputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    reasoningTokens: total.reasoningTokens + usage.reasoningTokens,
    unreportedCalls: total.unreportedCalls + usage.unreportedCalls,
    ...(unpriced(total) || unpriced(usage) || costs.length === 0 ? {} : { estimatedCostUsd: costs.reduce((sum, cost) => sum + cost, 0) }),
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
  /** What Workers AI reported about the reply. Absent when it reported nothing, or in traces saved before it existed. */
  providerResponse?:
    | {
        finishReason?: string | undefined;
        reasoningCharacters?: number | undefined;
        inputTokens?: number | undefined;
        cachedInputTokens?: number | undefined;
        outputTokens?: number | undefined;
        reasoningTokens?: number | undefined;
      }
    | undefined;
  /** List-price estimate in USD for this call; absent when its tokens or the model's price are unknown. */
  estimatedCostUsd?: number | undefined;
}

export interface TranslationDebugBatch {
  batch: number;
  segmentCount: number;
  segmentIds: string[];
  segmentLabels: string[];
  sourceCharacters: number;
  estimatedInputTokens: number;
  /** Glossary terms the prompt carried, out of the locale's whole glossary. Absent in traces saved before it existed. */
  glossaryTerms?: { sent: number; total: number } | undefined;
  attempts: TranslationDebugAttempt[];
}

export interface TranslationDebugTrace {
  id: string;
  operation: "content" | "catalog" | "sandbox";
  provider: "workers-ai-binding" | "workers-ai-http";
  model: string;
  /** Extra Workers AI input sent with every request, such as thinking settings; `messages` and `max_tokens` aren't shown. */
  requestInput: Record<string, unknown> | null;
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
  | {
      patch: Record<string, unknown>;
      batchCount: number;
      /** Something else an editor should check by hand, such as same-page links. */
      notice?: string | undefined;
      /** Custom block types copied untranslated because `blockFields` doesn't list them; never empty. */
      unlistedBlockTypes?: string[] | undefined;
      debug?: TranslationDebugTrace | undefined;
      /** This request's model calls only; a long entry's parts each report their own. */
      usage?: TranslationUsage | undefined;
    }
  | { patch: null; batchCount: number; error: string; debug: TranslationDebugTrace }
  | {
      patch: null;
      batchCount: number;
      next: TranslateContentNextPart;
      debug?: TranslationDebugTrace | undefined;
      usage?: TranslationUsage | undefined;
    };

/** A long entry is translated one part per request: send this back, with the same fields, to translate the next part. */
export interface TranslateContentNextPart {
  part: number;
  partCount: number;
  fingerprint: string;
  translations: Record<string, string>;
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

export interface CatalogGroupView {
  key: string;
  title: string | null;
}

export interface CatalogViewResponse extends WithLocaleTags {
  defaultLocale: string;
  locale: string;
  locales: CatalogLocaleSummary[];
  groups: CatalogGroupView[];
  entries: CatalogEntryView[];
  /** How the catalog writes placeholders: `"polystella"` (`{{name}}`) or `"icu"` (`{name}`). */
  messageSyntax: "polystella" | "icu";
}

export type CatalogGenerationResponse =
  | {
      translations: Record<string, string>;
      tokenFailures: Array<{ key: string; missing: string[]; spurious: string[]; problems?: string[] | undefined }>;
      debug?: TranslationDebugTrace | undefined;
      usage?: TranslationUsage | undefined;
    }
  | { translations: null; tokenFailures: []; error: string; debug: TranslationDebugTrace };

export interface CatalogOverrideMutationResponse {
  key: string;
}

export interface CatalogClearSyncedResponse {
  locale: string;
  cleared: string[];
  /** Keys that changed between listing and deleting; they were left untouched. */
  skipped: string[];
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

export type TranslationSandboxResponse =
  | { translation: string; debug?: TranslationDebugTrace | undefined; usage?: TranslationUsage | undefined }
  | { translation: null; error: string; debug: TranslationDebugTrace };

/** Most entry × locale translations one queued batch job may contain. */
export const MAX_BATCH_TRANSLATIONS = 5000;

export type BatchJobOutcome = "created" | "updated" | "skipped" | "failed";

export const MAX_JOB_INSTRUCTION_CHARACTERS = 2000;

/** One job's changes to Translation settings; `null` or `""` keeps the setting. */
export interface BatchJobSettings {
  /** Used for every locale of the job. */
  model: string | null;
  /** Thinking effort for `model`; `null` uses Translation settings' choice when it picks the same model, else the model's default. */
  reasoning: string | null;
  maxTokens: number | null;
  /** Added after the configured translation instructions. */
  instructions: string;
}

export interface BatchJobView {
  id: string;
  collection: string;
  locales: string[];
  total: number;
  settings: BatchJobSettings | null;
  /** The job this one retried. */
  retryOf: string | null;
  /** `finished` once every queued translation has a result and listing is done. */
  status: "running" | "cancelled" | "finished";
  createdAt: string;
  publish: boolean;
  updateExisting: boolean;
  /** The queue is still listing the collection, so `total` can still grow. */
  listing: boolean;
  /** Listing stopped at `MAX_BATCH_TRANSLATIONS`; later entries were not queued. */
  truncated: boolean;
  /** Selected source entries, `"all"` for the whole collection, `null` for jobs started before PolyStella recorded this. */
  entryCount: number | "all" | null;
  counts: Record<BatchJobOutcome, number>;
  /** Summed over the job's rows; absent when no row recorded usage, such as rows saved before PolyStella tracked it. */
  usage?: TranslationUsage | undefined;
}

/** The translation a batch row created, updated, or found. `locale` is the content locale. */
export interface BatchTranslationLink {
  id: string;
  locale: string;
  slug: string | null;
  /** Whether a live version exists after the row ran. */
  published: boolean;
}

export interface BatchJobResultView {
  entryId: string;
  /** Source entry title, slug, or id, in that order. */
  title: string;
  locale: string;
  outcome: BatchJobOutcome;
  message: string | null;
  translation: BatchTranslationLink | null;
  usage?: TranslationUsage | undefined;
}

export interface BatchJobResultsResponse {
  results: BatchJobResultView[];
  nextCursor: string | null;
}

export interface BatchJobEntriesResponse {
  /** `locale` is the source entry's content locale, for its edit link. `deleted` entries can no longer be opened. */
  entries: Array<{ id: string; title: string; locale: string | null; deleted: boolean }>;
  nextCursor: string | null;
}

export interface BatchJobsResponse extends WithLocaleTags {
  /** False when the deployment has no `batchQueueBinding`; the admin then translates in the browser only. */
  queueEnabled: boolean;
  jobs: BatchJobView[];
}
