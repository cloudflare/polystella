import { createContent, fetchContent, updateContent, type ContentEditorDraft, type ContentEditorDraftPatchResult } from "@emdash-cms/admin";

import {
  addTranslationUsage,
  isSeoField,
  type BatchJobSettings,
  type TranslateContentNextPart,
  type TranslateContentResponse,
  type TranslationDebugTrace,
  type TranslationUsage,
} from "../contracts.js";
import { errorMessage, pluginRequest } from "./utils.js";

type ContentItem = Awaited<ReturnType<typeof fetchContent>>;

export interface ContentTranslationHooks {
  onTranslating?: (() => void) | undefined;
  /** A long entry moved on to `part` (0-based) of `partCount`. */
  onPart?: ((part: number, partCount: number) => void) | undefined;
  /** Runs before the save, so a trace stays visible even when the save fails. */
  onTranslated?: ((debug: TranslationDebugTrace | undefined) => void) | undefined;
  /** A batch run's changes to Translation settings; administrators only. */
  settings?: BatchJobSettings | null | undefined;
}

export type ContentTranslationResult =
  | {
      entry: ContentItem;
      debug?: TranslationDebugTrace | undefined;
      /** Set when the content saved but the AI-translated flag did not. */
      flagWarning: string | null;
      /** Something an editor should check by hand, such as same-page links. */
      notice: string | null;
      /** Custom block types copied untranslated; empty when none. */
      unlistedBlockTypes: string[];
      /** Every part's model calls. */
      usage?: TranslationUsage | undefined;
    }
  | { entry: null; error: string; debug: TranslationDebugTrace };

export interface TranslateExistingEntryInput extends ContentTranslationHooks {
  collection: string;
  entryId: string;
  locale: string;
  fields: readonly string[];
  /** The revision the caller already checked; read here when absent. */
  rev?: string | undefined;
}

/** Replaces the selected fields of a saved translation. `_rev` makes EmDash reject the save if the entry changed meanwhile. */
export async function translateExistingEntry(input: TranslateExistingEntryInput): Promise<ContentTranslationResult> {
  const { collection, entryId, locale } = input;
  const rev = input.rev ?? (await fetchContent(collection, entryId, { locale }))._rev;
  if (rev === undefined) throw new Error("EmDash did not return a revision token; no fields were changed.");
  const result = await requestTranslation(input, entryId, locale);
  if (result.patch === null) return { entry: null, error: result.error, debug: result.debug };
  const entry = await updateContent(collection, entryId, { data: result.patch, _rev: rev }, { locale });
  const flagWarning = await recordAiTranslation(collection, entry.id, input.fields, input.settings?.model);
  return {
    entry,
    debug: result.debug,
    flagWarning,
    notice: result.notice ?? null,
    unlistedBlockTypes: result.unlistedBlockTypes ?? [],
    usage: result.usage,
  };
}

export interface TranslateIntoDraftInput extends TranslateExistingEntryInput {
  editorDraft: ContentEditorDraft;
}

export type DraftTranslationResult =
  | {
      status: "applied";
      debug?: TranslationDebugTrace | undefined;
      flagWarning: string | null;
      notice: string | null;
      unlistedBlockTypes: string[];
      /** SEO fields whose translation is longer than EmDash allows, so they were left out. */
      tooLong: string[];
      usage?: TranslationUsage | undefined;
    }
  | { status: "failed"; error: string; debug?: TranslationDebugTrace | undefined }
  | { status: "refused"; code: Extract<ContentEditorDraftPatchResult, { ok: false }>["code"] };

/**
 * Puts the selected fields' translations into the open editor without saving. Refused when the user
 * changed one of those fields while it was translated; nothing is sent from a read-only editor.
 */
export async function translateIntoDraft(input: TranslateIntoDraftInput): Promise<DraftTranslationResult> {
  const { collection, entryId, locale, editorDraft } = input;
  const before = editorDraft.get();
  if (before.readOnly) return { status: "refused", code: "EDITOR_DRAFT_READ_ONLY" };
  const result = await requestTranslation(input, entryId, locale);
  if (result.patch === null) return { status: "failed", error: result.error, debug: result.debug };
  const patch = result.patch;
  // EmDash refuses the whole patch when an SEO value exceeds its limit; other limits are checked on save.
  const tooLong = Object.keys(patch).filter((field) => {
    const maxLength = before.fieldDefinitions.find((definition) => definition.slug === field)?.validation?.maxLength;
    const value = patch[field];
    return isSeoField(field) && typeof maxLength === "number" && typeof value === "string" && value.length > maxLength;
  });
  const operations = Object.entries(patch)
    .filter(([field]) => !tooLong.includes(field))
    .map(([field, value]) => ({ op: "set" as const, field, value }));
  if (operations.length === 0)
    return { status: "failed", error: "Every translation is longer than its field allows.", debug: result.debug };
  const flagFields = operations.map(({ field }) => field).filter((field) => !isSeoField(field));
  // Recorded before the patch, so the server's baseline is the text the patch replaces.
  const pending =
    flagFields.length === 0 ? { added: [], warning: null } : await recordPendingAiTranslation(collection, entryId, flagFields);
  // Edits to other fields during the translation are kept; only the translated fields must be unchanged.
  const latest = editorDraft.get();
  const changed = operations.some(({ field }) => JSON.stringify(latest.fields[field]) !== JSON.stringify(before.fields[field]));
  const outcome: ContentEditorDraftPatchResult = changed
    ? { ok: false, code: "EDITOR_DRAFT_STALE", message: "A translated field changed during translation" }
    : editorDraft.patch(operations, { expectedRevision: latest.revision });
  if (outcome.ok) {
    return {
      status: "applied",
      debug: result.debug,
      flagWarning: pending.warning,
      notice: result.notice ?? null,
      unlistedBlockTypes: result.unlistedBlockTypes ?? [],
      tooLong,
      usage: result.usage,
    };
  }
  if (pending.added.length > 0) {
    await pluginRequest("ai-translation/pending", {
      method: "POST",
      body: JSON.stringify({ collection, entryId, fields: pending.added, cancel: true }),
    }).catch((cause: unknown) => console.error("[polystella-emdash] could not cancel a pending AI translation", cause));
  }
  return { status: "refused", code: outcome.code };
}

