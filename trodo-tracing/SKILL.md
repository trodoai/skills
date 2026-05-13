---
name: trodo-tracing
version: 2.0.0
sdk_version_node: ">=2.1.0"
sdk_version_python: ">=2.1.0"
sdk_version_node_long_session: ">=2.2.0"
sdk_version_python_long_session: ">=2.2.0"
sdk_version_node_track_mcp: ">=2.3.0"
sdk_version_python_track_mcp: ">=2.3.0"
sdk_version_node_register_otel: ">=2.4.0"
sdk_version_node_pure_esm: ">=2.4.2"
last_updated: 2026-05-13
description: >-
  Integrate Trodo agent analytics tracing into a codebase. Detects the user's
  language, framework, and existing OTel setup to pick the correct integration
  path and generate working instrumentation code. Use when the user asks to add
  Trodo tracing, fix missing traces, add tool call spans, track conversation
  threads, handle streaming agents, add Trodo alongside existing Datadog/Jaeger
  OTel, or add custom metadata to AI agent runs. **For MCP servers — record one
  RUNLESS span per tools/call (no parent run); see the MCP recipe.** For
  websocket-pinned chats and scheduled jobs that resume across workers, the
  startRun / endRun primitives (SDK 2.2.0) still apply. **For NextJS / Vercel AI
  SDK projects with `@vercel/otel` or an `instrumentation.ts` file already
  present — prefer the OTLP env-var path (Path A, no SDK install required); see
  §0a.** **For projects with an existing OTel pipeline (Datadog/Jaeger/
  Honeycomb) — use `registerOTel({ mode: 'otlp' })` (Path B, SDK 2.4.0+); see
  §0b.** **For pure-ESM Node apps (`"type": "module"`): always use the full
  register.mjs bootstrap recipe regardless of SDK version — the explicit OTel
  hook registration is required for LLM spans to appear.** **Raw provider SDK
  tool calls are NOT auto-instrumented — auto-capture applies to LLM calls
  always, and to tool calls only when the framework owns the call site (LangChain
  Tool, Vercel AI SDK tools, OpenAI Agents SDK, LlamaIndex query engine, Haystack
  pipeline). For raw OpenAI / Anthropic / Gemini / Bedrock function calling, wrap
  the local tool execution with trodo.tool() or trodo.withSpan({ kind: 'tool' })
  — see §2 table.** Specifically enforces three output-capture rules: (1) await
  the full result before setOutput so streamed replies aren't truncated, (2) put
  the FULL structured payload in span output and surface short summaries as
  setAttribute(...) instead of pre-summarising, (3) never hand-slice content
  before setOutput — the SDK handles caps at 64KB.
---

# Trodo Tracing

## Philosophy

You are an experienced Trodo integrator. **Explore first, plan second, confirm with the user, then implement.**

The workflow has four mandatory phases. Never skip or merge phases. Do not write a single line of instrumentation code until Phase 3 is explicitly approved.

**Always:** explore → plan (with agent topology + identity decisions) → confirm → implement → verify.

---

## PHASE 1 — Explore

Before anything else, deeply explore the codebase to understand:

1. **Language and runtime** — Node.js, Python, TypeScript, pure-ESM, CJS, Next.js edge/node.
2. **Framework and providers** — which LLM SDKs and agent frameworks are imported.
3. **Existing OTel** — any `@opentelemetry/` imports, `NodeTracerProvider`, `TracerProvider`, `OTLPTraceExporter`, `tracer.start_as_current_span`, Datadog/Jaeger/Honeycomb config.
4. **Agent topology** — all agent entry points, what tools they call, whether sub-agents or chained calls exist, what the call graph looks like. Read every file that contains agent/run/pipeline logic.
5. **Identity signals** — every place a user identifier exists: `req.user.id`, `session.userId`, `auth.email`, `apiKey.orgId`, JWT claims, cookie values, etc.
6. **Conversation/session signals** — `chatId`, `threadId`, `sessionId`, `conversationId`, or any multi-turn grouping field.
7. **Package manager and existing deps** — `package.json` / `requirements.txt`, check if `trodo-node` / `trodo-python` is already listed and at what version.
8. **Module type** — `"type": "module"` in `package.json` means pure-ESM rules apply for the entire project.

Read every file that contains LLM calls or agent logic before proceeding. Don't skim — missing an agent entry point or a tool call means incomplete tracing.

---

## PHASE 2 — Plan (present to user, wait for approval)

After exploring, present a complete plan in plain English before writing any code. Do NOT use technical jargon unnecessarily. The plan must show:

### Plan template

