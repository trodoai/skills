---
name: trodo-tracing
version: 3.0.0
sdk_version_node: ">=2.23.0"
sdk_version_python: ">=2.23.0"
last_updated: 2026-09-25
description: >-
  Install Trodo agent tracing into a codebase: map every agent entry point,
  decide the run boundary by a fixed rule (one run per external trigger; sub-agents,
  tools and loops are spans inside it; queued work is a linked run; a chat turn is a
  run grouped by conversationId), then wire trodo-node / trodo-python with the right
  identity, input/output and metadata. Use for "add Trodo tracing", "instrument my
  agents", "trace my LangChain / Vercel AI / OpenAI / MCP / multi-agent app",
  "add Trodo next to my OTel", and for auditing or fixing an existing Trodo integration
  ("my runs split", "error with no message", "output is empty").
---

# Trodo Tracing

You are integrating Trodo into someone else's agent. The trace you produce is the
picture their team will debug from for months. The whole job is to make that picture
**true**: one run per thing a user or scheduler triggered, every real step inside it,
the real user on it, the real input and reply on it, failures red.

Read [`references/run-model.md`](./references/run-model.md) **before anything else**.
It is the contract this skill exists to apply. Everything below is the procedure for
applying it.

## Preconditions

- **SDK floor:** `trodo-node` / `trodo-python` **≥ 2.23**. If an older version is
  installed, upgrade it as part of EXECUTE; this skill does not carry workarounds for
  older releases.
- **Site id:** `TRODO_SITE_ID` from the dashboard (Integration Manager). Server-side
  env only — never `NEXT_PUBLIC_` / `VITE_` / `PUBLIC_`. If the user gave it in the
  prompt, use it; otherwise ask once, or leave the env var name in place and tell them.
- **Already instrumented?** If `trodo.init` / `wrapAgent` / `wrap_agent` / `trackMcp`
  already exist, run the same procedure in audit mode — step 3 becomes a gap report and
  step 4 applies approved fixes. See [`references/audit.md`](./references/audit.md).
- **Docs:** `https://docs.trodo.ai/llms.txt` lists every page; append `.md` to any
  page URL for markdown. Read the page a recipe cites before writing that recipe's code.

## The procedure

Five steps, in order. Steps 1–3 produce written artifacts the user sees. **No
instrumentation code is written before step 3 is on screen.**

### 1. Map the stack → the Stack Map table

Follow [`references/stack-map.md`](./references/stack-map.md) exactly: services →
language / runtime / process kind → providers and frameworks → **every** entry point
(HTTP routes, queue consumers, cron ticks, CLI scripts, websocket/bot handlers,
MCP `tools/call`, multiplexed branches) → identity source → thread-id source → answer
boundary. Sweep for call sites (`chat.completions`, `messages.create`, `generateText`,
`.invoke(`, `tool_calls`, `tool_use`, `Promise.all`, `create_task`, `enqueue`,
`setInterval`, …) and walk outward to the trigger. Never rely on file names, never
assume there is exactly one agent, never stop at the first one you find.

Large repo or unclear flow → delegate the sweep to explore agents with the grep table
and have them return the filled table. Do not guess rows, and **do not move to step 2
until every sweep has returned**. If an area cannot be swept, list it under "not
audited" in the plan instead of dropping it silently.

Two checks per row before it counts:
- **Is it live?** A route or job with no caller in the repo and no deploy target (a
  service the code stopped calling) is dead code — list it as such and skip it.
- **Which process runs it, and does that process call `init`?** Every deployable process
  (web server, each worker, each cron/job entry) needs its own `init` at start, before
  any work runs. A worker that inits lazily, or never, emits nothing for the jobs it
  runs before that point.

### 2. Decide the shape → one trace tree per entry point

Apply [`run-model.md` §2](./references/run-model.md) — the eight questions, in
order, per entry point — and write the expected tree for each (format in
`stack-map.md` §5). The rule is decidable from code; do not ask the user which
components "feel like" agents. In particular:

- a multiplexed route/task with N branches → N trees with N agent names;
- sub-agents, rounds, supervisors, fan-out inside one request → `agent` spans in one tree;
- a job the request enqueues → its own tree, `parentRunId` + the same
  `conversationId` / `distinctId`;
- detached in-process work → inside the tree, awaited or joined;
- a chat turn → one tree per turn, `conversationId` from the thread id;
- MCP `tools/call` → runless spans, no tree.

Then fix, per tree: **run name**, **input / output** sources (§4), **`distinctId`**
by the resolution order (§5), **`conversationId`** source (§6), the **metadata** set
(§7), and where **init** and **flush** go for that process kind (§9,
[`references/runtimes.md`](./references/runtimes.md)).

Check each framework in play against [`references/frameworks.md`](./references/frameworks.md)
to mark what is auto-captured and what needs a manual span. A manual span appears in a
tree only for a real, uncovered step: a dispatched tool, a retrieval, a sub-agent, a
meaningful stage. Never invent structure; never re-wrap what auto-instrumentation
already emits.

