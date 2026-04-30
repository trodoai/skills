# Long-lived sessions — `startRun` / `endRun`

> Requires `trodo-node >= 2.2.0` and `trodo-python >= 2.2.0`. Older SDKs do not expose these primitives — `wrapAgent` is the only public lifecycle, and it can't span multiple HTTP requests.

> **NOT FOR MCP SERVERS.** If you're tracing an MCP server (third-party MCP session calling your `tools/call` endpoint), use [**runless spans**](./mcp-runless.md) instead. MCP servers proxy tool calls but never see the user's prompt or the LLM's final answer, so a Run carries no analytical value — and MCP has no clean session-end signal, so Runs created at `initialize` get stuck in `running` forever. The runless span pattern is purpose-built for MCP.

## When to use this pattern

Use `startRun` + `joinRun` + `endRun` when a single logical Run record needs to span **multiple HTTP requests** served by **potentially different worker processes** over **minutes or hours**, AND the server actually owns the prompt+answer. Two concrete cases:

1. **Websocket-pinned chats.** Each user message is a separate handler invocation but logically the same conversation, AND the server sees both the user's message and the LLM's reply.
2. **Scheduled jobs that resume on a different worker.** A job opens a Run, gets pre-empted, resumes on a different machine.

For MCP servers — see [`mcp-runless.md`](./mcp-runless.md). The previous version of this doc included an MCP example here; that guidance was removed because MCP fundamentally can't model the run lifecycle correctly.

If the run can be expressed inside one async function, **prefer `wrapAgent`** — it's one HTTP call to the backend instead of two and keeps the surface area smaller. Don't reach for `startRun`/`endRun` when `wrapAgent` would do.

## The shape

```
Process A                Process B (later, different worker)        Process C (sweeper)
─────────                ────────────────────────────────────        ────────────────────
startRun() → runId
  ↓
persist runId            joinRun(runId, ...) → child span
  somewhere                joinRun(runId, ...) → child span
  (Redis, DB,              joinRun(runId, ...) → child span
  request scope)            ...                                     endRun(runId)
```

Same `runId` threads through everything. Backend stitches the spans into one timeline under one Run record.

## Node.js example — websocket-pinned chat

```typescript
import trodo from 'trodo-node';
import { redis } from './redis.js';

trodo.init({ siteId: process.env.TRODO_SITE_ID! });

// On connection open: mint a run that the whole conversation will append to.
async function onConnect(ws, userId) {
  const runId = await trodo.startRun('chat', {
    distinctId: userId,
    conversationId: ws.conversationId,
  });
  await redis.set(`ws:run:${ws.id}`, runId, 'EX', 86400);
  ws.runId = runId;
}

// On each message: append a span (LLM call + any tool calls nested inside).
async function onMessage(ws, userMessage) {
  return trodo.joinRun(ws.runId, null, async (span) => {
    span.setInput({ message: userMessage });
    const reply = await callLLM(userMessage);
    span.setOutput({ reply });
    return reply;
  }, { name: 'chat.turn', kind: 'agent' });
}

// On disconnect / explicit close: finalise.
async function onClose(ws, reason) {
  if (ws.runId) {
    await trodo.endRun(ws.runId, { status: reason === 'normal' ? 'ok' : 'error' });
    await redis.del(`ws:run:${ws.id}`);
  }
}
```

## Python example — scheduled job that resumes on a different worker

```python
import os, uuid, redis, trodo

trodo.init(site_id=os.environ["TRODO_SITE_ID"])
r = redis.Redis(...)

# Worker A — start the job. May get pre-empted before finishing.
def start_job(job_id: str, params: dict) -> str:
    run_id = trodo.start_run(
        "ingest_pipeline",
        conversation_id=job_id,
        metadata={"params": params},
    )
    r.set(f"job:run:{job_id}", run_id, ex=24 * 3600)
    return run_id

# Worker B (later, possibly different machine) — resume by re-joining the run.
async def resume_job(job_id: str):
    raw = r.get(f"job:run:{job_id}")
    if not raw:
        return None  # job expired
    run_id = raw.decode()
    with trodo.join_run(run_id, name="resumed_step", kind="agent") as span:
        result = await do_one_step()
        span.set_output(result)
        return result

# Final worker — close the job.
def finish_job(job_id: str, status: str = "ok"):
    raw = r.get(f"job:run:{job_id}")
    if raw:
        trodo.end_run(raw.decode(), status=status)
        r.delete(f"job:run:{job_id}")
```

