import { describe, expect, it } from "vitest";
import { isRevalidationRequest } from "../src/agent/revalidation.js";
import { Store } from "../src/db.js";

describe("answer revalidation foundations", () => {
  it("detects revalidation language without matching ordinary questions", () => {
    expect(isRevalidationRequest("Is your answer still correct today?")).toBe(true);
    expect(isRevalidationRequest("Has pricing changed since Monday?")).toBe(true);
    expect(isRevalidationRequest("Explain PostgreSQL MVCC")).toBe(false);
  });

  it("loads the latest searched answer only for the owning user", () => {
    const store = new Store(":memory:");
    store.ensureConversation("c1", "u1", 1);
    const messageId = store.addMessage({
      conversationId: "c1",
      userId: "u1",
      role: "assistant",
      content: "The old answer [1].",
      createdAt: 1,
      tz: "UTC",
    });
    store.addSearchProvenance(
      "c1",
      "u1",
      messageId,
      [{ query: "old query", retrievedAt: "2026-11-01T00:00:00.000Z" }],
      [{ title: "Old", url: "https://old.test", domain: "old.test", published_date: null, snippet: "old", retrieved_at: "2026-11-01T00:00:00.000Z" }],
    );

    expect(store.latestSearchedAnswer("u1")?.queries[0]?.query).toBe("old query");
    expect(store.latestSearchedAnswer("u2")).toBeUndefined();
  });
});
