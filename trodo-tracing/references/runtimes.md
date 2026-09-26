# Runtimes — where `init` goes, where the run starts, how it flushes

Targets `trodo-node` / `trodo-python` ≥ 2.23. Pair with `run-model.md` §9.

`init` is called **once per process**, before any provider client is constructed:

```ts
import trodo from 'trodo-node';
trodo.init({ siteId: process.env.TRODO_SITE_ID! });   // then import/construct OpenAI etc.
```
```python
import os, trodo
trodo.init(site_id=os.environ["TRODO_SITE_ID"])        # then `from openai import OpenAI`
```

`TRODO_SITE_ID` is server-side only — never `NEXT_PUBLIC_` / `VITE_` / `PUBLIC_`. Guard tests: `if os.environ.get("TRODO_SITE_ID") and not os.environ.get("TRODO_DISABLED"): trodo.init(...)`, or leave `init` in the app entry that tests never import.

A **shared provider client constructed at module top level** (`export const openai = new OpenAI()` in `lib/llm.ts`, imported by the entry file) is the most common reason LLM spans are missing: the module graph evaluates `lib/llm.ts` before the line that calls `init()`. Fix by putting `init()` in its own module imported **first**, or by making the client lazy.

---

## Long-running HTTP servers

| Runtime | `init` | Run start | Notes |
|---|---|---|---|
| **Express / Koa / Fastify / Hono / NestJS** | first line of the entry file (or a `tracing.ts` imported first; NestJS: top of `main.ts` before `NestFactory.create`) | `wrapAgent` inside the route handler / controller method / service method the handler awaits | For SSE, keep the wrap open until the stream ends (§ Streaming below). `expressMiddleware()` is **only** for joining an inbound `X-Trodo-Run-Id` from another service — it never starts a run. |
| **Next.js (App Router)** | `instrumentation.ts` → `register()`; only `await import('./lib/trodo-node-init')` inside `if (process.env.NEXT_RUNTIME === 'nodejs')` — never a top-level `import trodo` (Edge bundling) | `wrapAgent` inside the route handler / server action | Edge runtime routes cannot use the SDK — move to Node runtime or use `trackLlmCall`. With `@vercel/otel` already present see `dual-export.md`. |
| **Next.js (Pages API)** | same `instrumentation.ts` | inside the handler | |
| **Remix / SvelteKit / Nuxt / Astro (Node adapter)** | server entry / `hooks.server.ts` / a Nitro plugin, before providers | inside the loader/action/endpoint | |
| **FastAPI / Starlette** | top of `main.py` before `from openai import …`; or a `lifespan` startup if the client is lazy | `with trodo.wrap_agent(...)` inside the path operation, or on the service function it awaits | `BackgroundTasks` run **after** the response — see Detached work. `fastapi_middleware()` is only for joining inbound runs. |
| **Flask** | top of the app module | inside the view | `@copy_current_request_context` threads do not carry contextvars — pass `current_run_id()` and `join_run` |
| **Django** | `settings.py` bottom or `wsgi.py`/`asgi.py` before app import | inside the view / DRF action | Celery tasks are separate processes — see Queues |
| **Websocket servers** (`ws`, Socket.IO, FastAPI websockets) | process start | **one run per inbound message that produces a reply** (`wrapAgent` in the message handler), `conversationId` = the connection's thread id. Use `startRun`/`endRun` only when a *single reply* is assembled across several frames. | Never one run per connection. |
| **Slack / Discord / Telegram bots** (Bolt, discord.js, python-telegram-bot) | process start | one run per event that triggers the agent; `distinctId` = platform user id (mapped to the app user if known); `conversationId` = `thread_ts` / channel+thread / chat id; metadata `channel: 'slack'` | Bolt `ack()` early, keep the wrap around the work |

### Streaming to the client inside a handler

The wrap must not resolve before the full text exists. Three working shapes:

```ts
// A — buffer, then respond (simplest)
const { result } = await trodo.wrapAgent('support_chat', async (run) => {
  run.setInput(messages);
  const text = await streamAndCollect(messages);   // consume fully
  run.setOutput(text);
  return text;
}, opts);
res.json({ reply: result });

// B — stream to the client while the run stays open (Express SSE / raw)
await trodo.wrapAgent('support_chat', async (run) => {
  run.setInput(messages);
  let full = '';
  for await (const delta of stream) { full += delta; res.write(`data: ${JSON.stringify(delta)}\n\n`); }
  res.end();
  run.setOutput(full);          // after the loop, once
  return full;
}, opts);

// C — the route must return a Response object before the stream ends (Next.js / Vercel AI)
export async function POST(req: Request) {
  const runId = await trodo.startRun('support_chat', { distinctId, conversationId, input: messages });
  const result = streamText({
    model, messages,
    onFinish: async ({ text }) => { await trodo.endRun(runId, { output: text }); },
    onError: async ({ error }) => { await trodo.endRun(runId, { status: 'error', errorSummary: String(error) }); },
  });
  return result.toUIMessageStreamResponse();   // returns immediately; the run closes in onFinish
}
```

`streamText` / `generateText` calls made inside a `startRun` route are still captured by the AI SDK integration; join them to the run with `trodo.joinRun(runId, null, () => streamText(...), { name: 'turn' })` if they land outside it on your first debug run.

---

## Serverless

