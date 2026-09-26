# node-monolith — offline tracing sandbox

A plain Node 20+ / CommonJS / Express monolith with several distinct agents, all
talking to a deterministic OpenAI mock. It is **not instrumented**: no `trodo-node`,
no tracing. A later agent instruments it; `scripts/check-traces.js` then judges the
result from what reached the ingest mock.

## Run

```bash
npm install                      # express, openai, uuid
bash scripts/drive.sh            # mocks + server up, drives every agent, tears down
node scripts/check-traces.js     # asserts the run model from mock/ingest-log.jsonl
```

Un-instrumented, `drive.sh` works end to end and `check-traces.js` fails with
`0 runs found`. That is the baseline.

When instrumenting with the local SDK checkout, install it with
`npm install --install-links <path-to-sdks/trodo-node-sdk>` (the sandbox never
imports `trodo-node` on its own). `drive.sh` exports `TRODO_API_BASE` and
`TRODO_SITE_ID` (defaults below) and leaves them alone if already exported.

## Ports

| what | env | default |
| --- | --- | --- |
| Express app | `PORT` | 4310 |
| MCP JSON-RPC (`POST /mcp`) | `PORT + 1` | 4311 |
| OpenAI mock | `OPENAI_MOCK_PORT` | 4320 |
| Trodo ingest mock | `INGEST_PORT` | 4330 |
| ingest target | `TRODO_API_BASE` | `http://127.0.0.1:4330` |
| site id header | `TRODO_SITE_ID` | `sandbox-site` |
| investigator rounds | `INVESTIGATOR_ROUNDS` | 3 |
| digest interval | `DIGEST_INTERVAL_MS` | 0 (off; `POST /internal/cron/digest` on demand) |

`src/llm/client.js` builds the shared `OpenAI` client at module top level
(`baseURL: OPENAI_BASE_URL`, `apiKey: 'test'`, `maxRetries: 0`) — a deliberate pitfall
for instrumentation that wraps the client after import.

## Layout

```
src/server.js                  Express app; starts worker, cron, MCP server
src/llm/client.js              shared OpenAI client (top-level singleton)
src/agents/chat/               POST /api/chat — streaming tool-calling loop (SSE)
src/agents/investigator/       RLM-style job agent + detached notifySlack
src/routes/tasks.js            POST /api/tasks/run — summarize|classify|translate
src/jobs/worker.js             in-process array queue polled by setInterval
src/cron/digest.js             setInterval digest + POST /internal/cron/digest
src/mcp/server.js              JSON-RPC over POST /mcp, Mcp-Session-Id header
scripts/backfill.js            one-shot CLI: classify fixtures/tickets.json, exit
mock/openai-mock.js            deterministic OpenAI-shaped mock (stream + non-stream, 429 on RATE_LIMIT_ME)
mock/trodo-ingest-mock.js      catch-all ingest, appends to mock/ingest-log.jsonl
scripts/drive.sh               end-to-end driver
scripts/check-traces.js        run-model assertions
```

## What `drive.sh` does

1. `conv-1` / `u-42`: "hi, how long do refunds take?", "where is my order 5512?" (tool `lookup_order`), "I'm angry, escalate this" (tool `escalate` → enqueues `investigate_issue`)
2. `conv-2` / `u-7`: "help with my account"
3. three tasks: summarize, classify, translate
4. waits ~3 s for the investigator job and its detached Slack notify
5. `POST /internal/cron/digest`
6. MCP: initialize → tools/list → tools/call get_order → tools/call search_docs (session id saved to `.logs/mcp-session-id`)
7. `node scripts/backfill.js`
8. `conv-3` / `u-99`: a turn containing `RATE_LIMIT_ME` → the mock returns 429
9. teardown, prints the ingest-log line count

## Intended run model (what `check-traces.js` asserts)

| agent | runs | shape |
| --- | --- | --- |
| chat (`POST /api/chat`) | 1 run **per turn** (5 total) | `conversation_id` = conversationId, `distinct_id` = `x-user-id`; ≥1 llm span; `lookup_order` / `escalate` tool spans on the right turns; input holds the user turn, output is the final text (not a stream object); the `RATE_LIMIT_ME` turn is `status: error` mentioning 429 / rate limit |
| tasks (`POST /api/tasks/run`) | 3 runs, **3 different agent names** | one llm span each — one multiplexed handler must not become one agent |
| investigator (job `investigate_issue`) | 1 run of its own | `parent_run_id` = the escalate chat run (or, acceptable, same `conversation_id conv-1`); `distinct_id u-42`; ≥2 agent-kind/round spans, ≥3 llm, ≥2 tool |
| notify (detached `setImmediate` `notifySlack`) | not lost | its llm call lands inside the investigator run or in its own notify run; total llm ≥ `2 + INVESTIGATOR_ROUNDS + 1` |
| digest (`POST /internal/cron/digest`) | 1 run | 1 llm span |
| backfill (`scripts/backfill.js`) | 3 runs × 1 llm **or** 1 run × 3 llm | one-shot process: must flush before `process.exit(0)` |
| MCP (`POST /mcp`) | **zero runs** | 2 runless tool spans (`run_id: null`), `agent_name` MCP, `conversation_id` = `Mcp-Session-Id` |
| hygiene | — | no `running` runs left, no orphan spans, no runless non-MCP spans |

The checker is field-name tolerant (`agent_name`/`agentName`, `distinct_id`/`distinctId`,
`parent_run_id`/`parentRunId`, JSON-string vs object payloads) and reconstructs runs from
full trees (`/api/sdk/runs/ingest`), incremental starts/spans/ends (`/api/sdk/runs/start`,
`/api/sdk/runs/:id/spans`, `/api/sdk/runs/:id/end`), and runless `/api/sdk/spans/append`.
OTLP protobuf at `/v1/traces` is counted, not parsed. It classifies by `agent_name` first
and only then by input text. Pass a different log path as the first argument.

## Files ignored by git

`node_modules/`, `.logs/`, `mock/ingest-log.jsonl`, `package-lock.json`.
