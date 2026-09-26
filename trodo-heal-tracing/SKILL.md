---
name: trodo-heal-tracing
version: 1.3.0
sdk_version_node: ">=2.23.0"
sdk_version_python: ">=2.23.0"
last_updated: 2026-09-25
description: >-
  Audit an existing Trodo agent-tracing integration, find the gaps that make
  the dashboard lie, propose a fix for each, and — once approved — apply it.
  This is the HEAL/AUDIT master (not first-time install; for a fresh integration
  use `trodo-tracing`). Use when the user says "audit my Trodo tracing", "find
  gaps in my instrumentation", "why do my runs show status error but no error
  message", "a step failed but the span shows ok", "my LLM calls aren't showing
  as child spans", "tool calls are missing from the trace", "the run output is
  empty / truncated", "my users all show as anonymous", "traces are incomplete",
  or "something's wrong with my Trodo traces, fix it". Runs the 6-phase loop
  (DETECT/inventory → UNDERSTAND → ANALYZE → PLAN → CONFIRM → EXECUTE): it never
  edits code before showing a gap report and getting approval, and it never adds
  spans for steps that don't exist. **Founding fact: Trodo's ingest captures
  every error field the client emits (the OTel `exception` event's
  exception.type / exception.message / exception.stacktrace, span status.message,
  error.type, HTTP/provider status codes, severity level) — so a span that shows
  "error" with no message means the message was never recorded on the span at the
  source. The gap is client-side, and this skill fixes it there.**
---

# Trodo Tracing — Heal & Gap Audit

> **This skill audits and repairs an *existing* Trodo tracing integration.**
> It does not do first-time setup — for a codebase with no Trodo yet, use
> [`trodo-tracing`](../trodo-tracing/SKILL.md). This skill assumes `trodo.init`
> (or an OTLP export to Trodo) is already present and asks: *is the trace a
> faithful, complete picture of what the code actually does — and if not, where
> is the gap and how do we close it?*

## What "healthy" means

A healthy integration satisfies these invariants. Every gap this skill finds is
one of them broken:

1. **Every agent entry point is instrumented** — no run-producing path is dark.
2. **Every real step shows up** — LLM calls, dispatched tools, retrievals appear
   as spans; nothing real is missing and nothing fake is invented.
3. **Failures read as failures** — a step that errored shows `status = error`
   **with** an error type and message, not a green "ok" and not a bare "error".
4. **Outputs are complete** — run/span output is the full payload, not empty,
   truncated, or a hand-picked summary.
5. **Runs are attributed** — a real `distinctId` (not anon), consistent across
   `wrapAgent` / `trackMcp` / `startRun`.
6. **The run shape matches the runtime** — `wrapAgent` for in-process,
   `startRun`/`endRun` for cross-worker, `trackMcp` for MCP; no stuck-running
   runs, no accidental sibling runs, no double-tracking.

## Founding fact — the ingest side is not the gap

Before blaming Trodo, know what Trodo already does. The OTLP ingest
(`/v1/traces`) and the native SDK ingest both extract, and persist, the full
error picture from whatever the client sends:

| Trodo column | Read from (in order) |
|---|---|
| `error_message` | OTel `exception` event `exception.message` → span `status.message` |
| `error_type` | `exception.type` → `error.type` semconv |
| `status_code` | `http.response.status_code` / `gen_ai.response.status_code` / `error.code` / `rpc.grpc.status_code` |
| `stack_trace` | `exception.stacktrace` |
| `level` | `trodo.level` / `langfuse.observation.level` → derived (`error` when status code 2 or an exception was recorded) |
| `status` | `error` when OTel status code = 2 **or** an exception event exists, else `ok` |

So if a span in the dashboard shows **`error` with an empty message**, it is
almost never that Trodo dropped it — it is that **the source span carried a
status of ERROR but no `exception` event and no `status.message`**. Common
causes, all client-side and all fixable:

- The code **caught the exception and re-threw a bare value** (`throw { code }`,
  `throw 'failed'`) instead of an `Error` — so there's no `.message` to record.
- A **framework marked the span errored but never called `recordException`**
  (e.g. an aborted/timed-out request where the abort reason is empty).
- A **span processor in the client's OTel pipeline strips span events** before
  export (some redaction/sampling processors do) — the `exception` event never
  leaves the app.
