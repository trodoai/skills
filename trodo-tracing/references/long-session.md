# Long-lived sessions — `startRun` / `endRun`

> Requires `trodo-node >= 2.2.0` and `trodo-python >= 2.2.0`. Older SDKs do not expose these primitives — `wrapAgent` is the only public lifecycle, and it can't span multiple HTTP requests.

## When to use this pattern

Use `startRun` + `joinRun` + `endRun` when a single logical Run record needs to span **multiple HTTP requests** served by **potentially different worker processes** over **minutes or hours**. Three concrete cases:

1. **MCP servers.** One third-party MCP session (keyed by `Mcp-Session-Id`) makes many `tools/call` requests. You want one Run with all tool calls as child spans, not N disconnected Runs.
2. **Websocket-pinned chats.** Each user message is a separate handler invocation but logically the same conversation.
3. **Scheduled jobs that resume on a different worker.** A job opens a Run, gets pre-empted, resumes on a different machine.

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

## Node.js example — MCP server

```typescript
import trodo from 'trodo-node';
import { redis } from './redis.js';

trodo.init({ siteId: process.env.TRODO_SITE_ID! });

// Process A — MCP `initialize` handler.
async function handleInitialize(req: Request) {
  const sessionId = req.headers.get('mcp-session-id') ?? crypto.randomUUID();
  const runId = await trodo.startRun('external_mcp_session', {
    distinctId: req.userId,
    conversationId: sessionId,
    metadata: { mcp_client: req.clientLabel, mcp_plan: req.planType },
  });
  await redis.set(`mcp:run:${sessionId}`, runId, 'EX', 3600);
  return new Response(null, { headers: { 'Mcp-Session-Id': sessionId } });
}

// Process B — MCP `tools/call` handler. Possibly a different worker.
async function handleToolCall(req: Request, toolName: string, args: unknown) {
  const sessionId = req.headers.get('mcp-session-id')!;
  const runId = await redis.get(`mcp:run:${sessionId}`);
  if (!runId) return null; // session expired or never initialised

  return trodo.joinRun(runId, null, async (span) => {
    span.setInput({ tool: toolName, params: args });
    const result = await TOOLS[toolName](args);
    span.setOutput(result);  // ← FULL payload (Rule 2)
    if (result.summary) span.setAttribute('summary', String(result.summary));
    return result;
  }, { name: `tool.${toolName}`, kind: 'tool' });
}

// Process C — session-end sweeper (Redis TTL expiry, explicit close, etc).
async function closeMcpSession(sessionId: string, status: 'ok' | 'error' = 'ok') {
  const runId = await redis.get(`mcp:run:${sessionId}`);
  if (runId) {
    await trodo.endRun(runId, { status });
    await redis.del(`mcp:run:${sessionId}`);
  }
}
```

## Python example — MCP server

```python
import os, uuid, redis, trodo

trodo.init(site_id=os.environ["TRODO_SITE_ID"])
r = redis.Redis(...)

# Process A — MCP `initialize` handler.
def handle_initialize(req):
    session_id = req.headers.get("mcp-session-id") or str(uuid.uuid4())
    run_id = trodo.start_run(
        "external_mcp_session",
        distinct_id=str(req.user_id),
        conversation_id=session_id,
        metadata={"mcp_client": req.client_label, "mcp_plan": req.plan_type},
    )
    r.set(f"mcp:run:{session_id}", run_id, ex=3600)
    return {"headers": {"Mcp-Session-Id": session_id}}

# Process B — MCP `tools/call` handler.
async def handle_tool_call(req, tool_name, args):
    session_id = req.headers["mcp-session-id"]
    raw = r.get(f"mcp:run:{session_id}")
    if not raw:
        return None  # session expired
    run_id = raw.decode()

    with trodo.join_run(run_id, name=f"tool.{tool_name}", kind="tool") as span:
        span.set_input({"tool": tool_name, "params": args})
        result = await TOOLS[tool_name](args)
        span.set_output(result)  # ← FULL payload (Rule 2)
        if isinstance(result, dict) and isinstance(result.get("summary"), str):
            span.set_attribute("summary", result["summary"])
        return result

# Process C — sweeper.
def close_mcp_session(session_id, status="ok"):
    raw = r.get(f"mcp:run:{session_id}")
    if raw:
        trodo.end_run(raw.decode(), status=status)
        r.delete(f"mcp:run:{session_id}")
```

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
| Used `wrapAgent` for an MCP server / long session | Each tool call is its own disconnected Run; conversation impossible to reconstruct | Switch to `startRun` + `joinRun` + `endRun`. `wrapAgent` is a single-context-manager block; it can't bridge HTTP requests. |
| Passed `runId` to `joinRun` but the Run was never opened with `startRun` first | Spans appear orphaned in the dashboard with no parent Run record | `joinRun` only appends spans — it never creates the Run. You need `startRun` (or a `wrapAgent` from another process holding the run open) somewhere first. |
| TTL on stored `runId` shorter than the session | Mid-session `tools/call` finds no `runId` → spans dropped | Bump the TTL on every request that touches the session (`r.expire(...)`). Or pick a TTL longer than your worst-case session length. |
| Called `endRun` twice for the same `runId` | Second call updates the row again — usually harmless but wasteful | Make the close path idempotent at the Redis level (delete the key after `endRun` so re-entry finds no run). |
| SDK on `< 2.2.0` | `trodo.startRun is not a function` / `AttributeError: module 'trodo' has no attribute 'start_run'` | Bump to `trodo-node@^2.2.0` / `trodo-python>=2.2.0`. The legacy fallback is per-call `wrapAgent` runs threaded by `conversationId` — different `runId` per call but at least groupable in the dashboard. |

## Why not `wrapAgent`?

`wrapAgent` opens a Run and closes it in the same call stack — `__enter__` mints the `runId`, `__exit__` POSTs `/runs/ingest` with the run + all buffered spans in one request. That's efficient and correct for in-process agents but impossible to use across HTTP request boundaries: there's no way to "hold the wrapAgent open" while you wait for the next inbound request, and there's no way to pre-supply a `runId` to `wrapAgent`.

`startRun` + `endRun` decompose `wrapAgent`'s lifecycle into two independent calls so each phase can run in a different place.
