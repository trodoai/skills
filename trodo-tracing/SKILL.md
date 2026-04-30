---
name: trodo-tracing
version: 1.5.0
sdk_version_node: ">=2.1.0"
sdk_version_python: ">=2.1.0"
sdk_version_node_long_session: ">=2.2.0"
sdk_version_python_long_session: ">=2.2.0"
sdk_version_node_track_mcp: ">=2.3.0"
sdk_version_python_track_mcp: ">=2.3.0"
last_updated: 2026-04-30
description: >-
  Integrate Trodo agent analytics tracing into a codebase. Detects the user's
  language, framework, and existing OTel setup to pick the correct integration
  path and generate working instrumentation code. Use when the user asks to add
  Trodo tracing, fix missing traces, add tool call spans, track conversation
  threads, handle streaming agents, add Trodo alongside existing Datadog/Jaeger
  OTel, or add custom metadata to AI agent runs. **For MCP servers — record one
  RUNLESS span per tools/call (no parent run); see the MCP recipe.** For
  websocket-pinned chats and scheduled jobs that resume across workers, the
  startRun / endRun primitives (SDK 2.2.0) still apply. Specifically enforces
  three output-capture rules: (1) await the full result before setOutput so
  streamed replies aren't truncated, (2) put the FULL structured payload in
  span output and surface short summaries as setAttribute(...) instead of
  pre-summarising, (3) never hand-slice content before setOutput — the SDK
  handles caps at 64KB.
---

# Trodo Tracing

## Philosophy

You are an experienced Trodo integrator. Detect first, decide second, read the relevant doc page third, then write code. The docs are the reference; you are the judgment.

**Always:** detect → clarify if ambiguous → pick path → read the doc page → generate code → check pitfalls.

One idea to keep in mind the whole way through: **Trodo auto-instruments most providers out of the box.** A single `trodo.init({ siteId })` call plus wrapping the agent entry point with `wrapAgent` is often the entire integration. Resist adding manual `llm()` / `tool()` wrappers or OpenInference-style instrumentors when the provider is already in Trodo's auto-instrumented list (see `references/auto-instrumentation.md`).

## How to access docs

Base URL: `https://docs.trodo.ai`

Use your available fetch/search tools (WebFetch, mcp_fetch, WebSearch, etc.) in this order:

**1. Start with the index**

Fetch the full list of every published doc page with titles and URLs:
`https://docs.trodo.ai/llms.txt`

Use this to discover which page covers the topic, then fetch that page directly. Always prefer this over guessing a URL — the published set of pages changes as docs are updated.

**2. Fetch individual pages as markdown**

Append `.md` to any page URL from the index:
`https://docs.trodo.ai/agent-analytics/integrations/vercel-ai-sdk.md`

Read the relevant page before writing code. The decision tree below tells you which page to look for.

**3. Search as a fallback**

If you can't identify the right page from the index, use your available web search tools:
`site:docs.trodo.ai <query>`

## Detect

Inspect imports and file structure before deciding anything:

| Signal | How to detect |
|---|---|
| **Language** | `.ts`/`.js`/`.mjs`/`.cjs` = TypeScript / JavaScript · `.py` = Python |
| **Framework** | `from 'ai'` = Vercel AI SDK · `from '@openai/agents'` = OpenAI Agents SDK · `from 'langchain'` or `from langchain` = LangChain · `from 'llamaindex'` or `from llama_index` = LlamaIndex · `from 'haystack'` = Haystack (Python only) |
| **Provider** | `from 'openai'` / `from openai` = OpenAI · `from '@anthropic-ai/sdk'` / `from anthropic` = Anthropic · `from '@aws-sdk/client-bedrock-runtime'` / `import boto3` bedrock = Bedrock · `from 'cohere-ai'` / `from cohere` = Cohere · `from '@google/generative-ai'` / `from google.generativeai` = Google Gemini · `@google-cloud/vertexai` / `from vertexai` = Vertex AI · `from '@mistralai/mistralai'` / `from mistralai` = Mistral |
| **Streaming** | `streamText`, `messages.stream()`, `messages.create({ stream: true })`, `stream=True` in Python, async generator patterns, SSE response (`text/event-stream`) |
| **Existing OTel** | `@opentelemetry/` imports, `NodeTracerProvider`, `TracerProvider`, `BatchSpanProcessor`, `OTLPTraceExporter`, `tracer.start_as_current_span` |
| **Runtime** | `next.config.*` or `app/` / `pages/` = Next.js · `express()` / `fastify()` = Node server · `FastAPI()` / `Flask()` = Python server · otherwise standalone script |
| **Package manager** | `pnpm-lock.yaml` = pnpm · `yarn.lock` = yarn · `package-lock.json` = npm · `bun.lockb` = bun · `poetry.lock` = poetry · `uv.lock` = uv · `requirements.txt` = pip |

