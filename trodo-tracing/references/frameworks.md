# Frameworks and providers — what is captured for you, what you wrap

Targets `trodo-node` / `trodo-python` ≥ 2.23. Two mechanisms feed spans into a run:

1. **Provider instrumentors** registered by `trodo.init()` for every supported package that is installed (list below). They capture the model call itself.
2. **The OTel bridge.** Any OpenTelemetry span emitted in-process — by a framework's own OTel support, by an instrumentor Trodo didn't ship — is converted to a Trodo span and nested under the active run. Kind is inferred: `gen_ai.tool.name` / `ai.toolCall.name` → `tool`; `gen_ai.request.model` / `gen_ai.usage.*` / `ai.model.id` → `llm`; `db.system` / `retrieval.query` → `retrieval`; else `generic`. Input/output are read from every common convention (GenAI semconv, OpenLLMetry indexed keys, OpenInference `input.value`, Vercel `ai.prompt`, Traceloop, Langfuse, MLflow).

Both only work **inside a run**. Nothing lands without `wrapAgent` / `startRun` at the entry point.

Docs index: `https://docs.trodo.ai/observability/features/instrumentation/frameworks/overview`.

---

## Raw provider SDKs

| Package | Node | Python | LLM span | Tool dispatch |
|---|---|---|---|---|
| OpenAI (`chat.completions`, `responses.create`) | `openai` + `@opentelemetry/instrumentation-openai` | `openai` + `opentelemetry-instrumentation-openai` | auto | **manual** — you run `tool_calls[]`; wrap the dispatcher (`manual-instrumentation.md`) |
| Anthropic | `@anthropic-ai/sdk` + `@traceloop/instrumentation-anthropic` | `anthropic` + `opentelemetry-instrumentation-anthropic` | auto | **manual** — `tool_use` blocks |
| Google Gemini | `@google/genai` **1.x** (also legacy `@google/generative-ai`) + `@traceloop/instrumentation-google-generativeai` | `google-genai` (new SDK only; `google.generativeai` is not instrumented) | auto | manual |
| Vertex AI | `@google-cloud/vertexai` + `@traceloop/instrumentation-vertexai` | `vertexai` | auto | manual |
| Bedrock | `@aws-sdk/client-bedrock-runtime` + `@traceloop/instrumentation-bedrock` | `boto3` + `opentelemetry-instrumentation-bedrock` | auto | manual |
| Cohere | `cohere-ai` + `@traceloop/instrumentation-cohere` | `cohere` | auto | manual |
| Mistral | use `trodo.llm(...)` | `mistralai` + `opentelemetry-instrumentation-mistralai` | Node manual / Py auto | manual |
| Ollama / vLLM / any OpenAI-compatible base URL | the `openai` client pointed at it — instrumented like OpenAI | same | auto | manual |
| Raw `fetch` / `httpx` to a model endpoint | generic HTTP span only | same | **`trackLlmCall` / `track_llm_call`** after the call, with tokens | manual |

Docs per provider: `…/instrumentation/frameworks/openai`, `/anthropic`, `/google`, `/bedrock`, `/cohere`, `/mistral`, `/http`, and `…/instrumentation/raw-http`.

**Install the instrumentor package** alongside the SDK — `trodo.init()` registers only what is present. With `init({ debug: true })` Node prints the active instrumentors once at startup; a missing peer prints the install command once. Python prints nothing per package — confirm by seeing `llm` spans on the first run.

**Node ESM** (`"type": "module"`): raw provider SDKs need module hooking. Start with `node --import trodo-node/register app.js` (calls `init()` from `TRODO_SITE_ID`; do not call `init()` again). Per the docs, even with the hook the raw `openai` 4.x/5.x, Anthropic and Google SDKs may still emit no spans under ESM — verify with `debug: true`; if empty, wrap those calls with `trodo.llm(...)` or run CommonJS. LangChain and the Vercel AI SDK are unaffected. Python is unaffected.

---

## Agent frameworks