### 3. Show the plan, confirm once

Present, in one message: the Stack Map table, the trace trees, and a short list of the
choices made (identity source, conversation source, any SDK upgrade, any framework
caveat such as "Node ESM raw OpenAI may need `trodo.llm`"). If something is a genuine
tie — two equally plausible user ids, an inline call to something the team ships as a
separate product — ask **one** question with a recommendation (`AskUserQuestion` when
available). Otherwise say what you picked and proceed. In a non-interactive session
never block: pick by the rule, state it, continue.

### 4. Execute

Per service, in this order, using the recipes:

1. **Install / upgrade** the SDK with the project's package manager, plus the
   instrumentor packages for the providers found (`frameworks.md` table).
2. **Init once per process**, before any provider client is constructed
   (`runtimes.md`). Watch for a shared client created at module top level — put init
   in a module imported first, or make the client lazy.
3. **Wrap each entry point** exactly as its tree says: `wrapAgent` / `wrap_agent`,
   `startRun`+`endRun` only for a single turn/job that spans requests, `trackMcp` for MCP.
   Set `run.setInput(...)` first thing and `run.setOutput(...)` with the real reply
   (`run-model.md` §4). Pass `distinctId`, `conversationId`, `parentRunId`,
   `metadata` as decided.
4. **Add the manual spans** the trees list — tool dispatch loops, retrievals,
   sub-agents — with [`references/manual-instrumentation.md`](./references/manual-instrumentation.md).
   Remember `tool()` / `llm()` / `retrieval()` / `trace()` are **factories**; for
   one-shot use inside a dispatcher use `withSpan` / `trodo.span`.
5. **Propagate** across queues, workers and services as the trees say
   (`runtimes.md` §Queues, [`references/cross-service.md`](./references/cross-service.md)).
6. **Streaming** handlers keep the run open until the full text exists
   ([`references/streaming.md`](./references/streaming.md), `runtimes.md` §Streaming).
7. **Flush** for one-shot and serverless processes (`run-model.md` §9).
8. **Failures**: let errors throw; where code recovers, `setError` / `setErrorSummary`.
9. Set `TRODO_SITE_ID` in the env file the app already loads; never commit a value.

Match the codebase's style: same module system, same async style, same error handling
idiom. Do not refactor around the instrumentation. Do not add spans for steps that
don't exist.

### 5. Verify against the trees

Not done when it compiles. Run one request per entry point with
`trodo.init({ debug: true })` (or `TRODO_DEBUG=1`) and compare the emitted runs and
spans to the trees from step 2 using the checklist in `run-model.md` §11: run count
and names, nesting depth, LLM spans with tokens, tool spans with `tool_name` + input +
output, run input/output populated, `distinctId` / `conversationId` / `parentRunId`
present, failures red with a message, no `running` rows, one-shot processes flushed.
If the Trodo MCP is connected, query the runs instead of reading logs. Also confirm
the SDK is really live in each deployed process: some codebases wrap `trodo` in a
stub that silently no-ops when the package fails to load, and a serverless bundle can
drop an optional dependency. One run per deployed agent visible in the dashboard is
the proof; a local debug run is not. Report exactly
what you saw; fix any mismatch before calling it done. If you could not run it, say so
and give the user the checklist to run.

## Recipes and references

| Need | File |
|---|---|
| The run/span/turn/conversation model, boundary rule, I/O contract, identity, metadata, failures, flushing | [`references/run-model.md`](./references/run-model.md) |
| Discovering services, entry points, multiplexing, identity and thread sources | [`references/stack-map.md`](./references/stack-map.md) |
| Which frameworks/providers auto-capture what; LangGraph, OpenAI Agents SDK, Pydantic AI, CrewAI, ADK, Mastra, Claude Agent SDK, gateways | [`references/frameworks.md`](./references/frameworks.md) |
| Init/flush per runtime: Express/Next/FastAPI/Django/Flask/bots, serverless, queues (BullMQ/Celery/SQS), cron/CLI, detached work, websockets | [`references/runtimes.md`](./references/runtimes.md) |
| Instrumentor packages, `debug: true`, `disableInstrumentations`, ESM | [`references/auto-instrumentation.md`](./references/auto-instrumentation.md) |
| Manual spans: tool dispatch loop, `withSpan`, factories, `setLlm` (cache/reasoning tokens), `trackLlmCall`, output vs attributes | [`references/manual-instrumentation.md`](./references/manual-instrumentation.md) |
| Streaming (Vercel AI, OpenAI, Anthropic, SSE) | [`references/streaming.md`](./references/streaming.md) |
| One turn or job spanning requests/workers: `startRun` / `joinRun` / `endRun` | [`references/long-session.md`](./references/long-session.md) |
| Cross-service and worker propagation, middleware, body propagation | [`references/cross-service.md`](./references/cross-service.md) |
| MCP servers: `trackMcp` runless spans | [`references/mcp-runless.md`](./references/mcp-runless.md) |
| Vercel AI SDK v5/v6/v7 specifics, Next.js `instrumentation.ts` | [`references/vercel-ai-sdk.md`](./references/vercel-ai-sdk.md) |
| Existing OTel (Datadog/Honeycomb/`@vercel/otel`), OTLP path | [`references/dual-export.md`](./references/dual-export.md) |
| Auditing an existing integration: invariants, inventory, gap catalog, gap report | [`references/audit.md`](./references/audit.md) |
| Reporting a wrong or missing instruction in this skill | [`references/skill-feedback.md`](./references/skill-feedback.md) |

