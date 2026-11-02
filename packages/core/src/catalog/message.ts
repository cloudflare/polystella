import { isPluralElement, isSelectElement, isTagElement, parse, TYPE, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import { IntlMessageFormat } from "intl-messageformat";

import { supportedLocaleTag } from "./locale-tags.js";

/** Values a message placeholder can receive. Dates and epoch milliseconds feed `date`/`time` placeholders. */
export type MessageValue = string | number | boolean | Date;

export type MessageValues = Readonly<Record<string, MessageValue>>;

/** A catalog string that is not a valid PolyStella message. `offset` points into the original string. */
export class MessageSyntaxError extends Error {
  readonly template: string;
  readonly reason: string;
  readonly offset: number | undefined;

  constructor(template: string, reason: string, offset?: number | undefined) {
    super(offset === undefined ? `[polystella] invalid message: ${reason}` : `[polystella] invalid message: ${reason} at offset ${offset}`);
    this.name = "MessageSyntaxError";
    this.template = template;
    this.reason = reason;
    this.offset = offset;
  }
}

interface ParsedMessage {
  ast: MessageFormatElement[];
  /** Strict ICU text produced by the converter, and per-unit maps back into the original string. */
  icu: string;
  starts: number[];
  ends: number[];
}

const PARSE_CACHE_LIMIT = 2000;
const FORMATTER_CACHE_LIMIT = 2000;
// shortcut: caches clear when full instead of evicting LRU; fine for catalog-sized key sets, revisit for unbounded templates.
const parseCache = new Map<string, ParsedMessage | MessageSyntaxError>();
const formatterCache = new Map<string, IntlMessageFormat>();

const SYNTAX_REASONS: Readonly<Record<string, string>> = {
  EXPECT_ARGUMENT_CLOSING_BRACE: "unclosed placeholder or branch",
  EMPTY_ARGUMENT: "empty placeholder",
  MALFORMED_ARGUMENT: "invalid placeholder name (use letters, digits and _)",
  EXPECT_ARGUMENT_TYPE: "missing placeholder type after the comma",
  INVALID_ARGUMENT_TYPE: "unknown placeholder type (use plural, select, selectordinal, number, date or time)",
  EXPECT_ARGUMENT_STYLE: "missing style after the placeholder type",
  INVALID_NUMBER_SKELETON: "invalid number skeleton",
  INVALID_DATE_TIME_SKELETON: "invalid date/time skeleton",
  EXPECT_SELECT_ARGUMENT_OPTIONS: "missing branches",
  EXPECT_PLURAL_ARGUMENT_SELECTOR: "missing plural branch name",
  EXPECT_SELECT_ARGUMENT_SELECTOR: "missing select branch name",
  EXPECT_PLURAL_ARGUMENT_SELECTOR_FRAGMENT: "plural branch must be wrapped in { }",
  EXPECT_SELECT_ARGUMENT_SELECTOR_FRAGMENT: "select branch must be wrapped in { }",
  INVALID_PLURAL_ARGUMENT_SELECTOR: "invalid plural branch name",
  DUPLICATE_PLURAL_ARGUMENT_SELECTOR: "duplicate plural branch",
  DUPLICATE_SELECT_ARGUMENT_SELECTOR: "duplicate select branch",
  MISSING_OTHER_CLAUSE: "plural/select needs an `other` branch",
};

/**
 * Rewrites PolyStella's message dialect (every placeholder wrapped in `{{ }}`, branch bodies in single
 * braces) into strict ICU MessageFormat. Single braces in plain text become quoted literals.
 */
export function toIcuMessage(template: string): string {
  return convert(template).icu.replace(/[\uE000\uE001]+/g, (run) => `'${restoreBraces(run)}'`);
}

/** Parses a catalog message. Throws `MessageSyntaxError` with an offset into `template`. */
export function parseMessage(template: string): MessageFormatElement[] {
  return parsed(template).ast;
}

/** Placeholder names used anywhere in a message, including inside branches. */
export function messageArgumentNames(template: string): Set<string> {
  return new Set(argumentKinds(parsed(template).ast).keys());
}

/**
 * Formats a catalog message. Missing or unusable values leave their placeholder visible as source
 * text instead of throwing. Throws `MessageSyntaxError` only when the template itself is invalid.
 */
export function formatMessage(template: string, values: MessageValues = {}, locale?: string | undefined): string {
  if (isPlainText(template)) return template;
  const message = parsed(template);
  const tag = supportedLocaleTag(locale);
  const unusable = unusableArguments(message.ast, values);
  try {
    if (unusable.size === 0) return stringify(cachedFormatter(template, message.ast, tag).format(values));
    const patched = replaceArguments(message.ast, unusable, (node) => sourceText(template, message, node));
    return stringify(new IntlMessageFormat(patched, tag).format(values));
  } catch {
    return template;
  }
}

/** True when `template` contains no braces or apostrophes, so formatting cannot change it. */
export function isPlainText(template: string): boolean {
  return !/[{}']/.test(template);
}

/** Kinds per placeholder name, e.g. `count → {"plural"}`, `total → {"argument", "number"}`. */
export function argumentKinds(ast: readonly MessageFormatElement[]): Map<string, Set<string>> {
  const kinds = new Map<string, Set<string>>();
  walk(ast, (node) => {
    const kind = nodeKind(node);
    if (kind === undefined || !("value" in node)) return;
    const set = kinds.get(node.value) ?? new Set<string>();
    set.add(kind);
    kinds.set(node.value, set);
  });
  return kinds;
}

/** Calls `visit` for every element, descending into plural/select branches and tags. */
export function walk(nodes: readonly MessageFormatElement[], visit: (node: MessageFormatElement) => void): void {
  for (const node of nodes) {
    visit(node);
    if (isPluralElement(node) || isSelectElement(node)) {
      for (const option of Object.values(node.options)) walk(option.value, visit);
    } else if (isTagElement(node)) walk(node.children, visit);
  }
}

function parsed(template: string): ParsedMessage {
  const cached = parseCache.get(template);
  if (cached instanceof MessageSyntaxError) throw cached;
  if (cached !== undefined) return cached;
  try {
    const converted = convert(template);
    const ast = parseIcu(template, converted);
    walk(ast, (node) => {
      if (node.type === TYPE.literal) node.value = restoreBraces(node.value);
    });
    const result = { ast, ...converted };
    remember(parseCache, template, result, PARSE_CACHE_LIMIT);
    return result;
  } catch (error) {
    if (error instanceof MessageSyntaxError) remember(parseCache, template, error, PARSE_CACHE_LIMIT);
    throw error;
  }
}

function parseIcu(template: string, converted: Omit<ParsedMessage, "ast">): MessageFormatElement[] {
  try {
    return parse(converted.icu, { ignoreTag: true, requiresOtherClause: true, captureLocation: true });
  } catch (error) {
    const kind = error instanceof Error ? error.message : String(error);
    const icuOffset = readLocationOffset(error);
    const offset = icuOffset === undefined ? undefined : (converted.starts[icuOffset] ?? template.length);
    throw new MessageSyntaxError(template, SYNTAX_REASONS[kind] ?? kind.toLowerCase().replaceAll("_", " "), offset);
  }
}

function readLocationOffset(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("location" in error)) return undefined;
  const location = error.location;
  if (typeof location !== "object" || location === null || !("start" in location)) return undefined;
  const start = location.start;
  if (typeof start !== "object" || start === null || !("offset" in start)) return undefined;
  return typeof start.offset === "number" ? start.offset : undefined;
}

type Frame = "argument" | "branch";

// Literal text braces travel through the ICU parser as private-use sentinels: quoting them as
// '{' breaks when the next character is an apostrophe ('{''s reads as an escaped quote).
const OPEN_BRACE = "\uE000";
const CLOSE_BRACE = "\uE001";

function restoreBraces(text: string): string {
  return text.replaceAll(OPEN_BRACE, "{").replaceAll(CLOSE_BRACE, "}");
}

function convert(template: string): Omit<ParsedMessage, "ast"> {
  let icu = "";
  const starts: number[] = [];
  const ends: number[] = [];
  const stack: Array<{ frame: Frame; offset: number }> = [];
  const emit = (text: string, start: number, end: number): void => {
    for (let index = 0; index < text.length; index++) {
      icu += text[index];
      starts.push(start);
      ends.push(end);
    }
  };
  const inText = (): boolean => stack.length === 0 || stack.at(-1)?.frame === "branch";

  let index = 0;
  while (index < template.length) {
    const char = template[index] ?? "";
    const next = template[index + 1];
    if (char === "'") {
      if (next === "'") {
        emit("''", index, index + 2);
        index += 2;
        continue;
      }
      if (next === "{" || next === "}" || (next === "#" && stack.some((entry) => entry.frame === "branch"))) {
        const close = template.indexOf("'", index + 1);
        const stop = close === -1 ? template.length : close + 1;
        for (let quoted = index; quoted < stop; quoted++) emit(template[quoted] ?? "", quoted, quoted + 1);
        index = stop;
        continue;
      }
      emit(char, index, index + 1);
      index += 1;
      continue;
    }
    if (inText()) {
      if (char === "{" && next === "{") {
        stack.push({ frame: "argument", offset: index });
        emit("{", index, index + 2);
        index += 2;
      } else if (char === "{") {
        emit(OPEN_BRACE, index, index + 1);
        index += 1;
      } else if (char === "}" && stack.at(-1)?.frame === "branch") {
        stack.pop();
        emit("}", index, index + 1);
        index += 1;
      } else if (char === "}") {
        emit(CLOSE_BRACE, index, index + 1);
        index += 1;
      } else {
        emit(char, index, index + 1);
        index += 1;
      }
      continue;
    }
    if (char === "}" && next === "}") {
      stack.pop();
      emit("}", index, index + 2);
      index += 2;
    } else if (char === "{") {
      stack.push({ frame: "branch", offset: index });
      emit("{", index, index + 1);
      index += 1;
    } else if (char === "}") {
      throw new MessageSyntaxError(template, "a placeholder must close with }}", index);
    } else {
      emit(char, index, index + 1);
      index += 1;
    }
  }
  const unclosed = stack.at(-1);
  if (unclosed !== undefined) {
    throw new MessageSyntaxError(template, unclosed.frame === "argument" ? "unclosed {{" : "unclosed branch {", unclosed.offset);
  }
  return { icu, starts, ends };
}

function nodeKind(node: MessageFormatElement): string | undefined {
  switch (node.type) {
    case TYPE.argument:
      return "argument";
    case TYPE.number:
    case TYPE.date:
    case TYPE.time: {
      const name = node.type === TYPE.number ? "number" : node.type === TYPE.date ? "date" : "time";
      const style = styleKey(node.style);
      return style.length === 0 ? name : `${name}, ${style}`;
    }
    case TYPE.select:
      return "select";
    case TYPE.plural: {
      const name = node.pluralType === "ordinal" ? "selectordinal" : "plural";
      return node.offset === 0 ? name : `${name} offset:${node.offset}`;
    }
    default:
      return undefined;
  }
}

function styleKey(style: unknown): string {
  if (typeof style === "string") return style;
  if (typeof style !== "object" || style === null) return "";
  if ("tokens" in style) return `::${JSON.stringify(style.tokens)}`;
  if ("pattern" in style && typeof style.pattern === "string") return `::${style.pattern}`;
  return "";
}

function unusableArguments(ast: readonly MessageFormatElement[], values: MessageValues): Set<string> {
  const unusable = new Set<string>();
  walk(ast, (node) => {
    if (node.type === TYPE.literal || node.type === TYPE.pound || node.type === TYPE.tag) return;
    if (!Object.hasOwn(values, node.value)) {
      unusable.add(node.value);
      return;
    }
    const value = values[node.value];
    const numeric = typeof value === "number" || (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)));
    if ((node.type === TYPE.plural || node.type === TYPE.number) && !numeric) unusable.add(node.value);
    if ((node.type === TYPE.date || node.type === TYPE.time) && !(value instanceof Date ? !Number.isNaN(value.getTime()) : numeric)) {
      unusable.add(node.value);
    }
  });
  return unusable;
}