```
## Trodo Agent Tracking Plan

### Integration method
[One or two sentences: what path will be used and why — e.g. "Pure-ESM Node.js
bootstrap via --import register.mjs, because this project uses "type": "module"
with raw OpenAI SDK calls and no existing OTel pipeline."]

### Agent topology
Show every agent, its tools, sub-agents, and what auto-instrumentation covers vs.
what needs manual wrapping. Use a tree format:

  agent-name  →  [file: path/to/file.js]
  ├── LLM call: openai.chat.completions.create  [auto-instrumented ✓]
  ├── tool: get_weather(location)  [needs manual wrap — raw OpenAI function calling]
  └── tool: search_web(query)  [needs manual wrap — raw OpenAI function calling]

  another-agent  →  [file: path/to/other.js]
  └── LLM call: anthropic.messages.create  [auto-instrumented ✓]

If the project has only standalone scripts (not a unified app), list each script
as its own agent and note that they are independent runs.

### Identity
  distinctId:     [candidate(s) found, recommendation, ask for confirmation]
  conversationId: [candidate(s) found or "none — single-shot, no multi-turn",
                   recommendation, ask for confirmation]

### Files to create or modify
  - register.mjs  (NEW)  — ESM bootstrap + trodo init
  - src/agent.ts  (MODIFY)  — wrap the main agent entry + tool spans
  - ...

### Dependencies to install
  - trodo-node@latest
  - @opentelemetry/api@^1.x
  - @opentelemetry/instrumentation-openai@^0.14.0  ← pinned; 0.15.x is broken
  - @opentelemetry/sdk-node@^0.x
  - @opentelemetry/sdk-trace-base@^1.x
  - @opentelemetry/exporter-trace-otlp-proto@^0.x
  - @opentelemetry/resources@^1.x
  [List only what's needed for the chosen path and not already present]

### How to run after install
  node --env-file=.env --import ./register.mjs src/agent.js
  [Or whatever the correct invocation is for this project]

Shall I proceed with this plan?
```

**Do not start Phase 3 until the user explicitly approves or adjusts the plan.**

### Mandatory clarifications before approving the plan

The following must always be asked and included in the plan before coding. Batch them into the plan — never ask mid-implementation.

**1. distinctId source.** Read auth, session, request, or config code. List every plausible identifier, state the recommendation, and ask for confirmation. This value goes into `wrapAgent({ distinctId })`, `trackMcp({ distinctId })`, and `startRun`. For standalone scripts with no auth, propose `"demo-user"` but flag it clearly as a placeholder.

**2. conversationId.** Look for `chatId`, `sessionId`, `threadId`, or any multi-turn grouping field. If found, surface it. If this is a single-shot script or no conversation concept exists, say so explicitly — don't silently omit it.

**3. Run boundary.** When there are multiple agent files or chained calls, show the options and recommend one:
- One outer `wrapAgent` — recommended when all steps run in one function call
- Separate `wrapAgent` runs linked via `parentRunId` — when each step is independently triggered
- `startRun` + `joinRun` + `endRun` — only for websocket/scheduled jobs that span workers

**4. Which agents to instrument.** If multiple agent files exist, ask which to trace, or confirm "all of them."

---

## PHASE 3 — Implement (only after plan is approved)

Now write and apply all code changes. Follow these rules:

### Import pattern (Node.js)

Always use a single import — never two separate imports of `trodo-node`:

```js
// ✅ correct
import trodo, { wrapAgent } from 'trodo-node';

// ❌ wrong — double import
import trodo from 'trodo-node';
import { wrapAgent } from 'trodo-node';
```

If only `wrapAgent` is needed (no `trodo.tool()` etc.), a named-only import is fine:

```js
import { wrapAgent } from 'trodo-node';
```

### Pure-ESM bootstrap — always use the FULL recipe

On pure-ESM Node projects (`"type": "module"`), always generate the full `register.mjs` below, regardless of the installed trodo-node version. The lean recipe (just `openai/shims/node` + trodo.init) works in some environments but silently fails to register LLM spans in others because the OTel ESM loader hook is not registered explicitly. The full recipe is safe for all environments.

```js
// register.mjs — always use this exact form for pure-ESM Node projects
import { register } from 'node:module';
import { createRequire } from 'node:module';

// Shim `require` — trodo-node's ESM build uses it to lazy-load OTel peer deps.
// Pure ESM has no global `require`, so without this the auto-instrumentation
// silently registers zero providers.
globalThis.require = createRequire(import.meta.url);

// Register the OTel ESM loader hook BEFORE any user module is linked.
// Without this, `import openai from "openai"` in the entry file resolves
// unpatched and chat.completions.create never emits a span.
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

// Pre-load OpenAI Node shims so IITM doesn't leave client.fetch === undefined.
// Only needed if the project imports 'openai' directly. Remove if not.
await import('openai/shims/node');

// Init Trodo — runs after the OTel hook is registered, so providers are patched.
const trodo = (await import('trodo-node')).default;
trodo.init({
  siteId: process.env.TRODO_SITE_ID,
});
```

Run every script with:
```bash
node --env-file=.env --import ./register.mjs path/to/script.js
```

