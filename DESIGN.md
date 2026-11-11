# DESIGN

A chat agent with one tool, web search. The hard part is not search. It is knowing what "today" and "Monday" mean, remembering what the user said before, and re-checking an old answer against fresh sources. With one model-facing tool, all of that lives in the harness, not in extra tools.

## How it works

Each turn runs through four stages.

1. **Context assembly (no LLM).** The system prompt carries the current date, time and weekday in the user's timezone (sent by the client). The static prompt comes first so provider prompt caching helps.
2. **Time and recall (no LLM).** chrono-node resolves phrases like "Monday" or "3 November" to absolute date ranges. We pull stored messages from that window, and run SQLite FTS5 over the user's history when the message points backward ("I asked", "we shortlisted"). Hits are injected as a dated block. If nothing is found, the agent says so and never invents a past question.
3. **Agent loop.** A hand-written loop (about 150 lines) streams the model and runs `web_search` calls, in parallel when the model emits several. Budget: 4 steps, 3 parallel calls per step, about 25 seconds wall clock. When the budget runs out, it answers with what it has and flags the gaps.
4. **Post-processing.** Every `[n]` citation is checked against URLs the search tool actually returned, and invalid ones are stripped. The answer, its queries and its source URLs are persisted.

`web_search({ query, recency_after?, topic?, domains? })` returns normalized results (title, URL, domain, published date, snippet of about 800 characters, `retrieved_at`), top 5, deduplicated. `recency_after` powers "what changed since Monday". `domains` lets the agent read a vendor's own pricing page. Results are delimited and treated as data, never instructions. A short-TTL cache (about 5 minutes for news, 1 hour otherwise) is bypassed whenever `recency_after` is set.

"Is your answer still correct today?" reloads the stored answer, reruns its queries with `recency_after` set to the answer date, and diffs. The reply opens with a verdict, then the delta, and separates "changed (cited)", "no change found" and "could not verify".

## Why this shape

- **Memory and time are deterministic.** A recall tool the model must remember to call is a failure point, and the spec allows one tool. Harness-side recall is faster and testable with a fixed clock.
- **Hand-rolled loop.** Budgets, parallel calls, citation checks and tool-call repair are the interesting parts, so I own them instead of hiding them in a framework.
- **Open-weight model via OpenRouter.** Reviewers cannot self-host. Model IDs come from env (`MODEL_ID`, `FAST_MODEL_ID`), with an ordered fallback list. Open models sometimes emit malformed tool JSON, so args are validated with Zod, the error is returned to the model once, and a fallback parser handles tool calls placed in content.
- **Search behind an interface.** Tavily ships as the provider. The `SearchProvider` interface keeps a swap cheap without carrying a second adapter I would not have time to test.
- **One process, no native deps.** Hono serves SSE and a small vanilla frontend. Storage is Node's built-in `node:sqlite` (FTS5 included), so `npm install` never compiles anything. A first attempt with `better-sqlite3` failed a clean install when no prebuilt binary was reachable. Requires Node 22.13+.

## Considered and rejected

- **Router or classifier model in front.** Adds latency to every turn. The main model decides whether to search.
- **LangGraph or a full agent framework.** More surface than a 4-step loop needs.
- **MCP search server.** An extra process with no gain here.
- **Vector DB for memory.** FTS5 plus date windows is enough at this scale.
- **Self-hosted model.** Reviewers could not run it.
- **Second search adapter (Exa).** Cut for scope. The interface remains.

## Measured

- Model bake-off (valid tool-call rate, time to first token, quality, 20 prompts): `TODO table: GLM / Kimi / Qwen`
- Eval suite (`npm run eval`, mock search, fixed clock): `TODO pass rate`
- Latency on a typical single-search turn: `TODO time to first token / total`

## Failure behavior

Search retries once, then the agent answers from model knowledge and labels it unverified. Provider errors fall through the model list. Each turn writes a JSON trace (time to first token, search time, total) viewable at `/debug`.

## With another week

- **Claim ledger.** Extract claims and sources per answer so revalidation diffs claims, not whole answers.
- **Page fetch.** Read vendor pricing pages directly instead of relying on snippets.
- **Background re-verification** of topics the user is tracking, with a nudge when something changes.
- **Larger evals** with an LLM judge, plus a timezone-boundary test set.
