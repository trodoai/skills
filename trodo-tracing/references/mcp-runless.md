# MCP server tracing — runless spans

> Use this pattern when you're building an MCP (Model Context Protocol) server that proxies tool calls. **Do not** use `wrapAgent` or `startRun`/`endRun` for MCP — see "Why not a run?" below.

## When to use this pattern

You're operating an MCP server. Third-party clients (Claude.ai, Cursor, Claude Desktop, ChatGPT custom connectors, the `trodomcp` stdio adapter) call your `tools/list` and `tools/call` over HTTP or stdio. Each request flows through your server but the user's prompt and the LLM's final answer **never reach you** — they live inside the client.

Don't reach for this pattern for chatbots, agent pipelines, or any server that owns the conversation. Use `wrapAgent` for those.

## Why not a run?

The MCP server sees:
- `initialize` — capability handshake.
- `tools/list` — return your catalog.
- `tools/call` — invoke a tool, return its result.

It does **not** see:
- The user's prompt.
- The LLM's reasoning.
- The LLM's final answer.

A Trodo Run wrapping a session would have empty `input` and `output`, no signal for clustering, and — critically — no clean session-end signal in either MCP transport, so Runs end up stuck in `running` forever unless you bolt on a sweeper.

The runless-span model fixes all of that: each `tools/call` is one self-contained row in `agent_spans`. No lifecycle to manage. The `Mcp-Session-Id` becomes a `conversation_id` field for grouping.

## The SDK helper — `track_mcp` / `trackMcp`

Both Python and Node SDKs (>= 2.3.0) ship a single function for this. **Use it; don't write the HTTP yourself.** It handles span_id minting, conversation_id auto-uuid, ISO timestamps, JSON serialisation, error path, and 64KB truncation.

### Python — `trodo-python >= 2.3.0`

```python
import time, trodo

trodo.init(site_id="<your_site_id>")

async def handle_tool_call(req, tool_name, arguments):
    t0 = time.perf_counter()
    try:
        result = await TOOLS[tool_name](arguments)
        trodo.track_mcp(
            tool=tool_name,
            distinct_id=req.user_email,                       # required
            session_id=req.headers.get("mcp-session-id"),     # auto-uuid'd if omitted
            input=arguments,
            output=result,
            duration_ms=int((time.perf_counter() - t0) * 1000),
            client_label=req.client_label,                    # 'anthropic' / 'cursor' / etc.
        )
        return result
    except Exception as e:
        trodo.track_mcp(
            tool=tool_name,
            distinct_id=req.user_email,
            session_id=req.headers.get("mcp-session-id"),
            input=arguments,
            error=str(e),
            duration_ms=int((time.perf_counter() - t0) * 1000),
        )
        raise
```

`track_mcp` returns the `span_id` if you want it for cross-system correlation; otherwise ignore it.

### Node — `trodo-node >= 2.3.0`

```typescript
import trodo from 'trodo-node';

trodo.init({ siteId: process.env.TRODO_SITE_ID! });

async function handleToolCall(req, toolName, args) {
  const t0 = Date.now();
  try {
    const result = await TOOLS[toolName](args);
    await trodo.trackMcp({
      tool: toolName,
      distinctId: req.userEmail,                          // required
      sessionId: req.headers['mcp-session-id'] as string, // auto-uuid'd if omitted
      input: args,
      output: result,
      durationMs: Date.now() - t0,
      clientLabel: req.clientLabel,                       // 'anthropic' / 'cursor' / etc.
    });
    return result;
  } catch (e) {
    await trodo.trackMcp({
      tool: toolName,
      distinctId: req.userEmail,
      sessionId: req.headers['mcp-session-id'] as string,
      input: args,
      error: String(e),
      durationMs: Date.now() - t0,
    });
    throw e;
  }
}
```

## What auto-fills (so you don't have to think about it)

| Field | Default behaviour |
|---|---|
| `span_id` | Always auto-minted (UUID v4). Returned by the function so you can log it. |
| `session_id` / `conversation_id` | If you pass it, used. If not, fresh UUID per call (each call becomes its own grouping bucket). |
| `agent_name` | Hardcoded to `"MCP"`. Override via `agent_name=` (Python) / `agentName:` (Node) only for custom tags. |
| `kind` | Hardcoded to `"tool"`. |
| `name` | `f"tool.{tool}"` |
| `started_at` | `now() - duration_ms`. You only track wall-time. |
| `ended_at` | `now()` |
| `status` | `"error"` if `error=` set, else `"ok"`. |

You're responsible for: **tool name, who's the user, what went in, what came out, how long it took.** Everything else has a sane default.

