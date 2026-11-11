import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { Store } from "../src/db.js";
import type { LlmClient, LlmRequest } from "../src/llm/client.js";
import { createLogger, silentLogger } from "../src/logger.js";

const NOW = Date.UTC(2026, 10, 11, 9, 0);
const TZ = "Asia/Kolkata";

let store: Store;
let calls: LlmRequest[];
let failNext = false;
let mode: "ok" | "empty" | "reasoning-only" = "ok";

const fakeLlm: LlmClient = {
  async *stream(req) {
    calls.push(req);
    if (failNext) throw new Error("upstream down");
    if (mode === "reasoning-only") yield { type: "reasoning" };
    if (mode === "ok") {
      yield { type: "token", text: "Hello" };
      yield { type: "token", text: " world" };
    }
    yield { type: "finish", model: "fake/model", finishReason: mode === "ok" ? "stop" : "length" };
  },
};

const post = (app: ReturnType<typeof createApp>, body: unknown, cookie?: string) =>
  app.request("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });

function events(text: string) {
  return text
    .trim()
    .split("\n\n")
    .map((blk) => {
      const type = /^event: (.*)$/m.exec(blk)![1]!;
      return { type, data: JSON.parse(/^data: (.*)$/m.exec(blk)![1]!) as Record<string, unknown> };
    });
}

beforeEach(() => {
  store = new Store(":memory:");
  calls = [];
  failNext = false;
  mode = "ok";
});

describe("POST /api/chat", () => {
  it("streams tokens, persists both turns and reports a trace", async () => {
    const app = createApp({ store, llm: fakeLlm, clock: () => NOW, log: silentLogger });
    const res = await post(app, { message: "Hi there", tz: TZ });
    expect(res.status).toBe(200);
    const evs = events(await res.text());
    expect(evs.map((e) => e.type)).toEqual(["meta", "token", "token", "done"]);
    const convId = evs[0]!.data.conversationId as string;
    const rows = store.conversationMessages(convId, /uid=([^;]+)/.exec(res.headers.get("set-cookie")!)![1]!);
    expect(rows.map((r) => [r.role, r.content])).toEqual([["user", "Hi there"], ["assistant", "Hello world"]]);
    expect(evs[3]!.data.trace).toMatchObject({ model: "fake/model" });
  });

  it("puts today's date in the system prompt and carries the thread forward", async () => {
    const app = createApp({ store, llm: fakeLlm, clock: () => NOW, log: silentLogger });
    const first = await post(app, { message: "Hi", tz: TZ });
    const cookie = /uid=[^;]+/.exec(first.headers.get("set-cookie")!)![0];
    const convId = events(await first.text())[0]!.data.conversationId as string;
    await (await post(app, { message: "And again", conversationId: convId, tz: TZ }, cookie)).text();

    const second = calls[1]!.messages;
    expect(second[0]!.role).toBe("system");
    expect(second[0]!.content).toContain("Wednesday 11 Nov 2026, 14:30 (Asia/Kolkata)");
    expect(second.slice(1).map((m) => m.content)).toEqual(["Hi", "Hello world", "And again"]);
  });

  it("recalls an earlier conversation from the stored history", async () => {
    const monday = Date.UTC(2026, 10, 9, 5, 12);
    store.ensureConversation("11111111-1111-4111-8111-111111111111", "me", monday);
    store.addMessage({ conversationId: "11111111-1111-4111-8111-111111111111", userId: "me", role: "user", content: "Shortlist: HubSpot, Zoho", createdAt: monday, tz: TZ });
    const app = createApp({ store, llm: fakeLlm, clock: () => NOW, log: silentLogger });
    await (await post(app, { message: "What did I ask you on Monday?", tz: TZ }, "uid=me")).text();
    expect(calls[0]!.messages[0]!.content).toContain("[Mon 9 Nov 2026, 10:42] user: Shortlist: HubSpot, Zoho");
  });

  it("imports client-supplied history when the server has none", async () => {
    const app = createApp({ store, llm: fakeLlm, clock: () => NOW, log: silentLogger });
    await (
      await post(app, {
        message: "What did I ask you on 3 November?",
        tz: TZ,
        history: [{ role: "user", content: "old question about pricing", ts: "2026-11-03T10:00:00Z" }],
      }, "uid=me2")
    ).text();
    // history was imported into the (new) current conversation, so it is part of the thread, not recall
    expect(calls[0]!.messages.some((m) => m.content === "old question about pricing")).toBe(true);
  });

  it("reports upstream failures as an error event", async () => {
    failNext = true;
    const app = createApp({ store, llm: fakeLlm, clock: () => NOW, log: silentLogger });
    const evs = events(await (await post(app, { message: "Hi" })).text());
    expect(evs.at(-1)).toMatchObject({ type: "error" });
    expect(String(evs.at(-1)!.data.message)).toContain("upstream down");
  });

  it("refuses a conversation that belongs to someone else", async () => {
    const app = createApp({ store, llm: fakeLlm, clock: () => NOW, log: silentLogger });
    const first = await post(app, { message: "Hi" }, "uid=alice");
    const convId = events(await first.text())[0]!.data.conversationId as string;
    const evs = events(await (await post(app, { message: "Hi", conversationId: convId }, "uid=bob")).text());
    expect(evs).toEqual([{ type: "error", data: { type: "error", message: "Conversation not found." } }]);
  });

  it("rejects malformed bodies", async () => {
    const app = createApp({ store, llm: fakeLlm, clock: () => NOW, log: silentLogger });
    expect((await post(app, { message: "" })).status).toBe(400);
    expect((await post(app, { nope: true })).status).toBe(400);
  });

  it("serves the browser bundles the UI imports", async () => {
    const app = createApp({ store, llm: fakeLlm, clock: () => NOW, log: silentLogger });
    for (const path of ["/vendor/marked.js", "/vendor/purify.js"]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("javascript");
      expect(await res.text()).toMatch(/export/);
    }
  });

  it("tells the user when the model returns no text, and does not save an empty reply", async () => {
    mode = "empty";
    const app = createApp({ store, llm: fakeLlm, clock: () => NOW, log: silentLogger });
    const res = await post(app, { message: "Hi" }, "uid=e1");
    const evs = events(await res.text());
    const last = evs.at(-1)!;
    expect(last.type).toBe("error");
    expect(String(last.data.message)).toContain("finish reason: length");
    const convId = evs[0]!.data.conversationId as string;
    expect(store.conversationMessages(convId, "e1").map((m) => m.role)).toEqual(["user"]);
  });

  it("shows a reasoning status, then explains when reasoning never produced an answer", async () => {
    mode = "reasoning-only";
    const app = createApp({ store, llm: fakeLlm, clock: () => NOW, log: silentLogger });
    const evs = events(await (await post(app, { message: "what's the model name" })).text());
    expect(evs.map((e) => e.type)).toEqual(["meta", "status", "error"]);
    expect(String(evs[2]!.data.message)).toContain("only produced reasoning");
  });

  describe("request-cycle logging", () => {
    const capture = (level: "info" | "debug" = "info") => {
      const lines: string[] = [];
      return { lines, log: createLogger({ level, sink: (l) => lines.push(l) }) };
    };

    it("logs one traceable cycle: request, context, first token, done, response end", async () => {
      const { lines, log } = capture();
      const app = createApp({ store, llm: fakeLlm, clock: () => NOW, log });
      await (await post(app, { message: "what's the model name", tz: TZ })).text();
      const order = ["http.request", "turn.start", "turn.context", "turn.first_token", "turn.done", "http.response.end"];
      const idx = order.map((m) => lines.findIndex((l) => l.includes(` ${m} `) || l.includes(` ${m}`)));
      expect(idx.every((i) => i >= 0)).toBe(true);
      expect([...idx].sort((a, b) => a - b)).toEqual(idx);
      const req = /req=([0-9a-f]{8})/.exec(lines[0]!)![1]!;
      expect(lines.every((l) => l.includes(`req=${req}`))).toBe(true);
      expect(lines.join("\n")).toContain("outcome=ok");
    });

    it("keeps message bodies out of info logs but includes them at debug", async () => {
      const secret = "my very private question about HubSpot";
      const info = capture("info");
      await (await post(createApp({ store, llm: fakeLlm, clock: () => NOW, log: info.log }), { message: secret })).text();
      expect(info.lines.join("\n")).not.toContain("turn.prompt");
      expect(info.lines.join("\n")).not.toContain("Hello world");
      const dbg = capture("debug");
      await (await post(createApp({ store: new Store(":memory:"), llm: fakeLlm, clock: () => NOW, log: dbg.log }), { message: secret })).text();
      expect(dbg.lines.join("\n")).toContain("turn.prompt");
      expect(dbg.lines.join("\n")).toContain("Hello world");
    });

    it("logs upstream failures with the reason", async () => {
      failNext = true;
      const { lines, log } = capture();
      await (await post(createApp({ store, llm: fakeLlm, clock: () => NOW, log }), { message: "Hi" })).text();
      const err = lines.find((l) => l.includes("turn.error"))!;
      expect(err).toContain("upstream down");
      expect(lines.join("\n")).toContain("outcome=error");
    });

    it("logs an empty model response as a warning", async () => {
      mode = "reasoning-only";
      const { lines, log } = capture();
      await (await post(createApp({ store, llm: fakeLlm, clock: () => NOW, log }), { message: "Hi" })).text();
      const warn = lines.find((l) => l.includes("turn.empty_response"))!;
      expect(warn).toContain("WARN");
      expect(warn).toContain("reasoningOnly=true");
      expect(warn).toContain("finishReason=length");
    });
  });
});
