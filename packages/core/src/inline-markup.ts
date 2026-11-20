/**
 * Inline markup a segment carries: `html` masks tags such as `<gradient>…</gradient>`;
 * `markdown` also masks links, images, emphasis, code spans and escapes.
 */
export type InlineMarkup = "html" | "markdown";

interface MarkupToken {
  value: string;
  role: "open" | "close" | "standalone";
  /** Index of the paired token, for `open` and `close`. */
  pair?: number;
}

/** Segment text with its inline markup swapped for `{{ps_N}}` placeholders. */
export interface MaskedText {
  text: string;
  tokens: readonly MarkupToken[];
}

export type RestoredText = { text: string; problems?: undefined } | { text?: undefined; problems: string[] };

const TOKEN_PATTERN = /\{\{ps_(\d+)\}\}/g;
const TAG_PATTERN = /<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*?)?\/?>/g;

export const INLINE_MARKUP_PROMPT_RULE =
  "Some segments contain placeholders like {{ps_1}} that stand for formatting or links. Copy every placeholder exactly once and never translate it. A pair like {{ps_1}}text{{ps_2}} wraps text: keep the translation of that text between the same two placeholders, in the same order. You may move placeholders to fit the target language's word order.";

/** Returns `null` when the text has no markup to protect. */
export function maskInlineMarkup(source: string, markup: InlineMarkup): MaskedText | null {
  // shortcut: text that already contains our placeholder syntax is sent unmasked; switch tokens if real content needs it.
  if (/\{\{ps_\d+\}\}/.test(source)) return null;
  const tokens: MarkupToken[] = [];
  const token = (value: string, role: MarkupToken["role"], pair?: number): string => {
    tokens.push({ value, role, ...(pair === undefined ? {} : { pair }) });
    return `{{ps_${tokens.length}}}`;
  };
  const wrap = (open: string, inner: string, close: string): string => {
    const openIndex = tokens.length;
    const openToken = token(open, "open", openIndex + 1);
    const closeToken = token(close, "close", openIndex);
    return `${openToken}${inner}${closeToken}`;
  };

  let text = source;
  if (markup === "markdown") {
    text = text
      .replace(/(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g, (code) => token(code, "standalone"))
      .replace(/\\[\\`*_{}[\]()#+\-.!<>~|]/g, (escape) => token(escape, "standalone"))
      .replace(/<(?:https?:\/\/|mailto:)[^\s<>]+>/g, (autolink) => token(autolink, "standalone"));
  }
  text = maskTags(text, token, wrap);
  if (markup === "markdown") {
    text = text
      .replace(/\[\^[^\]\s]+\]/g, (footnote) => token(footnote, "standalone"))
      .replace(/(!?\[)([^[\]]*)(\]\([^()\s]*(?:\s+"[^"]*")?\)|\]\[[^[\]]*\])/g, (_whole, open: string, inner: string, close: string) =>
        wrap(open, inner, close),
      );
    for (const pattern of [
      /(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g,
      /(?<![\w*])(\*)(?=[^\s*])([\s\S]*?[^\s*])\*(?![\w*])/g,
      /(?<![\w])(_)(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)/g,
    ]) {
      let previous: string;
      do {
        previous = text;
        text = text.replace(pattern, (_whole, marker: string, inner: string) => wrap(marker, inner, marker));
      } while (text !== previous);
    }
  }
  return tokens.length === 0 ? null : renumberInReadingOrder(text, tokens);
}

/** Masking runs in passes, so numbers are reassigned to read 1, 2, 3… from the start of the text. */
function renumberInReadingOrder(text: string, tokens: readonly MarkupToken[]): MaskedText {
  const order = [...text.matchAll(TOKEN_PATTERN)].map((match) => Number(match[1]) - 1);
  const newIndex = new Map(order.map((oldIndex, index) => [oldIndex, index]));
  const renumbered = order.map((oldIndex): MarkupToken => {
    const { value, role, pair } = tokens[oldIndex] ?? { value: "", role: "standalone" };
    const newPair = pair === undefined ? undefined : newIndex.get(pair);
    return { value, role, ...(newPair === undefined ? {} : { pair: newPair }) };
  });
  return {
    text: text.replace(TOKEN_PATTERN, (_whole, digits: string) => `{{ps_${(newIndex.get(Number(digits) - 1) ?? 0) + 1}}}`),
    tokens: renumbered,
  };
}

/** Puts the markup back, or lists what the translation lost, duplicated, reordered or emptied. */
export function restoreInlineMarkup(translation: string, masked: MaskedText): RestoredText {
  const problems: string[] = [];
  const seen = new Map<number, number>();
  const order: number[] = [];
  for (const match of translation.matchAll(TOKEN_PATTERN)) {
    const index = Number(match[1]) - 1;
    if (masked.tokens[index] === undefined) problems.push(`${match[0]} is not in the source`);
    else {
      seen.set(index, (seen.get(index) ?? 0) + 1);
      order.push(index);
    }
  }
  for (const [index] of masked.tokens.entries()) {
    const count = seen.get(index) ?? 0;
    if (count === 0) problems.push(`missing {{ps_${index + 1}}}`);
    if (count > 1) problems.push(`{{ps_${index + 1}}} appears ${count} times`);
  }
  if (problems.length === 0 && nestsCorrectly(sourceOrder(masked), masked.tokens)) {
    const nesting = nestingProblem(order, masked.tokens);
    problems.push(...(nesting === null ? emptiedPairs(translation, masked) : [nesting]));
  }
  if (problems.length > 0) return { problems };
  return { text: translation.replace(TOKEN_PATTERN, (_whole, digits: string) => masked.tokens[Number(digits) - 1]?.value ?? "") };
}

function maskTags(
  text: string,
  token: (value: string, role: MarkupToken["role"], pair?: number) => string,
  wrap: (open: string, inner: string, close: string) => string,
): string {
  const tags = [...text.matchAll(TAG_PATTERN)].map((match) => ({
    value: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
  const pairs = new Map<number, number>();
  const openStack: number[] = [];
  for (const [index, tag] of tags.entries()) {
    if (tag.value.endsWith("/>")) continue;
    const name = /^<\/?([^\s/>]+)/.exec(tag.value)?.[1];
    if (!tag.value.startsWith("</")) openStack.push(index);
    else {
      const openPosition = openStack.findLastIndex((open) => /^<([^\s/>]+)/.exec(tags[open]?.value ?? "")?.[1] === name);
      if (openPosition === -1) continue;
      const [open] = openStack.splice(openPosition);
      if (open !== undefined) pairs.set(open, index);
    }
  }
  const build = (from: number, to: number, cursor: number, limit: number): string => {
    let out = "";
    for (let index = from; index < to; index += 1) {
      const tag = tags[index];
      if (tag === undefined || tag.start < cursor) continue;
      out += text.slice(cursor, tag.start);
      const close = pairs.get(index);
      const closeTag = close === undefined ? undefined : tags[close];
      if (close !== undefined && closeTag !== undefined) {
        out += wrap(tag.value, build(index + 1, close, tag.end, closeTag.start), closeTag.value);
        cursor = closeTag.end;
      } else {
        out += token(tag.value, "standalone");
        cursor = tag.end;
      }
    }
    return out + text.slice(cursor, limit);
  };
  return build(0, tags.length, 0, text.length);
}

function sourceOrder(masked: MaskedText): number[] {
  return [...masked.text.matchAll(TOKEN_PATTERN)].map((match) => Number(match[1]) - 1);
}

function nestsCorrectly(order: readonly number[], tokens: readonly MarkupToken[]): boolean {
  return nestingProblem(order, tokens) === null;
}

function nestingProblem(order: readonly number[], tokens: readonly MarkupToken[]): string | null {
  const open: number[] = [];
  for (const index of order) {
    const token = tokens[index];
    if (token?.role === "open") open.push(index);
    else if (token?.role === "close") {
      if (open.at(-1) !== token.pair) return `{{ps_${index + 1}}} must close {{ps_${(token.pair ?? 0) + 1}}}, which has to come before it`;
      open.pop();
    }
  }
  return null;
}

function emptiedPairs(translation: string, masked: MaskedText): string[] {
  const problems: string[] = [];
  for (const [index, token] of masked.tokens.entries()) {
    const pair = token.pair;
    if (token.role !== "open" || pair === undefined) continue;
    const between = (text: string): string | undefined => {
      const start = text.indexOf(`{{ps_${index + 1}}}`);
      const end = text.indexOf(`{{ps_${pair + 1}}}`);
      return start === -1 || end === -1
        ? undefined
        : text
            .slice(start, end)
            .replace(/^\{\{ps_\d+\}\}/, "")
            .replace(TOKEN_PATTERN, "");
    };
    if (between(masked.text)?.trim() && !between(translation)?.trim()) {
      problems.push(`the text between {{ps_${index + 1}}} and {{ps_${pair + 1}}} is empty`);
    }
  }
  return problems;
}