## Clarify

> **Ask before deciding.** Even when the codebase makes a choice look obvious, surface it as a confirmation with a recommendation. Imposing the wrong `distinctId` or run boundary is hard to undo later — distinct ids fragment user profiles across runs and MCP spans, and mis-sized run boundaries either hide signal (everything in one giant trace) or destroy it (every step is its own disconnected run).

Use `AskUserQuestion` when available for these confirmations. Batch the always-ask questions below into a single round before writing any instrumentation code.

### Always ask — even if signals look obvious

These two decisions must be user-confirmed before generating tracing code. Detect candidates first, then surface them with a recommendation.

**1. distinctId source for tracing.** Read auth, session, MCP request, or worker-job code, list every plausible identifier you see, and ask once for the value used across `wrapAgent({ distinctId })`, `track_mcp({ distinct_id })` / `trackMcp({ distinctId })`, `start_run({ distinct_id })`, and any `join_run` callsite. Template:

> "For the `distinctId` attached to runs and spans, I see `req.user.email`, `session.userId` (uuid), and `apiKey.orgId` available. Should I use the same identifier across `wrapAgent`, `track_mcp`, and `start_run`? **Recommend: `session.userId` (uuid)** so it lines up with your events tracking. Alternatives: `email`, `org_id`, or supply your own."

For MCP servers, `track_mcp` / `trackMcp` *requires* `distinct_id` — this question is non-skippable when MCP is in scope. Don't silently fall back to `req.headers['x-user-email']` or the MCP session id; ask.

**2. Run scope / boundary — one wrap or separate.** When multiple logical steps, sub-agents, chained LLM calls, or several agent entrypoints are present, ask which run shape fits:

> "I see three logical steps: `plan()` → `retrieve()` → `answer()`. Three options:
> - **One outer `wrapAgent('rag-agent', ...)`** — recommended; inner LLM calls become auto-instrumented child spans under one trace. Best when this all runs in one HTTP request.
> - **Three separate `wrapAgent` runs linked via `parentRunId`** — when each step is independently retriable / cached / triggered.
> - **`startRun` + `joinRun` + `endRun`** — only when the run spans workers / requests (websocket-pinned chat, scheduled job that resumes on a different worker).
>
> Which fits your runtime?"

Default recommendation when the user has no preference: **wrap the outermost entry function only.** Inner provider calls (OpenAI, Anthropic, LangChain, etc.) get auto-instrumented as child spans — no manual `llm()` / `tool()` wrapping needed. Break into separate runs only when the steps are independently triggered (queue consumer per-job, separate HTTP endpoints) or the run is multi-request (websocket / scheduled job → `startRun` / `endRun`). For MCP servers, neither applies — use `track_mcp` per `tools/call` (see §5a).

### Also ask when…

These are situational triggers — fire on top of the always-ask checklist when the signal is present:

- **Multiple agent entry points found** — more than one file contains agent/run/pipeline definitions (e.g. `agentA.ts` and `agentB.ts`, or an `agents/` directory with several files). Ask which to instrument:
  > "I found agent definitions in `src/agents/chat.ts` and `src/agents/search.ts`. Which one(s) should I instrument, or should I add tracing to all of them?"
- **Multiple frameworks coexist** — e.g. Vercel AI SDK and OpenAI Agents SDK imports both appear in the codebase:
  > "I see both Vercel AI SDK (`generateText`) and the OpenAI SDK directly (`openai.chat.completions.create`) used here. Should I instrument both, or just one?"
- **Vague request** — the user said "add tracing" or "instrument my agents" without pointing to specific files or functions. Combine with the always-ask checklist; don't write a single line until those two are confirmed.
- **Multiple agent functions in a single file** — several `agent()` / `run()` / chain definitions are present and it's not obvious which should be wrapped.

## Decision tree

Check in this order — sequence matters.

### 1. Existing OTel provider detected?

