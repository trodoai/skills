# The Run Model — how Trodo wants an agent shaped

This is the one page that decides the trace shape. Every other file in this skill
is a recipe for *how* to emit what this page says to emit. Read it fully before
drawing a single trace tree. It targets `trodo-node` / `trodo-python` **≥ 2.23**.

Docs: `https://docs.trodo.ai/observability/features/instrumentation/wrap-your-agent`,
`https://docs.trodo.ai/observability/features/instrumentation/multi-agent`,
`https://docs.trodo.ai/observability/features/conversations`.

---

## 1. Vocabulary

| Term | Meaning in Trodo | Emitted by |
|---|---|---|
| **Run** | One complete invocation of one agent, from an external trigger to the reply/result. The row in the Runs table: name, user, cost, latency, status. | `wrapAgent` / `wrap_agent` (in-process); `startRun`+`endRun` (one invocation that spans requests/workers) |
| **Span** | One step inside a run: an LLM call, a tool dispatch, a retrieval, a sub-agent, a named stage. Nested by call structure. | auto-instrumentation; `withSpan` / `trodo.span`; `tool` / `llm` / `retrieval` / `trace` factories; `joinRun` from another process |
| **Sub-agent span** | A span of kind `agent`: an agent that exists only to serve *this* run (planner, researcher, critic, one round of a loop). | `withSpan(name, fn, { kind: 'agent' })` / `trodo.span(name, kind='agent')` |
| **Linked run** | A separate run caused by another run — a job the first run enqueued, a webhook it registered. Recorded with `parentRunId`. | `wrapAgent(..., { parentRunId })` |
| **Turn** | One user message → one assistant reply. **A turn is a run.** | `wrapAgent` per turn |
| **Conversation** | Many turns of one thread, grouped by `conversationId`. Never inferred. | the same `conversationId` on every run of the thread |
| **Runless span** | A tool call the server proxies without seeing the prompt or the answer (MCP `tools/call`). | `trackMcp` / `track_mcp` |

Kinds are exactly five: `agent`, `llm`, `tool`, `retrieval`, `generic`. A run is always kind `agent`.

---

## 2. The boundary rule — decide from code, not from opinion

**A run is one externally-triggered invocation.** Find the trigger; everything the
trigger's handler reaches by a synchronous call or an awaited chain, in the same
process, is spans *inside* that run — however large, however many "agents" it
contains. Apply these questions in order; the first "yes" decides.

