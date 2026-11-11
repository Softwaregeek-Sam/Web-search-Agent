# web-search-agent

A chat agent whose only tool is web search. Time and memory are handled by the harness, not by extra tools. See [DESIGN.md](DESIGN.md).

## Run

Requires Node 22.13 or newer (uses the built-in `node:sqlite`, so there is nothing native to compile).

```bash
npm install
cp .env.example .env   # then fill in OPENROUTER_API_KEY and MODEL_ID
npm run dev            # http://localhost:3000
```

`MODEL_ID` is an open-weight model slug from https://openrouter.ai/models. Pick one that lists tool support. `TAVILY_API_KEY` is needed once the search tool lands (phase 2).

## Logging

Every chat request prints one traceable cycle, tagged with a request id (`req=`):

```
http.request -> turn.start -> turn.context -> llm.attempt -> llm.stream.open -> llm.chunk.first
  -> llm.reasoning.start (reasoning models) -> llm.content.start -> turn.first_token
  -> llm.finish -> turn.done -> http.response.end
```

While waiting for the first answer token, `llm.waiting` prints every 5 seconds, so a stall is visible. Failures print as `llm.attempt.failed` (with HTTP status and the provider's message) or `turn.empty_response` (model finished with no text, often a reasoning model that used its budget thinking).

`LOG_LEVEL=debug` also logs the full prompt and the full answer. `LOG_FORMAT=json` gives one JSON object per line. Info logs include only a 120-character preview of the user's message.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Server with reload |
| `npm test` | Unit and integration tests (fixed clock, fake LLM) |
| `npm run typecheck` | `tsc --noEmit` |

## Status

Phase 1 done: request-cycle logging, streaming chat, SQLite history with FTS5, timezone-aware date resolution, deterministic recall of earlier conversations. Next: `web_search` tool and agent loop budgets, citation checks, revalidation of old answers, eval suite.