→ **YES:** Don't replace the user's OTel setup. Trodo's SDK registers its own span processor, so it coexists with an existing `NodeTracerProvider` / `TracerProvider` — both exporters receive every span. The one thing to double-check is that `trodo.init()` runs **after** the user's provider is registered, so spans reach both destinations.

→ Read: [`references/dual-export.md`](./references/dual-export.md) and `https://docs.trodo.ai/recipes/dual-export.md`.

### 2. Framework or provider SDK in Trodo's auto-instrumented list?

This is the common case. Trodo auto-instruments these providers when `trodo.init()` runs:

- **Node:** `anthropic`, `openai`, `langchain`, `@aws-sdk/client-bedrock-runtime`, `cohere-ai`, `@google/generative-ai`, `@google-cloud/vertexai`, `llamaindex`, `ai` (Vercel AI SDK), `http` / `fetch`.
- **Python:** `anthropic`, `openai`, `langchain`, `llama_index`, `google.generativeai`, `vertexai`, `boto3` (Bedrock), `cohere`, `mistralai`, `haystack`, `httpx`, `requests`.

→ If detected, the full integration is three things:

1. **Install** `trodo-node` (Node) or `trodo-python` (Python).
2. **Init once** at the app entrypoint, before any provider client is imported or instantiated: `trodo.init({ siteId: process.env.TRODO_SITE_ID })` / `trodo.init(site_id=os.environ["TRODO_SITE_ID"])`.
3. **Wrap the agent entry function** with `wrapAgent(name, fn, opts?)` / `wrap_agent(name, ...)`.

No OpenInference. No manual `llm()` wrapping. The provider's LLM calls, tool calls, and retrieval calls nest under the run automatically.

→ Read: `https://docs.trodo.ai/llms.txt`, find the matching `integrations/<framework>.md`, fetch and read before writing code.

→ If **Vercel AI SDK** detected: also read [`references/vercel-ai-sdk.md`](./references/vercel-ai-sdk.md) — `experimental_telemetry: { isEnabled: true }` is still required on every call.

→ If **streaming** detected: also read [`references/streaming.md`](./references/streaming.md).

### 3. No matching framework / raw HTTP to an LLM?

→ Manual instrumentation. Pick helpers by the shape of the call:

| Helper | Use when | Span kind |
|---|---|---|
| `trodo.tool(name, fn)` | A tool invocation you want visible in the trace tree. | `tool` |
| `trodo.llm(name, fn, { model, provider })` | A raw LLM call not covered by auto-instrumentation. Auto-extracts tokens from OpenAI / Anthropic / Gemini response shapes. | `llm` |
| `trodo.retrieval(name, fn)` | Vector search, DB lookup, or any retrieval step. | `retrieval` |
| `trodo.trace(name, fn)` | Any generic step you want to see as a named span. | `generic` |
| `trodo.trackLlmCall({ model, provider, inputTokens, outputTokens, prompt, completion })` | One-shot record of an LLM call you already have the response for (raw `fetch`, self-hosted endpoint). | `llm` |

→ Read: [`references/manual-instrumentation.md`](./references/manual-instrumentation.md) and `https://docs.trodo.ai/agent-analytics/tracing/patterns.md`.

### 4. Cross-service or sub-agent?

The run context propagates inside a single Node/Python process via AsyncLocalStorage / contextvars. Outside that (different service, worker thread, process pool), you have to propagate `runId` manually.

→ **HTTP boundary:** `propagationHeaders()` on the caller, `expressMiddleware()` / `fastapi_middleware()` on the callee. The `X-Trodo-Run-Id` header carries the run.

→ **Worker thread / ProcessPoolExecutor:** capture `runId` from the parent, pass it in, call `joinRun(runId, fn)` / `join_run(run_id, ...)` inside.

→ Read: [`references/cross-service.md`](./references/cross-service.md) and `https://docs.trodo.ai/recipes/cross-service.md`.

### 5a. Building an MCP server that proxies tool calls?

`wrapAgent` and `startRun`/`endRun` are both wrong for MCP. The MCP server proxies tool calls but **never sees the user's prompt or the LLM's final answer** — those live inside Claude.ai / Cursor / ChatGPT, deliberately not exposed. So a "run" wrapping an MCP session has nothing meaningful in `input` / `output` and clustering it carries no signal.

