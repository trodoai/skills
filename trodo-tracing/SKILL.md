---
name: trodo-tracing
version: 1.0.0
sdk_version_node: ">=2.1.0"
sdk_version_python: ">=2.1.0"
last_updated: 2026-04-23
description: >-
  Integrate Trodo agent analytics tracing into a codebase. Detects the user's
  language, framework, and existing OTel setup to pick the correct integration
  path and generate working instrumentation code. Use when the user asks to add
  Trodo tracing, fix missing traces, add tool call spans, track conversation
  threads, handle streaming agents, add Trodo alongside existing Datadog/Jaeger
  OTel, or add custom metadata to AI agent runs.
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

Before writing any code, verify you know exactly what to instrument. Ask the user for clarification when any of the following are true:

- **Multiple agent entry points found** — more than one file contains agent/run/pipeline definitions (e.g. `agentA.ts` and `agentB.ts`, or an `agents/` directory with several files).
- **Multiple frameworks coexist** — e.g. Vercel AI SDK and OpenAI Agents SDK imports both appear in the codebase.
- **Vague request** — the user said "add tracing" or "instrument my agents" without pointing to specific files or functions.
- **Multiple agent functions in a single file** — several `agent()` / `run()` / chain definitions are present and it's not obvious which should be wrapped.

When any of these apply, **do not guess** — ask once with a concrete, specific question:

> "I found agent definitions in `src/agents/chat.ts` and `src/agents/search.ts`. Which one(s) should I instrument, or should I add tracing to all of them?"

> "I see both Vercel AI SDK (`generateText`) and the OpenAI SDK directly (`openai.chat.completions.create`) used here. Should I instrument both, or just one?"

If none of the above apply — there is exactly one agent, one framework, and the scope is unambiguous — skip this step and proceed directly to the decision tree.

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
| `setOutput` / `set_output` with metadata instead of real data | Dashboard shows `{ answerLength: 478 }` or `{ status: "ok" }` — not useful for debugging | Pass the actual payload: `setOutput({ answer: text.slice(0, 1000) })` for LLM outputs; `set_output({"status": status, "data": result_dict})` for tool spans. Trodo truncates at the server if needed — don't pre-summarize into useless counts or flags. |

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
