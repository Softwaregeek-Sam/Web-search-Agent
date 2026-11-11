import type { SearchProvider, SearchRequest, SearchResult } from "./provider.js";

const TAVILY_ENDPOINT = "https://api.tavily.com/search";

interface TavilyResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  published_date?: unknown;
}

interface TavilyResponse {
  results?: unknown;
  error?: unknown;
}

export class TavilyProviderError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "TavilyProviderError";
    this.status = status;
  }
}

export interface TavilyProviderOptions {
  apiKey?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

function domainOf(url: string): string {
  return new URL(url).hostname;
}

function publicationDate(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new TavilyProviderError("Tavily returned an invalid publication date");
  }
  const parsed = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TavilyProviderError("Tavily returned an invalid publication date");
  }
  return parsed.toISOString();
}

function asResult(value: TavilyResult, retrievedAt: string): SearchResult {
  if (typeof value.title !== "string" || typeof value.url !== "string" || typeof value.content !== "string") {
    throw new TavilyProviderError("Tavily returned a result with missing title, URL, or content");
  }
  let domain: string;
  try {
    domain = domainOf(value.url);
  } catch {
    throw new TavilyProviderError("Tavily returned an invalid result URL");
  }
  return {
    title: value.title,
    url: value.url,
    domain,
    published_date: publicationDate(value.published_date),
    snippet: value.content,
    retrieved_at: retrievedAt,
  };
}

export function createTavilyProvider(options: TavilyProviderOptions): SearchProvider {
  const { apiKey, endpoint = TAVILY_ENDPOINT, fetchImpl = fetch, now = () => new Date() } = options;
  if (!apiKey?.trim()) {
    throw new TavilyProviderError("TAVILY_API_KEY is required to use the Tavily search provider");
  }

  return {
    async search(request: SearchRequest) {
      const body: Record<string, unknown> = {
        api_key: apiKey,
        query: request.query,
        topic: request.topic ?? "general",
        max_results: 5,
      };
      if (request.domains?.length) body.include_domains = request.domains;
      if (request.recency_after) body.start_date = request.recency_after;

      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (error) {
        throw new TavilyProviderError(`Tavily request failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      const payload = (await response.json().catch(() => null)) as TavilyResponse | null;
      if (!response.ok) {
        const detail = payload && "error" in payload && typeof payload.error === "string" ? `: ${payload.error}` : "";
        throw new TavilyProviderError(`Tavily returned HTTP ${response.status}${detail}`, response.status);
      }
      if (!payload || !Array.isArray(payload.results)) {
        throw new TavilyProviderError("Tavily returned an invalid response: results must be an array");
      }

      const retrievedAt = now().toISOString();
      return payload.results.map((item) => asResult(item as TavilyResult, retrievedAt));
    },
  };
}
