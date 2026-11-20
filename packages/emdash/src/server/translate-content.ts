import {
  translateSegments,
  type Glossary,
  type Segment,
  type TranslateBatchAttemptEvent,
  type Translator,
} from "@cloudflare/polystella-core";
import { createMarkdownAdapter } from "@cloudflare/polystella-core/adapters";
import { validateTokenPreservation } from "@cloudflare/polystella-core/catalog/translate";

import { MAX_CONTENT_FIELDS } from "../contracts.js";
import type { BlockFieldPath } from "./options.js";

const MAX_SEGMENTS = 500;
const MAX_SEGMENT_CHARACTERS = 20_000;
const MAX_TOTAL_CHARACTERS = 30_000;
// One entry is one request here, so nothing else multiplies these provider calls.
const BATCH_CONCURRENCY = 3;
const markdownAdapter = createMarkdownAdapter();

type PathPart = string | number;

interface SegmentLocation {
  field: string;
  /** Where the text lives inside the values, starting at the field name. */
  path: PathPart[];
  leadingWhitespace: string;
  trailingWhitespace: string;
}

/** A span list (text block children or a table cell) whose joined text must keep the source placeholder tokens. */
interface SpanList {
  field: string;
  path: PathPart[];
  segmentIds: string[];
}

/** A Markdown string split into paragraph and list-item segments, rebuilt by core's Markdown adapter. */
interface MarkdownText {
  field: string;
  path: PathPart[];
  source: string;
  parsed: ReturnType<typeof markdownAdapter.parse>;
  /** Our segment id → the adapter's own id (`body:0`, ...). */
  adapterIds: Map<string, string>;
}

interface Collector {
  segments: Segment[];
  group: Segment[];
  locations: Map<string, SegmentLocation>;
  spanLists: SpanList[];
  markdownTexts: MarkdownText[];
  blockFields: BlockFieldPaths;
}

/** Custom Portable Text block type → text paths inside it, like `cards[].title`. */
export type BlockFieldPaths = Readonly<Record<string, readonly BlockFieldPath[]>>;

/**
 * Text in the block types EmDash itself writes: its editor, WordPress import and `emdash/ui` components.
 * Re-check against EmDash's converters and components whenever the tested EmDash version changes.
 */
export const EMDASH_BLOCK_FIELDS: BlockFieldPaths = {
  image: ["alt", "caption", "title"],
  gallery: ["images[].alt", "images[].caption"],
  video: ["caption"],
  button: ["text"],
  buttons: ["buttons[].text"],
  columns: ["columns[].content"],
  cover: ["content"],
  pullquote: ["text", "citation"],
  embed: ["caption"],
  iframe: ["title"],
};

export class ContentTranslationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentTranslationInputError";
  }
}

export interface TranslateContentFieldsOptions {
  values: Record<string, unknown>;
  translator: Translator;
  glossary: Glossary;
  sourceLocale: string;
  targetLocale: string;
  promptInstruction?: string | undefined;
  blockFields?: BlockFieldPaths | undefined;
  /** Fields of EmDash's `blocks` type. Their block types are the site's own, so only `blockFields` applies to them. */
  blocksFieldSlugs?: readonly string[] | undefined;
  onBatchAttempt?: ((event: TranslateBatchAttemptEvent) => void) | undefined;
  onValidationIssue?: ((segmentIds: string[], message: string) => void) | undefined;
  signal?: AbortSignal | undefined;
}

export interface TranslateContentFieldsResult {
  patch: Record<string, unknown>;
  batchCount: number;
}

