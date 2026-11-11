import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpenRouterClient, type LlmEvent } from "../src/llm/client.js";
import { createLogger } from "../src/logger.js";

type Scenario = "answer" | "reasoning-only" | "think-tags" | "bad-key-on-first";
let scenario: Scenario = "answer";
let requested: string[] = [];
let server: Server;
let baseUrl: string;

const sse = (chunks: unknown[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
const base = { id: "x", provider: "FakeProv", model: "x/served" };
const delta = (d: object, finish: string | null = null) => ({ ...base, choices: [{ index: 0, delta: d, finish_reason: finish }] });

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const model = JSON.parse(body).model as string;
      requested.push(model);
      if (scenario === "bad-key-on-first" && model === "a/one") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "No auth credentials found", code: 401 } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const usage = { ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } };
      if (scenario === "reasoning-only") {
        res.end(sse([delta({ role: "assistant", content: "" }), delta({ reasoning: "Let me think" }), delta({ reasoning: " more" }), delta({}, "length"), usage]));
      } else if (scenario === "think-tags") {
        res.end(sse([delta({ content: "<think>secret " }), delta({ content: "plan</think>Hi" }), delta({ content: " there" }), delta({}, "stop")]));
      } else {
        res.end(sse([delta({ role: "assistant", content: "" }), delta({ reasoning: "hmm" }), delta({ content: "I am " }), delta({ content: "a model" }), delta({}, "stop"), usage]));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

async function run(models: string[]) {
  requested = [];
  const lines: string[] = [];
  const log = createLogger({ level: "info", sink: (l) => lines.push(l) });
  const client = createOpenRouterClient({ openrouterKey: "k", models, baseUrl });
  const events: LlmEvent[] = [];
  let error: unknown;
  try {
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], log })) events.push(ev);
  } catch (e) {
    error = e;
  }
  return { events, lines, error };
}

describe("createOpenRouterClient (against a fake OpenRouter)", () => {
  it("streams reasoning status, then tokens, then finish with usage", async () => {
    scenario = "answer";
    const { events, lines } = await run(["a/one"]);
    expect(events.map((e) => e.type)).toEqual(["reasoning", "token", "token", "finish"]);
    expect(events.filter((e) => e.type === "token").map((e) => (e as { text: string }).text).join("")).toBe("I am a model");
    expect(events.at(-1)).toMatchObject({ finishReason: "stop", usage: { completion_tokens: 4 } });
    const log = lines.join("\n");
    for (const m of ["llm.attempt", "llm.stream.open", "llm.chunk.first", "llm.reasoning.start", "llm.content.start", "llm.finish"]) {
      expect(log).toContain(m);
    }
    expect(log).toContain("servedBy=FakeProv");
  });

  it("reports a reasoning-only stream with no answer text", async () => {
    scenario = "reasoning-only";
    const { events, lines } = await run(["a/one"]);
    expect(events.map((e) => e.type)).toEqual(["reasoning", "finish"]);
    expect(events.at(-1)).toMatchObject({ finishReason: "length" });
    expect(lines.join("\n")).toContain("reasoningChunks=2");
    expect(lines.join("\n")).toContain("contentChunks=0");
  });

  it("strips <think> blocks from content", async () => {
    scenario = "think-tags";
    const { events } = await run(["a/one"]);
    expect(events.filter((e) => e.type === "token").map((e) => (e as { text: string }).text).join("")).toBe("Hi there");
  });

  it("falls back to the next model when the first fails before streaming, and logs why", async () => {
    scenario = "bad-key-on-first";
    const { events, lines } = await run(["a/one", "b/two"]);
    expect(requested).toEqual(["a/one", "b/two"]);
    expect(events.at(-1)).toMatchObject({ type: "finish", model: "b/two" });
    const failed = lines.find((l) => l.includes("llm.attempt.failed"))!;
    expect(failed).toContain("WARN");
    expect(failed).toContain("status=401");
    expect(failed).toContain("nextModel=b/two");
    expect(failed).toContain("No auth credentials found");
  });

  it("throws the last error when every model fails", async () => {
    scenario = "bad-key-on-first";
    const { error } = await run(["a/one"]);
    expect(String(error)).toContain("401");
  });
});
