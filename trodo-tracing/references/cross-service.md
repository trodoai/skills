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

## Gotchas

- **Missing `runId`.** `joinRun(undefined, fn)` / `join_run(None, fn)` is a silent no-op. Log or assert the value before passing it across a boundary.
- **`init()` must run in the callee process too.** Each process has its own SDK state; a subprocess can't inherit the parent's init.
- **Header casing.** `X-Trodo-Run-Id` vs lowercase — the middleware normalises, but if you're rolling your own header extraction, check both.
- **Sub-agent as a separate run.** If you want the downstream service to appear as its own run linked to the parent (rather than nested inside it), skip the middleware and pass `parentRunId` to a fresh `wrapAgent` on the callee side instead.
