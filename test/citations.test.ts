import { describe, expect, it } from "vitest";
import { validateCitations } from "../src/agent/citations.js";

const sources = [
  { title: "One", url: "https://one.test", domain: "one.test", published_date: null, snippet: "one", retrieved_at: "2026-11-11T00:00:00.000Z" },
  { title: "Two", url: "https://two.test", domain: "two.test", published_date: null, snippet: "two", retrieved_at: "2026-11-11T00:00:00.000Z" },
];

describe("validateCitations", () => {
  it("keeps valid and repeated citations while removing out-of-range citations", () => {
    expect(validateCitations("Changed [1], unchanged [1], unsupported [3] and malformed [0].", sources)).toBe(
      "Changed [1], unchanged [1], unsupported  and malformed .",
    );
  });
});
