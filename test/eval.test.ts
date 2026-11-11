import { describe, expect, it } from "vitest";
import { buildRecall } from "../src/context/recall.js";
import { isRevalidationRequest } from "../src/agent/revalidation.js";
import { Store } from "../src/db.js";

const NOW = Date.UTC(2026, 10, 11, 9, 0);

describe("offline evaluation fixtures", () => {
  it("covers memory recall for the CRM example", () => {
    const store = new Store(":memory:");
    store.ensureConversation("old", "u1", NOW - 2 * 86_400_000);
    store.addMessage({
      conversationId: "old",
      userId: "u1",
      role: "user",
      content: "On Monday we shortlisted 5 CRM tools for a 20-person sales team.",
      createdAt: NOW - 2 * 86_400_000,
      tz: "UTC",
    });
    const recall = buildRecall(store, {
      userId: "u1",
      conversationId: "current",
      text: "On Monday we shortlisted 5 CRM tools. Has any changed?",
      nowMs: NOW,
      tz: "UTC",
    });
    expect(recall.block).toContain("CRM tools");
  });

  it("recognizes the revalidation examples", () => {
    expect(isRevalidationRequest("What did I ask you on 3 November? Is your answer still correct today?")).toBe(true);
    expect(isRevalidationRequest("Last Tuesday I asked about Postgres hosting. Has pricing changed since then?")).toBe(true);
  });
});