## Output capture rules still apply

The same three rules from the main SKILL apply to runless spans:

1. **Await the full result before serialising** — never write a streaming handle into `output`. Consume the stream, then call `track_mcp`.
2. **Output is the FULL payload, not a metadata summary** — pass the entire ToolResult into `output`. The SDK truncates at 64KB if it's huge; never pre-slice.
3. **Use `attributes` for filterable scalars** — counts, status flags, the human summary string. Pass them via the `attributes={...}` / `attributes: {...}` kwarg.

## Dashboard query patterns

```sql
-- Top 20 tools by call count over 7 days, with users + sessions touching each.
SELECT
  name AS tool,
  COUNT(*)                            AS calls,
  COUNT(*) FILTER (WHERE status='error') AS errors,
  AVG(duration_ms)                    AS avg_ms,
  COUNT(DISTINCT distinct_id)         AS users,
  COUNT(DISTINCT conversation_id)     AS sessions
FROM agent_spans
WHERE team_id = $1
  AND agent_name = 'MCP'
  AND run_id IS NULL
  AND started_at > NOW() - INTERVAL '7 days'
GROUP BY name
ORDER BY calls DESC
LIMIT 20;

-- All tools used by a specific user.
SELECT started_at, name, status, duration_ms, conversation_id
FROM agent_spans
WHERE team_id = $1
  AND agent_name = 'MCP'
  AND distinct_id = 'alice@example.com'
ORDER BY started_at DESC
LIMIT 100;

-- Reconstruct what tools a single MCP session called.
SELECT started_at, name, status, duration_ms
FROM agent_spans
WHERE team_id = $1
  AND conversation_id = $2  -- Mcp-Session-Id from the client
ORDER BY started_at ASC;
```

There's also a ready-made aggregate endpoint: `GET /api/agentic/mcp/activity?team_id=X&window_days=7`.

## Pitfalls

| Pitfall | Symptom | Fix |
|---|---|---|
| Used `wrapAgent` / `startRun` for the MCP path | Run rows stuck in `running`, empty input/output, no signal in clustering | Switch to `track_mcp` / `trackMcp` (this doc). |
| Forgot `distinct_id` / `distinctId` | The SDK throws ValueError / Error before posting | Always populate it — user email if the token has one (OAuth introspection), else user_id, else a stable client identifier. |
| Wrote raw HTTP instead of using the SDK helper | More code, easier to drift from the wire format | Use `track_mcp` / `trackMcp`. The SDK pins the schema. Only fall back to raw HTTP if you can't take the SDK dependency. |
| Awaited the SDK call and felt latency | Each `track_mcp` adds ~50–200 ms of HTTP RTT to your MCP response | If latency matters, fire-and-forget: `asyncio.create_task(asyncio.to_thread(trodo.track_mcp, ...))` (Python) / `trodo.trackMcp({...})` without `await` (Node — the promise still resolves in background, span lands a beat later). |
| Not echoing `Mcp-Session-Id` between processes | Spans land but `conversation_id` differs across the same MCP session | The MCP server must mint the session id on `initialize`, return it in the `Mcp-Session-Id` response header, and the client must echo it back. The `trodomcp` stdio adapter does this since v1.1.0. |

## Raw HTTP fallback

If you can't take the SDK dependency, the equivalent direct call is:

```http
POST https://sdkapi.trodo.ai/api/sdk/spans/append
Content-Type: application/json
X-Trodo-Site-Id: <site_id>

{
  "spans": [{
    "span_id": "<uuid>",
    "kind": "tool",
    "name": "tool.<tool_name>",
    "status": "ok",                          // or "error"
    "input":  "<json string of {tool, params}>",
    "output": "<json string of full result>",
    "tool_name": "<tool_name>",
    "started_at": "<ISO 8601>",
    "ended_at":   "<ISO 8601>",
    "duration_ms": 120,
    "agent_name":      "MCP",                // category
    "distinct_id":     "alice@example.com",  // REQUIRED
    "conversation_id": "<Mcp-Session-Id>",   // optional but recommended
    "attributes": { "mcp_client_label": "anthropic" }
  }]
}
```

Use the SDK if you can. The HTTP shape is the same; the SDK just fills in the fiddly bits.

## Related

- For genuine multi-request runs that the server *does* own end-to-end (websocket-pinned chats, scheduled jobs that resume on different workers): see [`long-session.md`](./long-session.md). That pattern is correct for those — just **not** for MCP.
- For the canonical single-process agent pattern: see the main SKILL §2 (Framework / provider auto-instrument).
