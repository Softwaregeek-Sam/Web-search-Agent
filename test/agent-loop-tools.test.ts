import { describe, expect, it } from "vitest";
import { runTurn } from "../src/agent/loop.js";
import { createLogger, silentLogger } from "../src/logger.js";
import type { LlmClient, LlmRequest } from "../src/llm/client.js";
import type { SearchProvider } from "../src/search/provider.js";
import { Store } from "../src/db.js";

const NOW = Date.UTC(2026, 10, 11, 9, 0);
const searchResult = {
  title: "Current result",
  url: "https://example.com/current",
  domain: "example.com",
  published_date: null,
  snippet: "Current source-backed information.",
  retrieved_at: "2026-11-11T09:00:00.000Z",
};

async function collect<T>(stream: AsyncGenerator<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

describe("one-step web_search execution", () => {
  it("validates and executes one tool call, then streams the final answer", async () => {
    const requests: LlmRequest[] = [];
    const llm: LlmClient = {
      async *stream(request) {
        requests.push(request);
        if (requests.length === 1) {
          yield {
            type: "tool_call",
            toolCall: {
              id: "call-1",
              type: "function",
              function: { name: "web_search", arguments: JSON.stringify({ query: "current result" }) },
            },
          };
          yield { type: "finish", model: "fake/model", finishReason: "tool_calls" };
          return;
        }
        expect(request.messages.at(-2)).toMatchObject({ role: "assistant", tool_calls: [{ id: "call-1" }] });
        expect(request.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call-1" });
        expect(request.messages.at(-1)?.content).toContain("<search_results>");
        yield { type: "token", text: " grounded answer" };
        yield { type: "finish", model: "fake/model", finishReason: "stop" };
      },
    };
    const queries: string[] = [];
    const search: SearchProvider = {
      async search(request) {
        queries.push(request.query);
        return [searchResult];
      },
    };
    const store = new Store(":memory:");
    const events = await collect(
      runTurn({ store, llm, search, clock: () => NOW, log: silentLogger }, { userId: "u1", message: "Find current result" }),
    );

    expect(queries).toEqual(["current result"]);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.tools?.[0]?.function.name).toBe("web_search");
    expect(events.map((event) => event.type)).toEqual(["meta", "status", "status", "token", "done"]);
    expect(events.at(-1)).toMatchObject({ type: "done", trace: { searchMs: 0 } });
    expect(store.conversationMessages((events[0] as { type: "meta"; conversationId: string }).conversationId, "u1").at(-1)?.content).toBe(
      " grounded answer",
    );
  });

  it("allows four tool-aware steps and labels an exhausted answer", async () => {
    let llmCalls = 0;
    let searches = 0;
    const llm: LlmClient = {
      async *stream() {
        llmCalls++;
        yield {
          type: "tool_call",
          toolCall: {
            id: `step-${llmCalls}`,
            type: "function",
            function: { name: "web_search", arguments: JSON.stringify({ query: `step ${llmCalls}` }) },
          },
        };
        yield { type: "finish", model: "fake/model", finishReason: "tool_calls" };
      },
    };
    const search: SearchProvider = {
      async search() {
        searches++;
        return [searchResult];
      },
    };
    const events = await collect(runTurn({ store: new Store(":memory:"), llm, search, clock: () => NOW, log: silentLogger }, { userId: "u1", message: "loop" }));

    expect(llmCalls).toBe(4);
    expect(searches).toBe(4);
    expect(events.at(-2)).toMatchObject({ type: "token", text: expect.stringContaining("budget exhausted") });
    expect(events.at(-1)?.type).toBe("done");
  });

  it("runs at most three searches concurrently and does not start a fourth", async () => {
    let active = 0;
    let maximumActive = 0;
    let searchCalls = 0;
    let llmCalls = 0;
    const llm: LlmClient = {
      async *stream() {
        llmCalls++;
        if (llmCalls === 1) {
          for (let i = 0; i < 4; i++) {
            yield {
              type: "tool_call",
              toolCall: {
                id: `parallel-${i}`,
                type: "function",
                function: { name: "web_search", arguments: JSON.stringify({ query: `parallel ${i}` }) },
              },
            };
          }
        } else {
          yield { type: "token", text: "parallel answer" };
        }
        yield { type: "finish", model: "fake/model", finishReason: "stop" };
      },
    };
    const search: SearchProvider = {
      async search() {
        searchCalls++;
        active++;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        return [searchResult];
      },
    };
    await collect(runTurn({ store: new Store(":memory:"), llm, search, clock: () => NOW, log: silentLogger }, { userId: "u1", message: "parallel" }));

    expect(searchCalls).toBe(3);
    expect(maximumActive).toBe(3);
  });

  it("stops pending searches when the request is cancelled", async () => {
    const controller = new AbortController();
    let resolveSearch: (() => void) | undefined;
    const llm: LlmClient = {
      async *stream() {
        yield {
          type: "tool_call",
          toolCall: {
            id: "cancel-1",
            type: "function",
            function: { name: "web_search", arguments: JSON.stringify({ query: "pending" }) },
          },
        };
        yield { type: "finish", model: "fake/model", finishReason: "tool_calls" };
      },
    };
    const search: SearchProvider = {
      async search() {
        await new Promise<void>((resolve) => {
          resolveSearch = resolve;
        });
        return [searchResult];
      },
    };
    const stream = runTurn(
      { store: new Store(":memory:"), llm, search, clock: () => NOW, log: silentLogger },
      { userId: "u1", message: "cancel", signal: controller.signal },
    );
    const pending = collect(stream);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const events = await Promise.race([
      pending,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("cancellation hung")), 200)),
    ]);

    resolveSearch?.();
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it("does not call search for invalid tool arguments and sends a repair result", async () => {
    let searchCalls = 0;
    let requestCount = 0;
    const llm: LlmClient = {
      async *stream(request) {
        requestCount++;
        if (requestCount === 1) {
          yield {
            type: "tool_call",
            toolCall: { id: "bad-1", type: "function", function: { name: "web_search", arguments: "{" } },
          };
          yield { type: "finish", model: "fake/model", finishReason: "tool_calls" };
        } else {
          expect(request.messages.at(-1)?.content).toContain("Tool call rejected");
          yield { type: "token", text: "I need a valid query." };
          yield { type: "finish", model: "fake/model", finishReason: "stop" };
        }
      },
    };
    const search: SearchProvider = {
      async search() {
        searchCalls++;
        return [];
      },
    };
    const store = new Store(":memory:");
    await collect(runTurn({ store, llm, search, clock: () => NOW, log: createLogger({ level: "silent" }) }, { userId: "u1", message: "Search" }));

    expect(searchCalls).toBe(0);
    expect(requestCount).toBe(2);
  });
});
