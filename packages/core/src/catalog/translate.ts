import { isPluralElement, isSelectElement, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import pRetry from "p-retry";

import { packGroupsIntoBatches } from "../batch.js";
import type { Glossary } from "../glossary.js";
import { assertUniqueSegmentIds, type Segment } from "../segment.js";
import { translateBatch, type TranslateBatchAttemptEvent, type TranslateBatchRetryEvent } from "../translate-batch.js";
import { isPermanentProviderError, type Translator } from "../translator.js";

import { pluralCategories } from "./locale-tags.js";
import { argumentKinds, MessageSyntaxError, parseMessage, walk } from "./message.js";

const TOKEN_RE = /\{\{(\w+)\}\}/g;

export const DEFAULT_UI_STRING_BATCH_SIZE = 25;

export function extractTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of text.matchAll(TOKEN_RE)) {
    if (match[1] !== undefined) tokens.add(match[1]);
  }
  return tokens;
}

export interface TokenValidationIssue {
  key: string;
  missing: string[];
  spurious: string[];
  /** Message-structure problems beyond placeholder names (syntax, plural/select branches, types). */
  problems?: string[] | undefined;
}

export function validateTokenPreservation(key: string, source: string, translation: string): TokenValidationIssue | null {
  const sourceTokens = extractTokens(source);
  const translationTokens = extractTokens(translation);
  const missing = [...sourceTokens].filter((token) => !translationTokens.has(token)).sort();
  const spurious = [...translationTokens].filter((token) => !sourceTokens.has(token)).sort();
  return missing.length === 0 && spurious.length === 0 ? null : { key, missing, spurious };
}

/** Problems in one message on its own: invalid syntax, or plural branches `tag` never selects. */
export function validateMessage(template: string, tag: string): string[] {
  let ast: MessageFormatElement[];
  try {
    ast = parseMessage(template);
  } catch (error) {
    return [describeSyntaxError(error)];
  }
  return [...swallowedPlaceholderProblems(template, ast), ...branchProblems(ast, undefined, tag, false)];
}

/**
 * Validates a catalog translation against its source message: it parses, uses the same placeholder
 * names and types, keeps select keys and `=N` branches, and uses exactly the target locale's plural
 * categories. Sources that are not valid messages fall back to `validateTokenPreservation`.
 */
export function validateMessageTranslation(
  key: string,
  source: string,
  translation: string,
  targetTag: string,
): TokenValidationIssue | null {
  let sourceAst: MessageFormatElement[];
  try {
    sourceAst = parseMessage(source);
  } catch {
    return validateTokenPreservation(key, source, translation);
  }
  let translationAst: MessageFormatElement[];
  try {
    translationAst = parseMessage(translation);
  } catch (error) {
    return { key, missing: [], spurious: [], problems: [describeSyntaxError(error)] };
  }

  const sourceKinds = argumentKinds(sourceAst);
  const translationKinds = argumentKinds(translationAst);
  const missing = [...sourceKinds.keys()].filter((name) => !translationKinds.has(name)).sort();
  const spurious = [...translationKinds.keys()].filter((name) => !sourceKinds.has(name)).sort();
  const problems = [...swallowedPlaceholderProblems(translation, translationAst)];
  for (const [name, kinds] of sourceKinds) {
    const translated = translationKinds.get(name);
    if (translated === undefined) continue;
    const from = describeKinds(kinds);
    const to = describeKinds(translated);
    if (from !== to) problems.push(`{{${name}}} changed from ${from} to ${to}`);
  }
  problems.push(...branchProblems(translationAst, sourceAst, targetTag, true));
  return missing.length === 0 && spurious.length === 0 && problems.length === 0
    ? null
    : { key, missing, spurious, ...(problems.length > 0 ? { problems } : {}) };
}

/** `true` when `template` is a valid message containing plural, select or selectordinal. */
export function hasBranchingMessage(template: string): boolean {
  try {
    return [...argumentKinds(parseMessage(template)).values()].some((kinds) =>
      [...kinds].some((kind) => kind.startsWith("plural") || kind.startsWith("select")),
    );
  } catch {
    return false;
  }
}

function describeSyntaxError(error: unknown): string {
  if (error instanceof MessageSyntaxError) {
    return error.offset === undefined ? `invalid message: ${error.reason}` : `invalid message: ${error.reason} at offset ${error.offset}`;
  }
  throw error;
}

// The parsed argument set misses a `{{name}}` that is visibly there: an apostrophe quoted it away.
function swallowedPlaceholderProblems(template: string, ast: readonly MessageFormatElement[]): string[] {
  const parsedNames = argumentKinds(ast);
  return [...extractTokens(template)]
    .filter((name) => !parsedNames.has(name))
    .map((name) => `an apostrophe hides {{${name}}}; write '' before it`);
}

