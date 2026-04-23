# Cross-service — Integration Notes

Targets `trodo-node` >= 2.1.0 and `trodo-python` >= 2.1.0.

Docs: `https://docs.trodo.ai/recipes/cross-service.md`, `https://docs.trodo.ai/agent-analytics/tracing/spans-external.md`.

---

## The problem

`wrapAgent` propagates the run context via AsyncLocalStorage (Node) or contextvars (Python). That covers `await`, imports, helper functions — anywhere the async chain reaches **inside one process**.

It does **not** cross process or network boundaries:

- HTTP request to another service.
- `worker_threads` / `ProcessPoolExecutor` / spawned child process.
- Background job picked up by a queue worker.

For those, propagate `runId` manually.

---

## HTTP boundary — automatic with middleware

Caller attaches the run headers; callee's middleware rehydrates the run.

### Caller (Node)

```ts
import trodo, { wrapAgent, propagationHeaders } from 'trodo-node';

trodo.init({ siteId: process.env.TRODO_SITE_ID! });

await wrapAgent('frontend-agent', async () => {
  const res = await fetch('https://worker.internal/summarize', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...propagationHeaders(),   // adds X-Trodo-Run-Id + X-Trodo-Parent-Span-Id
    },
    body: JSON.stringify({ doc }),
  });
  return res.json();
});
```

### Callee (Node / Express)

```ts
import express from 'express';
import trodo from 'trodo-node';

trodo.init({ siteId: process.env.TRODO_SITE_ID! });

const app = express();
app.use(trodo.expressMiddleware());   // auto-joins inbound runs

app.post('/summarize', async (req, res) => {
  // Everything inside this handler is captured under the caller's run,
  // nested below the caller's span.
  const summary = await summarizeWithLlm(req.body.doc);
  res.json({ summary });
});
```

### Callee (Python / FastAPI)

```python
import os, trodo
from fastapi import FastAPI

trodo.init(site_id=os.environ["TRODO_SITE_ID"])

app = FastAPI()
app.middleware("http")(trodo.fastapi_middleware())

@app.post("/summarize")
async def summarize(req: SummarizeRequest):
    summary = await summarize_with_llm(req.doc)
    return {"summary": summary}
```

### Caller (Python)

```python
import httpx, trodo

headers = trodo.propagation_headers()   # {"X-Trodo-Run-Id": "...", "X-Trodo-Parent-Span-Id": "..."}
r = httpx.post("https://worker.internal/summarize", headers=headers, json={"doc": doc})
```

---

## What happens when the header is missing

The middleware checks for `X-Trodo-Run-Id`. If absent, it passes through as a no-op — the handler runs normally but no spans are attached (no run context exists). It does **not** start a new run. This is by design: services called from non-traced callers shouldn't silently create orphan runs.

If you want inbound traffic without a header to still start a fresh run, wrap the handler body with `wrapAgent` explicitly.

---

## Worker threads / process pools — `joinRun`

Context doesn't survive `worker_threads` / `ProcessPoolExecutor` boundaries. Capture the `runId` in the parent, pass it in, call `joinRun` inside.

### Node

```ts
import trodo, { wrapAgent, currentRunId, joinRun } from 'trodo-node';
import { Worker } from 'worker_threads';

await wrapAgent('parent', async () => {
  const runId = currentRunId()!;                // capture
  const worker = new Worker('./worker.js', { workerData: { runId, doc } });
  await new Promise((r) => worker.on('exit', r));
});
```

```ts
// worker.js
import trodo, { joinRun, withSpan } from 'trodo-node';
import { workerData } from 'worker_threads';

trodo.init({ siteId: process.env.TRODO_SITE_ID! });

await joinRun(workerData.runId, async () => {
  await withSpan({ kind: 'tool', name: 'heavy-work' }, async (span) => {
    span.setInput(workerData.doc);
    // ...
  });
});
```

### Python

```python
import os, trodo
from concurrent.futures import ProcessPoolExecutor

def child(run_id: str, doc: str):
    trodo.init(site_id=os.environ["TRODO_SITE_ID"])
    with trodo.join_run(run_id):
        with trodo.span("heavy-work", kind="tool") as s:
            s.set_input(doc)
            # ...

with trodo.wrap_agent("parent") as run:
    run_id = trodo.current_run_id()
    with ProcessPoolExecutor() as pool:
        pool.submit(child, run_id, doc).result()
```

---

---

## Caller-owned vs callee-owned spans — which pattern to use

This is the most common source of duplicate spans. The answer depends on **who should own the semantic name** of the operation.

| Situation | Pattern |
|---|---|
| Caller makes a raw HTTP call and doesn't wrap it in `withSpan` | Use middleware on the callee — it creates one span named after the route (`http.POST./v1/plan`) and is the right owner |
| Caller wraps the HTTP call in `withSpan('planner')` to give it a business name | **Don't** add middleware on the callee — the caller's span is the owner. Middleware would create a second, duplicate span for the same operation |
| Caller creates a span for the overall operation but wants named child spans for sub-operations inside the callee (e.g. individual tools) | Use body-propagation — pass `run_id`/`parent_span_id` in the request body; callee calls `join_run` per sub-operation |

