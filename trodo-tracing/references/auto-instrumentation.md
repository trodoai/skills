# Auto-instrumentation — Integration Notes

Targets `trodo-node` >= 2.1.0 and `trodo-python` >= 2.1.0.

Docs: `https://docs.trodo.ai/agent-analytics/tracing/overview.md`, `https://docs.trodo.ai/agent-analytics/integrations/`.

---

## The one-line version

When `trodo.init()` runs, Trodo registers OpenTelemetry instrumentors for every supported provider that's installed. LLM / tool / retrieval / HTTP calls made inside a `wrapAgent` block become child spans automatically — you do not wrap them.

Default is **on**. Opt out with `autoInstrument: false` (Node) or `auto_instrument=False` (Python).

---

## Providers covered

### Node (`trodo-node`)

| Package | What's captured |
|---|---|
| `openai` | `chat.completions.create`, `responses.create`, streaming variants. Model, tokens, temperature, prompt, completion. |
| `@anthropic-ai/sdk` | `messages.create` + `messages.stream`. Model, tokens, prompt, completion. |
| `langchain` | Chain + LLM invocations, tool calls inside chains. |
| `@aws-sdk/client-bedrock-runtime` | `InvokeModelCommand`, `InvokeModelWithResponseStreamCommand`. Per-model-family token extraction. |
| `cohere-ai` | `chat`, `chatStream`, `generate`. |
| `@google/generative-ai` | `generateContent`, streaming. Model, tokens, prompt, completion. |
| `@google-cloud/vertexai` | `generateContent` on Vertex models. |
| `llamaindex` | Query engine + retriever calls. |
| `ai` (Vercel AI SDK) | `generateText`, `streamText`, `generateObject`. **Requires** `experimental_telemetry: { isEnabled: true }` on every call — see [`vercel-ai-sdk.md`](./vercel-ai-sdk.md). |
| `http` / `fetch` | Outbound HTTP as generic spans. Useful for raw LLM endpoints. |

### Python (`trodo-python`)

| Package | What's captured |
|---|---|
| `openai` (v1 + v2) | `chat.completions.create`, `responses.create`, Async variants, streaming. |
| `anthropic` | `messages.create` + `messages.stream`. |
| `langchain` / `langchain-core` | Chains, LLM invocations, tool calls. |
| `llama_index` | Query engine, retriever, LLM calls. |
| `google.generativeai` | `generate_content`, streaming. |
| `vertexai` | Gemini / Vertex model calls. |
| `boto3` (Bedrock) | `invoke_model`, `invoke_model_with_response_stream`. |
| `cohere` | Chat, generate. |
| `mistralai` | Chat completions. |
| `haystack` | Pipeline runs. |
| `httpx` / `requests` | Outbound HTTP as generic spans. |

---

## What shows up in the dashboard

Each auto-instrumented LLM call produces a span with:

- `span.kind = 'llm'`
- `gen_ai.system` — provider (e.g. `openai`, `anthropic`, `bedrock`)
- `gen_ai.request.model` — requested model
- `gen_ai.response.model` — returned model (may differ for alias routing)
- `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens`
- `gen_ai.request.temperature`, `top_p`, etc. when set
- Full prompt messages and completion content as span input/output

Cost is computed server-side from tokens + model using the Trodo pricing table — you don't pass it.

---

## Confirming it's working

Quickest check: enable debug mode and run one request.

```ts
trodo.init({ siteId: process.env.TRODO_SITE_ID!, debug: true });
```

You should see log lines like `[trodo] instrumented: openai`, `[trodo] instrumented: anthropic`. If a package you're using isn't in the log, either it's not installed or it was imported before `init()` ran.

Then hit [app.trodo.ai](https://app.trodo.ai) → Runs → click the latest run. The waterfall should show the root `wrapAgent` span with an LLM child span underneath.

---

## Disabling specific providers

The current SDK exposes a single boolean `autoInstrument`. There is no per-provider opt-out at the config level yet. If you need to disable one provider's auto-instrumentation (e.g. to debug), set `autoInstrument: false` and fall back to manual `trodo.llm()` / `trodo.trackLlmCall()` wrapping for the calls you care about — see [`manual-instrumentation.md`](./manual-instrumentation.md).

---

## Common reasons a provider isn't auto-captured

- **Client imported before `trodo.init()`.** The import binds a reference before auto-instrumentation patches the module. Move `init()` to the top of the entrypoint, or use Next.js `instrumentation.ts`.
- **Package not actually installed.** Auto-instrumentation registers only for packages present in `node_modules` / site-packages. `npm ls openai` or `pip show openai` to confirm.
- **`autoInstrument: false` set.** Check the `init()` call site.
- **Raw `fetch` to a provider URL.** `fetch` is captured as a generic HTTP span, but without provider-specific token/model extraction. Use `trodo.trackLlmCall()` after the fetch to record it as an LLM span with tokens.
- **Custom-wrapped clients.** If the user has their own HOF wrapping `openai.chat.completions.create`, the wrapper may capture the unpatched method reference at module load. Patch at the client instance level (e.g. `const openai = new OpenAI()` after init) instead of at the method level.
