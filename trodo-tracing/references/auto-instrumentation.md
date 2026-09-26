# Auto-instrumentation — what `init()` captures and how to confirm it

Targets `trodo-node` / `trodo-python` ≥ 2.23.

Docs: `https://docs.trodo.ai/observability/features/instrumentation/guide`,
`https://docs.trodo.ai/observability/features/instrumentation/frameworks/overview`.

---

## What happens at `init()`

`trodo.init()` registers an OpenTelemetry instrumentor for every supported provider
package that is **installed**, attaches Trodo's span processor to the process's OTel
tracer provider (the existing one if the app has one, otherwise its own), and — when
the Vercel AI SDK `ai` package is present — registers Trodo's AI SDK telemetry
integration. From then on:

- every model call through a supported package becomes an `llm` span with model,
  provider, tokens, prompt and completion;
- every OpenTelemetry span any library emits in-process is converted (kind inferred
  from `gen_ai.*` / `ai.*` / `db.system` attributes) and nested under the active run;
- tool spans appear **only** where the framework executes the tool itself (LangChain
  `Tool`, Vercel AI `tools: {}`, LlamaIndex query engines, Haystack components). Raw
  OpenAI / Anthropic / Gemini / Bedrock function calling returns a *description* of the
  call and your code runs it — nothing to patch; wrap the dispatch
  (`manual-instrumentation.md`).

None of it lands unless a run is active. Auto-instrumentation without `wrapAgent` /
`startRun` at the entry point produces nothing.

The per-framework coverage table (including agent frameworks and gateways) lives in
[`frameworks.md`](./frameworks.md).

---

## Install the instrumentor for each provider you found

The SDK resolves the package at runtime but does not bundle it.

| Provider | Node | Python |
|---|---|---|
| OpenAI | `@opentelemetry/instrumentation-openai` | `opentelemetry-instrumentation-openai` |
| Anthropic | `@traceloop/instrumentation-anthropic` | `opentelemetry-instrumentation-anthropic` |
| LangChain / LangGraph | `@traceloop/instrumentation-langchain` | `opentelemetry-instrumentation-langchain` |
| LlamaIndex | `@traceloop/instrumentation-llamaindex` | `opentelemetry-instrumentation-llamaindex` |
| Google Gemini (`@google/genai` 1.x / `google-genai`) | `@traceloop/instrumentation-google-generativeai` | `opentelemetry-instrumentation-google-generativeai` |
| Vertex AI | `@traceloop/instrumentation-vertexai` | `opentelemetry-instrumentation-vertexai` |
| Bedrock | `@traceloop/instrumentation-bedrock` | `opentelemetry-instrumentation-bedrock` |
| Cohere | `@traceloop/instrumentation-cohere` | `opentelemetry-instrumentation-cohere` |
| Mistral | — (use `trodo.llm`) | `opentelemetry-instrumentation-mistralai` |
| Haystack | — | `opentelemetry-instrumentation-haystack` |
| Vercel AI SDK | nothing — built in | — |
| Generic HTTP | `@opentelemetry/instrumentation-http` | `opentelemetry-instrumentation-requests` / `-httpx` |

Node also needs the OTel runtime once: `@opentelemetry/api @opentelemetry/sdk-node
@opentelemetry/sdk-trace-base @opentelemetry/resources`. A missing peer prints a
one-shot stderr warning naming the install command; `init({ silent: true })` suppresses
it when the omission is deliberate.

---

## Ordering

`init()` must run before the provider client is **constructed**. A client built at
module top level in a file imported before the init line holds an unpatched method.
Put init in its own module imported first, or construct the client lazily. In Next.js,
init lives in `instrumentation.ts` (`runtimes.md`). Under pure-ESM Node, raw provider
SDKs need the loader hook: `node --import trodo-node/register app.js` (it reads
`TRODO_SITE_ID` and calls `init()`; do not call it again). Even so, per the docs the raw
`openai` / Anthropic / Google SDKs may emit nothing under ESM — confirm with a debug run
and fall back to `trodo.llm(...)` or CommonJS if empty. LangChain and the Vercel AI SDK
capture under ESM normally; Python is unaffected.

---

## Double counting — `disableInstrumentations`

When a framework and its provider are both instrumented, one model call can produce
two `llm` spans.

- **Node + LangChain:** `trodo.init({ siteId, disableInstrumentations: ['openai'] })`
  (add `'anthropic'` etc. as relevant). Requires `trodo-node` ≥ 2.23.4 — earlier
  releases accepted the option only on `registerOTel()` and `init()` ignored it.
- **Python + LangChain:** do **not** disable the provider — the Python LangChain
  instrumentor defers to it and you would lose the LLM span. The SDK warns
  (`superseded-…`) when it detects the overlap.
- **Vercel AI SDK v7 where the app already calls `registerTelemetry`:** register
  `trodo.aiSdkTelemetry()` there and pass `disableInstrumentations: ['vercel-ai']`.
- Never wrap an auto-instrumented call in `trodo.llm(...)` / `withSpan({ kind: 'llm' })`.

`autoInstrument: false` / `auto_instrument=False` turns everything off; then every model
call needs `trodo.llm` or `trackLlmCall`.

---

## Confirming it works

```ts
trodo.init({ siteId: process.env.TRODO_SITE_ID!, debug: true });
```
```python
trodo.init(site_id=os.environ["TRODO_SITE_ID"], debug=True)
```

Node prints `[trodo-node] auto-instrumentation registered (N active: openai, …)` — a
provider missing from that list is not installed, or its peer failed to load. Python
prints no per-package line; it prints a one-time warning only when something is wrong
(a missing peer, or `'langchain' was NOT loaded because openai instrumentation is
already active`, which is expected). On both, the real check is the next step: the run
must show `llm` children. None → the client was constructed before `init`, or the
instrumentor package is not installed. Then run one request and
open the run: the root should show `llm` children with model and tokens. If tokens are
present but input/output are blank on Node OpenAI, that is the first-party
`@opentelemetry/instrumentation-openai` routing message content to OTel *logs*. The
alternative, `@traceloop/instrumentation-openai` (aliased to the same name), puts
content on the span **but its stream handler does not read `chunk.usage`**, so every
streamed call lands with zero tokens and zero cost. Tokens matter more than content
(cost, run totals, the checklist), so: keep the first-party package when the app streams;
switch to traceloop only for non-streaming apps, and re-check tokens after switching.
Python's `opentelemetry-instrumentation-openai` records both.

Streaming OpenAI calls need `stream_options: { include_usage: true }` or the span has
zero tokens.
