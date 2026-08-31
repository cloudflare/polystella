export { DEFAULT_CATALOG_BASE, DEFAULT_CATALOG_PATTERN } from "./constants.js";
export {
  buildTranslateFn,
  interpolate,
  resolveTranslations,
  type CatalogDictionary,
  type GetCatalogDictionary,
  type InterpolateParams,
  type MaybePromise,
  type ResolveCatalogTranslationsDeps,
  type TranslateFn,
} from "./runtime.js";
export {
  checkI18nDrift,
  checkI18nDrift as checkCatalogDrift,
  formatDriftIssues,
  loadAndCheckDrift,
  loadAndCheckDrift as loadAndCheckCatalogDrift,
  type DriftCheckInput,
  type DriftCheckResult,
  type DriftIssue,
  type LoadAndCheckDriftOptions,
} from "../i18n/drift.js";
export {
  applySyncToDisk,
  applySyncToDisk as applyCatalogSyncToDisk,
  formatLocaleFile,
  formatSyncSummary,
  parseSourceLayout,
  syncLocaleDict,
  type ApplySyncLocaleResult,
  type ApplySyncOptions,
  type ApplySyncResult,
  type FormatLocaleFileOptions,
  type SourceLayout,
  type SyncLocaleDictInput,
  type SyncLocaleDictResult,
} from "../i18n/sync.js";
