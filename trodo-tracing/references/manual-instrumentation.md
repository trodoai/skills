# Manual Instrumentation — Integration Notes

Targets `trodo-node` / `trodo-python` ≥ 2.23.

Docs: `https://docs.trodo.ai/observability/features/instrumentation/manual-spans`.

---

## When to reach for manual helpers

Prefer auto-instrumentation when it covers the provider (see [`auto-instrumentation.md`](./auto-instrumentation.md)). Use manual helpers for:

- Providers Trodo doesn't auto-instrument (self-hosted Ollama, vLLM, a partner inference API).
- Business logic you want visible as named spans (retrieval steps, custom tool calls not routed through the framework).
- Steps that aren't LLM calls but matter for debugging (cache lookup, validation, post-processing).

---

## The four helpers

> **These are wrapper factories, not inline executors.** `tool('x', fn)` does **not** call `fn`. It returns a **new callable** that, when invoked with the actual arguments, opens a span and runs `fn` inside it. You must call the returned callable to do any work and emit a span — assigning it to a variable and never calling it is a no-op (and a frequent bug: the wrapper logs as `[AsyncFunction (anonymous)]` if returned to a caller expecting the real result). For inline / one-shot use without a factory, prefer `trodo.withSpan(name, fn, { kind })` — see "Raw `withSpan`" below.

```ts
import { tool, llm, retrieval, trace } from 'trodo-node';

// These return callables — none of them runs the inner fn yet.
const search   = retrieval('vector-search', (q: string) => vectorDB.search(q, { topK: 5 }));
const lookup   = tool('lookup-order',       (id: string) => db.orders.findById(id));
const generate = llm('answer', callOllama,  { model: 'llama3.1:70b', provider: 'ollama' });
const format   = trace('format-output',     (raw: string) => raw.trim());

// Each call below executes the inner fn and emits one span.
const docs    = await search('how do refunds work?');
const order   = await lookup('order-123');
const answer  = await generate({ prompt: 'summarise these docs' });
const cleaned = format(answer.text);
```

Semantics identical in Python:

```python
from trodo import tool, llm, retrieval, trace

search   = retrieval("vector-search", lambda q: vector_db.search(q, top_k=5))
lookup   = tool("lookup-order", lambda oid: db.orders.find_by_id(oid))
generate = llm("answer", call_ollama, model="llama3.1:70b", provider="ollama")
format_  = trace("format-output", lambda raw: raw.strip())
```

Each wrapper returns a new callable that emits one span per invocation:

- Arguments → span input.
- Return value → span output.
- Thrown exception → `status = 'error'` + error type/message recorded.

---

## One input argument in TypeScript

The TS helpers pass a single value to the wrapped function. For multiple args, wrap them in an object:

```ts
// Wrong — fn receives only the first argument
const search = retrieval('search', async (query: string, topK: number) => { ... });

// Correct
const search = retrieval('search', async ({ query, topK }: { query: string; topK: number }) => {
  return vectorDB.search(query, { topK });
});

await search({ query: '...', topK: 5 });
```

Python wrappers preserve the full signature — no object-wrapping needed.

---

## Structure LLM-node input: the chat-message array

When you set the input of an **LLM-kind span** yourself (`setInput` / `set_input`, the `llm` helper, or `trackLlmCall`), pass the same messages you send to the model — a chat-message array, not one blob:

```ts
span.setInput([
  { role: 'system', content: systemPrompt },      // rules & role
  { role: 'context', content: retrievedDocs },    // RAG docs (Trodo extension)
  { role: 'user', content: 'Where is my order?' },
  { role: 'assistant', content: null, tool_calls: [/* … */] },
  { role: 'tool', content: '{"status":"shipped"}', tool_call_id: 'c1' },
  { role: 'user', content: 'When will it arrive?' },
]);
```
```python
span.set_input([
    {"role": "system", "content": system_prompt},
    {"role": "context", "content": retrieved_docs},
    {"role": "user", "content": user_question},
])
```

Roles: the standard `system` / `user` / `assistant` / `tool` plus `context` — a Trodo extension for RAG / retrieved documents. **Any order, any number per role.** `content` may be a string, an OpenAI-style content-parts array, or (for `context`) a list of doc strings/objects. Aliases `developer` / `model` / `function` normalise automatically.