- The manual span **swallowed the error and reported it via `setOutput` instead
  of raising or `setError`** — Trodo's status is exception-driven, so it stays
  `ok`… or the app forced `status=error` some other way but attached no message.

> **Where to look in the UI:** `error_message` / `error_type` / `stack_trace`
> render in the span's **status/error area**, not the **Attributes** tab. A span
> event named `exception` is *not* an attribute — don't conclude the message is
> missing just because it isn't in the Attributes list. Open the span's error
> section (or query the Trodo MCP) to confirm before treating it as a gap.

This is the premise of the whole skill: fix the recording at the source, and the
dashboard fills in — no backend change needed.

## On the OTLP / framework path: emit vs map vs price

When the integration exports through the client's **own** OTel pipeline —
`@vercel/otel`, a Langfuse OTel exporter, `registerOTel({ mode: 'otlp' })`, or
raw OTLP — rather than Trodo's native `wrapAgent`, split every field into three
concerns before deciding whose gap it is:

| Concern | Owner | Whose gap / who fixes it |
|---|---|---|
| **Emitting** a field onto the span (input, output, tokens, error, model) | The client's **framework + telemetry config** — Trodo cannot auto-instrument a call it never wrapped. e.g. Vercel AI SDK emits `ai.prompt` / `ai.response.text` **only** when `experimental_telemetry.isEnabled` **and** `recordInputs` / `recordOutputs` are on. | **Client-side. This skill fixes it** (enable telemetry / `recordInputs` / `recordOutputs`; stop a processor from stripping the attribute). |
| **Mapping** an emitted attribute → a Trodo column | **Trodo ingest.** It maps the standard GenAI + `ai.*` semconv keys: input ← `ai.prompt` / `gen_ai.prompt`; output ← `ai.response.text` / `gen_ai.completion`; plus tokens, cache-read, model, provider, temperature. | If the framework emits a field under a key Trodo doesn't recognise (or nested inside a blob like `ai.response.providerMetadata`), that's a **Trodo-side mapping gap — escalate, don't edit client code.** |
| **Pricing** tokens → cost | **Trodo's server-side cost cascade** (explicit client cost → team price → global price). | Cost mismatches — prompt-cache discount not applied, or a gateway's real cost (OpenRouter, buried in `providerMetadata`) ignored — are **Trodo-side. Escalate.** |

**So "should Trodo auto-instrument input/output for an OTLP client?" — no.** On the
OTLP path Trodo is a *receiver*, not an instrumentor: it maps what the framework
emits. Getting the field onto the span is the client's job (and this skill's,
when it's a config gap); recognising and pricing it is Trodo's. When you audit an
OTLP integration, decide per field: *emitted?* → if no and it should be, client
fix; *emitted but not showing?* → Trodo mapping, escalate; *showing but wrong
cost?* → Trodo pricing, escalate. Only the first is a code change in the user's
repo.

## The 6-phase loop

Same contract as the rest of the swarm. **Phases DETECT→CONFIRM are a hard gate:
change no code until the gap report is shown and the user approves.**

1. **DETECT (inventory)** — find every piece of existing instrumentation and
   every agent entry point. See "Inventory".
2. **UNDERSTAND** — for each entry point, trace the *real* execution flow (the
   same discipline as `trodo-tracing/references/stack-map.md`): which
   LLM calls, tool dispatches, retrievals, sub-agents actually run. This is the
   ground truth you compare the trace against. If the codebase is large, spawn
   an Explore/general-purpose agent to map it.
3. **ANALYZE** — walk the Gap catalog. For each real step, ask: is it captured?
   Correctly kinded? Does it fail loudly? For each existing span, ask: is it
   real, or invented? Match every finding to a broken invariant above.
4. **PLAN** — assemble the Gap report: one row per finding with file:line,
   severity, the invariant it breaks, the dashboard symptom, and the proposed
   fix. Nothing speculative.
5. **CONFIRM** — show the report. Ask which findings to fix (`AskUserQuestion`).
   Never auto-apply; never impose a `distinctId` or a run-shape change. The user
   drives.
6. **EXECUTE** — apply only the approved fixes, minimally, then verify (see
   "Verify the fix"). Re-run the audit if you changed enough to shift the map.

## Inventory — what's already there

Read the code before judging it. Build two lists.

**A. Instrumentation present** — grep for and locate each:

| Signal | Means |
|---|---|
| `trodo.init(` / `trodo.init(site_id` | SDK initialised — note the file and whether it precedes provider imports |
| `wrapAgent(` / `wrap_agent(` | Native run wraps — note every call site |
| `withSpan(` / `with_span(` , `trodo.tool(` / `.llm(` / `.retrieval(` / `.trace(` | Manual spans |
| `trackMcp(` / `track_mcp(` | MCP runless spans |
| `startRun(` / `start_run(` , `joinRun` , `endRun` | Long-session primitives |
| `registerOTel(` , `OTEL_EXPORTER_OTLP_ENDPOINT`, `@vercel/otel`, `instrumentation.ts` | OTLP export path (Path A/B) — errors flow via OTel, not the native API |
| `experimental_telemetry` | Vercel AI SDK telemetry — check it's on **every** call |
| SDK version in `package.json` / `pyproject.toml` | < 2.9.0 = degraded error capture (type+message only) |

**B. Agent entry points (instrumented or not)** — every request handler, queue
consumer, cron job, CLI command, or exported function that runs an LLM/agent.
A dark entry point (produces agent work, has no wrap) is the highest-severity
gap: the whole run is invisible.

Cross-check A against B. Anything in B not covered by A is a missing-run gap.

## Gap catalog

Grouped by invariant. For each: how to detect it in code, what it does to the
dashboard, and the fix. Fixes reference [`trodo-tracing`](../trodo-tracing/SKILL.md)
and its references rather than restating recipes.

### A. Error & status gaps — *this is where "error with no message" lives*

| Gap | Detection signal (in code) | Dashboard symptom | Fix |
|---|---|---|---|
| **Swallowed exception → false "ok"** | A `try/catch` inside `wrapAgent`/`withSpan`/`join_run` that catches, logs, and `return`s an error object (or `setOutput({error})`) without re-raising | Failed step shows green **ok**; error count is 0; alerts never fire | Trodo status is **exception-driven**. Let the error propagate out of the span callback, OR — if you must catch to recover — call `span.setError({ message, type?, statusCode? })` / `span.set_error(...)` (SDK ≥ 2.9.0) and `run.setErrorSummary(...)` / `run.set_error_summary(...)`. Never rely on `setOutput({status:'error'})` — it does not mark the span failed. |
| **Error with no message** (the reported case) | Error re-thrown as a non-`Error` (`throw { code }`, `throw resp`, `reject(string)`); or a manual span forced to error state with no message attached | Span shows **error**, message field empty | Throw a real `Error` that preserves the provider's `.message` and `.status`: `throw Object.assign(new Error(orig.message), { status: orig.status })`. For a caught-and-recovered path, pass the message explicitly to `setError({ message })`. |
| **Provider error re-wrapped, status/type lost** | Catch block that wraps the provider error in a generic `AppError('LLM failed')`, dropping `err.status` / `err.name` | Status shows error but `status_code` and `error_type` are null | When re-wrapping, carry the fields forward: `new AppError(msg, { cause: err, status: err.status })`, or call `setError({ message, type: err.name, statusCode: err.status })`. |
| **OTLP pipeline strips span events** | A custom `SpanProcessor` / redaction layer in the client's OTel setup that clears `span.events` before export | Vercel AI / raw-provider spans show error, no message/stack (message lives in the `exception` event, which was removed) | Stop stripping the `exception` event, or re-attach the message as `span.setStatus({ code: ERROR, message })` so it survives as `status.message` (which Trodo also reads). |
| **Vercel AI error not recorded** | App wraps `generateText`/`streamText` in its own try/catch and swallows before the AI SDK's error recorder runs, or the thrown value isn't an `Error` | `ai.*` span shows error, empty message | Let the AI SDK see the throw (it calls `recordException` itself), or set `experimental_telemetry.metadata` won't help here — ensure the error reaching the span is an `Error` instance. |
| **Old SDK** | `trodo-node` / `trodo-python` < 2.23 | Missing fixes: thin error capture, LangChain double counting, Vercel AI v7 not captured, nested-wrap warning | Upgrade to ≥ 2.23 before anything else. |

> **The rule for this group:** an errored step must (a) be *marked* errored —
> which happens on a propagating exception, or on an explicit `setError` /
> `set_error` (run level: `setErrorSummary` / `set_error_summary`) — and (b) carry a
> *message* — which requires the thrown value to be an `Error`, or that same explicit
> `setError`. Break either and you get exactly the "error with no message" (or
> worse, "ok on a failure") the user is seeing. Code that catches and returns an
> error object is the common case: it needs `setError`, not a refactor to re-throw.

