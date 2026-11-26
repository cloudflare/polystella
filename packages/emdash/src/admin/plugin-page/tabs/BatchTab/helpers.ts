import { ApiResponseError, fetchContent, fetchContentList, fetchTranslations, publishContent } from "@emdash-cms/admin";

import {
  POLYSTELLA_PLUGIN_ID,
  type AiTranslationStatus,
  type BatchJobSettings,
  type BatchJobView,
  type BatchTranslationLink,
  type CollectionPolicyResponse,
} from "../../../../contracts.js";
import { createTranslatedEntry, translateExistingEntry } from "../../../content-translation.js";
import { panelErrorMessage } from "../../../panels/ContentEditorPanel.js";
import { pluginRequest } from "../../../utils.js";

export type BatchTargetLocale = CollectionPolicyResponse["targetLocales"][number];

export interface BatchItem {
  id: string;
  title: string;
  slug: string | null;
}

export interface BatchJob {
  item: BatchItem;
  target: BatchTargetLocale;
  /** A translation this run wrote, to translate again if nobody edited or published it since. */
  redo?: BatchTranslation | undefined;
}

export type BatchOutcome = "created" | "updated" | "skipped" | "failed";

export interface BatchResult extends BatchJob {
  outcome: BatchOutcome;
  message: string | null;
  /** The created, updated, or already existing translation. */
  translation: BatchTranslation | null;
}

export type BatchTranslation = BatchTranslationLink;

/** The parts of EmDash's admin manifest that public URLs need. */
export interface PublicUrlContext {
  urlPattern: string | undefined;
  i18n: { defaultLocale: string; prefixDefaultLocale?: boolean | undefined } | undefined;
}

const DATE_TOKEN = /\{(?:year|month|day|hour|minute|second)\}/;

/**
 * Mirrors EmDash's admin `contentUrl`. `null` without a URL pattern, where the public path is unknown,
 * and for date-based patterns, which need the publish date.
 */
export function publicContentUrl(translation: BatchTranslation, context: PublicUrlContext): string | null {
  const { urlPattern, i18n } = context;
  if (translation.slug === null || urlPattern === undefined || urlPattern.length === 0 || DATE_TOKEN.test(urlPattern)) return null;
  const slug = translation.slug.replace(/^\/+/, "");
  const path = urlPattern.replaceAll("{id}", translation.id).replaceAll("{slug}", slug);
  const prefixed = i18n !== undefined && (translation.locale !== i18n.defaultLocale || i18n.prefixDefaultLocale === true);
  return prefixed ? `/${translation.locale}/${path.replace(/^\/+/, "")}` : path;
}

export interface BatchJobOptions {
  collection: string;
  sourceLocale: string | undefined;
  fields: readonly string[];
  updateExisting: boolean;
  publish: boolean;
  settings?: BatchJobSettings | null | undefined;
}

/** What the Batch tab hands to the run tab. `items` is empty for a whole-collection run; the run tab lists them. */
export interface BatchRunPlan {
  collection: string;
  scope: "all" | "selected";
  items: BatchItem[];
  targets: BatchTargetLocale[];
  options: BatchJobOptions;
  createdAt: number;
  /** The policy's `localeTags`: the run tab opens without a response that carries them. */
  localeTags?: Record<string, string> | undefined;
}

const RUN_KEY_PREFIX = "polystella:batch-run:";
const RUN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Stores the plan for the run tab (localStorage is shared across tabs) and drops plans nobody started. */
export function saveBatchRun(plan: BatchRunPlan, storage: Storage = window.localStorage): string {
  for (let index = storage.length - 1; index >= 0; index--) {
    const key = storage.key(index);
    if (key === null || !key.startsWith(RUN_KEY_PREFIX)) continue;
    const stale = readStoredPlan(storage.getItem(key));
    if (stale === null || plan.createdAt - stale.createdAt > RUN_MAX_AGE_MS) storage.removeItem(key);
  }
  const id = crypto.randomUUID();
  storage.setItem(RUN_KEY_PREFIX + id, JSON.stringify(plan));
  return id;
}

