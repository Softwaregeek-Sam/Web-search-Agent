import OpenAI from "openai";
import type { Config } from "../config.js";
import { errFields, silentLogger, type Logger } from "../logger.js";
import type { LlmConversationMessage, LlmToolCall, LlmToolDefinition } from "../types.js";
import { ThinkStripper } from "./think.js";

export type LlmEvent =
  | { type: "token"; text: string }
  /** Emitted once when the model starts streaming reasoning instead of answer text. */
  | { type: "reasoning" }
  | { type: "tool_call"; toolCall: LlmToolCall }
  | { type: "finish"; model: string; finishReason: string | null; usage?: unknown };

export interface LlmRequest {
  messages: LlmConversationMessage[];
  tools?: LlmToolDefinition[];
  signal?: AbortSignal;
  log?: Logger;
}

export interface LlmClient {
  stream(req: LlmRequest): AsyncGenerator<LlmEvent>;
}

interface Chunk {
  model?: string;
  provider?: string;
  usage?: unknown;
  choices?: {
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      reasoning_details?: unknown;
      tool_calls?: {
        index?: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
}

const HEARTBEAT_MS = 5000;

/**
 * OpenRouter client with an ordered model list. A model is skipped only when it
 * fails before streaming any token; after the first token, errors propagate.
 */
export function createOpenRouterClient(
  cfg: Pick<Config, "openrouterKey" | "models" | "providerOrder" | "reasoningEffort" | "baseUrl">,
): LlmClient {
  const client = new OpenAI({
    apiKey: cfg.openrouterKey,
    baseURL: cfg.baseUrl ?? "https://openrouter.ai/api/v1",
    defaultHeaders: { "X-Title": "web-search-agent" },
    maxRetries: 1,
  });

  return {
    async *stream({ messages, tools, signal, log = silentLogger }) {
      let lastError: unknown;
      for (const [i, model] of cfg.models.entries()) {
        const t0 = Date.now();
        let started = false;
        let contentChunks = 0;
        let reasoningChunks = 0;
        let otherChunks = 0;
        let finishReason: string | null = null;
        let usage: unknown;
        let provider: string | undefined;
        const toolCalls = new Map<number, LlmToolCall>();

        log.info("llm.attempt", {
          model,
          providers: cfg.providerOrder?.join(",") ?? "default",
          reasoningEffort: cfg.reasoningEffort ?? "default",
          messages: messages.length,
        });
        // While waiting for the first answer token, say so every few seconds so a stall is visible.
        const heartbeat = setInterval(() => {
          if (!started) {
            log.info("llm.waiting", { model, elapsedMs: Date.now() - t0, contentChunks, reasoningChunks, otherChunks });
          }
        }, HEARTBEAT_MS);

        try {
          const body = {
            model,
            messages,
            stream: true,
            ...(tools?.length ? { tools } : {}),
            ...(cfg.providerOrder ? { provider: { order: cfg.providerOrder, allow_fallbacks: false } } : {}),
            ...(cfg.reasoningEffort ? { reasoning: { effort: cfg.reasoningEffort } } : {}),
          };
          const stream = (await client.chat.completions.create(body as never, { signal })) as unknown as AsyncIterable<Chunk>;
          log.info("llm.stream.open", { model, ms: Date.now() - t0 });

          const strip = new ThinkStripper();
          let first = true;
          for await (const chunk of stream) {
            if (first) {
              first = false;
              provider = chunk.provider;
              log.info("llm.chunk.first", { model, servedBy: chunk.provider, servedModel: chunk.model, ms: Date.now() - t0 });
            }
            if (chunk.usage) usage = chunk.usage;
            const choice = chunk.choices?.[0];
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            const d = choice?.delta;
            for (const [fallbackIndex, part] of (d?.tool_calls ?? []).entries()) {
              const index = part.index ?? fallbackIndex;
              const current = toolCalls.get(index) ?? {
                id: "",
                type: "function" as const,
                function: { name: "", arguments: "" },
              };
              if (part.id) current.id = part.id;
              if (part.type) current.type = part.type;
              if (part.function?.name) current.function.name += part.function.name;
              if (part.function?.arguments) current.function.arguments += part.function.arguments;
              toolCalls.set(index, current);
            }

            const reasoning =
              d?.reasoning || d?.reasoning_content || (Array.isArray(d?.reasoning_details) && d.reasoning_details.length > 0);
            if (reasoning) {
              reasoningChunks++;
              if (reasoningChunks === 1) {
                log.info("llm.reasoning.start", { model, ms: Date.now() - t0 });
                yield { type: "reasoning" };
              }
            }
            if (!d?.content) {
              if (!reasoning) otherChunks++;
              continue;
            }
            contentChunks++;
            const text = strip.push(d.content);
            if (text) {
              if (!started) log.info("llm.content.start", { model, ms: Date.now() - t0, reasoningChunks });
              started = true;
              yield { type: "token", text };
            }
          }
          const tail = strip.end();
          if (tail) yield { type: "token", text: tail };
          for (const toolCall of toolCalls.values()) {
            yield { type: "tool_call", toolCall };
          }

          log.info("llm.finish", {
            model, servedBy: provider, finishReason, contentChunks, reasoningChunks, otherChunks,
            ms: Date.now() - t0, usage: usage === undefined ? undefined : JSON.stringify(usage),
          });
          yield { type: "finish", model, finishReason, usage };
          return;
        } catch (err) {
          if (started || signal?.aborted) {
            if (!signal?.aborted) log.error("llm.stream.error", { model, ms: Date.now() - t0, ...errFields(err) });
            throw err;
          }
          lastError = err;
          log.warn("llm.attempt.failed", {
            model, ms: Date.now() - t0, contentChunks, reasoningChunks,
            ...errFields(err), nextModel: cfg.models[i + 1] ?? "none",
          });
        } finally {
          clearInterval(heartbeat);
        }
      }
      throw lastError instanceof Error ? lastError : new Error("All configured models failed");
    },
  };
}