> **Earlier versions of this doc included MCP server examples here.** Those examples are intentionally removed — see the warning at the top of this file. For MCP, use [`mcp-runless.md`](./mcp-runless.md).

## API reference

### `startRun(agentName, opts)` / `start_run(agent_name, ...)`

Opens a Run record server-side with `status: "running"`. Returns the `runId`.

| Option | Notes |
|---|---|
| `agentName` (positional) | Required. Free-text identifier — e.g. `"external_mcp_session"`. |
| `runId` / `run_id` | Optional caller-supplied UUID. If omitted the SDK mints one. |
| `distinctId` / `distinct_id` | The end user — enables per-user filtering across the dashboard. |
| `conversationId` / `conversation_id` | Logical conversation key (e.g. `Mcp-Session-Id`). |
| `parentRunId` / `parent_run_id` | Marks this as a sub-agent under an existing run. |
| `metadata` | Free-form JSON tags. |
| `input` | Recorded as the run's input. Truncated at 64 KB. |

### `endRun(runId, opts)` / `end_run(run_id, ...)`

Finalises a Run opened by `startRun`. Aggregates any locally-buffered spans for the run, POSTs to `/runs/{id}/end`, unmarks the run as joined.

| Option | Notes |
|---|---|
| `runId` / `run_id` (positional) | Required. |
| `output` | Final payload. Truncated at 64 KB. |
| `status` | `"ok"` (default) or `"error"`. |
| `errorSummary` / `error_summary` | Human-readable error message. Set when `status="error"`. |
| `metadata` | Optional extra tags merged into the Run record. |

## Pitfalls

| Pitfall | Symptom | Fix |
|---|---|---|
| Forgot to persist `runId` between requests | `endRun` never called → run stuck in `"running"` forever | Persist `runId` in Redis / DB / request scope keyed by your session correlator (e.g. `Mcp-Session-Id`). Always pair `startRun` with a guaranteed `endRun` path (TTL sweeper if no explicit close exists). |
| Used `wrapAgent` for a websocket-pinned chat / scheduled job that resumes across workers | Each request is its own disconnected Run; conversation impossible to reconstruct | Switch to `startRun` + `joinRun` + `endRun`. `wrapAgent` is a single-context-manager block; it can't bridge HTTP requests. (For **MCP** specifically — use [`mcp-runless.md`](./mcp-runless.md), not this pattern.) |
| Passed `runId` to `joinRun` but the Run was never opened with `startRun` first | Spans appear orphaned in the dashboard with no parent Run record | `joinRun` only appends spans — it never creates the Run. You need `startRun` (or a `wrapAgent` from another process holding the run open) somewhere first. |
| TTL on stored `runId` shorter than the session | Mid-session `tools/call` finds no `runId` → spans dropped | Bump the TTL on every request that touches the session (`r.expire(...)`). Or pick a TTL longer than your worst-case session length. |
| Called `endRun` twice for the same `runId` | Second call updates the row again — usually harmless but wasteful | Make the close path idempotent at the Redis level (delete the key after `endRun` so re-entry finds no run). |
| SDK on `< 2.2.0` | `trodo.startRun is not a function` / `AttributeError: module 'trodo' has no attribute 'start_run'` | Bump to `trodo-node@^2.2.0` / `trodo-python>=2.2.0`. The legacy fallback is per-call `wrapAgent` runs threaded by `conversationId` — different `runId` per call but at least groupable in the dashboard. |

## Why not `wrapAgent`?

`wrapAgent` opens a Run and closes it in the same call stack — `__enter__` mints the `runId`, `__exit__` POSTs `/runs/ingest` with the run + all buffered spans in one request. That's efficient and correct for in-process agents but impossible to use across HTTP request boundaries: there's no way to "hold the wrapAgent open" while you wait for the next inbound request, and there's no way to pre-supply a `runId` to `wrapAgent`.

`startRun` + `endRun` decompose `wrapAgent`'s lifecycle into two independent calls so each phase can run in a different place.
