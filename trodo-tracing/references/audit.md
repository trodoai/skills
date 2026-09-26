# Auditing an existing integration

Use this when `trodo.init` / `wrapAgent` / `wrap_agent` / `startRun` / `trackMcp`
already exist in the codebase. The question changes from "how do I wire this" to
"is the trace a faithful picture of what the code does, and where does it lie". The
procedure in `SKILL.md` still applies — map the stack, draw the trees the code *should*
produce — but step 3 becomes a **gap report** and step 4 applies only approved fixes.

## What a healthy integration satisfies

1. **Every entry point is instrumented** — no run-producing path is dark.
2. **One run per external trigger** — not one per sub-agent, tool, iteration or model
   call; not one for several agents (multiplexed route, whole chat session).
3. **Every real step shows up**, correctly kinded — LLM, dispatched tool, retrieval,
   sub-agent — and nothing invented.
4. **Failures read as failures** — `status = error` *with* type and message.
5. **Input and output are the real payloads** — full, not blank, not a stream handle,
   not a summary.
6. **Runs are attributed** — a real `distinctId`, the same one on every surface;
   `conversationId` on every turn and on the linked runs it caused.
7. **The run shape matches the runtime** — `wrapAgent` in-process, `startRun`/`endRun`
   only for one turn/job spanning requests, `trackMcp` for MCP; nothing stuck `running`;
   no sibling runs from nested wraps; nothing double-counted.

## The ingest side is not the gap

Trodo's ingest persists every error field the client emits (`exception.type` /
`.message` / `.stacktrace`, `status.message`, `error.type`, HTTP and provider status
codes, level) and reads input/output from every common attribute convention. A span
that shows **error with no message** carried no message at the source; a **blank
input** was never set. Fix the recording, not the backend.

On the OTLP path (`@vercel/otel`, `registerOTel({ mode: 'otlp' })`, raw OTLP) split
each missing field into: *emitted?* (client config — this skill fixes it),
*emitted but not mapped?* (Trodo mapping — escalate), *mapped but priced wrong?*
(Trodo pricing — escalate). Only the first is a code change in the user's repo.

## Inventory

Grep and locate each; note file and whether it precedes provider imports:

| Signal | Means |
|---|---|
| `trodo.init(` | where init lives; is it before every provider client construction? |
| `wrapAgent(` / `wrap_agent(` / `@trodo.agent` | every run boundary — list all |
| `withSpan(` / `trodo.span(` / `tool(` / `llm(` / `retrieval(` / `trace(` | manual spans |
| `startRun` / `joinRun` / `endRun` | long-session primitives — is every `startRun` paired with a guaranteed `endRun`? |
| `trackMcp(` / `track_mcp(` | MCP runless spans |
| `registerOTel(` / `OTEL_EXPORTER_OTLP_ENDPOINT` / `instrumentation.ts` / `experimental_telemetry` | OTLP or Vercel path |
| SDK version in the lockfile | `< 2.23` is a gap on its own |

Cross-check against the entry points from `stack-map.md`: an entry point with no wrap
is the highest-severity gap.

## Gap catalog

Grouped by the invariant broken. Fixes point at the reference that has the recipe.

**Run shape** (`run-model.md` §2–3)
- `wrapAgent` reachable more than once from a single entry point's call graph
  (supervisor loop, `Promise.all` / `gather` over agents, per-tool wraps) → one request
  becomes N runs. Wrap once; sub-agents become `agent` spans.
- One `wrapAgent` named after a dispatcher around a `switch` on `type` / `kind` /
  `event` → unrelated agents share one name and success rate. One run per branch.
- A wrap whose lifetime is a whole chat session or websocket connection → one enormous
  run. One run per turn + `conversationId`.
- `wrapAgent` / `startRun` around an MCP `tools/call` → empty runs, rows stuck
  `running`. `trackMcp`.
- `startRun` with no guaranteed `endRun` → stuck `running`.
- Manual `agent` spans over framework-owned handoffs (LangGraph, LlamaIndex, Vercel AI
  steps) → duplicated layer.
- Queue consumer wrap with no `parentRunId` / `conversationId` / `distinctId` from the
  enqueuing run → orphaned `anon_*` job runs. Carry them in the payload (`runtimes.md`).
- Detached work (`setImmediate`, un-awaited promise, `create_task`, `BackgroundTasks`)
  doing LLM work after the wrap returned → spans lost. Await or `joinRun`.

**Missing spans** (`frameworks.md`, `auto-instrumentation.md`, `manual-instrumentation.md`)
- Provider client constructed before `init` → run with no LLM children.
- Instrumentor package not installed → same symptom; `debug: true` names it.
- Raw-provider `tool_calls` / `tool_use` dispatched with no `tool` span.
- Retrieval feeding the prompt with no `retrieval` span.
- Vercel AI v5/v6 call without `experimental_telemetry`; v7 with a second
  `registerTelemetry` (double) or `@ai-sdk/otel` alongside (double).
- Node + LangChain without `disableInstrumentations: ['openai']` → every model call
  twice. Python with the provider disabled → LLM span lost.
- Auto-instrumented call also wrapped in `trodo.llm` → double tokens and cost.

**Output / input** (`run-model.md` §4, `streaming.md`)
- No `setInput` on the run → blank input.
- Callback returns a `Response` / stream / `undefined` and never `setOutput` → output
  is `[object …]`, a partial stream, or blank.
- `setOutput` inside the `for await` loop → partial value.
- `setOutput({ summary })`, `{ status: 'ok' }`, `.slice(0, 500)` → the payload the
  dashboard exists to show is gone.
- OTLP path with `recordInputs` / `recordOutputs: false`, or a span processor stripping
  `ai.prompt` / `gen_ai.*` → tokens present, content blank.

**Failures** (`run-model.md` §8)
- `try/catch` that returns an error object without `setError` → green failure.
- `throw 'failed'` / `throw { code }` / a provider error re-wrapped without its
  `.message` / `.status` → red with no message or no status code.
- A span processor that strips span events → the `exception` event never leaves.

**Identity** (`run-model.md` §5–6)
- No `distinctId` → a new anonymous user per run.
- A different identifier on `wrapAgent` vs `trackMcp` vs `startRun` vs job payloads →
  one person split across profiles.
- Turns with no `conversationId` though a thread id is in scope.

**Config** (`runtimes.md`)
- `NEXT_PUBLIC_` / `VITE_` on the site id.
- One-shot script or serverless handler that does not await the wrap and flush.
- `registerOTel({ mode: 'otlp' })` expected to nest auto spans under `wrapAgent` (it
  cannot; each auto trace becomes its own run).

## The gap report

Rank most severe first, one row per finding:

```
| # | Severity | File:line | Invariant | Dashboard symptom | Proposed fix |
```

**high** = data wrong or absent (dark entry point, split/merged runs, green failure,
blank output, error with no message). **med** = incomplete (missing tool/retrieval
span, anonymous users, missing conversation). **low** = hygiene (double count, naming,
env prefix). Ask which to fix — all high, all, or a subset — and never change a run
boundary or an identity source without saying so first.

## Fix discipline

- The smallest change that restores the invariant: a one-line re-throw, a `setError`,
  a `parentRunId` in a payload — not a refactor.
- Add no span the audit did not tie to a real step; remove a user's span only when it
  is the cause (double-tracking, invented structure) and approved.
- Keep the app's recovery paths; record the failure with `setError` before them.

## Verify

Reproduce the failing path with `debug: true` (or via the Trodo MCP if connected) and
confirm the specific symptom is gone — the message present, the runs merged, the tool
span there — not just that code changed. Report what you saw.
