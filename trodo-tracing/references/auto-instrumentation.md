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

---

## Peer-dep compatibility (Node)

`trodo-node` 2.4.x depends on the OpenTelemetry packages but doesn't pin them tightly. Two upstream changes break the integration silently — auto-instrument throws inside an empty `catch {}`, the global tracer provider stays as `NoopTracerProvider`, and every span is dropped without a log line.

| Peer dep | Known-good range with trodo-node 2.4.x | Why |
|---|---|---|
| `@opentelemetry/api` | `^1.9.0` | stable |
| `@opentelemetry/sdk-node` | `^0.52.x` | stable |
| `@opentelemetry/resources` | `^1.x` | 2.x removed the `Resource` class; trodo-node calls `new Resource(...)`, which throws and is swallowed |
| `@opentelemetry/instrumentation` | `^0.52.x` | stable |
| `@opentelemetry/instrumentation-openai` | `≤ 0.14.x` | 0.15.0 has a TS-class-field bug that resets histogram fields after `super()`, crashing on the first metric `.record()` |

Pin these in `package.json` when running the pure-ESM bootstrap (SKILL.md §2a). For Next.js / `@vercel/otel` projects, the Vercel adapter pins compatible versions itself — no action needed. For Path B (`registerOTel({ mode: 'otlp' })`), the SDK install hint covers the required peers; the version pins above still apply if you hit the same symptoms.

---

## ESM bootstrap workarounds (newer peer deps)

If you cannot downgrade the OTel peer deps, add these patches to `register.mjs` (SKILL.md §2a) **after** the `globalThis.require` shim and **before** the `await import('trodo-node')` line. Both are no-ops on the known-good peer-dep ranges, so it's safe to ship them defensively.

**Resource shim** — restores the `new Resource(...)` constructor that trodo-node 2.4.1 expects. Returning an object from a constructor is legal JS — the engine uses the returned value instead of `this`:

```js
const resMod = globalThis.require('@opentelemetry/resources');
if (typeof resMod.Resource !== 'function' && typeof resMod.resourceFromAttributes === 'function') {
  class ResourceShim {
    constructor(attrs = {}) { return resMod.resourceFromAttributes(attrs); }
  }
  Object.defineProperty(resMod, 'Resource', {
    value: ResourceShim, writable: true, enumerable: true, configurable: true,
  });
}
```

**OpenAI instrumentation subclass** — re-runs `_updateMetricInstruments()` after the subclass field initializers blow away the parent's setup. The parent constructor populates the histogram fields, then the subclass's class-field declarations run (they execute *after* `super()` returns) and reset those fields to `undefined`; the next metric `.record()` call crashes:

```js
const oaiMod = globalThis.require('@opentelemetry/instrumentation-openai');
if (oaiMod.OpenAIInstrumentation && !oaiMod.OpenAIInstrumentation.__trodoPatched) {
  class Patched extends oaiMod.OpenAIInstrumentation {
    constructor(...args) { super(...args); this._updateMetricInstruments(); }
  }
  Patched.__trodoPatched = true;
  Object.defineProperty(oaiMod, 'OpenAIInstrumentation', {
    value: Patched, writable: true, enumerable: true, configurable: true,
  });
}
```

Both `Object.defineProperty` calls are required — TS-compiled module exports are read-only getters, so direct assignment (`mod.Resource = ResourceShim`) silently no-ops.
