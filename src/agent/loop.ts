import { randomUUID } from "node:crypto";
import { buildRecall } from "../context/recall.js";
import { formatNow, isValidTimeZone } from "../context/time.js";
import type { Store } from "../db.js";
import type { LlmClient } from "../llm/client.js";
import { clip, errFields, type Logger } from "../logger.js";
import type { SearchProvider, SearchRequest, SearchResult } from "../search/provider.js";
import type {
  AgentEvent,
  CitationSource,
  LlmConversationMessage,
  LlmMessage,
  LlmToolCall,
  LlmToolMessage,
  SearchQueryRecord,
  StoredMessage,
} from "../types.js";
import { validateCitations } from "./citations.js";
import { answerDate, isRevalidationRequest, REVALIDATION_SYSTEM_PROMPT } from "./revalidation.js";
import { buildSystemPrompt } from "./prompt.js";
import { ToolArgumentError, toolRepairMessage, validateWebSearchToolCall, WEB_SEARCH_TOOL } from "./tools.js";

export interface AgentDeps {
  store: Store;
  llm: LlmClient;
  clock: () => number;
  /** Per-request logger (already bound to the request id). */
  log: Logger;
  /** Search provider used when the model emits a validated web_search call. */
  search?: SearchProvider;
}

export interface ClientHistoryItem {
  role: "user" | "assistant";
  content: string;
  /** Epoch ms or ISO string; defaults to now. */
  ts?: number | string;
}

export interface TurnInput {
  userId: string;
  conversationId?: string;
  message: string;
  tz?: string;
  /** Prior messages supplied by the client. Imported only when the server has none for this conversation. */
  history?: ClientHistoryItem[];
  signal?: AbortSignal;
}

const MAX_HISTORY_MESSAGES = 40;
const MAX_HISTORY_CHARS = 24_000;
const MAX_AGENT_STEPS = 4;
const MAX_PARALLEL_SEARCHES = 3;

