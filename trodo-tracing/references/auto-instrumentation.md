# Auto-instrumentation — Integration Notes

Targets `trodo-node` >= 2.1.0 and `trodo-python` >= 2.1.0. Pure-ESM Node fixes shipped in `trodo-node` 2.4.2.

Docs: `https://docs.trodo.ai/agent-analytics/tracing/overview.md`, `https://docs.trodo.ai/agent-analytics/integrations/`.

---

## The one-line version

When `trodo.init()` runs, Trodo registers OpenTelemetry instrumentors for every supported provider that's installed. **LLM calls** made inside a `wrapAgent` block become child spans automatically — you do not wrap them.

**Tool calls and retrievals are auto-captured ONLY when the framework owns the call site** — LangChain `Tool`, Vercel AI SDK `tools: {...}`, OpenAI Agents SDK, LlamaIndex query engines, Haystack pipelines. With the raw OpenAI / Anthropic / Gemini / Bedrock SDKs in function-calling mode, the provider returns a description of the call (`tool_calls[]`, `tool_use` blocks) and your code dispatches it — there is no library boundary to patch, so you must wrap the tool execution manually with `trodo.tool(name, fn)` or `trodo.withSpan(name, fn, { kind: 'tool' })`. See the per-provider table below.

Default is **on**. Opt out with `autoInstrument: false` (Node) or `auto_instrument=False` (Python).

---

## Providers covered

### Node (`trodo-node`)

| Package | LLM call | Tool calls | Notes |
|---|---|---|---|
| `openai` (raw) | yes | **manual** | Returns `tool_calls[]`; your code runs the tool. Wrap with `trodo.tool` / `trodo.withSpan({ kind: 'tool' })`. |
| `@anthropic-ai/sdk` (raw) | yes | **manual** | Returns `tool_use` blocks; same pattern as raw OpenAI. |
| `langchain` | yes | **auto** | LangChain `Tool` abstraction is patched. |
| `@aws-sdk/client-bedrock-runtime` | yes | **manual** when used in function-calling mode | Per-model-family token extraction. |
| `cohere-ai` | yes | **manual** | `chat`, `chatStream`, `generate`. |
| `@google/generative-ai` | yes | **manual** when used with function calling | `generateContent`, streaming. |
| `@google-cloud/vertexai` | yes | **manual** when used with function calling | Same as `@google/generative-ai`. |
| `llamaindex` | yes | **auto** for query-engine tool calls | Retriever calls also auto. |
| `ai` (Vercel AI SDK) | yes | **auto** for `tools: {...}` | **Requires** `experimental_telemetry: { isEnabled: true }` on every call — see [`vercel-ai-sdk.md`](./vercel-ai-sdk.md). |
| `@openai/agents` | yes | **auto** | Framework owns tool execution. |
| `http` / `fetch` | n/a (generic) | n/a | Outbound HTTP as generic spans. Useful for raw LLM endpoints. |

### Python (`trodo-python`)

| Package | LLM call | Tool calls | Notes |
|---|---|---|---|
| `openai` (v1 + v2, raw) | yes | **manual** | Function calling returns `tool_calls`; your code dispatches. |
| `anthropic` (raw) | yes | **manual** | `messages.create` returns `tool_use` blocks. |
| `langchain` / `langchain-core` | yes | **auto** | Chains, LLM invocations, tool calls all patched. |
| `llama_index` | yes | **auto** for query-engine + retriever |
| `google.generativeai` | yes | **manual** when using function calling |
| `vertexai` | yes | **manual** when using function calling |
| `boto3` (Bedrock) | yes | **manual** when using function calling | `invoke_model`, `invoke_model_with_response_stream`. |
| `cohere` | yes | **manual** | Chat, generate. |
| `mistralai` | yes | **manual** | Chat completions. |
| `haystack` | yes | **auto** | Pipeline runs (components captured). |
| `httpx` / `requests` | n/a (generic) | n/a | Outbound HTTP as generic spans. |

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

`trodo-node` depends on the OpenTelemetry packages but doesn't pin them tightly. Some upstream changes break the integration silently on older SDK versions. Use `trodo.init({ debug: true })` on 2.4.2+ to surface peer-dep load errors to stderr.

| Peer dep | Known-good range | Why |
|---|---|---|
| `@opentelemetry/api` | `^1.9.0` | stable |
| `@opentelemetry/sdk-node` | `^0.50.x` – `^0.52.x` | trodo-node 2.4.x is exercised against this range; >= 0.53 untested |
| `@opentelemetry/resources` | `^1.20.0` or `^2.x` | **trodo-node ≥ 2.4.2 feature-detects v1 vs v2** — pass either. **On 2.4.1 or earlier, pin to `^1.x`** — `new Resource(...)` throws against v2 and the error is swallowed. |
| `@opentelemetry/instrumentation` | `^0.52.x` | stable |
| `@opentelemetry/instrumentation-openai` | `≤ 0.14.x` | 0.15.0 has a TS-class-field bug that resets histogram fields after `super()`, crashing on the first metric `.record()`. This is upstream and **still applies on trodo-node 2.4.2** — pin until OTel-contrib fixes the field initialization order. |

Pin these in `package.json` when running the pure-ESM bootstrap (SKILL.md §2a). For Next.js / `@vercel/otel` projects, the Vercel adapter pins compatible versions itself — no action needed. For Path B (`registerOTel({ mode: 'otlp' })`), the SDK install hint covers the required peers; the version pins above still apply if you hit the same symptoms.

### What 2.4.2 fixes vs what's still upstream

| Issue | Pre-2.4.2 | trodo-node ≥ 2.4.2 |
|---|---|---|
| `require()` undefined in ESM build (B1) | needs `register.mjs` shim | **fixed internally** via `createRequire(__filename)` |
| `new Resource(...)` against resources@2.x (B4) | needs Resource shim or v1 pin | **fixed internally** via runtime feature-detect on `resourceFromAttributes` |
| `span_id` 16-hex vs UUID parent (D1) | causes 500 on `runs/ingest`, runs land with `SPANS=0` | **fixed internally** — OTel-native 16-hex padded to UUID |
| Silent peer-dep failures | empty `catch {}`; no logs | `trodo.init({ debug: true })` logs to stderr on 2.4.2+ |
| `instrumentation-openai@0.15.0` class-field bug (B3) | crashes on metric record | **upstream** — still pin to ≤ 0.14.x |
| `openai/_shims/registry.mjs` × IITM (B5) | `client.fetch === undefined` | **upstream** — still preload `openai/shims/node` if importing `openai` directly |

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