### B. Missing-span gaps

| Gap | Detection signal | Symptom | Fix |
|---|---|---|---|
| **Dark entry point** | An agent entry point (Inventory B) with no `wrapAgent`/`startRun`/`trackMcp` | Run never appears | Wrap it — pick the shape by the rule in `trodo-tracing/references/run-model.md` §2. |
| **Provider imported before `init`** | `import OpenAI ...` above `trodo.init()`, or client constructed at module top-level before init | Run appears, **no child LLM spans** | Move `init()` before all provider imports; in Next.js into `instrumentation.ts`; pure-ESM → `--import trodo-node/register`. See `trodo-tracing/references/runtimes.md` and `auto-instrumentation.md` §Ordering. |
| **Raw-provider tool calls not wrapped** | `openai`/`anthropic`/Gemini call with `tools:[...]`, then your code dispatches `tool_calls[]`/`tool_use` with no `trodo.tool`/`withSpan` around it | LLM span present, the tool execution emits nothing | Wrap the dispatch: `trodo.tool(name, fn)` or `withSpan(name, fn, {kind:'tool'})`. Auto-capture only covers framework-owned tools (LangChain/Vercel AI/Agents SDK). See `trodo-tracing/references/frameworks.md`. |
| **Retrieval step invisible** | A vector search / KB lookup feeding the prompt, un-wrapped | RAG context source is dark in the trace | Wrap with `trodo.retrieval(name, fn)` — only if it's a real retrieval. |
| **`autoInstrument: false`** left in config | grep the init options | No framework spans nest | Remove the override (default `true`) unless an OTLP path deliberately owns instrumentation. |
| **Missing `experimental_telemetry`** on a Vercel AI call | any `generateText`/`streamText`/`generateObject` without `experimental_telemetry:{isEnabled:true}` | That call produces no spans | Add it to **every** call. |

### C. Output-capture gaps

| Gap | Detection signal | Symptom | Fix |
|---|---|---|---|
| **Stream returned unconsumed** | `wrapAgent` callback returns a stream/promise handle without awaiting it | Output empty or truncated mid-sentence | Consume first, then `setOutput`; for Vercel AI use `onFinish` / `await result.text`. `trodo-tracing/references/run-model.md` §4 and `streaming.md`. |
| **Summary instead of payload** | `setOutput({ summary })` / `set_output({status})` dropping the real result | Output panel useless for debugging | `setOutput(fullPayload)`; put scalars in `setAttribute`. Rule 2. |
| **Hand-sliced output** | `.slice(0, 500)` / `[:500]` before `setOutput` | Output cut off though source was complete | Remove the slice — SDK caps at 1 MB. Rule 3. |
| **Blank output** | wrapped fn returns `undefined`/`None` and no `setOutput` | Output blank | Return the result, or call `setOutput` explicitly. |
| **Vercel AI `recordInputs`/`recordOutputs` off** (OTLP path) | `experimental_telemetry: { isEnabled: true, recordInputs: false }` or `recordOutputs: false` | Span present with tokens/cost, but **input and/or output blank** (the framework never emitted `ai.prompt` / `ai.response.text`) | Remove the override — both default `true` when telemetry is enabled. This is the OTLP-path analog of a missing `setOutput`. |
| **A span processor strips prompt/response** (OTLP path) | a redaction/PII `SpanProcessor` in the client's OTel setup that deletes `ai.prompt` / `ai.response.text` / `gen_ai.*` before export | Input/output blank though telemetry config looks right | Narrow the redaction so it doesn't remove the whole attribute (mask the value instead), or accept the trade-off. Same failure shape as the exception-event stripping in group A. |

### D. Identity gaps

| Gap | Detection signal | Symptom | Fix |
|---|---|---|---|
| **No `distinctId`** | `wrapAgent(name, fn)` with no `distinctId`; OTLP calls with no `ai.telemetry.metadata.userId` | Every run is a fresh anon user; no per-user funnels | Thread the app's real user id (resolution order in `trodo-tracing/references/run-model.md` §5; ask only on a tie). |
| **Inconsistent id across surfaces** | `wrapAgent` uses `email`, `trackMcp` uses session id, `startRun` uses uuid | One human splits into 3 profiles | Pick one identifier and use it everywhere. Confirm with the user. |