function describeKinds(kinds: ReadonlySet<string>): string {
  const typed = [...kinds].filter((kind) => kind !== "argument");
  return (typed.length > 0 ? typed : [...kinds]).sort().join(" + ");
}

interface BranchSet {
  type: "plural" | "selectordinal" | "select";
  keys: Set<string>;
}

function branchSets(ast: readonly MessageFormatElement[]): Map<string, BranchSet[]> {
  const sets = new Map<string, BranchSet[]>();
  walk(ast, (node) => {
    if (!isPluralElement(node) && !isSelectElement(node)) return;
    const type = isSelectElement(node) ? "select" : node.pluralType === "ordinal" ? "selectordinal" : "plural";
    const list = sets.get(node.value) ?? [];
    list.push({ type, keys: new Set(Object.keys(node.options)) });
    sets.set(node.value, list);
  });
  return sets;
}

function branchProblems(
  ast: readonly MessageFormatElement[],
  sourceAst: readonly MessageFormatElement[] | undefined,
  tag: string,
  requireAllCategories: boolean,
): string[] {
  const problems: string[] = [];
  const sourceSets = sourceAst === undefined ? new Map<string, BranchSet[]>() : branchSets(sourceAst);
  for (const [name, sets] of branchSets(ast)) {
    for (const { type, keys } of sets) {
      const sourceKeys = new Set((sourceSets.get(name) ?? []).filter((set) => set.type === type).flatMap((set) => [...set.keys]));
      if (type === "select") {
        if (sourceAst === undefined) continue;
        const added = [...keys].filter((key) => !sourceKeys.has(key));
        const removed = [...sourceKeys].filter((key) => !keys.has(key));
        if (added.length > 0 || removed.length > 0) {
          problems.push(`{{${name}}} select branches must match the source (${[...sourceKeys].sort().join(", ")})`);
        }
        continue;
      }
      const categories = pluralCategories(tag, type === "plural" ? "cardinal" : "ordinal");
      const invalid = [...keys].filter((key) => !key.startsWith("=") && !categories.includes(key));
      if (invalid.length > 0)
        problems.push(`{{${name}}} ${type} branch ${invalid.join(", ")} is never used in ${tag} (use ${categories.join(", ")})`);
      const lacking = requireAllCategories ? categories.filter((category) => !keys.has(category)) : [];
      if (lacking.length > 0) problems.push(`{{${name}}} ${type} is missing ${lacking.join(", ")} for ${tag}`);
      const exactLost = [...sourceKeys].filter((key) => key.startsWith("=") && !keys.has(key));
      if (exactLost.length > 0) problems.push(`{{${name}}} ${type} lost exact branch ${exactLost.join(", ")}`);
    }
  }
  return problems;
}

/**
 * The token rule, plus an apostrophe rule when sources contain placeholders and an ICU rule listing
 * `targetTag`'s plural categories when sources contain plural/select/selectordinal.
 */
export function withMessageRules(glossary: Glossary, sources: readonly string[], targetTag: string): Glossary {
  const base = withTokenPreservationRule(glossary);
  const styleRules = [...base.styleRules];
  if (sources.some((source) => source.includes("{{"))) {
    styleRules.push({
      category: "apostrophes",
      instruction:
        "An apostrophe written directly before `{{`, before `}` or before `#` inside a plural branch must be doubled (`''`). Everywhere else write a single apostrophe.",
      example: "the {{company}} team -> l''équipe {{company}}",
    });
  }
  const branching = sources.filter(hasBranchingMessage);
  if (branching.length > 0) {
    const ordinal = branching.some((source) => source.includes("selectordinal"));
    styleRules.push({
      category: "icu-messages",
      instruction: [
        "Some strings are ICU messages such as `{{count, plural, one {...} other {...}}}`. Keep the double outer braces, the placeholder name, the keyword (plural, select, selectordinal) and the single braces around each branch; translate only the text inside the branches.",
        "`#` inside a plural branch stands for the number. Keep select keys and exact `=N` branches as written.",
        `For plural, write exactly these branches for ${targetTag}: ${pluralCategories(targetTag).join(", ")}.`,
        ...(ordinal
          ? [`For selectordinal, write exactly these branches for ${targetTag}: ${pluralCategories(targetTag, "ordinal").join(", ")}.`]
          : []),
      ].join(" "),
      example: "{{count, plural, =0 {No roles} one {# role} other {# roles}}}",
    });
  }
  return { ...base, styleRules };
}

export interface CatalogTranslationEntry {
  key: string;
  source: string;
}

export type EmptyKeyPair = CatalogTranslationEntry;

