import type { SearchProvider, SearchRequest, SearchResult } from "./provider.js";

export const DEFAULT_NEWS_CACHE_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_SEARCH_CACHE_TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
  expiresAt: number;
  results: SearchResult[];
}

export interface SearchCacheOptions {
  newsTtlMs?: number;
  defaultTtlMs?: number;
  now?: () => number;
}

function cacheKey(request: SearchRequest): string {
  return JSON.stringify({
    query: request.query,
    topic: request.topic ?? "general",
    domains: [...(request.domains ?? [])].sort(),
  });
}

function copy(results: SearchResult[]): SearchResult[] {
  return results.map((result) => ({ ...result }));
}

export function createCachedSearchProvider(provider: SearchProvider, options: SearchCacheOptions = {}): SearchProvider {
  const newsTtlMs = options.newsTtlMs ?? DEFAULT_NEWS_CACHE_TTL_MS;
  const defaultTtlMs = options.defaultTtlMs ?? DEFAULT_SEARCH_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const entries = new Map<string, CacheEntry>();

  return {
    async search(request) {
      if (request.recency_after) {
        return provider.search(request);
      }

      const key = cacheKey(request);
      const current = entries.get(key);
      const timestamp = now();
      if (current && current.expiresAt > timestamp) {
        return copy(current.results);
      }
      if (current) entries.delete(key);

      const results = await provider.search(request);
      const ttl = request.topic === "news" ? newsTtlMs : defaultTtlMs;
      entries.set(key, { expiresAt: timestamp + ttl, results: copy(results) });
      return copy(results);
    },
  };
}
