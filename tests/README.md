# Skill test harness

Offline sandbox apps for testing `trodo-tracing` blind: a fresh agent gets only the
prompt the Trodo app hands out, instruments the app, and a checker grades the traces the
SDK actually emitted against the intended run model. Nothing here talks to the network:
each sandbox ships a mock OpenAI server and a mock Trodo ingest that logs every payload.

| Sandbox | Exercises |
|---|---|
| [`node-monolith/`](./node-monolith) | Express SSE chat with a raw-OpenAI tool loop, a route multiplexed on `type` (3 agents), an in-process job queue running an RLM-style investigator with rounds, tools and a detached `setImmediate` LLM call, a cron digest, a one-shot CLI backfill, an MCP tool server |
| [`python-multiagent/`](./python-multiagent) | FastAPI + LangChain RAG assistant with a hand-rolled tool loop, `/generate` multiplexed on `kind`, a separate worker process with a `ThreadPoolExecutor`, a one-shot reindex script, a client timeout error path |
| [`nextjs-ai-sdk/`](./nextjs-ai-sdk) | Next.js App Router + Vercel AI SDK v7: streaming `/api/chat` route with tools, a server action, a webhook doing LLM work in `after()`, an Edge route the SDK cannot run on |

## Running a test

1. Copy the skill in: `mkdir -p <sandbox>/.claude/skills && cp -R ../trodo-tracing <sandbox>/.claude/skills/`
   (`.claude/` is gitignored in each sandbox).
2. Start a **fresh** agent in the sandbox with the in-app prompt (site id `sandbox-site`)
   plus these facts: Trodo is self-hosted at `TRODO_API_BASE`; install the SDK from the
   local checkout (`npm install --install-links ../../../sdks/trodo-node-sdk` /
   `.venv/bin/pip install -e ../../../sdks/trodo-python-sdk`); `scripts/drive.sh`,
   `scripts/check*`, and `README.md` are the grader and off-limits; nobody will answer
   questions. Do not give it the intended run model.
3. `export TRODO_SITE_ID=sandbox-site TRODO_API_BASE=http://127.0.0.1:<ingest port>` and
   run `scripts/drive.sh`, then the checker. Each sandbox's README lists ports and
   commands.
4. Reset with `git checkout -- <sandbox> && git clean -fd <sandbox>` before the next run.

The checkers mirror the backend's turn extractor (last `user` message of a chat array)
and accept every SDK payload shape (`runs/ingest` trees, `runs/start` + `/spans` +
`/end`, runless `spans/append`). A failure means the trace is wrong, not that the payload
looked unfamiliar — if a checker rejects a trace the run model says is right, fix the
checker.

Results on skill 3.0.0 (2026-09-26, blind runs, graded by these checkers): all three
pass. The Next.js run surfaced three `trodo-node` bugs fixed in 2.23.4 — AI SDK v7
tool spans had no output, `ai` could not be loaded under ESM so v7 apps got no spans,
and `init({ disableInstrumentations })` was ignored — and showed that `startRun` +
`endRun` in `onFinish` drops AI SDK spans (the skill now keeps `wrapAgent` open).

Keep sandboxes un-instrumented in git: commit before a blind run, and reset with
`git checkout -- <sandbox> && git clean -fd <sandbox>` afterwards.