export async function translateContentFields(options: TranslateContentFieldsOptions): Promise<TranslateContentFieldsResult> {
  const segments: Segment[] = [];
  const groups: Segment[][] = [];
  const locations = new Map<string, SegmentLocation>();
  const spanLists: SpanList[] = [];
  const markdownTexts: MarkdownText[] = [];
  const fields = Object.entries(options.values);
  if (fields.length > MAX_CONTENT_FIELDS) {
    throw new ContentTranslationInputError(`cannot translate more than ${MAX_CONTENT_FIELDS} fields at once`);
  }

  for (const [fieldIndex, [field, value]] of fields.entries()) {
    const collector: Collector = {
      segments,
      group: [],
      locations,
      spanLists,
      markdownTexts,
      blockFields: { ...EMDASH_BLOCK_FIELDS, ...options.blockFields },
    };
    if (typeof value === "string") {
      addSegment(`field:${fieldIndex}`, value, field, [field], collector);
    } else if (Array.isArray(value) && options.blocksFieldSlugs?.includes(field) === true) {
      collectBlocksField(value, `field:${fieldIndex}`, field, options.blockFields ?? {}, collector);
    } else if (Array.isArray(value)) {
      collectBlocks(value, `field:${fieldIndex}`, field, [field], collector);
    } else {
      throw new ContentTranslationInputError(`field "${field}" is not supported for translation`);
    }
    if (collector.group.length > 0) groups.push(collector.group);
  }

  if (segments.length > MAX_SEGMENTS) {
    throw new ContentTranslationInputError(`cannot translate more than ${MAX_SEGMENTS} text segments at once`);
  }
  const totalCharacters = segments.reduce((total, segment) => total + segment.text.length, 0);
  if (totalCharacters > MAX_TOTAL_CHARACTERS) {
    throw new ContentTranslationInputError(`cannot translate more than ${MAX_TOTAL_CHARACTERS} characters at once`);
  }

  const result = await translateSegments({
    translator: options.translator,
    segments,
    groups,
    glossary: options.glossary,
    sourceLocale: options.sourceLocale,
    targetLocale: options.targetLocale,
    concurrency: BATCH_CONCURRENCY,
    ...(options.promptInstruction === undefined ? {} : { promptInstruction: options.promptInstruction }),
    ...(options.onBatchAttempt === undefined ? {} : { onBatchAttempt: options.onBatchAttempt }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  const patch = structuredClone(options.values);
  const markdownSegmentFields = new Map(markdownTexts.flatMap((text) => [...text.adapterIds.keys()].map((id) => [id, text.field])));
  for (const segment of segments) {
    const translation = result.translations.get(segment.id);
    const markdownField = markdownSegmentFields.get(segment.id);
    if (markdownField !== undefined && translation !== undefined) {
      if (validateTokenPreservation(markdownField, segment.text, translation) !== null) {
        const message = `[polystella-emdash] translation changed placeholder tokens in field "${markdownField}"`;
        notifyValidationIssue(options.onValidationIssue, [segment.id], message);
        throw new Error(message);
      }
      continue;
    }
    const location = locations.get(segment.id);
    if (translation === undefined || location === undefined) {
      const message = `[polystella-emdash] missing translation for internal segment "${segment.id}"`;
      notifyValidationIssue(options.onValidationIssue, [segment.id], message);
      throw new Error(message);
    }
    const tokenIssue = validateTokenPreservation(location.field, segment.text, translation);
    if (tokenIssue !== null) {
      const message = `[polystella-emdash] translation changed placeholder tokens in field "${location.field}"`;
      notifyValidationIssue(options.onValidationIssue, [segment.id], message);
      throw new Error(message);
    }
    setAtPath(patch, location, `${location.leadingWhitespace}${translation}${location.trailingWhitespace}`);
  }
  for (const text of markdownTexts) {
    const translations = new Map<string, string>();
    for (const [id, adapterId] of text.adapterIds) {
      const translation = result.translations.get(id);
      if (translation === undefined) throw new Error(`[polystella-emdash] missing translation for internal segment "${id}"`);
      translations.set(adapterId, translation);
    }
    setAtPath(
      patch,
      { field: text.field, path: text.path, leadingWhitespace: "", trailingWhitespace: "" },
      markdownAdapter.applyTranslations(text.parsed, text.source, translations),
    );
  }
  validateSpanListTokens(options.values, patch, spanLists, (segmentIds, message) =>
    notifyValidationIssue(options.onValidationIssue, segmentIds, message),
  );

  return { patch, batchCount: result.batchCount };
}

function collectBlocks(blocks: readonly unknown[], idPrefix: string, field: string, path: PathPart[], collector: Collector): void {
  for (const [blockIndex, block] of blocks.entries()) {
    const blockPath = [...path, blockIndex];
    if (!isPortableTextNode(block)) {
      throw inputError(`Portable Text field "${field}" contains an invalid block`, blockPath);
    }
    const blockId = `${idPrefix}:block:${blockIndex}`;
    if (block._type === "block") {
      if (!Array.isArray(block.children)) {
        throw inputError(`Portable Text field "${field}" contains a block without children`, blockPath);
      }
      if (block.style !== "code") collectSpans(block.children, blockId, field, [...blockPath, "children"], collector);
    } else if (block._type === "table") {
      collectTable(block, blockId, field, blockPath, collector);
    } else {
      collectCustomBlock(block, collector.blockFields, blockId, field, blockPath, collector);
    }
  }
}

function collectBlocksField(
  blocks: readonly unknown[],
  idPrefix: string,
  field: string,
  blockFields: BlockFieldPaths,
  collector: Collector,
): void {
  for (const [blockIndex, block] of blocks.entries()) {
    if (!isPortableTextNode(block)) throw inputError(`blocks field "${field}" contains an invalid block`, [field, blockIndex]);
    collectCustomBlock(block, blockFields, `${idPrefix}:block:${blockIndex}`, field, [field, blockIndex], collector);
  }
}

function collectCustomBlock(
  block: Record<string, unknown> & { _type: string },
  blockFields: BlockFieldPaths,
  blockId: string,
  field: string,
  blockPath: PathPart[],
  collector: Collector,
): void {
  const fieldPaths = Object.hasOwn(blockFields, block._type) ? blockFields[block._type] : undefined;
  for (const fieldPath of fieldPaths ?? []) {
    const { path, markdown } =
      typeof fieldPath === "string" ? { path: fieldPath, markdown: false } : { path: fieldPath.path, markdown: true };
    collectBlockPath(block, path.split("."), markdown, blockId, field, blockPath, collector);
  }
}

function collectTable(table: Record<string, unknown>, blockId: string, field: string, blockPath: PathPart[], collector: Collector): void {
  if (!Array.isArray(table.rows)) throw inputError(`Portable Text field "${field}" contains a table without rows`, blockPath);
  for (const [rowIndex, row] of table.rows.entries()) {
    const rowPath = [...blockPath, "rows", rowIndex];
    if (!isRecord(row) || !Array.isArray(row.cells)) {
      throw inputError(`Portable Text field "${field}" contains an invalid table row`, rowPath);
    }
    for (const [cellIndex, cell] of row.cells.entries()) {
      const cellPath = [...rowPath, "cells", cellIndex];
      if (!isRecord(cell) || !Array.isArray(cell.content)) {
        throw inputError(`Portable Text field "${field}" contains an invalid table cell`, cellPath);
      }
      collectSpans(cell.content, `${blockId}:row:${rowIndex}:cell:${cellIndex}`, field, [...cellPath, "content"], collector);
    }
  }
}

function collectSpans(spans: readonly unknown[], idPrefix: string, field: string, path: PathPart[], collector: Collector): void {
  const segmentIds: string[] = [];
  for (const [spanIndex, span] of spans.entries()) {
    if (!isPortableTextSpan(span)) throw inputError(`Portable Text field "${field}" contains an invalid span`, [...path, spanIndex]);
    const id = `${idPrefix}:span:${spanIndex}`;
    if (addSegment(id, span.text, field, [...path, spanIndex, "text"], collector)) segmentIds.push(id);
  }
  if (segmentIds.length > 0) collector.spanLists.push({ field, path, segmentIds });
}

/** Follows one `a.b[].c` path. Strings are translated; a Portable Text array is walked like a field. */
function collectBlockPath(
  node: unknown,
  parts: string[],
  markdown: boolean,
  id: string,
  field: string,
  path: PathPart[],
  collector: Collector,
): void {
  const addText = markdown ? addMarkdownText : addSegment;
  const [head, ...rest] = parts;
  if (head === undefined || !isRecord(node)) return;
  const isList = head.endsWith("[]");
  const key = isList ? head.slice(0, -2) : head;
  if (!Object.hasOwn(node, key)) return;
  const value = node[key];
  const valuePath = [...path, key];
  const valueId = `${id}:${key}`;
  if (isList) {
    if (!Array.isArray(value)) return;
    for (const [index, item] of value.entries()) {
      const itemPath = [...valuePath, index];
      if (rest.length > 0) collectBlockPath(item, rest, markdown, `${valueId}:${index}`, field, itemPath, collector);
      else if (typeof item === "string") addText(`${valueId}:${index}`, item, field, itemPath, collector);
    }
  } else if (rest.length > 0) {
    collectBlockPath(value, rest, markdown, valueId, field, valuePath, collector);
  } else if (typeof value === "string") {
    addText(valueId, value, field, valuePath, collector);
  } else if (Array.isArray(value)) {
    collectBlocks(value, valueId, field, valuePath, collector);
  }
}

function validateSpanListTokens(
  source: Record<string, unknown>,
  patch: Record<string, unknown>,
  spanLists: readonly SpanList[],
  onValidationIssue: (segmentIds: string[], message: string) => void,
): void {
  for (const { field, path, segmentIds } of spanLists) {
    const sourceSpans = getAtPath(source, path);
    const translatedSpans = getAtPath(patch, path);
    if (!Array.isArray(sourceSpans) || !Array.isArray(translatedSpans)) continue;
    if (validateTokenPreservation(field, sourceSpans.map(spanText).join(""), translatedSpans.map(spanText).join("")) !== null) {
      const message = `[polystella-emdash] translation changed placeholder tokens in field "${field}"`;
      onValidationIssue(segmentIds, message);
      throw new Error(message);
    }
  }
}

function notifyValidationIssue(callback: TranslateContentFieldsOptions["onValidationIssue"], segmentIds: string[], message: string): void {
  try {
    callback?.(segmentIds, message);
  } catch {
    // Diagnostics must not change translation behavior.
  }
}

function spanText(value: unknown): string {
  return isRecord(value) && value._type === "span" && typeof value.text === "string" ? value.text : "";
}

/** Returns whether the text produced a segment; blank text is left as-is. */
function addSegment(id: string, source: string, field: string, path: PathPart[], collector: Collector): boolean {
  const text = source.trim();
  if (text.length === 0) return false;
  if (text.length > MAX_SEGMENT_CHARACTERS) {
    throw inputError(`one text segment exceeds ${MAX_SEGMENT_CHARACTERS} characters`, path);
  }
  const start = source.indexOf(text);
  const segment: Segment = { id, text, markup: "html" };
  collector.group.push(segment);
  collector.segments.push(segment);
  collector.locations.set(id, {
    field,
    path,
    leadingWhitespace: source.slice(0, start),
    trailingWhitespace: source.slice(start + text.length),
  });
  return true;
}

/** Splits Markdown into paragraph and list-item segments so the model never sees its block structure. */
function addMarkdownText(id: string, source: string, field: string, path: PathPart[], collector: Collector): boolean {
  if (source.trim().length === 0) return false;
  const parsed = markdownAdapter.parse(source);
  const adapterIds = new Map<string, string>();
  for (const segment of markdownAdapter.extractSegments(parsed, source, { sourcePath: `${field}.md`, translatableKeys: {} })) {
    if (segment.text.length > MAX_SEGMENT_CHARACTERS)
      throw inputError(`one text segment exceeds ${MAX_SEGMENT_CHARACTERS} characters`, path);
    const ownId = `${id}:${segment.id}`;
    adapterIds.set(ownId, segment.id);
    const ownSegment = { ...segment, id: ownId };
    collector.group.push(ownSegment);
    collector.segments.push(ownSegment);
  }
  if (adapterIds.size === 0) return false;
  collector.markdownTexts.push({ field, path, source, parsed, adapterIds });
  return true;
}

function getAtPath(root: unknown, path: readonly PathPart[]): unknown {
  let current = root;
  for (const part of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<PathPart, unknown>)[part];
  }
  return current;
}

function setAtPath(patch: Record<string, unknown>, location: SegmentLocation, translation: string): void {
  const last = location.path.at(-1);
  const parent = getAtPath(patch, location.path.slice(0, -1));
  if (last === undefined || typeof parent !== "object" || parent === null) {
    throw new Error(`[polystella-emdash] field "${location.field}" changed structure at ${formatPath(location.path)}`);
  }
  (parent as Record<PathPart, unknown>)[last] = translation;
}

function inputError(message: string, path: readonly PathPart[]): ContentTranslationInputError {
  return new ContentTranslationInputError(path.length > 1 ? `${message} at ${formatPath(path)}` : message);
}

/** `["body", 3, "cards", 0, "title"]` → `body[3].cards[0].title`. */
function formatPath(path: readonly PathPart[]): string {
  return path.map((part, index) => (typeof part === "number" ? `[${part}]` : index === 0 ? part : `.${part}`)).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPortableTextNode(value: unknown): value is Record<string, unknown> & { _type: string; _key: string } {
  return (
    isRecord(value) && typeof value._type === "string" && value._type.length > 0 && typeof value._key === "string" && value._key.length > 0
  );
}

function isPortableTextSpan(value: unknown): value is Record<string, unknown> & { _type: "span"; _key: string; text: string } {
  return (
    isPortableTextNode(value) &&
    value._type === "span" &&
    typeof value.text === "string" &&
    (value.marks === undefined || (Array.isArray(value.marks) && value.marks.every((mark) => typeof mark === "string")))
  );
}