| Platform | `init` | Flush |
|---|---|---|
| AWS Lambda (Node / Python) | module scope (cold start) | `await trodo.flush()` (Node) / `trodo.flush()` (Python) as the last line before `return`. The wrap itself must be awaited. |
| Vercel Functions / Next.js route on Vercel | as Next.js above | `after(() => trodo.flush())` from `next/server`, or `waitUntil` from `@vercel/functions`; otherwise flush before returning |
| Cloud Run (request-scoped concurrency) / Cloud Functions / Azure Functions | module scope | flush before returning; Cloud Run services with `min-instances` behave like servers |
| Edge runtimes (Vercel Edge, Cloudflare Workers, Deno Deploy) | the Node SDK does not run there | use the OTLP path (`dual-export.md` §B) or `trackLlmCall` via `fetch` — say so plainly |

Fire-and-forget (`wrapAgent(...).then(...)` without `await`, `void trodo.flush()`) loses runs on every platform that freezes after the response.

---

## Queues, jobs, workers

The consumer is the trigger: **one run per job** in the worker, linked to the run that enqueued it.

```ts
// producer, inside the chat turn's run
await queue.add('investigate_issue', {
  reason, trodo: { parentRunId: trodo.currentRunId(), conversationId, distinctId },
});

// consumer (BullMQ / SQS / pg-boss / custom poller)
new Worker('investigate_issue', (job) =>
  trodo.wrapAgent('issue_investigator', async (run) => {
    run.setInput(job.data);
    const result = await investigate(job.data);
    run.setOutput(result);
    return result;
  }, {
    parentRunId: job.data.trodo?.parentRunId,
    conversationId: job.data.trodo?.conversationId,
    distinctId: job.data.trodo?.distinctId,
    metadata: { channel: 'queue', job_id: job.id, attempt: job.attemptsMade + 1 },
  }));
```
```python
# Celery / RQ / Dramatiq / arq — same shape; init at worker start (Celery: worker_process_init signal)
@celery.task(bind=True)
def triage_ticket(self, payload):
    t = payload.get("trodo", {})
    with trodo.wrap_agent("ticket_triage", distinct_id=t.get("distinct_id"),
                          conversation_id=t.get("conversation_id"),
                          parent_run_id=t.get("parent_run_id"),
                          metadata={"channel": "queue", "attempt": self.request.retries + 1}) as run:
        run.set_input(payload)
        result = triage(payload)
        run.set_output(result)
        return result
```

Retries: each attempt is its own run (same `parentRunId`, `metadata.attempt`), which is what the dashboard needs to show flakiness. Concurrency inside a job (`ThreadPoolExecutor`, `Promise.all`) nests automatically **only** for `Promise.all`/`asyncio.gather`; Python threads need `contextvars.copy_context().run(...)` or `join_run(current_run_id(), ...)` inside the thread.

---

## Cron, scheduled and one-shot processes

| Shape | Run |
|---|---|
| A scheduler process that fires `setInterval` / APScheduler / `node-cron` jobs in-process | `wrapAgent` inside the job function, one run per tick, `metadata.channel = 'cron'`. No `distinctId` → pass a stable service identity (`'scheduler'`) rather than nothing, or `TRODO_DEFAULT_DISTINCT_ID` if the team uses one. |
| A CLI / script run by an external scheduler (`scripts/digest.js`, `python -m app.scheduled.reindex`) | `init` at the top; `wrapAgent` per **item** if the script processes items independently (one ticket = one run), or one run for the whole script if it produces a single result; **`await` everything and `await trodo.shutdown()` before exit** |
| A script that processes N items with one model call each and nothing per item is meaningful on its own | one run named for the script, N `llm` spans |

---

## Detached work inside a request

`setImmediate`, `void doThing()`, `asyncio.create_task`, FastAPI `BackgroundTasks`, `threading.Thread`, Next.js `after()`:

- **Cheapest correct fix:** await it before the wrap returns (`await Promise.allSettled([...])`), when latency allows.
- **Keep the run, hand over context:** capture `const runId = trodo.currentRunId()` before detaching, then inside the task `await trodo.joinRun(runId, null, async () => { ... }, { name: 'notify_slack', kind: 'generic' })`. Python: `run_id = trodo.current_run_id()` then `with trodo.join_run(run_id, name="notify_slack", kind="generic")`. The run may already be closed when the span lands; the backend still attaches spans to a finished run.
- **It is really a separate job** (its own retry, its own failure semantics): make it a linked run with `parentRunId`.

Never let a detached LLM call run with no context — it is dropped silently.

---

## MCP servers

`trackMcp` / `track_mcp` per `tools/call`, `distinctId` = the authenticated MCP user, `sessionId` = `Mcp-Session-Id`. No `wrapAgent`, no `startRun`. Full recipe: `mcp-runless.md`. If the MCP server *also* calls a model inside a tool (an "ask the docs" tool), that LLM call needs a run to land in — wrap that tool body with `wrapAgent(toolName, ...)` and pass the same `distinctId`/`conversationId`; it is the one MCP case where a run is right.

---

## Existing OpenTelemetry in the process

See `dual-export.md`. Summary: register the user's provider first, then `trodo.init()` (its processor attaches to the existing provider). With `@vercel/otel` on Next.js you may skip the SDK and export OTLP to `https://sdkapi.trodo.ai/v1/traces` with `Authorization=Bearer <site id>` and `experimental_telemetry.metadata { userId, sessionId, agentName }` — but then a run is whatever the OTel trace is, so a handler with two model calls in separate traces shows as two runs. Prefer the SDK when the user wants `wrapAgent` boundaries.