| # | Question about the piece of code | Shape |
|---|---|---|
| 1 | Is it the handler of an **external trigger** — an HTTP request, a queue message being *consumed*, a cron tick, a CLI invocation, a webhook delivery, one inbound chat message? | **Run.** `wrapAgent` here and nowhere deeper for this trigger. |
| 2 | Is it a **branch of a multiplexed trigger** — one route / task / event handler that switches on `type`, `task_type`, `kind`, `event`, `command` and does different LLM work per branch? | **One run per branch, each with its own agent name.** Wrap inside the branch (or pass the branch name to one wrap at the top). Never one run named after the dispatcher. |
| 3 | Is it reached from a run's handler by a call or `await` in the same process (helper, sub-agent, supervisor fan-out, loop iteration, `Promise.all` / `asyncio.gather`)? | **Spans inside that run.** Sub-agents → `agent` spans; dispatched tools → `tool`; retrieval → `retrieval`; named stages → `generic`; model calls → auto (`llm`). |
| 4 | Is it work the handler **detaches** and does not await — `setImmediate`, an un-awaited promise, `asyncio.create_task`, `BackgroundTasks`, `after()` / `waitUntil`, a thread — but still in the same process? | **Same run, but you must keep the run open or hand it the context.** Await it before the wrap returns; or capture `currentRunId()` and `joinRun` inside the task (Node) / `current_run_id()` + `join_run` (Python). A span emitted after the run closed is dropped. |
| 5 | Does the handler **enqueue / schedule** work that a *different consumer* picks up later (job queue, pub/sub, delayed task, webhook to itself)? | **Linked run.** The consumer is trigger #1 and gets its own `wrapAgent`. Put `runId`, `conversationId`, `distinctId` in the job payload; the consumer passes them as `parentRunId`, `conversationId`, `distinctId`. |
| 6 | Does the same invocation continue in **another process or service** (HTTP call to an internal service, worker thread, process pool) as part of producing *this* reply? | **Same run, remote spans.** `propagationHeaders()` on the caller + `expressMiddleware()` / `fastapi_middleware()` on the callee, or explicit `joinRun(runId, parentSpanId, …)`. |
| 7 | Does **one turn or one job** genuinely span several requests or workers before it has its reply (websocket chat where a turn's tool calls arrive as separate frames, a job pre-empted and resumed elsewhere, a human-in-the-loop pause)? | `startRun` → persist `runId` → `joinRun` per fragment → `endRun`. Still one run per turn/job, never per session. |
| 8 | Is it an **MCP `tools/call`** the server proxies without seeing the user prompt or the model's answer? | **Runless span** via `trackMcp`. No run. `sessionId` = the `Mcp-Session-Id`. |

Two consequences people get wrong:

- **Size is never the test.** A 40-step supervisor with five workers that all run inside one request is one run with `agent` spans. A two-line classifier consumed from a queue is its own run.
- **"One request, one run" is right; "one agent class, one run" is wrong.** If the codebase has `PlannerAgent`, `ResearchAgent`, `WriterAgent` classes that a single request calls in sequence, that is one run and three `agent` spans. They become separate runs only when something *else* triggers them.

When two readings survive all eight questions (rare: an inline call to something the team clearly ships as its own product), record both trees, recommend the linked-run shape, and ask once. Never block on this in a non-interactive session — pick, state it, proceed.

### Nesting facts you must respect

- `wrapAgent` inside `wrapAgent` = **two sibling runs**, never parent/child. The SDK warns once on stderr. If the inner one is a sub-agent of the request, it must be `withSpan(..., { kind: 'agent' })`.
- Spans emitted **outside any run are dropped** — including auto-instrumented LLM calls. Auto-instrumentation on its own produces nothing; every entry point needs its run.
- Auto-instrumented spans nest under whatever `withSpan` is active, so a sub-agent span "owns" the model calls made inside it. That is what makes the waterfall show who did what.
- The agent **loop** (LLM → tool_calls → dispatch → LLM …) is one run. An iteration is *not* a span. Each tool dispatch is a `tool` span; each model call is an `llm` span. Put `iterations` and `stop_reason` in run metadata.

---

## 3. Naming

- **Run name = the agent's identity**, stable across deploys, snake or kebab case: `support_chat`, `issue_investigator`, `daily_digest`, `email_writer`. Not the route (`POST /api/chat`), not the class (`ChatService`), not the dispatcher (`tasks`), not the version (`chat_v3` — version goes in metadata).
- One run name per distinct agent. The multiplexed route with `summarize | classify | translate` yields three names.
- **Sub-agent span name = the sub-agent's identity**: `planner`, `researcher`, `critic`, `round_2`. Fan-out instances: `researcher:pricing` plus `span.setAttribute('topic', 'pricing')`.
- **Tool span name = the tool's real name** (`lookup_order`) and `setTool(name)` with the same value.
- Prefixes like `ask.tool.lookup_order` are fine if the codebase already namespaces; never `step_1`, `child`, `tool`.

---

## 4. Input / output contract

The backend reads run input/output with a tolerant extractor: a plain string, a
chat-message array (it takes the **last** `user` / `assistant` message), or an object
with a recognised key (`question`, `message`, `query`, `text`, `prompt` for input;
`answer`, `response`, `text`, `result`, `output` for output). Anything else is stored
but cannot be shown as a turn, embedded per role, or scored.

| Where | Input | Output |
|---|---|---|
| **Run — chat/turn agents** | The user's new message as a string, **or** the full messages array you sent (system + history + new user turn). Both work; the array is better because it preserves history for the transcript view. | The final assistant reply as a string, or the assistant message object. **Never** a `Response`, a stream handle, `{ status: 'ok' }`, or a wrapper with counts. |
| **Run — non-chat agents** (classifier, job, cron) | The job payload / request body / the item being processed. | The structured result the agent produced (the classification, the report object). Full payload, not a summary. |
| **LLM span** (manual only) | The chat-message array you sent to the model. Roles `system` / `user` / `assistant` / `tool` plus Trodo's `context` for retrieved documents. | The completion text or message. Tokens via `setLlm`. |
| **Tool span** | The parsed arguments the model chose. | The **full** result returned to the model. Scalars you filter on → `setAttribute`. |
| **Retrieval span** | The query. | The documents returned (list). |
| **Sub-agent span** | What the sub-agent was asked to do. | What it produced. |

Rules that follow:

1. **Run input is never captured automatically** — the callback has no arguments. Call `run.setInput(...)` first thing in every wrap. (Python decorator `@trodo.agent` captures the function's arguments; the context manager does not.)
2. **Run output = the callback's return value unless you `setOutput`.** Route handlers usually return a `Response` / `res.json(...)` / `None` — in a handler, call `run.setOutput(reply)` explicitly with the reply, not the HTTP object.
3. **Streaming: the wrap must stay open until the full text exists.** `await result.text` (Vercel AI), `await stream.finalMessage()` (Anthropic), accumulate deltas (OpenAI) — then `setOutput`, then return. If the route must return the stream to the browser *before* it ends, keep the wrap alive with a promise resolved in `onFinish` and return the `Response` from *outside* the wrap, or use `startRun`/`endRun` with `endRun` in `onFinish`.
4. **Never pre-truncate or summarise** what goes into `setOutput`. The SDK caps at 1 MB.
5. **Never put the whole history in the *output***; the extractor takes the last assistant message, so a history array works, but a plain reply string is cleaner.

---

## 5. Identity — `distinctId`

Resolution order. Take the first that exists in the code path; state the choice; ask only if two candidates at the same level compete.

1. The **authenticated user's stable id** from the app's auth object. Prefer an immutable id over email; if the team already identifies users to Trodo by some id elsewhere, use that same one.
2. The **API-key / tenant owner** for machine callers (an integration hitting your API).
3. A **stable client/device/session id** the client already sends, for genuinely anonymous chat. Never per-request randomness.
4. **Nothing** — the SDK mints `anon_<uuid>` per run, so every run becomes a new "user". Acceptable only for internal scripts; say so in the summary.

The same id goes on **every** surface: `wrapAgent`, `startRun`, `trackMcp`, and into every job payload for linked runs. For our own product this is the pattern: `distinctId: userEmail || String(userId) || process.env.TRODO_DEFAULT_DISTINCT_ID`.

Tenant / organisation is **not** a distinct id — it goes in run metadata (`team_id`, `org_id`).

---

## 6. Conversation — `conversationId`

- Pass it on **every run of a thread**, including linked runs the thread caused and remote joins. Same value, same spelling.
- Source order: the app's chat/thread id → ticket / case id → a client-supplied conversation id → tell the user to mint one on the first turn and echo it back to the client. It is never inferred server-side.
- `trackMcp` calls it `sessionId` — it is the same field (`conversation_id`); use the `Mcp-Session-Id`.
- A **non-chat** agent (job, cron) has no conversation unless it serves one — an investigation triggered from a chat turn keeps that turn's `conversationId` so it appears in the thread.

---

## 7. Metadata — the required set

`run.setMetadata({...})` / `wrapAgent(..., { metadata })`. Scalars only; this is what the dashboard filters and breaks down on. Every run should carry what applies:

| Key (suggested) | Value |
|---|---|
| `environment` | `production` / `staging` / `development` — from the app's own env var |
| `release` | git sha or version tag, if the deploy exposes one |
| `agent_version` / `prompt_version` | when the app versions its prompts or agent config outside Trodo's prompt registry |
| `model` (when fixed per agent) | the configured model name — the per-call model is on the `llm` spans anyway |
| `channel` / `surface` | `web`, `slack`, `api`, `cli`, `cron` |
| `team_id` / `org_id` / `tenant` | who the run was for |
| `mode`, `effort`, feature flags | anything the code branches on |
| `iterations`, `stop_reason` | for loop agents |

Span-level scalars (`result_count`, `topic`, `cache_hit`) go on the span with `setAttribute`. Do not put objects in attributes.

---

## 8. Failures

- A thrown `Error` propagating out of the wrap / span is captured fully (type, message, status code, stack) and re-thrown. Do nothing extra.
- Code that **catches and recovers** must call `span.setError({ message, type, statusCode })` / `span.set_error(...)`, or at run level `run.setErrorSummary(msg, { type })` / `run.set_error_summary(...)`. Returning `{ error: ... }` leaves the span green.
- Throw `Error` objects, not strings or plain objects — a bare throw yields "error with no message".
- A retried-then-succeeded step is `ok` with `setLevel('warning')`.

---

## 9. Process lifetime and flushing

| Process kind | Init | Flush |
|---|---|---|
| Long-running server | once at startup, before provider clients are constructed | nothing per request; `await trodo.shutdown()` on SIGTERM if you already have a shutdown hook |
| One-shot script / CLI / cron process | once at the top | **`await` every wrap** and `await trodo.shutdown()` before exit — an unawaited wrap loses the run silently |
| Serverless function (Lambda, Cloud Run request-scoped, Vercel Function) | once at module scope (cold start) | `await trodo.flush()` before returning the response, or hand the flush to the platform's `waitUntil` / `after()`; never fire-and-forget the wrap |
| Worker (queue consumer) | once at worker start | per job nothing; `shutdown()` on drain |
| Test runner / CI | don't init, or init behind `TRODO_DISABLED` / a missing `TRODO_SITE_ID` guard so the suite doesn't emit |

---

## 10. Privacy, volume, feedback

- **PII / secrets in prompts:** if the app already redacts before logging, apply the same function before `setInput` / `setOutput`. Otherwise do not invent redaction; name the fields that will be stored and let the user decide.
- **High volume:** there is no client-side sampler; if the user needs one, wrap the `wrapAgent` call in their own `shouldTrace(request)` guard rather than sampling spans (partial trees are worse than absent ones).
- **Feedback / scores later:** return `runId` to the caller that will collect feedback (`const { result, runId } = await wrapAgent(...)`; Python `run.run_id`) and call `trodo.feedback(runId, {...})` when the user reacts.

---

## 11. Verification checklist (what a correct trace looks like)

| Check | Wrong looks like |
|---|---|
| One run per trigger; multiplexed branches have distinct names | N runs for one request; one run named `tasks` |
| Sub-agents nest as `agent` spans; their LLM/tool spans nest under them | flat list of LLM spans; sibling runs |
| Linked runs carry `parentRunId` + the thread's `conversationId` + the same `distinctId` | orphaned job runs with `anon_*` |
| Run input contains the user's message; output the final reply | blank, `[object Response]`, `{ status: 'ok' }` |
| Every LLM span has model + tokens; tool spans have `tool_name`, input, output | tokens zero; tool spans absent though `tool_calls` present |
| Detached work landed inside its run or as a linked run | span count lower than the code's call count |
| Failures are red with a message | green on a 429; red with no message |
| No run left `running`; one-shot processes flushed | `running` rows; scripts that emit nothing |
