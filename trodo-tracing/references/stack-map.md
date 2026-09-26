# Stack Map — understand the codebase before touching it

The output of this step is a written table the user (or the summary) sees. If you
cannot fill every column for every entry point from memory, you have not finished.

---

## 1. Services

A repo may hold several independently-deployed services; each is instrumented on its
own (own `init`, own process lifetime). Find them, in this order, and stop at the
first signal that yields more than one:

1. **Workspace config** — `workspaces` in root `package.json`, `pnpm-workspace.yaml`,
   `turbo.json`, `uv.lock` workspaces / `[tool.uv.workspace]`, `pyproject` path deps.
   Keep only directories with their own manifest.
2. **Compose / deploy config** — `docker-compose*.yml`, `Dockerfile.*`, `Procfile`,
   `vercel.json` functions, `cloudbuild*.yaml`, `fly.toml`, `render.yaml`. Each build
   context or process line is a service.
3. **Scattered manifests** — `package.json` / `pyproject.toml` / `requirements.txt`
   ≤ 4 levels deep, excluding `node_modules`, `.venv`, `dist`, `build`, `.next`.

Drop services that never reach an LLM or agent framework (pure CRUD, static sites).
Only instrument services inside the current working directory.

## 2. Per service: language, runtime, process kind

| Signal | Read |
|---|---|
| Language | `.ts`/`.js`/`.mjs`/`.cjs` → Node; `.py` → Python; anything else → OTLP path (`references/dual-export.md` §B) — say so, do not install the SDK |
| Module system (Node) | `"type": "module"` or `.mjs` → ESM (raw provider SDKs need `node --import trodo-node/register`); otherwise CJS |
| Runtime | Next.js (`next.config.*`, `app/`), Express / Fastify / Hono / NestJS / Koa, FastAPI / Flask / Django / Starlette, Lambda handler signature, Cloud Run / Cloud Functions, Vercel Functions, Bun, Deno |
| Process kind | **long-running server** · **one-shot script / CLI / cron** · **queue worker** · **serverless function** · **test runner**. This decides init placement and flushing (`run-model.md` §9) |
| Package manager | lockfile → `npm` / `pnpm` / `yarn` / `bun` / `pip` / `poetry` / `uv` |

## 3. Providers and frameworks

Grep imports, not file names. One service commonly has several.

| Category | Grep | Note |
|---|---|---|
| Raw providers | `from 'openai'` / `import openai`, `@anthropic-ai/sdk` / `import anthropic`, `@google/genai`, `google.genai`, `@aws-sdk/client-bedrock-runtime` / `boto3` bedrock, `cohere`, `mistralai`, `@google-cloud/vertexai` | LLM calls auto-capture; **tool dispatch is yours to wrap** |
| Agent / orchestration frameworks | `from 'ai'` (Vercel AI SDK), `langchain*`, `langgraph`, `llamaindex` / `llama_index`, `haystack`, `@openai/agents` / `agents` (OpenAI Agents SDK), `crewai`, `autogen` / `ag2`, `pydantic_ai`, `agno`, `@mastra/core`, `google.adk`, `@anthropic-ai/claude-agent-sdk` / `claude_agent_sdk`, `semantic_kernel`, `dspy` | Coverage differs per framework — `references/frameworks.md` |
| Gateways / proxies | `baseURL`/`base_url` pointing at OpenRouter, LiteLLM, Vercel AI Gateway, Azure OpenAI, a self-hosted vLLM / Ollama | The provider SDK is still instrumented; model/provider attribution comes from the model name — check `references/frameworks.md` §Gateways |
| MCP | `@modelcontextprotocol/sdk`, `mcp` (Python), a `tools/call` JSON-RPC handler | Runless spans — `references/mcp-runless.md` |
| Existing OTel | `@opentelemetry/sdk-node`, `NodeTracerProvider`, `TracerProvider`, `OTLPTraceExporter`, `@vercel/otel`, `dd-trace`, `instrumentation.ts` | Coexistence — `references/dual-export.md` |
| Existing Trodo | `trodo.init`, `wrapAgent`, `wrap_agent`, `startRun`, `trackMcp`, `TRODO_SITE_ID` | Already installed → audit mode, `references/audit.md` |

## 4. Entry points — the rows of the table

An entry point is anything **externally triggered** that ends up running an LLM.
Sweep call sites first, then walk outward to the trigger:

| Looking for | Grep |
|---|---|
| LLM call sites | `chat.completions`, `responses.create`, `messages.create`, `generateText`, `streamText`, `generateObject`, `.invoke(`, `.ainvoke(`, `.stream(`, `.predict(`, `client.models.`, `converse(`, `invoke_model` |
| Tool dispatch | `tool_calls`, `tool_use`, `function_call`, a `switch`/dict mapping tool name → function, `TOOLS`, `tools = {` |
| Sub-agents / fan-out | `handoff`, `delegate`, `subagent`, `spawn`, `Promise.all(`, `asyncio.gather(`, `ThreadPoolExecutor`, a loop calling an agent per item, `round`, `iteration` |
| Detached work | `setImmediate`, `void somePromise`, `.then(` without `await`, `asyncio.create_task`, `BackgroundTasks`, `after(`, `waitUntil(`, `threading.Thread` |
| Enqueue / consume | `.add(`, `.enqueue(`, `publish(`, `send_task`, `delay(`, `apply_async`, `sqs.sendMessage`; consumers: `process(`, `Worker(`, `@app.task`, `@celery.task`, `consume`, `subscribe`, `poll` |
| Cron / schedule | `cron`, `schedule`, `setInterval`, `@repeat_every`, `node-cron`, `APScheduler`, a `scripts/` directory run by a scheduler |
| HTTP / websocket / event handlers | route decorators, `app.post(`, `router.`, `@app.post`, `on('message'`, Slack/Discord/Telegram event handlers, webhook receivers |
| Multiplexing | a handler that switches on `type` / `task_type` / `kind` / `event` / `command` / `action` and does different LLM work per branch |
| Retrieval | `embed`, `similarity`, `vector`, `pgvector`, `<=>`, `pinecone`, `qdrant`, `weaviate`, `.search(`, `retriever`, keyword scoring over docs |
| Identity | `req.user`, `session.user`, `auth()`, `getServerSession`, `current_user`, `request.state.user`, `x-user-id`, API-key lookups, job payload `user_id` |
| Thread id | `conversationId`, `threadId`, `sessionId`, `chatId`, `ticketId`, `thread_ts`, `channel`, in-memory history keyed by something |
| Answer boundary | where the final reply is produced and sent: `res.json`, `res.write` in SSE, `return {"reply"}`, `ws.send`, `say(`, `postMessage`, the value written to the DB as the result |

### The table

```
| Service | Entry point (file:line) | Trigger | Process kind | Agent name | One run = | Steps in order (real flow) | Auto-captured | Manual spans needed (kind) | Identity source | Thread id source | Answer boundary |
```

Rules:

- **Trigger** must be an external event. If two rows share a trigger they are one run (unless multiplexed — then one row per branch, each with its own agent name).
- **One run =** names the unit a user or scheduler triggered: "one chat turn", "one `investigate_issue` job", "one digest tick", "one ticket in the backfill".
- **Steps** is the *real* call flow including loops (`×N`), fan-out, detached work (`⤳`), enqueues (`→ queue`), remote calls (`→ svc`). Trace the graph; do not idealise.
- **Auto-captured** lists what will appear with no code: provider LLM calls (if init precedes client construction), framework tool spans where the framework owns dispatch.
- **Manual spans needed** lists only real, uncovered steps: dispatched tools, retrievals, sub-agents, meaningful stages. Empty is a fine and common answer.

## 5. Expected trace tree

For every row, draw the tree the code will produce. This is what the user approves and what you verify against afterwards.

```
run: support_chat                 (1 per POST /api/chat turn · conversationId=body.conversationId · distinctId=x-user-id)
  input: messages[] · output: final reply text
  ├─ retrieval: search_kb          (manual)
  ├─ llm: gpt-4o-mini              (auto)        ┐
  ├─ tool: lookup_order            (manual)      │ loop ×≤4
  ├─ llm: gpt-4o-mini              (auto)        ┘
  └─ tool: escalate → enqueues investigate_issue {runId, conversationId, distinctId}

run: issue_investigator           (1 per job · parentRunId=chat run · same conversationId/distinctId)
  ├─ generic: hydrate
  ├─ llm: planner                  (auto)
  ├─ agent: round_1  → llm, tool: fetch_logs
  ├─ agent: round_2  → llm, tool: query_metrics
  ├─ llm: adjudicate
  └─ generic: notify_slack ⤳ detached — awaited before wrap returns → llm
```

## 6. Large or unclear codebases

If the flow cannot be described without re-reading, keep reading. If the repo is
large, delegate the sweep to an explore agent with the grep table above and have it
return the filled table — never guess the rows.
