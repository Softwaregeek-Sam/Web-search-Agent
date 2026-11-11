# Web Search Agent: Project Status and Work Breakdown

## What is being built

This project is a chat agent whose only model-facing tool is web search. The
application is designed to answer current, source-backed questions while
handling two pieces of context deterministically in the harness:

- **Time:** Resolve phrases such as “today”, “Monday”, and “3 November” using
  the user's timezone.
- **Memory:** Recall relevant messages from the user's previous conversations
  using date windows and SQLite FTS5 keyword search.

Each request should ultimately pass through these stages:

1. Assemble current-time, date-resolution, conversation-history, and recall
   context without using the LLM.
2. Run a bounded agent loop that can call `web_search`.
3. Stream the answer and status updates to the browser.
4. Validate citations against returned search URLs.
5. Persist the answer, queries, source URLs, and timing trace.
6. Re-run searches when the user asks whether an old answer is still correct.

The server is a Node.js/TypeScript application using Hono, OpenRouter, SQLite
(`node:sqlite`), and a small vanilla JavaScript frontend. It requires Node
22.13 or newer.

## Current implementation status

### Implemented

- Hono HTTP server with:
  - `GET /health`
  - streaming `POST /api/chat`
  - conversation history retrieval
  - static frontend and browser-vendored Markdown sanitization dependencies
- SSE events for metadata, status, tokens, completion, and errors.
- Browser chat UI with:
  - streaming rendering
  - Markdown rendering and DOMPurify sanitization
  - stop/new-conversation controls
  - local conversation-id persistence
  - browser timezone submission
- OpenRouter LLM client with:
  - ordered model fallback
  - provider ordering
  - reasoning-effort configuration
  - streaming token handling
  - reasoning status events
  - heartbeat logging while waiting for the first answer token
  - `<think>` block removal across streamed chunks
  - abort propagation
- SQLite persistence for conversations and messages.
- SQLite FTS5 indexing for message recall.
- User and conversation isolation checks.
- Timezone-aware date formatting and temporal reference resolution.
- Deterministic recall from:
  - resolved date ranges
  - backward-looking language
  - FTS5 keyword matches
  - neighboring messages for useful context
- Prompt construction for:
  - current date/time
  - resolved date notes
  - recalled conversations
  - no-search behavior
- Structured logging with request-bound fields, pretty/JSON formats, log levels,
  error fields, and request lifecycle events.
- Configuration validation for model, API, database, port, logging, provider,
  and reasoning settings.
- Typed and validated search provider contract with normalized result limits,
  canonical URL deduplication, and offline contract tests.
- Tavily search adapter with typed provider errors and response normalization.
- Injectable search cache with separate news and default TTLs and recency bypass.
- One-retry search wrapper with deterministic cleanup and explicit final failures.
- Typed LLM tool calls and `web_search` argument validation with bounded repair
  messages for malformed calls.
- One-step validated `web_search` execution with delimited untrusted results
  and follow-up answer streaming.
- Configured Tavily search wiring through cache and retry layers, SSE search
  status events, and model/search/total timing in turn traces.
- Bounded four-step agent looping with up to three concurrent searches per
  step, deterministic tool-result association, budget exhaustion labeling, and
  cancellation handling.
- Focused tests for configuration, logging, LLM streaming behavior, reasoning
  stripping, recall, time resolution, prompt/think behavior, and application
  behavior.

### Not implemented yet

- The `web_search` provider and normalized search-result contract.
- Search caching, deduplication, recency handling, retries, and provider
  failure behavior.
- The tool-aware bounded agent loop.
- Parallel search calls within one agent step.
- Tool argument validation and malformed tool-call repair.
- Citation validation and invalid-citation removal.
- Persistence of search queries, sources, and answer provenance.
- Revalidation of an old answer against fresh search results.
- `/debug` trace inspection.
- Evaluation fixtures, measured pass rates, model bake-off results, and latency
  measurements.
- Optional follow-up features such as claim-level comparison, direct page
  fetching, background re-verification, and larger judged evaluations.

## Independently testable work items

Each item below has a narrow scope, a concrete output, and a standalone
acceptance check. Work items should be completed and tested independently;
interfaces and fakes should be used where an item depends on unfinished
behavior elsewhere.

### Phase 2: Search foundation

#### W2.1 — Define the search provider contract — complete

- Add typed request/result interfaces for query, recency, topic, domains,
  title, URL, domain, publication date, snippet, and retrieval time.
- Define the normalized result limits and deduplication rules.
- Add contract tests using an in-memory fake provider.
- **Acceptance:** invalid provider results are rejected, valid results have the
  documented shape, and the tests do not require network access.

#### W2.2 — Implement the Tavily adapter — complete

- Implement the provider behind the search interface.
- Read the Tavily API key from configuration.
- Normalize Tavily responses and surface provider errors explicitly.
- **Acceptance:** mocked Tavily responses become normalized results and mocked
  non-success responses produce a typed/logged error.

#### W2.3 — Add search result caching — complete

- Add a short-lived cache with separate default TTLs for news and non-news.
- Bypass the cache whenever `recency_after` is supplied.
- Keep cache behavior behind a small injectable component.
- **Acceptance:** repeated eligible queries hit the cache; recency queries
  bypass it; expired entries trigger a provider call.

#### W2.4 — Add search retry and result cleanup — complete

- Retry a failed search once.
- Deduplicate by canonical URL.
- Keep only the top five normalized results.
- Preserve explicit failure information for the agent.
- **Acceptance:** retry count, deduplication, ordering, and failure behavior are
  covered by deterministic unit tests.