If both the caller `withSpan` and callee `fastapi_middleware`/`expressMiddleware` are active for the same HTTP call, you get duplicate spans: one with the business name you chose and one named `http.POST.<path>` — both appearing as children of the same parent. Remove one.

---

## Body-propagation — explicit `join_run` per sub-operation

Use this when the callee handler performs **multiple operations you want as individual named spans** (e.g. an orchestrator running N tool calls in parallel), and you don't want a single HTTP span wrapping them all.

The middleware approach creates one span per HTTP request. Body-propagation lets you create one span per tool/step inside the same request.

### Caller (Node — pass IDs in body)

```ts
import trodo, { wrapAgent, withSpan, propagationHeaders } from 'trodo-node';

await wrapAgent('chat', async () => {
  await withSpan('orchestrator', async () => {
    const { runId, parentSpanId } = propagationHeaders();
    // Pass them in the body — not just headers — so the callee can use them per tool
    const res = await fetch('https://orchestrator.internal/v1/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tools: [...],
        trodoRunId: runId,
        trodoParentSpanId: parentSpanId,
      }),
    });
    return res.json();
  });
});
```

`propagationHeaders()` returns `{ 'X-Trodo-Run-Id': '...', 'X-Trodo-Parent-Span-Id': '...' }`. Read the values from those keys to pass them in the body. Do **not** add the middleware to this callee — you want explicit per-operation spans, not one HTTP wrapper.

### Callee (Python — one `join_run` per sub-operation)

```python
from pydantic import BaseModel, Field

class RunRequest(BaseModel):
    tools: list
    trodo_run_id: str | None = Field(default=None, alias="trodoRunId")
    trodo_parent_span_id: str | None = Field(default=None, alias="trodoParentSpanId")

@app.post("/v1/run")
async def run(body: RunRequest):
    results = []
    for tool_name in body.tools:
        if body.trodo_run_id:
            with _trodo.join_run(body.trodo_run_id, body.trodo_parent_span_id,
                                  name=tool_name, kind="tool") as span:
                span.set_input({"tool": tool_name})
                result = await execute_tool(tool_name)
                span.set_output({"status": result["status"], "data": result.get("data")})
                results.append(result)
        else:
            results.append(await execute_tool(tool_name))
    return {"results": results}
```

Each tool call gets its own named child span under the caller's `orchestrator` span. The callee process has no middleware — there is no HTTP-level wrapper span.

---

## Marking spans as failed when no exception propagates

Context managers mark the span "ok" on clean exit and "failed" only if an exception propagates through the `with` block. If your code catches exceptions internally and returns error objects (common in resilient orchestrators), spans always appear "ok" even when tools fail.

Fix: re-raise a sentinel exception inside the `with` block when the result indicates failure, then catch it immediately outside to preserve the return value.

```python
class _SpanFailed(Exception):
    pass

async def run_one_tool(run_id, parent_id, name, params):
    _result = None
    try:
        with _trodo.join_run(run_id, parent_id, name=name, kind="tool") as span:
            span.set_input({"tool": name, "params": params})
            _result = await execute_tool(name, params)   # never raises — returns error dict
            status = _result.get("status", "?")
            output = {"status": status, "data": _result.get("data")}
            if status in ("error", "timeout"):
                output["error"] = _result.get("message", status)
            span.set_output(output)
            if status in ("error", "timeout"):
                raise _SpanFailed(output["error"])   # marks span as failed
    except _SpanFailed:
        pass   # span ended as failed; _result is set; continue normally
    return _result
```

The same principle applies in Node with `withSpan`:

```ts
let result: ToolResult | undefined;
try {
  await withSpan('my-tool', async (span) => {
    result = await runTool();   // never throws — returns { status, data }
    span.setOutput({ status: result.status, data: result.data });
    if (result.status === 'error') throw new Error(result.message);  // marks span failed
  });
} catch (e) {
  if (!result) throw e;  // unexpected error — re-throw
  // result is set; span is failed; continue
}
return result;
```

---

## Gotchas

- **Missing `runId`.** `joinRun(undefined, fn)` / `join_run(None, fn)` is a silent no-op. Log or assert the value before passing it across a boundary.
- **`init()` must run in the callee process too.** Each process has its own SDK state; a subprocess can't inherit the parent's init.
- **Header casing.** `X-Trodo-Run-Id` vs lowercase — the middleware normalises, but if you're rolling your own header extraction, check both.
- **Sub-agent as a separate run.** If you want the downstream service to appear as its own run linked to the parent (rather than nested inside it), skip the middleware and pass `parentRunId` to a fresh `wrapAgent` on the callee side instead.
- **CommonJS named exports (Node).** `require('trodo-node')` returns an object where named exports (`propagationHeaders`, `withSpan`, `joinRun`, `currentRunId`, `getActiveContext`) are at the top level of the module object, NOT on `.default`. When using a singleton pattern like `const trodo = require('trodo-node').default || require('trodo-node')`, you must explicitly attach named exports: `trodo.propagationHeaders = require('trodo-node').propagationHeaders`. Failing to do this causes `TypeError: trodo.propagationHeaders is not a function` at runtime.
