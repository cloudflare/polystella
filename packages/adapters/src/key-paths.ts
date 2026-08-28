import picomatch from "picomatch";

export type PathSegment = string | number;

const FORBIDDEN_SEGMENT_NAMES = new Set(["__proto__", "prototype", "constructor"]);
const patternMatcherCache = new Map<string, (path: string) => boolean>();

export function parsePath(path: string): { segments: (PathSegment | "*")[]; hasWildcard: boolean } {
  if (path.length === 0) throw new Error(`[polystella] empty key path is invalid`);
  const segments: (PathSegment | "*")[] = [];
  let hasWildcard = false;
  let index = 0;

  while (index < path.length) {
    if (path[index] === ".") {
      throw new Error(`[polystella] malformed key path "${path}": unexpected "." at index ${index}`);
    }
    if (path[index] === "[") {
      const closeIndex = path.indexOf("]", index);
      if (closeIndex === -1) {
        throw new Error(`[polystella] malformed key path "${path}": unclosed "[" at index ${index}`);
      }
      const inner = path.slice(index + 1, closeIndex);
      if (inner === "*") {
        segments.push("*");
        hasWildcard = true;
      } else if (/^\d+$/.test(inner)) {
        segments.push(Number(inner));
      } else {
        throw new Error(`[polystella] malformed key path "${path}": "[${inner}]" must be a non-negative integer or "*"`);
      }
      index = closeIndex + 1;
      if (index < path.length && path[index] === ".") {
        index++;
        if (index === path.length) throw new Error(`[polystella] malformed key path "${path}": trailing "."`);
      }
      continue;
    }

    let end = index;
    while (end < path.length && path[end] !== "." && path[end] !== "[") end++;
    const key = path.slice(index, end);
    if (key.length === 0) {
      throw new Error(`[polystella] malformed key path "${path}": empty segment near index ${index}`);
    }
    if (key === "*") {
      segments.push("*");
      hasWildcard = true;
    } else {
      assertSafeSegment(key, path);
      segments.push(key);
    }
    index = end;
    if (index < path.length && path[index] === ".") {
      index++;
      if (index === path.length) throw new Error(`[polystella] malformed key path "${path}": trailing "."`);
    }
  }

  return { segments, hasWildcard };
}

export function formatPath(segments: readonly PathSegment[]): string {
  let output = "";
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (segment === undefined) continue;
    output += typeof segment === "number" ? `[${segment}]` : index === 0 ? segment : `.${segment}`;
  }
  return output;
}

export function expandPath(path: string, data: unknown): string[] {
  const { segments, hasWildcard } = parsePath(path);
  return hasWildcard ? expandSegments(segments, data, []) : [path];
}

export function readAtPath(node: unknown, segments: readonly PathSegment[]): unknown {
  let current = node;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
    } else {
      if (typeof current !== "object" || !Object.hasOwn(current, segment)) return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

export function writeAtPath(node: unknown, segments: readonly PathSegment[], value: unknown): void {
  if (segments.length === 0) throw new Error(`[polystella] cannot write at empty path`);
  let current = node;
  for (let index = 0; index < segments.length - 1; index++) {
    const segment = segments[index];
    if (segment === undefined) continue;
    if (current === null || current === undefined) {
      throw new Error(`[polystella] cannot write at ${formatPath(segments)}: parent is null/undefined at segment ${index}`);
    }
    if (typeof segment === "number") {
      if (!Array.isArray(current)) {
        throw new Error(`[polystella] cannot write at ${formatPath(segments)}: expected array at segment ${index}, got ${typeof current}`);
      }
      current = current[segment];
    } else {
      if (typeof current !== "object") {
        throw new Error(`[polystella] cannot write at ${formatPath(segments)}: expected object at segment ${index}, got ${typeof current}`);
      }
      current = Object.hasOwn(current, segment) ? (current as Record<string, unknown>)[segment] : undefined;
    }
  }

  const last = segments.at(-1);
  if (last === undefined) throw new Error(`[polystella] cannot write at empty path`);
  if (current === null || current === undefined) {
    throw new Error(`[polystella] cannot write at ${formatPath(segments)}: terminal parent is null/undefined`);
  }
  if (typeof last === "number") {
    if (!Array.isArray(current)) {
      throw new Error(`[polystella] cannot write at ${formatPath(segments)}: expected array as terminal parent`);
    }
    current[last] = value;
  } else {
    if (typeof current !== "object") {
      throw new Error(`[polystella] cannot write at ${formatPath(segments)}: expected object as terminal parent`);
    }
    if (FORBIDDEN_SEGMENT_NAMES.has(last)) {
      throw new Error(`[polystella] cannot write at ${formatPath(segments)}: terminal segment "${last}" is reserved (prototype-chain).`);
    }
    (current as Record<string, unknown>)[last] = value;
  }
}

export function resolveConcretePaths(options: {
  parsed: unknown;
  sourcePath: string;
  translatableKeys: Record<string, string[]>;
}): string[] {
  const matchedRules: string[] = [];
  for (const [pattern, paths] of Object.entries(options.translatableKeys)) {
    if (!getMatcher(pattern)(options.sourcePath)) continue;
    for (const path of paths) {
      if (!matchedRules.includes(path)) matchedRules.push(path);
    }
  }

  const concrete: string[] = [];
  const seen = new Set<string>();
  for (const rule of matchedRules) {
    for (const expanded of expandPath(rule, options.parsed)) {
      if (seen.has(expanded)) continue;
      seen.add(expanded);
      concrete.push(expanded);
    }
  }
  return concrete;
}

function assertSafeSegment(segment: string, path: string): void {
  if (FORBIDDEN_SEGMENT_NAMES.has(segment)) {
    throw new Error(
      `[polystella] key path "${path}" contains reserved segment "${segment}". ` +
        `Segments named __proto__, prototype, or constructor are rejected because they traverse the JavaScript prototype chain.`,
    );
  }
}

function expandSegments(segments: readonly (PathSegment | "*")[], node: unknown, path: PathSegment[]): string[] {
  if (segments.length === 0) return [formatPath(path)];
  const [head, ...rest] = segments;
  if (head === "*") {
    if (node === null || node === undefined) return [];
    if (Array.isArray(node)) {
      return node.flatMap((entry, index) => expandSegments(rest, entry, [...path, index]));
    }
    if (typeof node === "object") {
      return Object.keys(node).flatMap((key) => expandSegments(rest, (node as Record<string, unknown>)[key], [...path, key]));
    }
    return [];
  }
  if (head === undefined) return [formatPath(path)];
  if (node === null || node === undefined) {
    return [formatPath([...path, head, ...rest.filter((segment): segment is PathSegment => segment !== "*")])];
  }
  if (typeof head === "number") {
    return Array.isArray(node) ? expandSegments(rest, node[head], [...path, head]) : [];
  }
  if (typeof node !== "object" || !Object.hasOwn(node, head)) return [];
  return expandSegments(rest, (node as Record<string, unknown>)[head], [...path, head]);
}

function getMatcher(pattern: string): (path: string) => boolean {
  const cached = patternMatcherCache.get(pattern);
  if (cached !== undefined) return cached;
  const matcher = picomatch(pattern);
  patternMatcherCache.set(pattern, matcher);
  return matcher;
}
