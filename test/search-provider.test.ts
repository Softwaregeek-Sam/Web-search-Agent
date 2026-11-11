import { describe, expect, it } from "vitest";
import {
  MAX_SEARCH_RESULTS,
  MAX_SEARCH_SNIPPET_LENGTH,
  SearchContractError,
  type SearchProvider,
  createValidatedSearchProvider,
} from "../src/search/provider.js";

const result = (overrides: Record<string, unknown> = {}) => ({
  title: "Example result",
  url: "https://example.com/article",
  domain: "example.com",
  published_date: "2026-11-11T12:00:00+00:00",
  snippet: "A useful search result.",
  retrieved_at: "2026-11-11T12:01:00+00:00",
  ...overrides,
});

const fake = (results: unknown[]): SearchProvider => ({
  async search() {
    return results as never;
  },
});

describe("validated search provider contract", () => {
  it("accepts valid requests and returns the documented result shape", async () => {
    const provider = createValidatedSearchProvider(fake([result()]));
    const results = await provider.search({
      query: "latest TypeScript release",
      recency_after: "2026-11-01",
      topic: "news",
      domains: ["typescriptlang.org"],
    });

    expect(results).toEqual([result()]);
  });

  it("rejects malformed provider results", async () => {
    const provider = createValidatedSearchProvider(fake([result({ url: "not a URL" })]));

    await expect(provider.search({ query: "test" })).rejects.toThrow(SearchContractError);
  });

  it("rejects invalid requests before calling the provider", async () => {
    let called = false;
    const provider = createValidatedSearchProvider({
      async search() {
        called = true;
        return [];
      },
    });

    await expect(provider.search({ query: " " })).rejects.toThrow(SearchContractError);
    expect(called).toBe(false);
  });

  it("deduplicates canonical URLs, truncates snippets, and keeps the first five results", async () => {
    const longSnippet = "x".repeat(MAX_SEARCH_SNIPPET_LENGTH + 20);
    const input = Array.from({ length: MAX_SEARCH_RESULTS + 2 }, (_, index) =>
      result({
        title: `Result ${index}`,
        url: index === 1 ? "https://EXAMPLE.com/article/#section" : `https://example.com/${index}`,
        snippet: longSnippet,
      }),
    );
    const provider = createValidatedSearchProvider(fake(input));

    const results = await provider.search({ query: "test" });

    expect(results).toHaveLength(MAX_SEARCH_RESULTS);
    expect(results[1]?.url).toBe("https://example.com/article");
    expect(results[0]?.snippet).toHaveLength(MAX_SEARCH_SNIPPET_LENGTH);
    expect(new Set(results.map((item) => item.url)).size).toBe(MAX_SEARCH_RESULTS);
  });
});