### E. Structural / run-shape gaps

| Gap | Detection signal | Symptom | Fix |
|---|---|---|---|
| **`wrapAgent` for an MCP server** | `wrapAgent` inside a `tools/call` handler | Each call = its own empty disconnected run | Switch to `trackMcp`/`track_mcp` (runless). `trodo-tracing/references/mcp-runless.md`. |
| **`wrapAgent` across workers/websocket** | `wrapAgent` opened in one handler, meant to close in another | Can't bridge; run never closes cleanly | `startRun`+`joinRun`+`endRun` — but only for a single turn/job spanning requests; a chat session is one run per turn. `trodo-tracing/references/long-session.md`. |
| **`startRun` never `endRun`** | a `startRun` with no guaranteed close path | Runs stuck **running** forever | Pair with a TTL sweeper / explicit close / `finally`. |
| **Accidental nested `wrapAgent`** | `wrapAgent` called inside another `wrapAgent` | Two sibling runs, not a nested trace | Sub-agent → `withSpan(name, fn, {kind:'agent'})` / `trodo.span(name, kind='agent')`; other sub-steps → `tool`/`trace`; `parentRunId` only for independently-triggered work. |
| **`wrapAgent` per sub-agent, where the sub-agent has no independent trigger** | more than one `wrapAgent`/`wrap_agent` reachable from a single entry point's call graph — a supervisor loop, `Promise.all`/`asyncio.gather` over per-item agents, a `Task`/spawn helper — **and** the inner agents have no route, queue, cron or retry policy of their own | One user request becomes N disconnected runs; no row holds the request's true cost or latency; the delegation tree is unrecoverable | Wrap once at the entry point; make those sub-agents `agent`-kind child spans (`withSpan(..., {kind:'agent'})` / `trodo.span(..., kind='agent')` — `wrapAgent` is run-level and cannot nest). **Verify the trigger test per agent before reporting this** — an agent with its own trigger is correctly its own run. `trodo-tracing/references/run-model.md` §2. |
| **Separate agents merged into one run** | one `wrapAgent` spanning agents that have their own routes / queues / crons / retry policies, often introduced by applying "one request, one run" as a rule | Each agent loses its own name, success rate, latency and cost — buried inside a trace that belongs to something else. Not recoverable from stored data | Give each independently-triggered agent its own run, linked with `parentRunId`. Do not propose a merge unless the trigger test says the inner agent has no independent existence. |
| **Sub-agent spans layered on framework-owned handoffs** | manual `agent` spans around OpenAI Agents SDK handoffs / LangGraph nodes / LlamaIndex workers | Duplicated layer in the waterfall; tree lies about depth | Those frameworks emit sub-agent spans themselves — remove the manual layer. |
| **Whole chat session in one `wrapAgent`** | a wrap whose lifetime is the session, not the turn | One enormous run; per-turn latency/cost/quality unrecoverable; run sits `running` | One run per turn + `conversationId`. |
| **Multiplexed route as one agent** | one `wrapAgent` named after a dispatcher (`tasks`, `run`, `handler`) around a `switch` on `type`/`kind`/`event` | Unrelated agents share one name, success rate and cost | One run per branch, each with its own agent name. `trodo-tracing/references/run-model.md` §2–3. |
| **Linked job run missing thread/user** | a queue consumer `wrapAgent` with `parentRunId` but no `conversationId` / `distinctId` from the enqueuing run | Job runs are `anon_*` and never show in the thread | Carry `runId`, `conversationId`, `distinctId` in the job payload. `trodo-tracing/references/runtimes.md` §Queues. |
| **Detached work lost** | `setImmediate` / un-awaited promise / `create_task` / `BackgroundTasks` doing LLM work after the wrap returned | Span count lower than the code's call count; the follow-up LLM call is invisible | Await it before the wrap returns, or `joinRun(currentRunId(), …)` inside the task. `runtimes.md` §Detached work. |
| **Multi-turn chat with no `conversationId`** | `wrapAgent` per turn with no `conversationId`/`conversation_id` and a thread id available nearby | Turns never group; no conversation view, no conversation-level evals | Pass the app's thread/session id as `conversationId`. |
| **Double-tracking** | `withSpan` on caller **and** `fastapi_middleware`/`expressMiddleware` on callee for the same op; or an auto-instrumented provider also hand-wrapped with `llm()` | Every operation appears twice; tokens/cost double-counted | Remove one side. Auto-instrumented providers must not be re-wrapped; caller-owned spans → drop the callee middleware. `trodo-tracing/references/frameworks.md` and `cross-service.md`. |