function replaceArguments(
  nodes: readonly MessageFormatElement[],
  names: ReadonlySet<string>,
  source: (node: MessageFormatElement) => string,
): MessageFormatElement[] {
  return nodes.map((node): MessageFormatElement => {
    if (node.type === TYPE.literal || node.type === TYPE.pound) return node;
    if (node.type === TYPE.tag) return { ...node, children: replaceArguments(node.children, names, source) };
    if (names.has(node.value)) return { type: TYPE.literal, value: source(node) };
    if (isPluralElement(node) || isSelectElement(node)) {
      const options = Object.fromEntries(
        Object.entries(node.options).map(([key, option]) => [key, { ...option, value: replaceArguments(option.value, names, source) }]),
      );
      return { ...node, options };
    }
    return node;
  });
}

function sourceText(template: string, message: ParsedMessage, node: MessageFormatElement): string {
  if (node.type === TYPE.argument) return `{{${node.value}}}`;
  const location = node.location;
  if (location === undefined) return "value" in node ? `{{${node.value}}}` : "";
  const start = message.starts[location.start.offset];
  const end = message.ends[location.end.offset - 1];
  return start === undefined || end === undefined ? "" : template.slice(start, end);
}

function cachedFormatter(template: string, ast: MessageFormatElement[], locale: string | undefined): IntlMessageFormat {
  const key = `${locale ?? ""}\u0000${template}`;
  const cached = formatterCache.get(key);
  if (cached !== undefined) return cached;
  const formatter = new IntlMessageFormat(ast, locale);
  remember(formatterCache, key, formatter, FORMATTER_CACHE_LIMIT);
  return formatter;
}

function remember<V>(cache: Map<string, V>, key: string, value: V, limit: number): void {
  if (cache.size >= limit) cache.clear();
  cache.set(key, value);
}

function stringify(result: unknown): string {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return result.map((part) => String(part)).join("");
  return String(result);
}