export function readBatchRun(id: string, storage: Storage = window.localStorage): BatchRunPlan | null {
  return readStoredPlan(storage.getItem(RUN_KEY_PREFIX + id));
}

export function clearBatchRun(id: string, storage: Storage = window.localStorage): void {
  storage.removeItem(RUN_KEY_PREFIX + id);
}

/** The run tab's address: this plugin page's path with `/batch-run` in place of the page path. */
export function batchRunUrl(pathname: string, id: string): string {
  const pluginRoot = `/plugins/${POLYSTELLA_PLUGIN_ID}`;
  const index = pathname.lastIndexOf(pluginRoot);
  const base = index === -1 ? pathname.replace(/\/+$/, "") : pathname.slice(0, index + pluginRoot.length);
  return `${base}/batch-run?run=${encodeURIComponent(id)}`;
}

function readStoredPlan(raw: string | null): BatchRunPlan | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isBatchRunPlan(value) ? value : null;
  } catch {
    return null;
  }
}

// Written by saveBatchRun in this origin; this only rejects corrupt or foreign values, not every nested field.
function isBatchRunPlan(value: unknown): value is BatchRunPlan {
  return (
    typeof value === "object" &&
    value !== null &&
    "collection" in value &&
    typeof value.collection === "string" &&
    "scope" in value &&
    (value.scope === "all" || value.scope === "selected") &&
    "items" in value &&
    Array.isArray(value.items) &&
    "targets" in value &&
    Array.isArray(value.targets) &&
    "options" in value &&
    typeof value.options === "object" &&
    value.options !== null &&
    "createdAt" in value &&
    typeof value.createdAt === "number"
  );
}

export function batchJobDone(job: BatchJobView): number {
  return job.counts.created + job.counts.updated + job.counts.skipped + job.counts.failed;
}

export function batchJobFinished(job: BatchJobView): boolean {
  return job.status === "finished";
}

export function planBatchJobs(items: readonly BatchItem[], targets: readonly BatchTargetLocale[]): BatchJob[] {
  return items.flatMap((item) => targets.map((target) => ({ item, target })));
}

/** Older rows may store the catalog code ("fr-FR") instead of the Astro locale path ("fr"). */
export function findExistingTranslation<T extends { locale: string }>(
  translations: readonly T[],
  target: BatchTargetLocale,
): T | undefined {
  const candidates = new Set([target.locale.toLowerCase(), target.code.toLowerCase()]);
  return translations.find((translation) => candidates.has(translation.locale.toLowerCase()));
}

/** Target locales that at least one of the entries has no translation for. */
export async function untranslatedLocales(
  collection: string,
  itemIds: readonly string[],
  targets: readonly BatchTargetLocale[],
  concurrency: number,
): Promise<string[]> {
  const missing = new Set<string>();
  await runBatchJobs(
    itemIds,
    concurrency,
    async (id) => {
      const { translations } = await fetchTranslations(collection, id);
      for (const target of targets) {
        if (findExistingTranslation(translations, target) === undefined) missing.add(target.locale);
      }
    },
    () => missing.size === targets.length,
  );
  return targets.map(({ locale }) => locale).filter((locale) => missing.has(locale));
}

export function entryTitle(entry: { id: string; slug: string | null; data: Record<string, unknown> }): string {
  const title = entry.data.title;
  if (typeof title === "string" && title.trim().length > 0) return title;
  return entry.slug ?? entry.id;
}

export interface ItemPage {
  items: BatchItem[];
  nextCursor: string | undefined;
}

const PAGE_SIZE = 50;

/** Source-locale entries only. Rows in a target locale are dropped too, in case EmDash returns them anyway. */
export async function loadItems(
  collection: string,
  sourceLocale: string,
  targets: readonly BatchTargetLocale[],
  search: string,
  cursor: string | undefined,
): Promise<ItemPage> {
  const query = search.trim();
  const result = await fetchContentList(collection, {
    limit: PAGE_SIZE,
    locale: sourceLocale,
    ...(query.length === 0 ? {} : { search: query }),
    ...(cursor === undefined ? {} : { cursor }),
  });
  return {
    items: result.items
      .filter(({ locale }) => locale === null || targets.every((target) => findExistingTranslation([{ locale }], target) === undefined))
      .map((item) => ({ id: item.id, title: entryTitle(item), slug: item.slug })),
    nextCursor: result.nextCursor,
  };
}