Note: `--env-file=.env` is required — Node.js does NOT auto-load `.env` files.

### short-lived scripts — always add `await trodo.shutdown()`

For standalone scripts that run and exit (not long-running servers), the process can exit while the ingest HTTP POST is still in flight. Always `await` the top-level `wrapAgent` call AND `await trodo.shutdown()` before the script body ends:

```js
// ✅ correct for a CLI / standalone script
const { result } = await wrapAgent('my-agent', async (run) => {
  // ...
}, { distinctId });
await trodo.shutdown();
```

Without `await trodo.shutdown()`, the process exits mid-POST and the run never appears in the dashboard. Long-running servers (Express, FastAPI, Next.js) don't hit this — only scripts.

### OTel peer dep version pinning (Node.js)

When installing OTel peer deps, always pin `@opentelemetry/instrumentation-openai` to `^0.14.0`. Version 0.15.0+ has a TypeScript class-field bug that resets histogram fields after `super()` and silently kills LLM span capture on startup. This is an upstream bug — pin even on the latest trodo-node.

```bash
npm install \
  @opentelemetry/api@^1.9.1 \
  @opentelemetry/instrumentation-openai@^0.14.0 \
  @opentelemetry/resources@^1.x \
  @opentelemetry/sdk-node@^0.x \
  @opentelemetry/sdk-trace-base@^1.x \
  @opentelemetry/exporter-trace-otlp-proto@^0.x
```

> **Always check the already-installed OTel packages in package.json before running install.** If `@opentelemetry/instrumentation-openai` is already at `^0.15.x`, downgrade it explicitly.

### "not loaded" debug warnings are harmless

When `trodo.init({ debug: true })` is set, Trodo tries to instrument every supported provider at startup. For each provider not installed (Anthropic, LangChain, Bedrock, Cohere, Gemini, etc.), it logs:

```
instrumentation 'anthropic' not loaded
instrumentation 'langchain' not loaded
...
```

These are completely harmless — they mean those providers aren't present. The important line to look for is:

```
auto-instrumentation registered (1 active: openai)
```

That confirms OpenAI is patched. All other "not loaded" lines can be ignored.

After confirming the setup works, `debug: true` can be removed to silence the noise.

### Install all dependencies before the user tests

Run the full `npm install` or `pip install` as part of Phase 3 — don't leave it for the user to do manually. Confirm the install succeeded before calling Phase 3 complete.

---

## PHASE 4 — Verify

After implementing, do these checks:

1. **Confirm dependencies installed** — run `npm list trodo-node @opentelemetry/instrumentation-openai` and verify the installed versions match expectations (especially the `0.14.x` pin).

2. **Print the exact run command** for the user — include `--env-file=.env` and `--import ./register.mjs`. If it's a server, show `npm run dev` or equivalent.