| Framework | LLM spans | Tool spans | Sub-agent / handoff spans | What you add |
|---|---|---|---|---|
| **Vercel AI SDK v7+** (`ai`) | auto — Trodo's telemetry integration is registered for you when `ai` is installed | auto | steps are flat `llm`/`tool` spans | `wrapAgent` at the entry point. If the app already calls `registerTelemetry(...)` itself, register `trodo.aiSdkTelemetry()` there **instead** and pass `disableInstrumentations: ['vercel-ai']` to `init` — registering twice doubles every span. Do not also install `@ai-sdk/otel`. |
| **Vercel AI SDK v5 / v6** | auto **only with** `experimental_telemetry: { isEnabled: true }` on every call | same | — | `wrapAgent` + the flag on every `generateText` / `streamText` / `generateObject` |
| **LangChain / LangGraph** (Node + Python) | auto (`@traceloop/instrumentation-langchain` / `opentelemetry-instrumentation-langchain`) | auto — `Tool` dispatch is framework-owned | LangGraph nodes and chains appear as spans | `wrapAgent` around the outermost `.invoke()` / `graph.stream()`. **Node:** pass `disableInstrumentations: ['openai']` (and `'anthropic'`) so the model call is not counted twice; **Python:** do not — the LangChain instrumentor defers to the provider one and you would lose the LLM span (`…/frameworks/langchain`). Human-in-the-loop `interrupt()` that resumes on a later request → `startRun`/`endRun`. |
| **LlamaIndex** | auto | auto for query-engine tools | agent workers appear | `wrapAgent` at the entry |
| **Haystack** (Python) | auto | pipeline components appear | — | `wrapAgent` at the entry |
| **OpenAI Agents SDK** (`@openai/agents`, `openai-agents`) | auto **via the underlying `openai` package** (CJS / Python) | **not** captured by Trodo — the framework runs tools itself and Trodo ships no instrumentor for it | not captured | `wrapAgent` at `run(agent, input)`. For tools, wrap each tool function body with `withSpan(name, fn, { kind: 'tool' })` / `trodo.span(name, kind='tool')` inside its definition; a handoff target becomes an `agent` span only if you wrap its invocation. If the app enables the SDK's own OpenTelemetry processor, the bridge picks those spans up instead — then add nothing. |
| **Pydantic AI** | auto via provider package, **or** via its OTel support: `Agent(..., instrument=True)` emits GenAI-semconv spans the bridge converts (llm + tool) | with `instrument=True`: auto | — | `wrap_agent` at `agent.run(...)`. Prefer `instrument=True` and then `disable_instrumentations=['openai']` to avoid a double LLM span; verify with `debug=True`. |
| **Google ADK** (Python) | its OTel spans are bridged (`gen_ai.*`) | bridged | bridged | `wrap_agent` around `runner.run_async(...)`; verify kinds in the first run |
| **CrewAI** | via the provider package (`openai`) or LiteLLM → generic HTTP only | not captured | crews/tasks not captured | `wrap_agent` around `crew.kickoff()`; `trodo.span(task.name, kind='agent')` per task if you own the loop; tools via `@trodo.tool`. If CrewAI's OTel telemetry is on, the bridge takes those spans. |
| **AutoGen / AG2**, **Agno**, **smolagents**, **DSPy**, **Semantic Kernel** | via provider package when they call `openai`/`anthropic` directly; nothing if they go through their own HTTP client | not captured | not captured | `wrap_agent` at the entry; `trodo.span(..., kind='agent')` per agent turn you can see; tools with `@trodo.tool`. Confirm LLM capture with `debug=True` before promising it. |
| **Mastra** (Node) | via `ai` (it builds on the Vercel AI SDK) → captured like Vercel AI v7 | via `ai` | workflows: bridge if Mastra's OTel export is on | `wrapAgent` around `agent.generate()` / workflow run |
| **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`, `claude_agent_sdk`) | the model runs in a subprocess — **nothing auto** | nothing | nothing | `wrapAgent` around `query(...)`; iterate the message stream and emit `withSpan(kind:'tool')` per `tool_use` result message and `trackLlmCall` per `assistant` message carrying `usage`; run output = the final `result` message |

**Rule for any framework not listed:** it is captured if and only if (a) it calls a supported provider SDK in-process (then the LLM span appears) or (b) it emits OpenTelemetry spans in-process (then the bridge converts them). Check with one debug run. Tool and sub-agent structure it executes itself is dark unless you wrap it.

---

## Gateways and routers

`baseURL` → OpenRouter, LiteLLM proxy, Vercel AI Gateway, Azure OpenAI, Bedrock via proxy. The client is still the `openai` SDK, so the LLM span appears. Two things to check on the first run:

- **Model / provider attribution** comes from the model string (`anthropic/claude-…` on OpenRouter is priced as Anthropic). If the gateway rewrites model names, set `span.setLlm({ model, provider })` in a manual span or accept the gateway's name and add a price under `…/features/pricing`.
- **Gateway-reported cost** (OpenRouter `usage.cost`) is not read automatically; pass it via `costDetails` on a manual `llm` span if the user needs it exact.

LiteLLM **as a library** (Python `litellm.completion`) makes its own HTTP calls — only a generic `httpx` span appears. Use `track_llm_call` after each call with the returned `usage`.

---

## Multi-agent, framework-owned vs hand-rolled

| Who owns the handoff | Sub-agent spans | You add |
|---|---|---|
| LangGraph nodes, LlamaIndex agent workers, Vercel AI multi-step, Pydantic AI / ADK with OTel on | already emitted | nothing — a manual `agent` span on top duplicates the layer |
| OpenAI Agents SDK handoffs, CrewAI crews, AutoGen group chats | **not** emitted by Trodo | one `agent` span per sub-agent you can see being invoked |
| Your own supervisor loop, `Promise.all` / `gather` over workers, a round loop | not emitted | one `agent` span per sub-agent / round, named for what it is |

Never a second `wrapAgent` for any of these — see `run-model.md` §2.