Docs pages (append `.md` for markdown): `wrap-your-agent`, `manual-spans`,
`multi-agent`, `long-running-runs`, `distributed-tracing`, `opentelemetry`, `raw-http`
under `https://docs.trodo.ai/observability/features/instrumentation/`;
`frameworks/<name>` for each provider; `conversations`, `metadata`, `status-and-errors`,
`feedback`, `mcp`, `pricing`, `users/identification` under
`https://docs.trodo.ai/observability/features/`.

## Handle reference

| Handle | From | Methods |
|---|---|---|
| `RunHandle` (Node) / `RunHandle` (Python) | `wrapAgent(name, async (run) => …)` / `with wrap_agent(...) as run` | `setInput`, `setOutput`, `setMetadata(obj)`, `setErrorSummary(msg, { type })`; properties `runId`, `distinctId` (Python: `run.run_id`, snake_case methods). **No `setAttribute`.** |
| `SpanHandle` | `withSpan(name, async (span) => …, { kind })` / `with trodo.span(name, kind=…) as span`; also `joinRun` | `setInput`, `setOutput`, `setAttribute(k, v)`, `setTool(name)`, `setLlm({ model, provider, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, usageDetails, costDetails })`, `setError({ message, type, statusCode })`, `setLevel(level)` |
| factories `tool` / `llm` / `retrieval` / `trace` | `const f = trodo.tool('name', fn)` then `await f(args)`; Python decorators `@trodo.tool('name')` | return a callable; calling **it** runs the work and emits the span |
| `wrapAgent` result | `const { result, runId } = await wrapAgent(...)` | keep `runId` for `trodo.feedback(runId, {...})` |
| `startRun(name, { runId?, distinctId, conversationId, parentRunId, metadata, input })` → `runId`; `joinRun(runId, parentSpanId \| null, fn, { name, kind })`; `endRun(runId, { output, status, errorSummary, metadata })` | | Python: `start_run`, `join_run(run_id, parent_span_id=None, name=, kind=)`, `end_run` |
| `trackMcp({ tool, distinctId, sessionId, input, output, error, durationMs, clientLabel })` | | Python `track_mcp(tool=, distinct_id=, session_id=, …)` |
| `trackLlmCall({ model, provider, inputTokens, outputTokens, prompt, completion, cost })` | | for a model call you already have the response of (raw HTTP) |
| `init({ siteId, debug, silent, autoInstrument, disableInstrumentations, otelMode })` | | Python `init(site_id=, debug=, auto_instrument=, disable_instrumentations=, otel_mode=)` |

## The mistakes this skill exists to prevent

Each is a trace that lies. The reference that explains the fix is in brackets.

1. **Several runs for one request** — a `wrapAgent` per sub-agent, per tool, per loop
   iteration, or per model call. [`run-model.md` §2]
2. **One run for several agents** — the multiplexed `/run` route named `tasks`; a
   whole chat session in one run. [`run-model.md` §2–3]
3. **Blank run input** — nothing called `setInput`. **Wrong run output** — the HTTP
   `Response`, a stream handle, `{ status: 'ok' }`, a hand-picked summary. [§4]
4. **`anon_*` users** — no `distinctId`; or a different id per surface. [§5]
5. **Turns that don't group** — no `conversationId`, or the linked job run lacks it. [§6]
6. **Lost spans** — LLM calls with no run around them; detached work after the run
   closed; a one-shot script that exited before flushing; a provider client built
   before `init`. [`runtimes.md`]
7. **Double counting** — `trodo.llm` around an auto-instrumented call; LangChain +
   provider instrumentor both on in Node; an `agent` span over a framework-owned handoff;
   caller `withSpan` + callee middleware. [`frameworks.md`, `cross-service.md`]
8. **Green failures** — errors caught and returned as data with no `setError`; bare
   `throw 'failed'`. [`run-model.md` §8]
9. **Factory awaited as if it ran** — `await trodo.tool(name, fn)`. [`manual-instrumentation.md`]
10. **MCP as runs** — `wrapAgent`/`startRun` around `tools/call`; runs stuck `running`. [`mcp-runless.md`]

## Feedback

If an instruction here is wrong or a scenario is missing, offer to file it — see
[`references/skill-feedback.md`](./references/skill-feedback.md). Product bugs go to
Trodo support, not the skills repo.
