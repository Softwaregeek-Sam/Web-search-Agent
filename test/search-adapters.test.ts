import { describe, expect, it } from "vitest";
import { createCachedSearchProvider } from "../src/search/cache.js";
import { createResilientSearchProvider } from "../src/search/resilient.js";
import { createTavilyProvider } from "../src/search/tavily.js";
import type { SearchProvider, SearchResult } from "../src/search/provider.js";

const baseResult: SearchResult = {
  title: "Example",
  url: "https://example.com/article",
  domain: "example.com",
  published_date: null,
  snippet: "Content",
  retrieved_at: "2026-11-11T12:00:00.000Z",
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("Tavily provider", () => {
  it("maps a Tavily response to normalized search results", async () => {
    let request: RequestInit | undefined;
    const provider = createTavilyProvider({
      apiKey: "key",
      endpoint: "https://tavily.test/search",
      now: () => new Date("2026-11-11T12:00:00.000Z"),
      fetchImpl: async (_input, init) => {
        request = init;
        return response({ results: [{ title: "Example", url: baseResult.url, content: "Content", published_date: null }] });
      },
    });

    await expect(provider.search({ query: "test", topic: "news", recency_after: "2026-11-01", domains: ["example.com"] })).resolves.toEqual([
      baseResult,
    ]);
    expect(JSON.parse(String(request?.body))).toMatchObject({
      api_key: "key",
      query: "test",
      topic: "news",
      start_date: "2026-11-01",
      include_domains: ["example.com"],
    });
  });

  it("surfaces non-success responses as provider errors", async () => {
    const provider = createTavilyProvider({ apiKey: "key", fetchImpl: async () => response({ error: "bad key" }, 401) });
    await expect(provider.search({ query: "test" })).rejects.toThrow("HTTP 401: bad key");
  });
});

describe("cached search provider", () => {
  it("caches eligible queries, uses topic TTLs, and bypasses cache for recency", async () => {
    let now = 0;
    let calls = 0;
    const provider: SearchProvider = {
      async search() {
        calls++;
        return [baseResult];
      },
    };
    const cached = createCachedSearchProvider(provider, { defaultTtlMs: 100, newsTtlMs: 10, now: () => now });

    await cached.search({ query: "same" });
    await cached.search({ query: "same" });
    expect(calls).toBe(1);
    now = 101;
    await cached.search({ query: "same" });
    expect(calls).toBe(2);
    await cached.search({ query: "same", recency_after: "2026-11-01" });
    expect(calls).toBe(3);
  });
});

describe("resilient search provider", () => {
  it("retries once, then cleans results", async () => {
    let calls = 0;
    const provider = createResilientSearchProvider({
      async search() {
        calls++;
        if (calls === 1) throw new Error("temporary");
        return [baseResult, { ...baseResult, url: `${baseResult.url}/` }, { ...baseResult, url: "https://example.com/other" }];
      },
    });

    await expect(provider.search({ query: "test" })).resolves.toHaveLength(2);
    expect(calls).toBe(2);
  });

  it("preserves explicit failure information after the retry", async () => {
    let calls = 0;
    const provider = createResilientSearchProvider({
      async search() {
        calls++;
        throw new Error("down");
      },
    });

    await expect(provider.search({ query: "test" })).rejects.toMatchObject({ name: "SearchProviderError", attempts: 2, cause: expect.any(Error) });
    expect(calls).toBe(2);
  });
});