### F. Config / ordering gaps

| Gap | Detection signal | Symptom | Fix |
|---|---|---|---|
| **`NEXT_PUBLIC_`/`VITE_` on the site id** | client-prefixed env var | Site id in client bundle; server may read nothing | Rename to `TRODO_SITE_ID`, read server-side only. |
| **Short-lived script exits before flush** | pure-ESM/CLI script that doesn't `await` the top-level `wrapAgent` + `trodo.shutdown()` | Run never lands, no error | `await` the wrap and `await trodo.shutdown()`/`flush()` before exit. |
| **OTLP `mode:'otlp'` expecting nested children** | `registerOTel({mode:'otlp'})` with an expectation that auto spans nest under `wrapAgent` | Auto-instrumented spans become their own runs | Use default `mode:'trodo'` for unified runs, or accept separate runs. `trodo-tracing/references/dual-export.md`. |

## Gap report — what to show the user (PLAN → CONFIRM)

Present findings as a ranked table, most-severe first. One row per gap:

```
| # | Severity | File:line | Invariant broken | Dashboard symptom | Proposed fix |
|---|----------|-----------|------------------|-------------------|--------------|
| 1 | high     | src/ai/utils.js:944 | Failures read as failures | Span "error", no message — provider error re-thrown as a bare object | Re-throw as Error preserving .message/.status (or setError) |
| 2 | high     | src/agents/chat.ts:1 (no wrap) | Every entry point instrumented | Whole run invisible | wrapAgent around answer() |
| 3 | med      | src/rag.ts:60 | Every real step shows up | Retrieval dark | trodo.retrieval('kb-search', ...) |
```

Severity guide: **high** = data is wrong or absent (dark run, false ok, empty
output, error with no message). **med** = incomplete (missing tool/retrieval span,
anon users). **low** = hygiene (double-count, naming, env prefix).

Then ask, with `AskUserQuestion`: which to fix now. Offer "all high", "all",
or a subset. For any identity or run-shape change, surface the recommendation and
let the user choose — same non-imposition rule as `trodo-tracing`.

## Fix discipline

When you apply approved fixes, obey the same rule that governs first-time
install — **instrument the real process, nothing more** (`trodo-tracing`
SKILL.md step 2 and `references/run-model.md`):

- Fix the gap with the **smallest change** that restores the invariant. A
  missing error message is a one-line re-throw, not a rewrite of the handler.
- **Do not add spans the audit didn't find a real step for.** Healing an
  integration is not an excuse to blanket-wrap helpers. If UNDERSTAND didn't
  surface a real, uncovered operation, don't add a span for it.
- **Do not remove the user's existing spans** unless they're the *cause* of a
  gap (double-tracking, invented span) and the user approved it.
- Preserve the app's control flow. If the code catches an error to recover
  (retry, fallback), keep the recovery — just make the span record the failure
  via `setError` before the recovery path.

## Verify the fix

Never report "fixed" without evidence. After applying:

1. **Reproduce the failing path** where practical (trigger the error, run the
   agent) with `trodo.init({ debug: true })` — debug logs show the span export
   and any peer-dep/load errors.
2. **If the Trodo MCP is connected**, query the most recent run/span and confirm
   the field is now populated (`error_message` present, `status='error'`, child
   LLM span exists, output non-empty). This is faster and more authoritative
   than reading logs.
3. Otherwise, tell the user exactly what to look for in the dashboard for the
   next run (e.g. "the failed verification span will now show `RateLimitError`
   and the provider message in its error section").

Confirm the specific symptom is gone — not just that code changed.

## Scope — what this skill does NOT do

- **First-time install** → `trodo-tracing`.
- **Product bugs in Trodo itself** (ingest 500s, dashboard rendering) → these
  are not client-side gaps; escalate to Trodo support, don't "fix" them in the
  user's code. The one exception this skill *does* own: confirming a suspected
  ingest gap is actually a client-side recording gap (per "Founding fact").

## Skill feedback

If a real gap class is missing from this catalog, or a proposed fix is wrong,
offer to submit feedback — see
[`references/skill-feedback.md`](../trodo-tracing/references/skill-feedback.md).
Product issues with Trodo belong in Trodo support, not here.