→ **Use the `track_mcp` / `trackMcp` SDK helper.** One call per `tools/call`. Requires `trodo-python >= 2.3.0` / `trodo-node >= 2.3.0`. `distinct_id` is required by the helper — confirm the source per Clarify §1 before writing the call. Do not silently fall back to `req.headers['x-user-email']` or the MCP session id if that's not what the user picked.

```python
# Python
trodo.track_mcp(
    tool=tool_name,
    distinct_id=req.user_email,
    session_id=req.headers.get("mcp-session-id"),
    input=arguments,
    output=result,
    duration_ms=elapsed_ms,
    client_label="anthropic",
)
```

```typescript
// Node
await trodo.trackMcp({
  tool: toolName,
  distinctId: req.userEmail,
  sessionId: req.headers["mcp-session-id"],
  input: args,
  output: result,
  durationMs: elapsedMs,
  clientLabel: "anthropic",
});
```

Auto-fills `span_id`, `agent_name="MCP"`, `kind="tool"`, `name="tool.<tool>"`, `started_at`, `ended_at`. The customer only thinks about `tool`, `distinct_id`, `input`, `output`, `duration_ms`. Returns the span_id.

→ Read: [`references/mcp-runless.md`](./references/mcp-runless.md) for raw-HTTP fallback, dashboard queries, and pitfalls.

### 5b. Websocket-pinned chats / scheduled jobs that resume across workers?

These genuinely have a beginning, middle, and end with one logical run. `wrapAgent` is a single-callback block — it opens *and* closes the run in one call stack, which can't bridge workers. Use the long-session primitives instead:

- **Websocket-pinned chats** — long-running connection where each message is a separate handler.
- **Scheduled jobs that resume on different workers.**
- **Anything where the run's start and end are not in the same call stack** AND the server actually owns the prompt+answer (i.e., not MCP — see 5a).

→ Use `startRun(name, opts)` to open the run and get back a `runId`, persist it (Redis is typical), use `joinRun(runId, ...)` from each subsequent request to add child spans, then `endRun(runId, opts)` from a sweeper / timeout / explicit close. Same `runId` threads through everything.

Requires `trodo-node >= 2.2.0` / `trodo-python >= 2.2.0`. If the user is on an older SDK, recommend upgrading before suggesting this pattern.

→ Read: [`references/long-session.md`](./references/long-session.md) and `https://docs.trodo.ai/agent-analytics/tracing/start-run-end-run.md`.

When NOT to reach for this: if the entire run can be expressed inside one async function, prefer `wrapAgent` — simpler and one HTTP call to the backend.

## Output capture discipline

These three rules are what the dashboard quietly punishes when the integration is wrong. Generated code MUST follow all three; flag any existing code that violates them.

### Rule 1 — Await the full result before `setOutput`

Streaming agents are the common offender. If the wrapped function returns a stream / promise / iterator without consuming it, `setOutput` (or the implicit return-value capture) records whatever has accumulated by then — usually the first chunk or two. The dashboard then shows a chat reply truncated mid-sentence even though the user saw the full answer in the UI.

```ts
// WRONG — Vercel AI SDK example. result is a stream object; the wrapped
// function returns before any text is materialised.
return await wrapAgent('chat', async (run) => {
  run.setInput({ question });
  const result = streamText({ model, messages, experimental_telemetry: { isEnabled: true } });
  return result;                           // ❌ run output ends up empty / partial
});

// RIGHT — collect the stream first, then setOutput, then return.
return await wrapAgent('chat', async (run) => {
  run.setInput({ question });
  const result = streamText({ model, messages, experimental_telemetry: { isEnabled: true } });
  const text = await result.text;          // ✅ full text only resolves after the stream finishes
  run.setOutput({ answer: text });
  return text;
});
```

The same rule applies to LangChain `astream`, OpenAI / Anthropic `stream=True`, async generators, custom SSE handlers — anything where the “result” is a handle to a future stream. The wrapped function must not return until the stream has been consumed.

When the framework offers an `onFinish` callback (Vercel AI SDK), call `setOutput` from there and return a promise that resolves only after `onFinish` fires.

### Rule 2 — Span output is the FULL payload; short summaries go into attributes

When generated code records a span (or sets the run output), the rule is:

- `setOutput(...)` / `set_output(...)` → the **full structured payload**: the orchestrator's complete `results` array, the planner's complete plan + gate + scope, the tool's complete row data. This is what an engineer needs to debug a regression three weeks later.
- `setAttribute(key, value)` → the **small high-signal bits** that humans want to filter / search / scan: status flags, counts, scores, the LLM-bound summary string. Attributes are flat key/value strings/numbers/booleans — they show up next to the span, not in the Output panel.

```ts
// WRONG — the “summary” is the only thing persisted; results[] is dropped
// from the trace forever.
await trodo.withSpan('orchestrator', async (span) => {
  const r = await runPhase1({ ... });
  span.setOutput({ summary: r.summary });   // ❌ loses r.results
  return r;
});

// RIGHT — full payload as output; the small summary string and the
// success/error counts go into searchable attributes.
await trodo.withSpan('orchestrator', async (span) => {
  const r = await runPhase1({ ... });
  span.setOutput(r);                                              // ✅ full results + summary
  span.setAttribute('result_count', (r.results || []).length);
  span.setAttribute('ok_count',    r.results.filter(x => x.status === 'ok').length);
  span.setAttribute('error_count', r.results.filter(x => x.status !== 'ok').length);
  if (r.summary?.summary) span.setAttribute('summary', String(r.summary.summary));
  return r;
});
```

```python
# Tool span pattern (Python orchestrator). The tool wrapper produces a
# ToolResult envelope { status, data: <small LLM summary>, raw: <full> }.
# Persist `raw` as the span output so the trace shows the real data,
# and mirror data.summary into a span attribute for quick scanning.
with trodo.join_run(run_id, parent_span_id, name=tool_name, kind="tool") as tool_span:
    tool_span.set_input({"tool": tool_name, "params": merged})
    result = await run_tool(...)
    raw = result.get("raw")
    data = result.get("data")
    output = {"status": result.get("status"), "data": raw if raw is not None else data}
    if isinstance(data, dict) and isinstance(data.get("summary"), str):
        tool_span.set_attribute("summary", data["summary"])
    tool_span.set_output(output)            # ✅ full structured payload
```

Use `setAttribute` for: counts, durations, scores, status flags, reasons, the LLM-bound summary string, IDs you might want to filter on. Use `setOutput` for: the actual data the agent / tool / step computed.

### Rule 3 — Never hand-truncate the value passed to `setOutput`

The SDK already truncates at 64 KB. Pre-slicing with `.slice(0, 500)` / `[:500]` / regex caps does nothing useful and hides the data the dashboard exists to show. If the value is already legitimately huge (a 1 MB result blob), keep it out of `setOutput` entirely — pass a structured pointer (`{ kind, byte_length, sample: ... }`) and stash the full thing in object storage. Do **not** silently chop the middle off.

```ts
run.setOutput({ finalAnswer: text.slice(0, 500) });   // ❌ caps the persisted answer
run.setOutput({ finalAnswer: text });                 // ✅ SDK handles the 64KB cap on its own
```

This applies equally to span output. If `data` is large but bounded by row counts (e.g. a hotspots array), pass it through unchanged — pagination / column truncation belongs in the dashboard, not the producer.

### Decision table

| Field | What goes here |
|---|---|
| `setInput(...)` | The user query / function arguments / tool params — what the step was asked to do |
| `setOutput(...)` | Everything the step actually produced. Tool result `raw`. Planner's full plan. Synthesizer's full reply. |
| `setAttribute(key, value)` | Counts, status flags, scores, IDs, the short summary string, anything you'd filter on |
| `setMetadata(**kwargs)` (run-level only) | Run-wide custom properties: `customer_tier`, `environment`, `feature_flag_X`, version tags |

If you find yourself wanting to put something in both `setOutput` and `setAttribute`, use both — the attribute makes it filterable, the output keeps the full context.

## Recipes

If the user's pattern matches one of these, start there before writing from scratch:

| Recipe | Pattern |
|---|---|
| `https://docs.trodo.ai/recipes/basic-agent.md` | Basic agent (OpenAI, Anthropic, LangChain, etc.) |
| `https://docs.trodo.ai/recipes/streaming-agent.md` | Streaming with SSE / async iterator |
| `https://docs.trodo.ai/recipes/tool-calling-agent.md` | Agent with tool calls |
| `https://docs.trodo.ai/recipes/multi-step-agent.md` | Multi-step / staged agent |
| `https://docs.trodo.ai/recipes/context-manager.md` | Multi-file split, context propagation |
| `https://docs.trodo.ai/recipes/cross-service.md` | Node ↔ Node or Node ↔ Python over HTTP |
| `https://docs.trodo.ai/recipes/sub-agents.md` | Parent agent spawning linked child runs |
| `https://docs.trodo.ai/recipes/from-scratch.md` | Raw HTTP to a custom LLM endpoint |
| `https://docs.trodo.ai/recipes/dual-export.md` | Existing OTel + Trodo side-by-side |
| `https://docs.trodo.ai/recipes/mcp-server.md` | **MCP server (runless spans)** — one span per `tools/call`, no parent run |