export function selectEmptyKeys(sourceDict: Record<string, string>, localeDict: Record<string, string>): EmptyKeyPair[] {
  const pairs: EmptyKeyPair[] = [];
  for (const [key, source] of Object.entries(sourceDict)) {
    if (source.length > 0 && (!Object.hasOwn(localeDict, key) || !localeDict[key])) pairs.push({ key, source });
  }
  return pairs;
}

export function withTokenPreservationRule(glossary: Glossary): Glossary {
  return {
    ...glossary,
    styleRules: [
      ...glossary.styleRules,
      {
        category: "placeholders",
        instruction:
          "Preserve every `{{token}}` placeholder verbatim - same name, same braces, same position relative to the surrounding text. Do not translate, rename, or remove them.",
        example: "Copyright ©{{year}}. -> Copyright ©{{year}}.",
      },
    ],
  };
}

export interface CatalogTranslationOptions {
  translator: Translator;
  glossary: Glossary;
  /** BCP 47 tag of the source strings; names the language in the prompt. */
  sourceLocale: string;
  /** BCP 47 tag of the translation; names the language and selects its plural categories. */
  targetLocale: string;
  context?: string | undefined;
  maxRetries?: number | undefined;
  retryMinTimeoutMs?: number | undefined;
  retryFactor?: number | undefined;
  retryRandomize?: boolean | undefined;
  inputTokenBudget?: number | undefined;
  maxSegmentsPerBatch?: number | undefined;
  signal?: AbortSignal | undefined;
  onRetry?: ((event: TranslateBatchRetryEvent) => void) | undefined;
  onBatchAttempt?: ((event: TranslateBatchAttemptEvent) => void) | undefined;
}

export interface TranslateCatalogEntriesOptions extends CatalogTranslationOptions {
  entries: readonly CatalogTranslationEntry[];
}

export interface TranslateCatalogEntriesResult {
  translations: Map<string, string>;
  tokenFailures: TokenValidationIssue[];
  batchCount: number;
}

export interface TranslateUiStringsOptions extends CatalogTranslationOptions {
  sourceDict: Record<string, string>;
  localeDict: Record<string, string>;
}

export interface TranslateUiStringsResult {
  dict: Record<string, string>;
  filled: string[];
  tokenFailures: TokenValidationIssue[];
  batchCount: number;
}

export async function translateCatalogEntries(opts: TranslateCatalogEntriesOptions): Promise<TranslateCatalogEntriesResult> {
  assertUniqueSegmentIds(opts.entries.map(({ key }) => key));
  const entries = opts.entries.filter(({ source }) => source.length > 0);
  if (entries.length === 0) return { translations: new Map(), tokenFailures: [], batchCount: 0 };

  const keysById = new Map<string, string>();
  const segments = entries.map(({ key, source }, index) => {
    const id = `catalog:${index}`;
    keysById.set(id, key);
    return { id, text: source };
  });
  const batches = packUiStringBatches(segments, opts);
  const translations = new Map<string, string>();
  const tokenFailures: TokenValidationIssue[] = [];

  for (const segments of batches) {
    opts.signal?.throwIfAborted();
    const glossary = withMessageRules(
      opts.glossary,
      segments.map(({ text }) => text),
      opts.targetLocale,
    );
    const result = await translateUiBatchWithRetries({ ...opts, segments, glossary, keysById });
    const failedKeys = new Set(result.tokenFailures.map(({ key }) => key));
    for (const [id, text] of result.translations) {
      const key = keysById.get(id);
      if (key === undefined) throw new Error(`[polystella] missing catalog key for internal segment id "${id}"`);
      if (!failedKeys.has(key)) translations.set(key, text);
    }
    tokenFailures.push(...result.tokenFailures);
  }

  return { translations, tokenFailures, batchCount: batches.length };
}

export async function translateUiStringsForLocale(opts: TranslateUiStringsOptions): Promise<TranslateUiStringsResult> {
  const emptyKeys = selectEmptyKeys(opts.sourceDict, opts.localeDict);
  const dict = { ...opts.localeDict };
  if (emptyKeys.length === 0) return { dict, filled: [], tokenFailures: [], batchCount: 0 };

  const result = await translateCatalogEntries({ ...opts, entries: emptyKeys });
  const failedKeys = new Set(result.tokenFailures.map(({ key }) => key));
  const filled: string[] = [];
  for (const { key } of emptyKeys) {
    const value = result.translations.get(key);
    if (!failedKeys.has(key) && value !== undefined) {
      dict[key] = value;
      filled.push(key);
    }
  }

  return { dict, filled: filled.sort(), tokenFailures: result.tokenFailures, batchCount: result.batchCount };
}