3. **Tell the user what to look for in the dashboard** — explain the specific run names, that LLM spans will appear nested under each run, and (for raw OpenAI function calling) that tool spans will appear alongside them. Point to [app.trodo.ai](https://app.trodo.ai).

4. **Remind the user about the TRODO_SITE_ID env var** — tell them where to add it (`.env` file or shell session) and where to find the value (dashboard → Integration Manager).

---

## How to access docs

Base URL: `https://docs.trodo.ai`

Use fetch/search tools in this order:

**1. Start with the index**

Fetch the full list of every published doc page:
`https://docs.trodo.ai/llms.txt`

Use this to discover the right page, then fetch it directly. Always prefer this over guessing a URL.

**2. Fetch individual pages as markdown**

Append `.md` to any page URL from the index:
`https://docs.trodo.ai/agent-analytics/integrations/vercel-ai-sdk.md`

Read the relevant page before writing code.

**3. Search as a fallback**

If you can't identify the right page from the index:
`site:docs.trodo.ai <query>`

---

## Detect

Inspect imports and file structure before deciding anything:

| Signal | How to detect |
|---|---|
| **Language** | `.ts`/`.js`/`.mjs`/`.cjs` = TypeScript / JavaScript · `.py` = Python |
| **Framework** | `from 'ai'` = Vercel AI SDK · `from '@openai/agents'` = OpenAI Agents SDK · `from 'langchain'` or `from langchain` = LangChain · `from 'llamaindex'` or `from llama_index` = LlamaIndex · `from 'haystack'` = Haystack (Python only) |
| **Provider** | `from 'openai'` / `from openai` = OpenAI · `from '@anthropic-ai/sdk'` / `from anthropic` = Anthropic · `from '@aws-sdk/client-bedrock-runtime'` / `import boto3` bedrock = Bedrock · `from 'cohere-ai'` / `from cohere` = Cohere · `from '@google/generative-ai'` / `from google.generativeai` = Google Gemini · `@google-cloud/vertexai` / `from vertexai` = Vertex AI · `from '@mistralai/mistralai'` / `from mistralai` = Mistral |
| **Streaming** | `streamText`, `messages.stream()`, `messages.create({ stream: true })`, `stream=True` in Python, async generator patterns, SSE response (`text/event-stream`) |
| **Existing OTel** | `@opentelemetry/` imports, `NodeTracerProvider`, `TracerProvider`, `BatchSpanProcessor`, `OTLPTraceExporter`, `tracer.start_as_current_span` |
| **Runtime** | `next.config.*` or `app/` / `pages/` = Next.js · `express()` / `fastify()` = Node server · `FastAPI()` / `Flask()` = Python server · `"type": "module"` in package.json = pure-ESM · otherwise standalone script |
| **Package manager** | `pnpm-lock.yaml` = pnpm · `yarn.lock` = yarn · `package-lock.json` = npm · `bun.lockb` = bun · `poetry.lock` = poetry · `uv.lock` = uv · `requirements.txt` = pip |

---

## Decision tree

Check in this order — sequence matters. The first three paths target stacks that already speak OTel; everything below is the SDK-first integration.

### 0a. NextJS / Vercel AI with `@vercel/otel` or `instrumentation.ts`?

→ **Detection signals (BOTH must be true):**
- `package.json` has `@vercel/otel` *or* a root `instrumentation.ts` / `instrumentation.js` file exists.
- The app uses Vercel AI SDK (`ai` package) or another OTel-emitting framework.

→ **Recommend Path A — env-var-only, no Trodo SDK install.** Set two env vars and `experimental_telemetry.metadata` on calls. Trodo's `/v1/traces` endpoint accepts standard OTLP/protobuf, maps `ai.*` semconv to runs/spans, and writes to the same dashboard.

```
# .env.local
OTEL_EXPORTER_OTLP_ENDPOINT=https://sdkapi.trodo.ai
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer ${TRODO_SITE_ID}"
```

```ts
// instrumentation.ts (only needed if not already present)
import { registerOTel } from '@vercel/otel';
export function register() {
  registerOTel({ serviceName: 'support-bot' });
}
```

```ts
// In any route — pass user/session/agent metadata so the dashboard groups runs.
import { generateText } from 'ai';
const result = await generateText({
  model: openai('gpt-4o'),
  messages,
  experimental_telemetry: {
    isEnabled: true,
    metadata: {
      userId: session.user.id,        // → distinct_id
      sessionId: chatId,              // → conversation_id
      agentName: 'support_chat',      // → agent_name
      experimentId: 'v3-prompt',
      tier: 'enterprise',
    },
  },
});
```

→ **Where users get the site_id:** dashboard → Integration Manager (same value as `trodo.init({ siteId })`). The Bearer token IS the site_id; there is no separate API key.

→ **Pitfalls:**
- `experimental_telemetry.isEnabled: true` is required on every Vercel AI call — without it, no spans emit.
- The OTel exporter is server-side only; `NEXT_RUNTIME === 'nodejs'` guard your `register()` if you don't want it on Edge.
- If you ALSO want the SDK's `wrapAgent` / `feedback` API on top of this, install `trodo-node` and call `registerOTel({ mode: 'otlp', siteId })` instead — see §0b. They coexist; auto-instrumented spans still go through OTLP.

### 0b. Existing OTel pipeline (Datadog / Jaeger / Honeycomb), and user wants Trodo as ALSO a destination?

→ **Detection signals:** `@opentelemetry/sdk-node` / `dd-trace` / `@opentelemetry/sdk-trace-node` actively configured (look for `NodeTracerProvider`, `OTLPTraceExporter`, or framework auto-config); user explicitly asked to "add Trodo alongside" / "send to both" / "without replacing".

→ **Recommend Path B — `registerOTel({ mode: 'otlp' })` from `trodo-node >= 2.4.0`.** Attaches a Trodo OTLP exporter to the existing tracer provider so every span fans out to both.

```ts
// instrumentation.ts (or app bootstrap, AFTER the existing OTel provider is registered)
import { registerOTel } from 'trodo-node';

registerOTel({
  siteId: process.env.TRODO_SITE_ID!,
  mode: 'otlp',
  endpoint: 'https://sdkapi.trodo.ai',
  serviceName: 'support-bot',
});
```

→ **Required peer deps when picking `mode: 'otlp'`:**
```
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-proto @opentelemetry/resources
```

→ **Caveat for `mode: 'otlp'`:** auto-instrumented spans form their own OTel traces and become their own runs server-side. They are NOT auto-attached as children of the current `wrapAgent` run — that requires the default `mode: 'trodo'`. Document this with the user.

### 1. Existing OTel provider detected (anything else)?

→ **YES:** Don't replace the user's OTel setup. Trodo's SDK registers its own span processor, so it coexists with an existing `NodeTracerProvider` / `TracerProvider` — both exporters receive every span. The one thing to double-check is that `trodo.init()` runs **after** the user's provider is registered.

→ Read: `https://docs.trodo.ai/recipes/dual-export.md`.

### 2. Framework or provider SDK in Trodo's auto-instrumented list?

This is the common case. Trodo auto-instruments these providers when `trodo.init()` runs:

- **Node:** `anthropic`, `openai`, `langchain`, `@aws-sdk/client-bedrock-runtime`, `cohere-ai`, `@google/generative-ai`, `@google-cloud/vertexai`, `llamaindex`, `ai` (Vercel AI SDK), `http` / `fetch`.
- **Python:** `anthropic`, `openai`, `langchain`, `llama_index`, `google.generativeai`, `vertexai`, `boto3` (Bedrock), `cohere`, `mistralai`, `haystack`, `httpx`, `requests`.

→ If detected, the full integration is three things:

1. **Install** `trodo-node` (Node) or `trodo-python` (Python).
2. **Init once** at the app entrypoint, before any provider client is imported or instantiated.
3. **Wrap the agent entry function** with `wrapAgent(name, fn, opts?)` / `wrap_agent(name, ...)`.

#### What "auto-instrumented" actually covers

The provider's **LLM call** (`chat.completions.create`, `messages.create`, `generateText`, etc.) becomes a nested span automatically. **Tool spans are a different story:**

| Provider / framework | LLM call auto-captured? | Tool spans auto-captured? |
|---|---|---|
| `langchain` / `langchain-core` (Node + Python) | yes | **yes** — LangChain's `Tool` abstraction is patched |
| Vercel AI SDK (`ai`) with `tools: {...}` and `experimental_telemetry: { isEnabled: true }` | yes | **yes** — the SDK owns the call site and emits tool spans |
| OpenAI Agents SDK (`@openai/agents` / `openai-agents`) | yes | **yes** — the framework owns tool execution |
| `llamaindex` / `llama_index` | yes | **yes** for query-engine tool calls |
| Haystack pipelines (Python) | yes | **yes** for pipeline-component invocations |
| **Raw OpenAI** (`openai.chat.completions.create` with `tools: [...]`) | yes | **no** — the SDK returns a `tool_calls[]` array; your code runs the tool. Wrap with `trodo.tool(name, fn)` or `trodo.withSpan(name, fn, { kind: 'tool' })`. |
| **Raw Anthropic** (`anthropic.messages.create` with `tools: [...]`) | yes | **no** — same as raw OpenAI; wrap manually. |
| **Raw Gemini / Vertex / Bedrock / Cohere / Mistral with function calling** | yes | **no** — same pattern. Wrap manually. |

> **The rule:** auto-instrumentation patches what the library executes. If the provider returns a *description* of a tool call for your code to run (raw OpenAI / Anthropic function calling), the tool execution is not in the provider's library and there is nothing to patch. Wrap it manually.

→ Read: `https://docs.trodo.ai/llms.txt`, find the matching `integrations/<framework>.md`, fetch and read before writing code.

### 2a. Pure-ESM Node app (`"type": "module"`)?

**Always use the full `register.mjs` recipe** (see Phase 3). Do not use the lean recipe.

The lean recipe (`openai/shims/node` + trodo.init inline) works in some environments but fails silently in others — LLM spans don't appear because:
- Without `globalThis.require = createRequire(...)`, trodo's ESM build can't lazy-load OTel peer deps.
- Without `register('@opentelemetry/instrumentation/hook.mjs', ...)`, the OTel loader hook is registered too late to patch `openai` before the module is linked.

On `trodo-node >= 2.4.2`, B1/B4/D1 are fixed internally, but the explicit `register(...)` call in `register.mjs` is still required for reliable LLM span capture.

**Required:** `node --env-file=.env --import ./register.mjs script.js`

Note: `--env-file=.env` is required because Node does NOT auto-load `.env` files.

→ **Also required for short-lived scripts:** `await wrapAgent(...)` at top level AND `await trodo.shutdown()` at the end. Without `await trodo.shutdown()`, the process exits mid-POST and the run never lands in the dashboard.

### 3. No matching framework / raw HTTP to an LLM?

→ Manual instrumentation. Pick helpers by the shape of the call:

| Factory / Helper | Returns a wrapped callable for | Span kind |
|---|---|---|
| `trodo.tool(name, fn)` | A tool invocation you want visible in the trace tree. **Factory.** | `tool` |
| `trodo.llm(name, fn, { model, provider })` | A raw LLM call not covered by auto-instrumentation. **Factory.** | `llm` |
| `trodo.retrieval(name, fn)` | Vector search, DB lookup, or any retrieval step. **Factory.** | `retrieval` |
| `trodo.trace(name, fn)` | Any generic step you want to see as a named span. **Factory.** | `generic` |
| `trodo.withSpan(name, fn, { kind })` | **Inline executor** — runs `fn` immediately, emits one span, resolves with the return value. | configurable |
| `trodo.trackLlmCall({ model, provider, inputTokens, outputTokens, prompt, completion })` | One-shot record of an LLM call you already have the response for. | `llm` |

> **Important — `tool` / `llm` / `retrieval` / `trace` are wrapper factories.** Calling `trodo.tool('x', fn)` does **not** execute `fn` — it returns a new callable. Call that callable with the actual arguments to run the work and emit the span.

```ts
// Factory form — define once, call many times
const getWeather = trodo.tool('get_weather', (args) => fetchWeather(args.location));
const result = await getWeather({ location: 'NYC' });   // span emits here

// Inline form — execute now, span around this one call
const result = await trodo.withSpan(
  'get_weather',
  async (span) => { span.setInput(args); return fetchWeather(args.location); },
  { kind: 'tool' },
);
```

### 4. Cross-service or sub-agent?

The run context propagates inside a single Node/Python process via AsyncLocalStorage / contextvars. Outside that (different service, worker thread, process pool), propagate `runId` manually.

→ **HTTP boundary:** `propagationHeaders()` on the caller, `expressMiddleware()` / `fastapi_middleware()` on the callee.
→ **Worker thread / ProcessPoolExecutor:** capture `runId` from the parent, pass it in, call `joinRun(runId, fn)` / `join_run(run_id, ...)` inside.

→ Read: `https://docs.trodo.ai/recipes/cross-service.md`.

### 5a. Building an MCP server that proxies tool calls?

`wrapAgent` and `startRun`/`endRun` are both wrong for MCP. Use `track_mcp` / `trackMcp` — one call per `tools/call`.

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

→ Read: `https://docs.trodo.ai/recipes/mcp-server.md`.

### 5b. Websocket-pinned chats / scheduled jobs that resume across workers?

→ Use `startRun(name, opts)` + `joinRun(runId, ...)` + `endRun(runId, opts)`. `wrapAgent` can't bridge workers.

→ Read: `https://docs.trodo.ai/agent-analytics/tracing/start-run-end-run.md`.

---

## Handle reference

| Helper | Callback signature | Handle methods |
|---|---|---|
| `wrapAgent(name, async (run) => …)` | `RunHandle` | `setInput(obj)`, `setOutput(obj)`, `setMetadata(obj)` — **no `setAttribute`** |
| `startRun(name, …)` → `joinRun(runId, async (run) => …)` | `RunHandle` | same as above |
| `withSpan({ kind, name }, async (span) => …)` | `SpanHandle` | `setInput`, `setOutput`, `setAttribute(key, value)`, `setLlm({...})`, `setTool(name)` |
| `tool(name, fn)` / `llm(...)` / `retrieval(...)` / `trace(...)` | factory — calling the inner fn yields no handle | n/a |

If you want a scalar attribute on the **run** (counts, flags, version tags), use `run.setMetadata({ key: value })`. If you want a scalar attribute on a **span**, use `span.setAttribute(key, value)` from inside `withSpan`. Calling `run.setAttribute(...)` throws `TypeError: run.setAttribute is not a function`.

---

## Output capture discipline

### Rule 1 — Await the full result before `setOutput`

Streaming agents are the common offender. The wrapped function must not return until the stream has been consumed.

```ts
// WRONG — result is a stream object; run output ends up empty / partial
return await wrapAgent('chat', async (run) => {
  const result = streamText({ model, messages, experimental_telemetry: { isEnabled: true } });
  return result;   // ❌
});

// RIGHT — collect the stream first, then setOutput, then return
return await wrapAgent('chat', async (run) => {
  const result = streamText({ model, messages, experimental_telemetry: { isEnabled: true } });
  const text = await result.text;   // ✅ full text only resolves after stream finishes
  run.setOutput({ answer: text });
  return text;
});
```

### Rule 2 — Span output is the FULL payload; short summaries go into attributes

```ts
// WRONG — summary is the only thing persisted; results[] is dropped forever
span.setOutput({ summary: r.summary });   // ❌

// RIGHT — full payload as output; small summary string as attribute
span.setOutput(r);
span.setAttribute('result_count', r.results.length);
if (r.summary) span.setAttribute('summary', String(r.summary));
```

### Rule 3 — Never hand-truncate the value passed to `setOutput`

The SDK already truncates at 64 KB. Pre-slicing with `.slice(0, 500)` / `[:500]` hides data.

```ts
run.setOutput({ finalAnswer: text.slice(0, 500) });   // ❌
run.setOutput({ finalAnswer: text });                 // ✅
```

---

## Recipes

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
| `https://docs.trodo.ai/recipes/mcp-server.md` | MCP server (runless spans) |

---

## Minimal install — what the generated code should look like

### Node.js (non-ESM server)

```ts
// 1. At the app entry (index.ts / server.ts / instrumentation.ts):
import trodo from 'trodo-node';
trodo.init({ siteId: process.env.TRODO_SITE_ID! });

// 2. Import provider clients AFTER init.
import OpenAI from 'openai';
import { wrapAgent } from 'trodo-node';

const openai = new OpenAI();

export async function answer(userId: string, question: string) {
  const { result } = await wrapAgent(
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

### Node.js (pure-ESM script)

```js
// register.mjs — full bootstrap (see Phase 3)
import { register } from 'node:module';
import { createRequire } from 'node:module';
globalThis.require = createRequire(import.meta.url);
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
await import('openai/shims/node');
const trodo = (await import('trodo-node')).default;
trodo.init({ siteId: process.env.TRODO_SITE_ID || 'YOUR_SITE_ID' });
```

```js
// script.js
import trodo, { wrapAgent } from 'trodo-node';
import OpenAI from 'openai';

const openai = new OpenAI();

const { result } = await wrapAgent(
  'my-agent',
  async (run) => {
    run.setInput({ question: 'Hello' });
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    run.setOutput({ answer: resp.choices[0].message.content });
    return resp.choices[0].message.content;
  },
  { distinctId: 'user-123' },
);

await trodo.shutdown();  // required for short-lived scripts
```

```bash
# Run with:
node --env-file=.env --import ./register.mjs script.js
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

Finally: tell the user to set `TRODO_SITE_ID` in their `.env` (server-only, never `NEXT_PUBLIC_` prefix) and point them at [app.trodo.ai](https://app.trodo.ai) → Integration Manager to grab the value.

---

## Critical constraints

- **Init before client import.** `trodo.init()` must run before any provider client is imported or instantiated. In pure-ESM, the `--import register.mjs` pattern handles this.
- **Single import of trodo-node.** Never write two separate `import trodo from 'trodo-node'` and `import { wrapAgent } from 'trodo-node'` in the same file. Use `import trodo, { wrapAgent } from 'trodo-node'`.
- **`await trodo.shutdown()` on short-lived scripts.** Without this, pure-ESM scripts exit mid-POST and the run never lands in the dashboard.
- **`--env-file=.env` for all Node.js scripts.** Node does not auto-load `.env`. Always include this flag when running any script that reads env vars.
- **Pin `@opentelemetry/instrumentation-openai@^0.14.0`.** 0.15.x breaks LLM span capture silently.
- **Tool spans for raw provider SDKs are NOT automatic.** Wrap the dispatch loop with `trodo.tool(name, fn)` or `trodo.withSpan(name, fn, { kind: 'tool' })`.
- **Use `debug: true` to see why auto-instrument isn't loading.** It logs every peer-dep load failure to stderr.
- **Vercel AI SDK — every call.** `experimental_telemetry: { isEnabled: true }` must appear on every `generateText` / `streamText` / `generateObject` call.
- **Env vars are server-only.** Never prefix `TRODO_SITE_ID` with `NEXT_PUBLIC_` / `VITE_` / `PUBLIC_`.
- **Always return a value.** The wrapped function's return value becomes the run output. Returning `undefined` leaves the output field blank.
- **Nested `wrapAgent` = two runs, not a nested run.** For sub-steps inside an agent, use `trodo.trace(name, fn)` or `trodo.tool(name, fn)`. For a genuine child run linked to a parent, use the `parentRunId` option.
- **Span status is exception-driven, not output-driven.** `setOutput({ status: 'error' })` does NOT mark the span as failed. Whether a span shows "ok" or "failed" is determined by whether an unhandled exception propagated through the context manager.
- **Never impose distinctId or run boundary without asking.** Always detect candidates and confirm with the user (see Phase 2).

---

## Known pitfalls

| Pitfall | Symptom | Fix |
|---|---|---|
| Provider client imported before `trodo.init()` | No child LLM spans under the run | Move `trodo.init()` to the very first line of the entry file, or use `--import register.mjs` for pure-ESM |
| Pure-ESM: lean `register.mjs` (no explicit OTel hook) | LLM spans don't appear even though "auto-instrumentation registered (1 active: openai)" is logged | Use the full recipe: add `register('@opentelemetry/instrumentation/hook.mjs', import.meta.url)` before trodo.init() |
| `@opentelemetry/instrumentation-openai@0.15.x` installed | LLM spans silently don't appear | Pin to `^0.14.0` and reinstall |
| Short-lived script exits before run lands | Dashboard never receives the run, no error logged | `await` the top-level `wrapAgent` call AND `await trodo.shutdown()` before script exits |
| No `--env-file=.env` flag | `OPENAI_API_KEY` / `TRODO_SITE_ID` undefined, silent failures | Add `--env-file=.env` to the node command |
| Double import of trodo-node in same file | Redundant / confusing; potential undefined behavior if multiple instances | `import trodo, { wrapAgent } from 'trodo-node'` — single import |
| "not loaded" warnings for every unused provider | Confusing noise in terminal | These are harmless — they mean those providers aren't installed. Only `auto-instrumentation registered (1 active: openai)` matters. Remove `debug: true` after confirming it works. |
| Missing `experimental_telemetry` on Vercel AI SDK calls | Root span appears, no child LLM spans | Add `experimental_telemetry: { isEnabled: true }` to every `generateText` / `streamText` / `generateObject` call |
| `NEXT_PUBLIC_TRODO_SITE_ID` used in client components | Site ID ends up in client bundle; server has no value at runtime | Rename to `TRODO_SITE_ID`, read only in server code |
| Returning stream object instead of consuming it | Output field shows `[object ReadableStream]` or empty | Consume stream inside the wrapper; call `run.setOutput(assembledText)` in `onFinish` |
| Calling `joinRun(runId, fn)` with undefined `runId` | Silent no-op; spans created inside have no parent run | Verify the `X-Trodo-Run-Id` header is actually present |
| `autoInstrument: false` left in config | No framework spans nest under the run | Remove the override or set to `true` (default) |
| Debug mode says "site not found" | All tracking silently drops | Site ID is wrong or from the wrong environment — check [app.trodo.ai](https://app.trodo.ai) |
| Returning `undefined` / `None` from wrapped function | Run appears with blank output | Return the final result explicitly, or call `run.setOutput(...)` |
| `run.setAttribute is not a function` (inside `wrapAgent`) | TypeError thrown when tagging a run with metadata | `RunHandle` only exposes `setInput`, `setOutput`, `setMetadata`. Use `run.setMetadata({ key: value })`. |
| Returned a `tool()` / `llm()` wrapper instead of calling it | No tool span; downstream code receives the wrapper, not the result | `trodo.tool('x', fn)` is a factory — call the returned callable: `const wrapped = trodo.tool('x', fn); await wrapped(args)` |
| Raw OpenAI / Anthropic tool calls not appearing as tool spans | LLM span shows, no tool spans | Raw provider SDKs don't auto-capture tool execution. Wrap the dispatch with `trodo.tool(name, fn)` or `trodo.withSpan(name, fn, { kind: 'tool' })`. |
| `wrapAgent` used for MCP server | Every `tools/call` becomes a disconnected Run with no input/output | Switch to `trodo.trackMcp({...})` — one runless span per `tools/call`. |
| `wrapAgent` used for websocket-pinned chat or scheduled job | Single-callback block can't bridge requests/workers | Switch to `startRun` + `joinRun` + `endRun`. |
| `propagationHeaders` is not a function (Node CommonJS) | TypeError at runtime | It's a named export: `const { propagationHeaders } = require('trodo-node')` |
| Code returns error objects instead of raising — span shows "ok" | Tool shows green "ok" even though it failed | Raise an exception inside the `wrapAgent`/`withSpan` block when the result indicates failure. |
| `setOutput` with metadata instead of real data | Dashboard shows `{ answerLength: 478 }` — not useful | Pass the actual payload: `setOutput({ answer: text })`. |

---

## When things go wrong

Before suggesting code changes, check in this order:

1. **No traces at all.**
   - Is `TRODO_SITE_ID` set? (`console.log(process.env.TRODO_SITE_ID)` on the server.)
   - Is `trodo.init()` called before any provider client import? (Pure-ESM: use `--import register.mjs`.)
   - Did the script exit before flushing? Add `await trodo.shutdown()` at the end.
   - Is the process staying alive long enough? In serverless / short-lived scripts, call `await trodo.flush()` / `await trodo.shutdown()` before exit.

2. **Traces appear but no child LLM spans.**
   - Was the provider client instantiated **after** `trodo.init()`?
   - For pure-ESM: is the full `register.mjs` recipe being used (with explicit `register()` call)?
   - Is `@opentelemetry/instrumentation-openai` at `^0.14.0`? Not `^0.15.x`?
   - Did the user set `autoInstrument: false`?
   - Run with `trodo.init({ debug: true })` to see which instrumentation packages loaded successfully.

3. **Tool spans not appearing.**
   - Is the user using raw OpenAI / Anthropic function calling (not LangChain / Vercel AI tools)? If so, wrap the dispatch loop with `trodo.tool(name, fn)`.

4. **Empty output on the run.**
   - Does the wrapped function return a value?
   - For streaming: is `run.setOutput()` called in `onFinish`?

5. **Span never closes / run stuck in "running".**
   - Does the wrapped function resolve in all code paths?
   - For streaming: is the stream actually consumed?

→ Full troubleshooting: `https://docs.trodo.ai/agent-analytics/tracing/troubleshooting.md`.

**If the user has the Trodo MCP connected**, query recent runs directly to confirm whether spans are arriving before suggesting any code changes.

---

## Skill feedback

If the skill gives incorrect guidance, references a page that doesn't exist, or is missing a scenario you encountered — offer to submit feedback. See `https://docs.trodo.ai/skill-feedback.md` for the process.

Do **not** trigger this for issues with Trodo itself (the product) — only for issues with this skill's instructions.