export interface CreateTranslatedEntryInput extends ContentTranslationHooks {
  collection: string;
  sourceEntryId: string;
  sourceLocale: string | undefined;
  locale: string;
  fields: readonly string[];
}

/** Creates a draft in `locale` from the latest saved source entry, with the selected fields translated. */
export async function createTranslatedEntry(input: CreateTranslatedEntryInput): Promise<ContentTranslationResult> {
  const { collection, sourceEntryId, locale } = input;
  const source = await fetchContent(collection, sourceEntryId, input.sourceLocale === undefined ? {} : { locale: input.sourceLocale });
  const result = await requestTranslation(input, sourceEntryId, locale);
  if (result.patch === null) return { entry: null, error: result.error, debug: result.debug };
  // Same payload as EmDash's own "Create translation" button, with the selected fields translated.
  const entry = await createContent(collection, {
    data: { ...source.data, ...result.patch },
    slug: source.slug,
    locale,
    translationOf: sourceEntryId,
  });
  const flagWarning = await recordAiTranslation(collection, entry.id, input.fields, input.settings?.model);
  return {
    entry,
    debug: result.debug,
    flagWarning,
    notice: result.notice ?? null,
    unlistedBlockTypes: result.unlistedBlockTypes ?? [],
    usage: result.usage,
  };
}

/** Marks the saved entry as AI-translated for `getEnrichedEntry`. Runs before any publish, so a live page never lacks its flag. */
async function recordAiTranslation(
  collection: string,
  entryId: string,
  fields: readonly string[],
  model: string | null | undefined,
): Promise<string | null> {
  try {
    const body = { collection, entryId, fields, ...(model === null || model === undefined ? {} : { model }) };
    await pluginRequest("ai-translation", { method: "POST", body: JSON.stringify(body) });
    return null;
  } catch (cause) {
    // The content is already saved, so this is a warning, not a failure.
    console.error("[polystella-emdash] could not mark the entry as AI-translated", cause);
    return `Saved, but PolyStella could not mark it as AI-translated (${errorMessage(cause)}).`;
  }
}

/** The translation goes into the editor; the save that changes these fields confirms the flag. */
async function recordPendingAiTranslation(
  collection: string,
  entryId: string,
  fields: readonly string[],
): Promise<{ added: string[]; warning: string | null }> {
  try {
    const { added } = await pluginRequest<{ added: string[] }>("ai-translation/pending", {
      method: "POST",
      body: JSON.stringify({ collection, entryId, fields }),
    });
    return { added, warning: null };
  } catch (cause) {
    // The translation still goes into the form, so this is a warning, not a failure.
    console.error("[polystella-emdash] could not mark the entry as AI-translated", cause);
    return {
      added: [],
      warning: `The translation is in the form, but PolyStella could not mark it as AI-translated (${errorMessage(cause)}).`,
    };
  }
}

/** Long entries come back one part at a time; each request sends the earlier parts' translations back. */
async function requestTranslation(
  input: ContentTranslationHooks & { collection: string; fields: readonly string[] },
  entryId: string,
  targetLocale: string,
): Promise<Exclude<TranslateContentResponse, { next: TranslateContentNextPart }>> {
  input.onTranslating?.();
  const settings = input.settings ?? null;
  const body = { collection: input.collection, entryId, targetLocale, fields: input.fields, ...(settings === null ? {} : { settings }) };
  let result = await pluginRequest<TranslateContentResponse>("translate-content", { method: "POST", body: JSON.stringify(body) });
  let usage = "usage" in result ? result.usage : undefined;
  while ("next" in result) {
    const { part, partCount, fingerprint, translations } = result.next;
    input.onPart?.(part, partCount);
    result = await pluginRequest<TranslateContentResponse>("translate-content", {
      method: "POST",
      body: JSON.stringify({ ...body, part, fingerprint, translations }),
    });
    usage = addTranslationUsage(usage, "usage" in result ? result.usage : undefined);
  }
  input.onTranslated?.(result.debug);
  return result.patch === null ? result : { ...result, usage };
}
