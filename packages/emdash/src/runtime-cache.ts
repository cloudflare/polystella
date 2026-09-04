const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  expiresAt: number;
  value: Promise<Record<string, string>>;
}

const cache = new Map<string, CacheEntry>();

export function cachedRuntimeOverrides(
  locale: string,
  load: () => Promise<Record<string, string>>,
  now: number = Date.now(),
): Promise<Record<string, string>> {
  const existing = cache.get(locale);
  if (existing !== undefined && existing.expiresAt > now) return existing.value;

  const value = load();
  cache.set(locale, { expiresAt: now + CACHE_TTL_MS, value });
  return value;
}

export function invalidateRuntimeOverrides(locale: string): void {
  // Other isolates retain their entry for at most CACHE_TTL_MS.
  cache.delete(locale);
}