Trodo embeds the input **as a whole and each role separately** (all `user` messages as one vector, all `system` as one, …), which powers LLM-node analysis and the grounding / hallucination detectors. Grounding source = `context` messages when present, else the `tool` + `assistant` messages.

**Do this when you can, don't force it.** If the input is a single prompt with no separable parts, pass the plain string — it's embedded as one vector and nothing is lost. Do NOT use the retired `{ system_instruction, context, query }` object — it is treated as one opaque blob (no per-role embeddings, grounding scores skip). Auto-instrumented provider spans (OpenAI/Anthropic/…) already carry the provider's message array and get per-role treatment automatically — this guidance is for spans whose input **you** set.

Docs: `https://docs.trodo.ai/observability/features/instrumentation/manual-spans`.

---

## Nesting is automatic — don't pass `runId`

Helpers nest under the currently active run via AsyncLocalStorage (Node) / contextvars (Python). When called from inside `wrapAgent`, they become children of the run automatically. Don't pass `runId` / `run` / `ctx` down — the helpers read it from context.

```ts
const myAgent = (input: string) =>
  wrapAgent('my-agent', async () => {
    const docs = await search(input);        // auto-nests under my-agent
    const order = await lookup('123');       // auto-nests
    const response = await generate(input);  // auto-nests
    return format(response.text);             // auto-nests
  });
```

If a helper is called **outside** any `wrapAgent`, it's a no-op — the span has no run to attach to and is dropped. This is usually unintentional.

---

## `wrapAgent` always starts a new run

From the source: `wrapAgent` opens a fresh run context. Calling `wrapAgent` inside another `wrapAgent` creates **two sibling runs**, not a parent-child span.

- Want a sub-step inside one run? Use `trace()` or `tool()`.
- Want a genuinely linked child run (showing up as a separate run in the dashboard but tracing back to the parent)? Use the `parentRunId` option on the inner `wrapAgent`.

---

## Error handling is automatic

A thrown exception inside `wrapAgent` / `withSpan` / `span` / `joinRun` sets `status = 'error'` on the failing span (and the run) and is re-thrown — you do not need try/catch purely to mark the span as failed.

The capture is automatic:

| Field | Captured from the thrown error |
|---|---|
| `error_type` | exception class (e.g. `RateLimitError`, `TypeError`) |
| `error_message` | the message |
| `status_code` | `err.status` / `err.statusCode` / `err.response.status_code` / `err.code` — covers OpenAI, Anthropic, httpx/fetch/axios, stdlib |
| `stack_trace` | the stack / traceback |
| `level` | `error` (severity; Langfuse-style `debug`/`default`/`warning`/`error`) |

```ts
// No try/catch needed just for Trodo
const order = await lookup(orderId);
// If lookup throws, the span ends status='error' with type/message/status_code/stack.
```

You still need try/catch if you want to handle the error in your own code. To record an error **without** re-throwing (you caught it to recover), use `span.setError({ message, type?, statusCode? })` (Node) / `span.set_error(message, type=, status_code=)` (Python). Run-level: `run.setErrorSummary(summary)` / `run.set_error_summary(summary)`.

