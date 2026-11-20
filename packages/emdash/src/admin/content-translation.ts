import { createContent, fetchContent, updateContent } from "@emdash-cms/admin";

import type { TranslateContentNextPart, TranslateContentResponse, TranslationDebugTrace } from "../contracts.js";
import { errorMessage, pluginRequest } from "./utils.js";

type ContentItem = Awaited<ReturnType<typeof fetchContent>>;

export interface ContentTranslationHooks {
  onTranslating?: (() => void) | undefined;
  /** A long entry moved on to `part` (0-based) of `partCount`. */
  onPart?: ((part: number, partCount: number) => void) | undefined;
  /** Runs before the save, so a trace stays visible even when the save fails. */
  onTranslated?: ((debug: TranslationDebugTrace | undefined) => void) | undefined;
}

export type ContentTranslationResult =
  | {
      entry: ContentItem;
      debug?: TranslationDebugTrace | undefined;
      /** Set when the content saved but the AI-translated flag did not. */
      flagWarning: string | null;
    }
  | { entry: null; error: string; debug: TranslationDebugTrace };

export interface TranslateExistingEntryInput extends ContentTranslationHooks {
  collection: string;
  entryId: string;
  locale: string;
  fields: readonly string[];
}

/** Replaces the selected fields of a saved translation. `_rev` makes EmDash reject the save if the entry changed meanwhile. */
export async function translateExistingEntry(input: TranslateExistingEntryInput): Promise<ContentTranslationResult> {
  const { collection, entryId, locale } = input;
  const saved = await fetchContent(collection, entryId, { locale });
  if (saved._rev === undefined) throw new Error("EmDash did not return a revision token; no fields were changed.");
  const result = await requestTranslation(input, entryId, locale);
  if (result.patch === null) return { entry: null, error: result.error, debug: result.debug };
  const entry = await updateContent(collection, entryId, { data: result.patch, _rev: saved._rev }, { locale });
  return { entry, debug: result.debug, flagWarning: await recordAiTranslation(collection, entry.id, input.fields) };
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
  return { entry, debug: result.debug, flagWarning: await recordAiTranslation(collection, entry.id, input.fields) };
}

/** Marks the saved entry as AI-translated for `getEnrichedEntry`. Runs before any publish, so a live page never lacks its flag. */
async function recordAiTranslation(collection: string, entryId: string, fields: readonly string[]): Promise<string | null> {
  try {
    await pluginRequest("ai-translation", { method: "POST", body: JSON.stringify({ collection, entryId, fields }) });
    return null;
  } catch (cause) {
    // The content is already saved, so this is a warning, not a failure.
    console.error("[polystella-emdash] could not mark the entry as AI-translated", cause);
    return `Saved, but PolyStella could not mark it as AI-translated (${errorMessage(cause)}).`;
  }
}

/** Long entries come back one part at a time; each request sends the earlier parts' translations back. */
async function requestTranslation(
  input: ContentTranslationHooks & { collection: string; fields: readonly string[] },
  entryId: string,
  targetLocale: string,
): Promise<Exclude<TranslateContentResponse, { next: TranslateContentNextPart }>> {
  input.onTranslating?.();
  const body = { collection: input.collection, entryId, targetLocale, fields: input.fields };
  let result = await pluginRequest<TranslateContentResponse>("translate-content", { method: "POST", body: JSON.stringify(body) });
  while ("next" in result) {
    const { part, partCount, fingerprint, translations } = result.next;
    input.onPart?.(part, partCount);
    result = await pluginRequest<TranslateContentResponse>("translate-content", {
      method: "POST",
      body: JSON.stringify({ ...body, part, fingerprint, translations }),
    });
  }
  input.onTranslated?.(result.debug);
  return result;
}