export async function loadAllItems(collection: string, sourceLocale: string, targets: readonly BatchTargetLocale[]): Promise<BatchItem[]> {
  const items: BatchItem[] = [];
  let cursor: string | undefined;
  do {
    const next = await loadItems(collection, sourceLocale, targets, "", cursor);
    items.push(...next.items);
    cursor = next.nextCursor;
  } while (cursor !== undefined);
  return items;
}

export interface CollectionTranslationStats {
  sourceEntries: number;
  publishedSourceEntries: number;
  /** Source entries with no translation, keyed by target locale. */
  untranslated: Record<string, number>;
}

/** Counts from one paged list per locale, matched by translation group, instead of a request per entry. */
export async function collectionTranslationStats(
  collection: string,
  sourceLocale: string,
  targets: readonly BatchTargetLocale[],
  signal?: AbortSignal | undefined,
): Promise<CollectionTranslationStats> {
  // Older translations can be stored under the catalog code ("fr-FR") instead of the content locale ("fr").
  const targetRowLists = (target: BatchTargetLocale) =>
    Promise.all([...new Set([target.locale, target.code])].map((locale) => listAllEntries(collection, locale, signal))).then((lists) =>
      lists.flat(),
    );
  const [sourceRows, ...targetRows] = await Promise.all([listAllEntries(collection, sourceLocale, signal), ...targets.map(targetRowLists)]);
  const sources = sourceRows.filter(({ locale }) => targets.every((target) => findExistingTranslation([{ locale }], target) === undefined));
  const untranslated: Record<string, number> = {};
  targets.forEach((target, index) => {
    const translatedGroups = new Set(
      (targetRows[index] ?? []).filter((row) => findExistingTranslation([row], target) !== undefined).map(translationGroupOf),
    );
    untranslated[target.locale] = sources.filter((row) => !translatedGroups.has(translationGroupOf(row))).length;
  });
  return {
    sourceEntries: sources.length,
    publishedSourceEntries: sources.filter(({ status }) => status === "published").length,
    untranslated,
  };
}

interface EntryRow {
  id: string;
  locale: string;
  status: string;
  translationGroup: string | null;
}

function translationGroupOf(row: EntryRow): string {
  return row.translationGroup ?? row.id;
}

async function listAllEntries(collection: string, locale: string, signal: AbortSignal | undefined): Promise<EntryRow[]> {
  const rows: EntryRow[] = [];
  let cursor: string | undefined;
  do {
    signal?.throwIfAborted();
    const result = await fetchContentList(collection, { limit: 100, locale, ...(cursor === undefined ? {} : { cursor }) });
    rows.push(...result.items);
    cursor = result.nextCursor;
  } while (cursor !== undefined);
  return rows;
}

/** Workers pull the next job until the list is empty or `shouldStop` turns true; in-flight jobs finish. */
export async function runBatchJobs<T>(
  jobs: readonly T[],
  concurrency: number,
  run: (job: T) => Promise<void>,
  shouldStop: () => boolean,
): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (next < jobs.length && !shouldStop()) {
      const job = jobs[next];
      next += 1;
      if (job !== undefined) await run(job);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
}