## Minimal install — what the generated code should look like

### Node.js

```ts
// 1. At the app entry (index.ts / server.ts / instrumentation.ts):
import trodo from 'trodo-node';
trodo.init({ siteId: process.env.TRODO_SITE_ID! });

// 2. Everything below can be in the same file or a different one —
//    import provider clients AFTER init, so auto-instrumentation patches them.
import OpenAI from 'openai';
import { wrapAgent } from 'trodo-node';

const openai = new OpenAI();

export async function answer(userId: string, question: string) {
  const { result, runId } = await wrapAgent(
    'support-agent',
    async (run) => {
      run.setInput({ question });
      const resp = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: question }],
      });
      const answer = resp.choices[0].message.content;
      run.setOutput({ answer });
      return answer;
    },
    { distinctId: userId },
  );
  return result;
}
```

### Python

```python
# 1. At the app entry (main.py / app.py):
import os, trodo
trodo.init(site_id=os.environ["TRODO_SITE_ID"])

# 2. Import provider clients AFTER init.
from openai import OpenAI

client = OpenAI()

def answer(user_id: str, question: str) -> str:
    with trodo.wrap_agent("support-agent", distinct_id=user_id) as run:
        run.set_input({"question": question})
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": question}],
        )
        answer = resp.choices[0].message.content
        run.set_output({"answer": answer})
        return answer
```

