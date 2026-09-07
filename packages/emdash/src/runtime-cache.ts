const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  expiresAt: number;
  generation: number;
  value: Promise<Record<string, string>>;
}

const caches = new WeakMap<object, Map<string, CacheEntry>>();
const generations = new Map<string, number>();

export function cachedRuntimeOverrides(
  scope: object,
  locale: string,
  load: () => Promise<Record<string, string>>,
  now: number = Date.now(),
): Promise<Record<string, string>> {
  let cache = caches.get(scope);
  if (cache === undefined) {
    cache = new Map();
    caches.set(scope, cache);
  }

  const existing = cache.get(locale);
  const generation = generations.get(locale) ?? 0;
  if (existing !== undefined && existing.expiresAt > now && existing.generation === generation) return existing.value;

  const value = load();
  cache.set(locale, { expiresAt: now + CACHE_TTL_MS, generation, value });
  return value;
}

export function invalidateRuntimeOverrides(locale: string): void {
  generations.set(locale, (generations.get(locale) ?? 0) + 1);
}
