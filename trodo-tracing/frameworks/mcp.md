---
name: trodo-tracing-mcp
version: 2.0.0
sdk_version_node_track_mcp: ">=2.3.0"
sdk_version_python_track_mcp: ">=2.3.0"
last_updated: 2026-05-16
description: >-
  Add Trodo agent tracing to an MCP server (`@modelcontextprotocol/sdk` or
  `mcp` in Python). MCP servers record ONE RUNLESS span per `tools/call` —
  there is no parent run, no `wrapAgent`. Use `trackMcp` / `track_mcp` per
  tool invocation with the required `distinct_id`. Use when the codebase
  contains `@modelcontextprotocol/sdk` / `mcp` imports, exports `tools/list`
  + `tools/call` handlers, or runs as a stdio / SSE MCP server. The distinct
  id is non-skippable — never fall back to the MCP session id.
---

# Trodo Tracing — MCP Server (runless spans)

Focused recipe for MCP servers. MCP has no conversational run boundary — each `tools/call` is its own thing.

Full reference: [`../trodo-tracing/references/mcp-runless.md`](../trodo-tracing/references/mcp-runless.md).

## 6-phase loop

### DETECT
- `@modelcontextprotocol/sdk` (Node) or `mcp` (Python) imports.
- A `tools/list` + `tools/call` handler.
- stdio transport, SSE, or websocket runtime.

### UNDERSTAND
MCP is fundamentally **runless** in Trodo's data model:
- No agent owns the conversation (the client does).
- No `wrapAgent` — there is no agent function to wrap.
- Each `tools/call` is recorded as a single span with no parent run.

### ANALYZE
- Use `trodo.trackMcp({ distinctId, tool, input, output, durationMs })` (Node) or `trodo.track_mcp(distinct_id=..., tool=..., input=..., output=..., duration_ms=...)` (Python) inside the `tools/call` handler.
- `distinctId` is **required** and non-skippable. Never substitute the MCP session id — that's not a user.
- The id source must be supplied by the MCP client (header, query string, auth context). If the user can't tell you where it comes from, surface the question now.

### PLAN

```ts
import trodo from 'trodo-node';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

trodo.init({ siteId: process.env.TRODO_SITE_ID });

server.setRequestHandler(CallToolRequestSchema, async (req, ctx) => {
  const start = Date.now();
  const result = await runTool(req.params.name, req.params.arguments);
  await trodo.trackMcp({
    distinctId: ctx.extra?.userId ?? throwOnMissingId(),
    tool: req.params.name,
    input: req.params.arguments,
    output: result,
    durationMs: Date.now() - start,
  });
  return result;
});
```

```python
import trodo
trodo.init(site_id=os.environ["TRODO_SITE_ID"])

@server.call_tool()
async def call_tool(name, arguments, ctx):
    t0 = time.time()
    result = await run_tool(name, arguments)
    trodo.track_mcp(
      distinct_id=ctx.user_id,  # MUST be set; raise if not
      tool=name,
      input=arguments,
      output=result,
      duration_ms=int((time.time() - t0) * 1000),
    )
    return result
```

### CONFIRM
Surface:
- The `distinctId` source (delegated to `trodo-identify` — for MCP, ask explicitly where the id comes from).
- That every `tools/call` invokes `trackMcp` exactly once.
- No `wrapAgent`, no `startRun` — MCP is runless.

### EXECUTE
Apply diffs to the `tools/call` handler(s). Verify spans appear in the Trodo dashboard with the right `distinct_id` and tool name.

## Critical pitfalls

- **Falling back to the MCP session id.** That's an ephemeral connection id, not a user. Profiles will fragment.
- **Calling `wrapAgent` or `startRun` on the MCP server entry.** MCP has no run boundary; this creates malformed traces.
- **Forgetting `durationMs`.** Latency analytics break.
- **Streaming tool output.** Capture the *final* output for the span; don't push partial chunks.
