import { z } from "zod";

export const MAX_SEARCH_RESULTS = 5;
export const MAX_SEARCH_SNIPPET_LENGTH = 800;

const searchRequestSchema = z.object({
  query: z.string().trim().min(1),
  recency_after: z.iso.date().optional(),
  topic: z.enum(["general", "news"]).optional(),
  domains: z.array(z.string().trim().min(1)).max(20).optional(),
});

const searchResultSchema = z.object({
  title: z.string().trim().min(1),
  url: z.string().trim().url(),
  domain: z.string().trim().min(1),
  published_date: z.iso.datetime({ offset: true }).nullable(),
  snippet: z.string().trim().min(1),
  retrieved_at: z.iso.datetime({ offset: true }),
});

export interface SearchRequest {
  query: string;
  recency_after?: string;
  topic?: "general" | "news";
  domains?: string[];
}

export interface SearchResult {
  title: string;
  url: string;
  domain: string;
  published_date: string | null;
  snippet: string;
  retrieved_at: string;
}

export interface SearchProvider {
  search(request: SearchRequest): Promise<SearchResult[]>;
}

export class SearchContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchContractError";
  }
}

export function validateSearchRequest(request: SearchRequest): SearchRequest {
  const parsed = searchRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw new SearchContractError(`Invalid search request: ${parsed.error.message}`);
  }
  return parsed.data;
}

function canonicalUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

export function normalizeSearchResults(results: SearchResult[]): SearchResult[] {
  if (!Array.isArray(results)) {
    throw new SearchContractError("Invalid search results: expected an array");
  }

  const normalized: SearchResult[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    const parsed = searchResultSchema.safeParse(result);
    if (!parsed.success) {
      throw new SearchContractError(`Invalid search result: ${parsed.error.message}`);
    }

    const value = parsed.data;
    const url = canonicalUrl(value.url);
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    normalized.push({
      ...value,
      url,
      snippet: value.snippet.slice(0, MAX_SEARCH_SNIPPET_LENGTH),
    });
    if (normalized.length === MAX_SEARCH_RESULTS) {
      break;
    }
  }
  return normalized;
}

export function createValidatedSearchProvider(provider: SearchProvider): SearchProvider {
  return {
    async search(request) {
      const validRequest = validateSearchRequest(request);
      const results = await provider.search(validRequest);
      return normalizeSearchResults(results);
    },
  };
}