### Phase 3: Agent loop

#### W3.1 — Add tool-call types and validation — complete

- Extend LLM request/event types for assistant tool calls and tool results.
- Validate `web_search` arguments with Zod.
- Return one useful validation error to the model for malformed arguments.
- **Acceptance:** valid arguments reach the provider; invalid arguments never
  reach search and produce a bounded repair response.

#### W3.2 — Implement one-step tool execution — complete

- Execute a single validated `web_search` call.
- Delimit search results as untrusted data.
- Feed the tool result back into the model conversation.
- **Acceptance:** a fake LLM tool call produces one fake search invocation and a
  final streamed answer containing the tool result.

#### W3.3 — Implement bounded multi-step looping — complete

- Add a maximum of four agent steps.
- Stop when the model produces a final answer.
- Return a clearly labeled answer when the step budget is exhausted.
- **Acceptance:** tests cover immediate answers, one search, repeated searches,
  and budget exhaustion.

#### W3.4 — Add bounded parallel search execution — complete

- Execute up to three search calls in parallel within one step.
- Preserve deterministic result association with each tool call.
- Respect request cancellation.
- **Acceptance:** three calls run concurrently, a fourth is not started, and
  cancellation stops pending work without hanging the SSE stream.

#### W3.5 — Wire search into context and streaming — complete

- Pass the search-enabled prompt to the loop.
- Stream search status events to the browser.
- Record model, search, and total timing in the trace.
- **Acceptance:** an end-to-end fake-LLM/fake-search test receives status,
  token, and done events in the expected order.

### Phase 4: Citations and provenance

#### W4.1 — Validate answer citations

- Parse `[n]` citations from the final answer.
- Map citation numbers only to URLs returned by the search calls.
- Strip invalid citations rather than allowing unsupported sources.
- Define behavior for missing, repeated, and out-of-range citations.
- **Acceptance:** valid citations remain, invalid citations are removed, and
  citation behavior is covered without network access.

#### W4.2 — Persist search provenance

- Add storage for search queries, normalized sources, answer associations, and
  retrieval timestamps.
- Keep provenance linked to the conversation and assistant message.
- **Acceptance:** a completed searched turn can be reloaded with all queries and
  source URLs in insertion/order-preserving form.

#### W4.3 — Show sources in the frontend

- Render validated sources below an answer.
- Keep URLs escaped/sanitized and open them safely.
- Handle answers with no sources and failed searches.
- **Acceptance:** browser-level or DOM tests verify safe rendering and correct
  source-to-citation mapping.

### Phase 5: Answer revalidation

#### W5.1 — Detect revalidation requests

- Detect requests such as “Is your answer still correct today?”.
- Identify the referenced stored answer and its original search queries.
- Return an explicit error when no eligible answer exists.
- **Acceptance:** detection works for positive and negative examples and never
  selects another user's conversation.

#### W5.2 — Re-run historical searches

- Re-run stored queries with `recency_after` set to the original answer date.
- Reuse the search interface while bypassing stale cache entries.
- **Acceptance:** fake-provider tests verify the date boundary and cache bypass.

#### W5.3 — Produce a revalidation response

- Compare old and new evidence.
- Format the response with:
  - a verdict first
  - changed claims with citations
  - no-change findings
  - unverifiable items
- Persist the revalidation result and trace.
- **Acceptance:** deterministic fixtures cover changed, unchanged, and
  unverifiable sources.

### Phase 6: Observability and evaluation

#### W6.1 — Add debug trace storage and `/debug`

- Persist request traces containing first-token, search, and total timings.
- Add a protected/read-only debug endpoint or local debug view.
- Avoid exposing prompts, answers, or secrets at normal log levels.
- **Acceptance:** a completed request is inspectable with timing fields and
  debug output does not leak API keys.

#### W6.2 — Build the fixed-clock evaluation suite

- Add representative prompts for current facts, dates, memory, search,
  citations, failures, and revalidation.
- Use mock LLM and search providers.
- Report pass rate and failure details from one repeatable command.
- **Acceptance:** `npm run eval` runs offline with a fixed clock and produces a
  stable result format.

#### W6.3 — Measure model quality and latency

- Record the model bake-off for valid tool-call rate, time to first token, and
  answer quality.
- Measure a typical single-search turn's first-token and total latency.
- Replace the measurement placeholders in `DESIGN.md`.
- **Acceptance:** the documented tables include methodology, sample size, and
  reproducible commands.

#### W6.4 — Add resilience and boundary tests

- Cover provider failure/fallback, malformed tool JSON, client disconnects,
  search exhaustion, timezone boundaries, and empty model output.
- **Acceptance:** each failure mode has a deterministic regression test and an
  explicit user-visible or logged outcome.

## Optional follow-up work

These are deliberately separate from the core deliverable and can be
implemented independently after the core phases:

- Claim ledger for claim-level revalidation instead of whole-answer diffing.
- Direct page fetching for vendor pricing and other primary-source pages.
- Background re-verification for topics the user is tracking.
- Larger evaluations with an LLM judge.
- A second search adapter, if the provider interface proves useful.

## Definition of done

The core project is complete when:

1. A user can ask a current question and receive a streamed answer grounded in
   normalized search results.
2. Every displayed citation maps to a URL actually returned for that answer.
3. Search queries, sources, answer text, and timing data are persisted.
4. Time and memory behavior remains deterministic and timezone-aware.
5. Old answers can be revalidated and reported as changed, unchanged, or
   unverifiable.
6. Search, model, and client failures are visible, bounded, and tested.
7. The offline evaluation suite and documented measurements are reproducible.

