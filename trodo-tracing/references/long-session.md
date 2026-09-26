# One turn or one job spanning requests — `startRun` / `joinRun` / `endRun`

Targets `trodo-node` / `trodo-python` ≥ 2.23.

Docs: `https://docs.trodo.ai/observability/features/instrumentation/long-running-runs`.

> **Not for MCP servers** — use [`mcp-runless.md`](./mcp-runless.md).
> **Not for "a whole chat session"** — a session is many runs (one per turn) grouped by
> `conversationId`; see [`run-model.md`](./run-model.md) §1–2.

## When this is the right shape

`wrapAgent` opens and closes the run in one call stack. Use the split primitives only
when **one run's** beginning and end are genuinely in different call stacks:

1. **A job pre-empted and resumed on another worker** — start on worker A, spans from
   worker B, close from whoever finishes.
2. **Human-in-the-loop** — a LangGraph `interrupt()` or an approval step; the run
   pauses and resumes on a later request, still producing *one* reply.
3. **A single reply assembled across websocket frames** (rare). One inbound message
   that produces one reply is still `wrapAgent` in the message handler.

If the run fits inside one async function, use `wrapAgent`.

## The shape

```
process / request A         process / request B (later)        closer
startRun() → runId          joinRun(runId, …) → span           endRun(runId, { output })
persist runId               joinRun(runId, …) → span
```

The same `runId` threads through; the backend stitches the spans under one run.

> **Not for a streaming route.** A Next.js / Vercel AI route that returns the stream
> `Response` early keeps `wrapAgent` open instead (`vercel-ai-sdk.md` §Streaming).
> `startRun` does not activate the run context, so spans that rely on it — every
> auto-instrumented and AI SDK span — are dropped; only explicit `joinRun` spans land.

## Python — job resumed on another worker

```python
import os, redis, trodo
trodo.init(site_id=os.environ["TRODO_SITE_ID"])
r = redis.Redis()

def start_job(job_id, params, user_id):
    run_id = trodo.start_run("ingest_pipeline", distinct_id=user_id,
                             input=params, metadata={"job_id": job_id})
    r.set(f"job:run:{job_id}", run_id, ex=24 * 3600)

def resume_step(job_id):
    run_id = (r.get(f"job:run:{job_id}") or b"").decode()
    if not run_id:
        return
    with trodo.join_run(run_id, name="resumed_step", kind="agent") as span:
        result = do_one_step()
        span.set_output(result)

def finish_job(job_id, result, ok=True):
    run_id = (r.get(f"job:run:{job_id}") or b"").decode()
    if run_id:
        trodo.end_run(run_id, output=result, status="ok" if ok else "error")
        r.delete(f"job:run:{job_id}")
```

## API

| Call | Options |
|---|---|
| `startRun(name, opts)` / `start_run(name, …)` → `runId` | `runId` (supply your own), `distinctId`, `conversationId`, `parentRunId`, `metadata`, `input` |
| `joinRun(runId, parentSpanId \| null, fn, { name, kind })` / `join_run(run_id, parent_span_id=None, name=, kind=)` | opens one span on the run; `kind` defaults to `agent` — use `tool` / `generic` when the fragment is one |
| `endRun(runId, opts)` / `end_run(run_id, …)` | `output`, `status: 'ok' \| 'error'`, `errorSummary`, `metadata` |

## Pitfalls

| Pitfall | Fix |
|---|---|
| `startRun` with no guaranteed `endRun` → row stuck `running` | `try/finally`, `onFinish` + `onError`, or a TTL sweeper |
| `runId` not persisted / TTL shorter than the job | persist keyed by your job or session id; refresh the TTL on each touch |
| `joinRun(undefined, …)` | silent no-op — assert the id before crossing a boundary |
| Using this for every turn of a chat | one `wrapAgent` per turn + `conversationId`; this pattern is for a *single* turn that spans requests |
| Auto-instrumented / AI SDK spans missing on a `startRun` run | `startRun` does not activate context; run that work inside `joinRun(runId, …)`, or use `wrapAgent` if the run fits in one call stack |