/** Never throws: every failure becomes a result row so one bad entry can't stop the batch. */
export async function runBatchJob(job: BatchJob, options: BatchJobOptions): Promise<BatchResult> {
  const { collection, fields, settings } = options;
  let creating = false;
  let translation: BatchResult["translation"] = job.redo ?? null;
  try {
    if (job.redo !== undefined) return await redoTranslation(job, job.redo, options);
    const { translations } = await fetchTranslations(collection, job.item.id);
    const existing = findExistingTranslation(translations, job.target);
    if (existing !== undefined) {
      translation = { id: existing.id, locale: existing.locale, slug: existing.slug, published: existing.status === "published" };
    }
    if (existing === undefined) {
      creating = true;
      const result = await createTranslatedEntry({
        collection,
        sourceEntryId: job.item.id,
        sourceLocale: options.sourceLocale,
        locale: job.target.locale,
        fields,
        settings,
      });
      if (result.entry === null) return { ...job, outcome: "failed", message: result.error, translation };
      const created = { id: result.entry.id, locale: result.entry.locale ?? job.target.locale, slug: result.entry.slug, published: false };
      const publish = await publishIfAsked(collection, created, options.publish);
      translation = { ...created, published: publish.published };
      return { ...job, outcome: "created", message: joinMessages(result.flagWarning, result.notice, publish.message), translation };
    }
    if (!options.updateExisting) return { ...job, outcome: "skipped", message: "A translation already exists.", translation };
    const result = await translateExistingEntry({ collection, entryId: existing.id, locale: existing.locale, fields, settings });
    if (result.entry === null) return { ...job, outcome: "failed", message: result.error, translation };
    const publish = await publishIfAsked(collection, existing, options.publish);
    const updated = translation === null ? null : { ...translation, published: translation.published || publish.published };
    return { ...job, outcome: "updated", message: joinMessages(result.flagWarning, result.notice, publish.message), translation: updated };
  } catch (cause) {
    const changedMeanwhile = cause instanceof ApiResponseError && cause.status === 409;
    return {
      ...job,
      outcome: changedMeanwhile ? "skipped" : "failed",
      message: panelErrorMessage(cause, creating ? job.target.locale : undefined),
      translation,
    };
  }
}

/** Same checks as the server queue's redo: still a draft, and no AI-written field changed since. */
async function redoTranslation(job: BatchJob, translation: BatchTranslation, options: BatchJobOptions): Promise<BatchResult> {
  const { collection, fields, settings } = options;
  const query = new URLSearchParams({ collection, entryId: translation.id });
  // The revision is read first: an edit after it makes the save conflict, an edit before it shows in the status.
  const saved = await fetchContent(collection, translation.id, { locale: translation.locale });
  const status = await pluginRequest<AiTranslationStatus>(`ai-translation/status?${query.toString()}`);
  const skip = (message: string): BatchResult => ({ ...job, outcome: "skipped", message, translation });
  if (saved._rev === undefined) throw new Error("EmDash did not return a revision token; no fields were changed.");
  if (saved.status !== "draft") return skip("The translation is published or scheduled, so it was not redone.");
  if (!status.aiTranslated || status.editedFields === null) {
    return skip("PolyStella can't tell whether the translation was edited, so it was not redone.");
  }
  if (status.editedFields.length > 0) return skip("The translation was edited after PolyStella wrote it, so it was not redone.");
  const result = await translateExistingEntry({
    collection,
    entryId: translation.id,
    locale: translation.locale,
    fields,
    settings,
    rev: saved._rev,
  });
  if (result.entry === null) return { ...job, outcome: "failed", message: result.error, translation };
  const publish = await publishIfAsked(collection, translation, options.publish);
  return {
    ...job,
    outcome: "updated",
    message: joinMessages(result.flagWarning, result.notice, publish.message),
    translation: { ...translation, published: publish.published },
  };
}

/** A failed publish leaves the saved draft in place, so it is reported on the row instead of failing it. */
function joinMessages(...messages: Array<string | null>): string | null {
  const present = messages.filter((message) => message !== null);
  return present.length === 0 ? null : present.join(" ");
}

async function publishIfAsked(
  collection: string,
  translation: { id: string; locale: string },
  publish: boolean,
): Promise<{ published: boolean; message: string | null }> {
  if (!publish) return { published: false, message: null };
  try {
    await publishContent(collection, translation.id, { locale: translation.locale });
    return { published: true, message: "Published." };
  } catch (cause) {
    return { published: false, message: `Saved as a draft; publishing failed: ${panelErrorMessage(cause)}` };
  }
}
