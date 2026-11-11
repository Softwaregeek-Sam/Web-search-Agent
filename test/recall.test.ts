import { beforeEach, describe, expect, it } from "vitest";
import { buildRecall } from "../src/context/recall.js";
import { Store } from "../src/db.js";

const NOW = Date.UTC(2026, 10, 11, 9, 0); // Wed 11 Nov 2026, 14:30 IST
const TZ = "Asia/Kolkata";
const at = (m: number, d: number, h: number, min: number) => Date.UTC(2026, m - 1, d, h, min) - 5.5 * 3_600_000;

let store: Store;
function seed(conv: string, user: string, ts: number, q: string, a: string) {
  store.ensureConversation(conv, user, ts);
  store.addMessage({ conversationId: conv, userId: user, role: "user", content: q, createdAt: ts, tz: TZ });
  store.addMessage({ conversationId: conv, userId: user, role: "assistant", content: a, createdAt: ts + 60_000, tz: TZ });
}
const recall = (text: string, conversationId = "c-now", userId = "u1") =>
  buildRecall(store, { userId, conversationId, text, nowMs: NOW, tz: TZ });

beforeEach(() => {
  store = new Store(":memory:");
  seed("c-mon", "u1", at(11, 9, 10, 42), "We shortlisted HubSpot, Pipedrive, Zoho, Salesforce and Freshsales for 20 sellers", "Here is a comparison of the five tools.");
  seed("c-tue", "u1", at(11, 3, 16, 5), "Which managed Postgres host is cheapest?", "Neon and Supabase have free tiers.");
  seed("c-other", "u2", at(11, 9, 11, 0), "Secret plan for another user", "Noted.");
});

describe("buildRecall", () => {
  it("pulls the right day's messages with timestamps in the user's zone", () => {
    const r = recall("On Monday we shortlisted 5 CRM tools. Has anything changed?");
    expect(r.block).toContain("[Mon 9 Nov 2026, 10:42] user: We shortlisted HubSpot");
    expect(r.block).toContain("assistant: Here is a comparison");
    expect(r.block).not.toContain("Postgres");
    expect(r.dateNotes).toContain("Mon 9 Nov 2026");
  });

  it("finds an explicit date", () => {
    expect(recall("What did I ask you on 3 November?").block).toContain("managed Postgres host");
  });

  it("says plainly when nothing is stored for the date", () => {
    expect(recall("What did I ask you on 5 November?").block).toContain("No stored messages");
  });

  it("never returns another user's messages", () => {
    const r = recall("What did we discuss on Monday?");
    expect(r.block).not.toContain("Secret plan");
  });

  it("excludes the current conversation", () => {
    store.ensureConversation("c-now", "u1", at(11, 9, 12, 0));
    store.addMessage({ conversationId: "c-now", userId: "u1", role: "user", content: "same-thread message on Monday", createdAt: at(11, 9, 12, 0), tz: TZ });
    expect(recall("what did I say on Monday?").block).not.toContain("same-thread");
  });

  it("falls back to keyword search when the message points backward without a date", () => {
    const r = recall("Which CRM tools did we shortlist earlier?");
    expect(r.block).toContain("HubSpot");
    expect(r.block).toContain("comparison"); // neighbor reply is included
  });

  it("does nothing for ordinary messages", () => {
    const r = recall("Explain how B-trees work");
    expect(r.block).toBeNull();
    expect(r.messageCount).toBe(0);
  });
});