function trimHistory(messages: StoredMessage[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  let chars = 0;
  for (const m of messages.slice(-MAX_HISTORY_MESSAGES).reverse()) {
    chars += m.content.length;
    if (chars > MAX_HISTORY_CHARS && out.length > 0) break;
    out.push({ role: m.role, content: m.content });
  }
  return out.reverse();
}

function toMs(ts: number | string | undefined, fallback: number): number {
  if (ts === undefined) return fallback;
  const n = typeof ts === "number" ? ts : Date.parse(ts);
  return Number.isFinite(n) ? n : fallback;
}

function searchToolResult(results: unknown): string {
  return `<search_results>\n${JSON.stringify(results)}\n</search_results>`;
}

function assistantToolCallsMessage(calls: LlmToolCall[]): LlmConversationMessage {
  return { role: "assistant", content: null, tool_calls: calls };
}

function searchErrorResult(message: string): string {
  return `<search_error>\n${JSON.stringify({ error: message })}\n</search_error>`;
}

function searchCancelledError(): Error {
  const error = new Error("Search cancelled.");
  error.name = "AbortError";
  return error;
}

async function searchWithCancellation(
  provider: SearchProvider,
  request: Parameters<SearchProvider["search"]>[0],
  signal?: AbortSignal,
) {
  if (!signal) return provider.search(request);
  if (signal.aborted) throw searchCancelledError();

  return new Promise<Awaited<ReturnType<SearchProvider["search"]>>>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(searchCancelledError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    provider.search(request).then(
      (results) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(results);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

async function executeSearchCall(
  call: LlmToolCall,
  provider: SearchProvider | undefined,
  signal: AbortSignal | undefined,
  log: Logger,
): Promise<{ message: LlmToolMessage; request?: SearchRequest; results?: SearchResult[] }> {
  let request;
  try {
    request = validateWebSearchToolCall(call);
    if (!provider) throw new Error("Search is not configured.");
    const results = await searchWithCancellation(provider, request, signal);
    log.info("turn.search.done", { query: request.query, results: results.length });
    return { message: { role: "tool", tool_call_id: call.id, content: searchToolResult(results) }, request, results };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof ToolArgumentError) {
      log.warn("turn.tool_call.invalid", { id: call.id, message: error.message });
      return { message: toolRepairMessage(error) };
    }
    log.error("turn.search.error", { query: call.function.arguments, ...errFields(error) });
    return {
      message: { role: "tool", tool_call_id: call.id, content: searchErrorResult(error instanceof Error ? error.message : String(error)) },
      request,
    };
  }
}

/**
 * One chat turn: assemble context, run a bounded tool-aware loop, then persist
 * the final answer.
 */
export async function* runTurn(deps: AgentDeps, input: TurnInput): AsyncGenerator<AgentEvent> {
  const { store, llm, clock, log, search } = deps;
  const started = clock();
  const tz = input.tz && isValidTimeZone(input.tz) ? input.tz : "UTC";
  const conversationId = input.conversationId ?? randomUUID();
  log.info("turn.start", {
    conversation: input.conversationId ? conversationId : `${conversationId} (new)`,
    tz,
    tzRequested: input.tz && tz !== input.tz ? input.tz : undefined,
    chars: input.message.length,
    message: clip(input.message),
    clientHistory: input.history?.length,
  });

  if (!store.ensureConversation(conversationId, input.userId, started)) {
    log.warn("turn.conversation_not_found", { conversation: conversationId });
    yield { type: "error", message: "Conversation not found." };
    return;
  }
  yield { type: "meta", conversationId };

  if (input.history?.length && store.conversationMessages(conversationId, input.userId).length === 0) {
    for (const h of input.history) {
      store.addMessage({
        conversationId, userId: input.userId, role: h.role, content: h.content,
        createdAt: toMs(h.ts, started), tz,
      });
    }
  }

  const recall = buildRecall(store, { userId: input.userId, conversationId, text: input.message, nowMs: started, tz });
  const system = buildSystemPrompt({
    nowText: formatNow(started, tz),
    recallBlock: recall.block,
    dateNotes: recall.dateNotes,
    search: search !== undefined,
  });

  const prior = trimHistory(store.conversationMessages(conversationId, input.userId));
  store.addMessage({ conversationId, userId: input.userId, role: "user", content: input.message, createdAt: started, tz });
  const messages: LlmConversationMessage[] = [
    { role: "system", content: system },
    ...prior,
    { role: "user", content: input.message },
  ];
  log.info("turn.context", {
    now: formatNow(started, tz),
    dates: recall.dateNotes ?? "none",
    recalledMessages: recall.messageCount,
    threadMessages: prior.length,
    systemChars: system.length,
  });
  log.debug("turn.prompt", { messages: JSON.stringify(messages) });

  if (search && isRevalidationRequest(input.message)) {
    const historical = store.latestSearchedAnswer(input.userId);
    if (!historical || historical.queries.length === 0) {
      yield { type: "error", message: "I could not find an earlier searched answer to revalidate." };
      return;
    }
    const recencyAfter = answerDate(historical.message.createdAt);
    const queries = historical.queries.map((query) => ({ ...query, recency_after: recencyAfter }));
    yield { type: "status", text: "Rechecking the earlier answer…" };
    const searchStarted = clock();
    let fresh;
    try {
      fresh = await Promise.all(queries.map((query) => search.search(query)));
    } catch (error) {
      log.error("revalidation.search_error", errFields(error));
      yield { type: "error", message: `Revalidation search failed: ${error instanceof Error ? error.message : String(error)}` };
      return;
    }
    const revalidationSearchMs = clock() - searchStarted;
    const revalidationSources: CitationSource[] = [];
    const seen = new Set<string>();
    for (const result of fresh.flat()) {
      if (!seen.has(result.url)) {
        seen.add(result.url);
        revalidationSources.push(result);
      }
    }
    const evidence = fresh.flat();
    const revalidationMessages: LlmConversationMessage[] = [
      { role: "system", content: `${REVALIDATION_SYSTEM_PROMPT}\nCurrent date and time: ${formatNow(started, tz)}` },
      {
        role: "user",
        content: `<original_answer>\n${historical.message.content}\n</original_answer>\n<fresh_search_results>\n${JSON.stringify(evidence)}\n</fresh_search_results>`,
      },
    ];
    let revalidatedAnswer = "";
    let revalidationModel = "";
    let revalidationFinish: string | null = null;
    try {
      for await (const event of llm.stream({ messages: revalidationMessages, signal: input.signal, log })) {
        if (event.type === "token") revalidatedAnswer += event.text;
        else if (event.type === "finish") {
          revalidationModel = event.model;
          revalidationFinish = event.finishReason;
        }
      }
    } catch (error) {
      log.error("revalidation.error", errFields(error));
      yield { type: "error", message: `Revalidation failed: ${error instanceof Error ? error.message : String(error)}` };
      return;
    }
    if (!revalidatedAnswer.trim()) {
      yield { type: "error", message: `Revalidation returned no answer (finish reason: ${revalidationFinish ?? "unknown"}).` };
      return;
    }
    revalidatedAnswer = validateCitations(revalidatedAnswer, revalidationSources);
    yield { type: "token", text: revalidatedAnswer };
    const messageId = store.addMessage({
      conversationId,
      userId: input.userId,
      role: "assistant",
      content: revalidatedAnswer,
      createdAt: clock(),
      tz,
    });
    store.addSearchProvenance(conversationId, input.userId, messageId, queries, revalidationSources);
    yield {
      type: "done",
      messageId,
      trace: {
        model: revalidationModel,
        ttftMs: null,
        searchMs: revalidationSearchMs,
        totalMs: clock() - started,
        recalledMessages: recall.messageCount,
        promptChars: REVALIDATION_SYSTEM_PROMPT.length,
      },
      sources: revalidationSources,
    };
    return;
  }

  let answer = "";
  let ttft: number | null = null;
  let model = "";
  let finishReason: string | null = null;
  let usage: unknown;
  let chunks = 0;
  let reasoning = false;
  let searchMs: number | null = null;
  const searchQueries: SearchQueryRecord[] = [];
  const sources: CitationSource[] = [];
  const sourceUrls = new Set<string>();
  const bufferAnswer = search !== undefined;
  let budgetExhausted = false;
  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    const toolCalls: LlmToolCall[] = [];
    try {
      for await (const ev of llm.stream({
        messages,
        tools: search ? [WEB_SEARCH_TOOL] : undefined,
        signal: input.signal,
        log,
      })) {
        if (ev.type === "token") {
          if (ttft === null) {
            ttft = clock() - started;
            log.info("turn.first_token", { ttftMs: ttft });
          }
          chunks++;
          answer += ev.text;
          if (!bufferAnswer) yield { type: "token", text: ev.text };
        } else if (ev.type === "reasoning") {
          reasoning = true;
          yield { type: "status", text: "Model is reasoning before it answers…" };
        } else if (ev.type === "tool_call") {
          toolCalls.push(ev.toolCall);
        } else {
          model = ev.model;
          finishReason = ev.finishReason;
          usage = ev.usage;
        }
      }
    } catch (err) {
      if (input.signal?.aborted) {
        log.warn("turn.aborted", { partialChars: answer.length });
        if (answer) store.addMessage({ conversationId, userId: input.userId, role: "assistant", content: answer, createdAt: clock(), tz });
        return;
      }
      log.error("turn.error", errFields(err));
      const detail = err instanceof Error ? err.message : String(err);
      yield { type: "error", message: `The model request failed: ${detail}` };
      return;
    }

    if (toolCalls.length === 0) break;
    messages.push(assistantToolCallsMessage(toolCalls));

    const calls = toolCalls.slice(0, MAX_PARALLEL_SEARCHES);
    const skipped = toolCalls.slice(MAX_PARALLEL_SEARCHES);
    if (calls.length > 0) {
      yield { type: "status", text: `Searching the web (${calls.length} quer${calls.length === 1 ? "y" : "ies"})…` };
      const searchStarted = clock();
      try {
        const results = await Promise.all(calls.map((call) => executeSearchCall(call, search, input.signal, log)));
        searchMs = (searchMs ?? 0) + (clock() - searchStarted);
        messages.push(...results.map((result) => result.message));
        for (const result of results) {
          if (result.request && result.results) {
            const retrievedAt = result.results[0]?.retrieved_at ?? new Date().toISOString();
            searchQueries.push({ ...result.request, retrievedAt });
            for (const source of result.results) {
              if (!sourceUrls.has(source.url)) {
                sourceUrls.add(source.url);
                sources.push(source);
              }
            }
          }
        }
      } catch (error) {
        searchMs = (searchMs ?? 0) + (clock() - searchStarted);
        if (input.signal?.aborted) {
          log.warn("turn.aborted", { partialChars: answer.length });
          if (answer) store.addMessage({ conversationId, userId: input.userId, role: "assistant", content: answer, createdAt: clock(), tz });
          return;
        }
        log.error("turn.search.batch_error", errFields(error));
        yield { type: "error", message: `The search request failed: ${error instanceof Error ? error.message : String(error)}` };
        return;
      }
    }
    messages.push(
      ...skipped.map((call) => ({
        role: "tool" as const,
        tool_call_id: call.id,
        content: searchErrorResult(`Search call limit is ${MAX_PARALLEL_SEARCHES} per step; this call was not executed.`),
      })),
    );
    if (step === MAX_AGENT_STEPS - 1) budgetExhausted = true;
    yield { type: "status", text: "Preparing the answer…" };
  }

  if (budgetExhausted) {
    const notice = "\n\n[Search step budget exhausted; this answer may be incomplete.]";
    answer += notice;
    if (!bufferAnswer) yield { type: "token", text: notice };
    log.warn("turn.step_budget_exhausted", { steps: MAX_AGENT_STEPS });
  }

  if (answer.trim() === "") {
    log.warn("turn.empty_response", { model, finishReason, reasoningOnly: reasoning, totalMs: clock() - started });
    const why = reasoning
      ? "It only produced reasoning and never wrote an answer, so it may have used its whole budget thinking."
      : "It returned no text.";
    yield {
      type: "error",
      message: `The model finished without an answer (finish reason: ${finishReason ?? "unknown"}). ${why} Try REASONING_EFFORT=low or a different MODEL_ID.`,
    };
    return;
  }

  answer = validateCitations(answer, sources);
  if (bufferAnswer) yield { type: "token", text: answer };
  const messageId = store.addMessage({ conversationId, userId: input.userId, role: "assistant", content: answer, createdAt: clock(), tz });
  if (searchQueries.length || sources.length) {
    store.addSearchProvenance(conversationId, input.userId, messageId, searchQueries, sources);
  }
  const trace = {
    model,
    ttftMs: ttft,
    searchMs,
    totalMs: clock() - started,
    recalledMessages: recall.messageCount,
    promptChars: system.length,
  };
  log.info("turn.done", {
    model, finishReason, chars: answer.length, chunks, ttftMs: ttft, searchMs, totalMs: trace.totalMs,
    usage: usage === undefined ? undefined : JSON.stringify(usage),
  });
  log.debug("turn.answer", { text: answer });
  yield { type: "done", messageId, trace, sources };
}