Full reference: [`https://docs.trodo.ai/observability/features/status-and-errors`](https://docs.trodo.ai/observability/features/status-and-errors).

---

## `trackLlmCall` — the imperative alternative

When you already have the response object and just want to record it without wrapping the call site:

```ts
const resp = await fetch(LLM_URL, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());

await trodo.trackLlmCall({
  model: resp.model,
  provider: 'ollama',
  inputTokens: resp.prompt_eval_count,
  outputTokens: resp.eval_count,
  prompt: body,
  completion: resp,
});
```

No-op outside an active run context (same as the helpers). Use for single LLM calls where wrapping the call site is awkward.

---

## `llm()` auto-extracts tokens

`llm()` inspects the return value and pulls tokens from the standard shapes:

- OpenAI / OpenAI-compat: `response.usage.prompt_tokens`, `response.usage.completion_tokens`.
- Anthropic: `response.usage.input_tokens`, `response.usage.output_tokens`.
- Gemini: `response.usageMetadata.promptTokenCount`, `response.usageMetadata.candidatesTokenCount`.

If the shape is different, pass `extractUsage`:

```ts
const generate = llm('answer', callSomething, {
  model: 'something',
  provider: 'self-hosted',
  extractUsage: (r: any) => ({ inputTokens: r.in_toks, outputTokens: r.out_toks }),
});
```

---

## Custom cost

If the model isn't in Trodo's pricing table (self-hosted, negotiated rate, zero-cost), pass `cost` explicitly via `trackLlmCall`:

```ts
await trodo.trackLlmCall({
  model: 'llama3.1:70b',
  provider: 'ollama-self-hosted',
  inputTokens: 1200,
  outputTokens: 320,
  cost: 0,   // self-hosted, don't bill
});
```

The helper-wrapped form (`llm()`) doesn't take a cost override — for custom pricing, go through `trackLlmCall` or set the attribute manually via `withSpan`.

---

## Span names

Whatever string you pass becomes the span name verbatim — no automatic prefix. If you want `tool.lookup-order` as the span name, pass `'tool.lookup-order'`.

---

## Raw `withSpan` — when to use it

For attributes the typed helpers don't expose, or when you need explicit control over span lifecycle:

```ts
await trodo.withSpan('chat.completions', async (span) => {
  span.setLlm({ model: 'gpt-4o-mini', provider: 'openai', inputTokens: 120, outputTokens: 64 });
  span.setInput({ prompt: '...' });
  span.setAttribute('trodo.customer_tier', 'enterprise');
  const result = await openai.chat.completions.create({ ... });
  span.setOutput(result);
  return result;
}, { kind: 'llm' });
```

`withSpan` ends the span automatically when the callback returns or throws. Prefer it over raw OTel `tracer.startActiveSpan` — the latter requires manual `span.end()` in all code paths, which is easy to forget in error branches.

---

## Span output vs span attributes — the split

This rule turns up in every multi-stage agent and is easy to get wrong. The trace is only useful if `setOutput` carries the **full payload** of what the step actually produced; the small filterable bits go into `setAttribute`.

```ts
// Example: orchestrator stage that calls multiple downstream tools.
await trodo.withSpan('orchestrator', async (span) => {
  span.setInput({ tools: phase1Tools });
  const r = await runPhase1({ ... });   // r = { results: [...], summary: { ... } }

  span.setOutput(r);                                          // ✅ full results[] preserved
  span.setAttribute('result_count', r.results.length);
  span.setAttribute('ok_count',  r.results.filter(x => x.status === 'ok').length);
  span.setAttribute('error_count', r.results.filter(x => x.status !== 'ok').length);
  if (r.summary?.summary) span.setAttribute('summary', String(r.summary.summary));

  return r;
});
```

```python
# Tool span pattern. The tool envelope carries both:
#   data : small LLM-bound summary (used downstream by the model)
#   raw  : full structured payload (intended for observability)
# Persist `raw` as span output and mirror data.summary into an attribute.
with trodo.join_run(run_id, parent_span_id, name=tool_name, kind="tool") as span:
    span.set_input({"tool": tool_name, "params": merged})
    result = await run_tool(tool_name, merged)

    raw  = result.get("raw")
    data = result.get("data")
    output = {"status": result.get("status"), "data": raw if raw is not None else data}

    if isinstance(data, dict) and isinstance(data.get("summary"), str):
        span.set_attribute("summary", data["summary"])
    span.set_output(output)
```

What goes where:

| Method | Use for |
|---|---|
| `setInput` / `set_input` | The arguments / params / question that triggered this step |
| `setOutput` / `set_output` | The **complete** structured result the step produced (raw rows, full plan, full reply) |
| `setAttribute` / `set_attribute` | Counts, status flags, scores, IDs, the LLM-bound summary string — anything you'd filter on in the dashboard |
| `setMetadata` / `set_metadata` (run-level only) | Run-wide context: `customer_tier`, `environment`, deploy version, feature flags |

Anti-patterns to avoid:

- `setOutput({ summary: r.summary })` — drops `r.results`. Use `setOutput(r)` and put the summary in an attribute instead.
- `setOutput(r.text.slice(0, 500))` — there's no reason to pre-truncate. SDK caps at 1 MB on its own.
- Passing pre-shrunk `data` (the LLM-bound copy) to `setOutput` when the tool also has a `raw` field. Prefer `raw` for observability; `data` is for the prompt.
- Putting structured payloads in `setAttribute`. Attributes are flat; objects get stringified and become hard to search. Keep attributes scalar.