Finally: tell the user to set `TRODO_SITE_ID` in their `.env` (server-only, no `NEXT_PUBLIC_` prefix) and point them at [app.trodo.ai](https://app.trodo.ai) to grab the value.

## Critical constraints

Rules the docs mention that assistants routinely miss:

- **Init before client import.** `trodo.init()` must run before any provider client is imported or instantiated. Auto-instrumentation patches provider SDKs at init time — a client imported earlier holds an unpatched reference and emits no child spans. In Next.js, put `trodo.init()` inside `instrumentation.ts` → `register()`, guarded by `process.env.NEXT_RUNTIME === "nodejs"`.
- **Vercel AI SDK — every call.** `experimental_telemetry: { isEnabled: true }` must appear on every `generateText` / `streamText` / `generateObject` call. Missing it on even one call means that call produces no child spans.
- **Env vars are server-only.** `TRODO_SITE_ID` is read at runtime on the server. Never prefix it with `NEXT_PUBLIC_` / `VITE_` / `PUBLIC_` — that embeds it in the client bundle where it's both unnecessary and wrong (auto-instrument runs in Node, not the browser).
- **Streaming output.** Call `run.setOutput(text)` / `run.set_output(text)` in the framework's finish callback (`onFinish` for Vercel AI SDK), **not** inside the for-await loop that consumes the stream. Calling it mid-loop records a partial value.
- **Always return a value.** The wrapped function's return value becomes the run output. Returning `undefined` / `None` leaves the output field blank in the dashboard. If the return value is intentionally empty, call `run.setOutput(...)` explicitly.
- **Custom attributes.** Use `trodo.*` prefix (e.g. `trodo.user_id`, `trodo.environment`, `trodo.customer_tier`) for attributes you want filterable in the dashboard. Other prefixes still flow through but aren't indexed the same way.
- **Nested `wrapAgent` = two runs, not a nested run.** Each `wrapAgent` call starts a new root run. For sub-steps inside an agent, use `trodo.trace(name, fn)` or `trodo.tool(name, fn)`. For a genuine child run linked to a parent, use the `parentRunId` option.
- **Span status is exception-driven, not output-driven.** `setOutput({ status: 'error' })` / `set_output({"status": "error"})` does NOT mark the span as failed in the dashboard. Whether a span shows "ok" or "failed" is determined entirely by whether an unhandled exception propagated through the context manager or callback. If your code swallows exceptions and returns error objects instead of raising, the span always appears "ok". See pitfalls below for the correct pattern.
- **Never impose distinctId or run boundary.** Detect candidates from the codebase, then **ask** (per Clarify §1 and §2). Even when only one identifier appears plausible, surface it for confirmation — splitting one user across two profiles across `wrapAgent` and `track_mcp`, or wrapping three independent agents into one trace, is hard to undo. Same rule applies to which agent functions to wrap when multiple entrypoints exist.
- **CommonJS `require()` and named exports (Node).** When loading `trodo-node` via `require()` rather than ESM `import`, named exports (`propagationHeaders`, `getActiveContext`, `joinRun`, `currentRunId`, `withSpan`) are NOT on `module.default`. Pull them explicitly: `const { propagationHeaders } = require('trodo-node')` or attach them to the singleton after `require`. Any code that does `trodo = trodoModule.default || trodoModule` and then calls `trodo.propagationHeaders()` will throw "not a function" unless the named export is manually attached.

## Known pitfalls

| Pitfall | Symptom | Fix |
|---|---|---|
| Provider client imported before `trodo.init()` | No child LLM spans under the run | Move `trodo.init()` to the very first line of the entry file, or to `instrumentation.ts` in Next.js |
| Missing `experimental_telemetry` on Vercel AI SDK calls | Root span appears, no child LLM spans | Add `experimental_telemetry: { isEnabled: true }` to every `generateText` / `streamText` / `generateObject` call |
| `NEXT_PUBLIC_TRODO_SITE_ID` used in client components | Site ID ends up in client bundle; server still has no value at runtime | Rename to `TRODO_SITE_ID`, read only in server code (`instrumentation.ts`, API routes, server actions) |
| Returning stream object instead of consuming it | Output field shows `[object ReadableStream]` or empty | Consume the stream inside the wrapper; call `run.setOutput(assembledText)` in `onFinish` |
| Calling `joinRun(runId, fn)` with undefined `runId` | Silent no-op; spans created inside have no parent run | Verify the `X-Trodo-Run-Id` header is actually present; fall back to creating a new run if not |
| `autoInstrument: false` left in config | No framework spans nest under the run | Remove the override or set to `true` (default) |
| Debug mode says "site not found" | All tracking silently drops | Site ID is wrong or from the wrong environment — check [app.trodo.ai](https://app.trodo.ai) and copy the site ID again |
| Returning `undefined` / `None` from wrapped function | Run appears with blank output | Return the final result explicitly, or call `run.setOutput(...)` |
| Code returns error objects instead of raising — span shows "ok" | Tool / step shows green "ok" status in dashboard even though it failed | Raise an exception inside the `with join_run(...)` / `withSpan(...)` block when the result indicates failure. Catch a sentinel exception outside the block if you need to return the error object rather than re-throw. See cross-service.md "span failure" section. |
| `withSpan` on caller + `fastapi_middleware` on callee — every operation appears twice | Duplicate spans with names like `planner` and `http.POST./v1/plan` for the same logical call | These two patterns conflict. When the caller owns the semantic span (`withSpan`), remove the middleware from the callee — or use the body-propagation pattern (pass `run_id`/`parent_span_id` in the request body and call `join_run` per sub-operation inside the handler). See cross-service.md "caller-owned vs callee-owned spans". |
| `propagationHeaders` is not a function (Node CommonJS) | `TypeError: trodo.propagationHeaders is not a function` at runtime | `propagationHeaders` is a **named export**, not on the default export. With `require()`: `const { propagationHeaders } = require('trodo-node')` — or after loading the module, attach it: `trodo.propagationHeaders = trodoModule.propagationHeaders`. |
| `setOutput` / `set_output` with metadata instead of real data | Dashboard shows `{ answerLength: 478 }` or `{ status: "ok" }` — not useful for debugging | Pass the actual payload: `setOutput({ answer: text })` for LLM outputs; `set_output({"status": status, "data": raw_or_full_dict})` for tool spans. Trodo truncates at 64KB on the server — don't pre-summarize into useless counts or flags. |
| Wrapped function returns the stream object instead of the awaited text | Run output captured at half a sentence; chat reply renders fine in the UI but persists truncated mid-table or mid-paragraph | **Rule 1.** Consume the stream inside the wrapper (e.g. `const text = await result.text;` for Vercel AI SDK, or call `setOutput` from `onFinish`) and only then `setOutput` / return. Never return a stream handle from a `wrapAgent` callback. |
| Hand-slicing `setOutput` payload (`text.slice(0, 500)`, `[:500]`) | Persisted run / span output cuts off mid-sentence even though the source was complete | **Rule 3.** Remove the slice. SDK caps at 64 KB on its own. If the payload is genuinely too large for that, structure it (`{ kind, byteLength, sample, ref }`) — never silently chop. |
| Tool / planner / orchestrator span only stores a hand-picked subset of the result | Activity tab shows `{summary: "..."}` even though the tool computed full per-row data; debugging requires re-running | **Rule 2.** `setOutput(fullResult)` and use `setAttribute('summary', s)`, `setAttribute('result_count', n)`, etc. for the searchable bits. Same shape applies to internal staged spans (planner, orchestrator, evaluator, synthesize) — full payload as output, scalars as attributes. |
| Tool wrapper drops the `raw` field on the way to the span | Tool's full structured output is computed but lost — only the LLM-bound `data.summary` lands in the trace | When building a span output for a tool result, prefer `result.raw` over `result.data` if both are present; `data` is the small LLM-bound summary, `raw` is the full payload meant for observability. |
| Used `wrapAgent` for an MCP server | Every `tools/call` becomes its own disconnected Run; the synthetic Run carries no input/output because the MCP server never sees the user's prompt or the LLM's answer | Switch to `trodo.track_mcp(...)` (Python) / `trodo.trackMcp({...})` (Node) — one runless span per `tools/call`, no parent run. Requires SDK >= 2.3.0. See [`references/mcp-runless.md`](./references/mcp-runless.md). |
| Used `startRun` / `endRun` for an MCP server | Runs stuck in `running` (no clean session-end signal in MCP); spans threaded into a Run that has no meaningful prompt/answer to anchor them | Same fix — switch to `track_mcp` / `trackMcp`. `startRun`/`endRun` is correct for websocket-pinned chats and scheduled jobs, NOT for MCP proxies. See [`references/mcp-runless.md`](./references/mcp-runless.md). |
| Used `wrapAgent` for a websocket-pinned chat or scheduled job | Single-callback block can't bridge requests/workers | Switch to `startRun` + `joinRun` + `endRun` (SDK 2.2.0+). See [`references/long-session.md`](./references/long-session.md). |
| `startRun` called but never `endRun` | Run stuck in `"running"` forever in the dashboard | Pair every `startRun` with a guaranteed close path — a TTL sweeper, an explicit session-end notification, or `try/finally` if the session is bounded by one request lifecycle. |

## When things go wrong

Before suggesting code changes, check in this order:

1. **No traces at all.**
   - Is `TRODO_SITE_ID` set in the runtime environment? (`console.log(process.env.TRODO_SITE_ID)` on the server.)
   - Is `trodo.init()` called before any provider client import?
   - Is the process staying alive long enough to flush? In serverless / short-lived scripts, call `await trodo.flush()` / `await trodo.shutdown()` before exit.
2. **Traces appear but no child spans.**
   - Was the provider client instantiated **after** `trodo.init()`? If the client was constructed at module top-level and the init runs later, the client holds an unpatched reference.
   - Is the framework in the auto-instrument list (see `references/auto-instrumentation.md`)? If not, wrap calls manually with `tool()` / `llm()`.
   - Did the user set `autoInstrument: false`?
3. **Empty output on the run.**
   - Does the wrapped function return a value?
   - For streaming: is `run.setOutput()` called in `onFinish`?
4. **Span never closes / run stuck in "running".**
   - Does the wrapped function resolve in all code paths (success and error)?
   - For streaming: is the stream actually consumed?

→ Full troubleshooting: `https://docs.trodo.ai/agent-analytics/tracing/troubleshooting.md`.

**If the user has the Trodo MCP connected**, query recent runs directly to confirm whether spans are arriving before suggesting any code changes. That's faster than adding debug logs.

**Enable debug mode** (`trodo.init({ siteId, debug: true })`) when the checks above don't resolve the issue — it logs every API call, span export, and error to stderr.

## Skill feedback

If the skill gives incorrect guidance, references a page that doesn't exist, or is missing a scenario you encountered — offer to submit feedback. See [`references/skill-feedback.md`](./references/skill-feedback.md) for the process.

Do **not** trigger this for issues with Trodo itself (the product) — only for issues with this skill's instructions.
