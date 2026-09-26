# Trodo Skills — agent tracing

One Agent Skill that teaches AI coding assistants (Claude Code, Cursor, Windsurf, …) how
to instrument AI agents with [Trodo](https://trodo.ai) using `trodo-node` and
`trodo-python` (≥ 2.23) — and how to audit an integration that already exists.

## Install

```bash
npx skills add trodoai/skills
```

## Use

```text
"install trodo tracing, my site id is XXXX"          → trodo-tracing
"trace my LangChain / Vercel AI / OpenAI agents"     → trodo-tracing
"trace my MCP server"                                → trodo-tracing
"add trodo alongside my Datadog OTel"                → trodo-tracing
"audit my trodo tracing, find the gaps"              → trodo-tracing (audit mode)
"my runs show error but no error message"            → trodo-tracing (audit mode)
"one request shows up as five runs"                  → trodo-tracing (audit mode)
```

`/trodo-tracing` works as a direct slash invocation. The prompt
the Trodo app hands out is:

```text
Install the Trodo agent-tracing skill from github.com/trodoai/skills
(npx skills add trodoai/skills), then follow it to add tracing to every agent
in this project. My Trodo site ID is <your-site-id>. Map all agent entry points and
show me the run plan before writing code.
```

## The skill

[`trodo-tracing/SKILL.md`](./trodo-tracing/SKILL.md) is the procedure: map the stack →
decide the trace shape per entry point → show the plan once → execute → verify the
emitted trace against the plan. The substance lives in the references:

| Reference | Owns |
|---|---|
| [`references/run-model.md`](./trodo-tracing/references/run-model.md) | **The run model**: run / span / turn / conversation / linked run; the eight-question boundary rule; input/output contract; identity resolution; conversation source; required metadata; failures; flushing |
| [`references/stack-map.md`](./trodo-tracing/references/stack-map.md) | Discovering services, runtimes, process kinds, frameworks, every entry point (incl. multiplexed routes), identity and thread-id sources |
| [`references/frameworks.md`](./trodo-tracing/references/frameworks.md) | What each provider / agent framework auto-captures (OpenAI, Anthropic, Gemini, Bedrock, LangChain/LangGraph, Vercel AI, OpenAI Agents SDK, Pydantic AI, CrewAI, ADK, Mastra, Claude Agent SDK, gateways) |
| [`references/runtimes.md`](./trodo-tracing/references/runtimes.md) | Init and flush per runtime: Express/Next/FastAPI/Django/Flask/bots, serverless, queues, cron/CLI, detached work, websockets |
| [`references/auto-instrumentation.md`](./trodo-tracing/references/auto-instrumentation.md) | Instrumentor packages, ordering, `disableInstrumentations`, confirming with `debug` |
| [`references/manual-instrumentation.md`](./trodo-tracing/references/manual-instrumentation.md) | Tool dispatch loops, `withSpan`, factories, `setLlm`, output vs attributes |
| [`references/audit.md`](./trodo-tracing/references/audit.md) | Auditing an existing integration: invariants, inventory, gap catalog, gap report, fix discipline |
| [`streaming.md`](./trodo-tracing/references/streaming.md) · [`long-session.md`](./trodo-tracing/references/long-session.md) · [`cross-service.md`](./trodo-tracing/references/cross-service.md) · [`mcp-runless.md`](./trodo-tracing/references/mcp-runless.md) · [`vercel-ai-sdk.md`](./trodo-tracing/references/vercel-ai-sdk.md) · [`dual-export.md`](./trodo-tracing/references/dual-export.md) | Streaming, one turn/job across requests, propagation, MCP, Vercel AI SDK versions, existing OTel |

Already instrumented? The same procedure runs in **audit mode**
([`references/audit.md`](./trodo-tracing/references/audit.md)): inventory what exists,
draw the trees the code should produce, report the gaps that make the dashboard lie —
dark entry points, one request split into many runs, several agents merged into one,
green failures, error-with-no-message, empty output, anonymous users — and fix only
what is approved.

## Tests

[`tests/`](./tests) holds offline sandbox apps (Node monolith, Python multi-process,
Next.js + AI SDK) with a mock OpenAI server, a mock Trodo ingest, a drive script and a
checker that asserts the intended run model. Run the skill against a sandbox with a
fresh agent, then drive and check. See [`tests/README.md`](./tests/README.md).

## Versioning

`3.0.0`: one skill, agent tracing only. Rebuilt around `references/run-model.md`;
SDK floor 2.23; events, orchestrator and separate heal skills removed (audit folded in).

## Feedback

Wrong guidance or a missing scenario → open an issue at
[trodoai/skills/issues](https://github.com/trodoai/skills/issues). Product issues with
Trodo itself belong in the [Trodo support channels](https://trodo.ai).