function packUiStringBatches(
  segments: Segment[],
  opts: Pick<CatalogTranslationOptions, "inputTokenBudget" | "maxSegmentsPerBatch">,
): Segment[][] {
  const tokenBatches = packGroupsIntoBatches(
    segments.map((segment) => [segment]),
    opts.inputTokenBudget === undefined ? {} : { inputTokenBudget: opts.inputTokenBudget },
  );
  const requestedMax = opts.maxSegmentsPerBatch ?? DEFAULT_UI_STRING_BATCH_SIZE;
  const maxSegments = Number.isFinite(requestedMax) ? Math.max(1, Math.floor(requestedMax)) : DEFAULT_UI_STRING_BATCH_SIZE;
  const batches: Segment[][] = [];

  for (const tokenBatch of tokenBatches) {
    for (let index = 0; index < tokenBatch.length; index += maxSegments) {
      batches.push(tokenBatch.slice(index, index + maxSegments));
    }
  }
  return batches;
}

type TranslateUiBatchOptions = Pick<
  CatalogTranslationOptions,
  | "translator"
  | "sourceLocale"
  | "targetLocale"
  | "context"
  | "maxRetries"
  | "retryMinTimeoutMs"
  | "retryFactor"
  | "retryRandomize"
  | "signal"
  | "onRetry"
  | "onBatchAttempt"
> & {
  segments: Segment[];
  glossary: Glossary;
  keysById: ReadonlyMap<string, string>;
};

interface TranslateUiBatchResult {
  translations: Map<string, string>;
  tokenFailures: TokenValidationIssue[];
}

class TokenValidationError extends Error {
  constructor(
    readonly translations: Map<string, string>,
    readonly issues: TokenValidationIssue[],
  ) {
    super(
      `[polystella] token-preservation validation failed for ${issues.length} key(s): ${issues.map(formatTokenValidationIssue).join("; ")}`,
    );
    this.name = "TokenValidationError";
  }
}

/** One-line description of a failed key, e.g. `roles (missing: [count], spurious: []; plural is missing few for pl)`. */
export function formatTokenValidationIssue({ key, missing, spurious, problems }: TokenValidationIssue): string {
  const details = [`missing: [${missing.join(", ")}], spurious: [${spurious.join(", ")}]`, ...(problems ?? [])];
  return `${key} (${details.join("; ")})`;
}

class RetriableTypeError extends Error {
  constructor(readonly originalError: TypeError) {
    super(originalError.message, { cause: originalError });
    this.name = "RetriableTypeError";
  }
}

async function translateUiBatchWithRetries(opts: TranslateUiBatchOptions): Promise<TranslateUiBatchResult> {
  const maxRetries = opts.maxRetries ?? 0;
  const totalAttempts = Math.max(1, maxRetries + 1);

  try {
    const translations = await pRetry(
      async () => {
        try {
          const result = await translateBatch({
            translator: opts.translator,
            segments: opts.segments,
            glossary: opts.glossary,
            sourceLocale: opts.sourceLocale,
            targetLocale: opts.targetLocale,
            maxRetries: 0,
            ...(opts.onBatchAttempt === undefined ? {} : { onBatchAttempt: opts.onBatchAttempt }),
            ...(opts.context === undefined ? {} : { context: opts.context }),
            ...(opts.signal === undefined ? {} : { signal: opts.signal }),
          });
          const issues = opts.segments.flatMap((segment) => {
            const translation = result.get(segment.id);
            if (translation === undefined) return [];
            const key = opts.keysById.get(segment.id);
            if (key === undefined) throw new Error(`[polystella] missing catalog key for internal segment id "${segment.id}"`);
            const issue = validateMessageTranslation(key, segment.text, translation, opts.targetLocale);
            return issue === null ? [] : [issue];
          });
          if (issues.length > 0) throw new TokenValidationError(result, issues);
          return result;
        } catch (error) {
          throw error instanceof TypeError && !isPermanentProviderError(error) ? new RetriableTypeError(error) : error;
        }
      },
      {
        retries: maxRetries,
        minTimeout: opts.retryMinTimeoutMs ?? 0,
        factor: opts.retryFactor ?? 2,
        randomize: opts.retryRandomize ?? false,
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
        shouldRetry: ({ error }) => !isPermanentProviderError(error),
        onFailedAttempt: ({ error, attemptNumber, retriesLeft }) => {
          if (retriesLeft > 0 && !isPermanentProviderError(error)) {
            opts.onRetry?.({
              attempt: attemptNumber,
              totalAttempts,
              error: error instanceof RetriableTypeError ? error.originalError : error,
            });
          }
        },
      },
    );
    return { translations, tokenFailures: [] };
  } catch (error) {
    if (error instanceof TokenValidationError) {
      return { translations: error.translations, tokenFailures: error.issues };
    }
    if (error instanceof RetriableTypeError) throw error.originalError;
    throw error;
  }
}
