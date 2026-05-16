---
name: trodo-install
version: 2.0.0
last_updated: 2026-05-16
description: >-
  Orchestrate a full Trodo onboarding into any codebase. Parses the user's
  prompt to decide which tracks to run — events (browser/server tracking,
  identity, groups, custom events, sessions) and/or agent tracing (LLM and
  tool spans across Vercel AI / LangChain / raw provider / OTel pipeline /
  MCP). Each track runs a 6-phase loop: DETECT, UNDERSTAND, ANALYZE, PLAN,
  CONFIRM, EXECUTE. Always wires identity and init-guards as Phase 0
  prerequisites. Use when the user says "install trodo", "set up trodo",
  "install trodo with siteId XXXX", "add trodo to this project", "install
  trodo events", "install trodo agent tracing", or any combination —
  including when only a site id is given without a track. Delegates the full
  comprehensive flow to `trodo-events` and/or `trodo-tracing`; never writes
  integration code itself.
---

# Trodo Install (Orchestrator)

You orchestrate Trodo onboarding by dispatching to the two comprehensive
master skills:

- [`trodo-events`](../trodo-events/SKILL.md) — full app-side install:
  client (npm vs `<script>`), backend (Node / Python / both), `init` guards,
  identify, groups, custom events, sessions. Modules under
  [`trodo-events/modules/`](../trodo-events/modules) are loaded inline by
  that skill — they're not separate top-level skills.
- [`trodo-tracing`](../trodo-tracing/SKILL.md) — full agent-tracing install:
  detects framework, loads the right module from
  [`trodo-tracing/frameworks/`](../trodo-tracing/frameworks) (Vercel AI /
  OTel-pipeline / LangChain / raw-provider / MCP), wires `wrapAgent`,
  `distinctId`, run scope.

You never write integration code yourself. You parse intent, confirm site id,
delegate to the right master skill(s), surface their combined plan, and
trigger execution after the user approves.

## The 6-phase contract (every skill in this swarm honors it)

```
DETECT  →  UNDERSTAND  →  ANALYZE  →  PLAN  →  CONFIRM  →  EXECUTE
```

You enforce this for every track you run. No silent code edits. No plan-less
execution.

## Step 0 — Parse intent from the user's prompt

Decide which tracks to run *before* doing any detection.

| Words in the prompt | Run |
|---|---|
| "events", "tracking", "identify", "groups", "sessions", "custom event", "people properties", named events (`sign_up`, `purchase_completed`) | **Phase A: trodo-events** |
| "agent", "tracing", "spans", "tool calls", "LLM", "run", "MCP", "OTel", "Vercel AI", "LangChain", "LlamaIndex" | **Phase B: trodo-tracing** |
| Bare "install trodo" / "set up trodo" / only a site id given | **Both A and B** |
| Explicit scoping ("only agent", "just events", "skip tracing") | Respect — drop the other track |

If both tracks are off after parsing, ask the user once which they want;
default offer is "both".

## Step 1 — Capture site id and run Phase 0 prerequisites

- **Site id**: take from the prompt verbatim; ask once if missing. Thread it
  into every downstream skill.
- **Identity source (`distinctId`)**: runs as Phase 0 inside any track you
  run. `trodo-events` owns the implementation (via its `modules/identify.md`)
  and the result is reused by `trodo-tracing` so events and runs share the
  same identifier. The user can opt out at CONFIRM, but the default never
  silently skips it.
- **Init placement guards**: one init per runtime (browser / Node / Python),
  SSR + hot-reload safe.

## Step 2 — Phase A: trodo-events (only if on)

Delegate the entire comprehensive flow to [`trodo-events`](../trodo-events/SKILL.md).
That skill runs end-to-end:

1. DETECT — frontend framework, backend runtime, auth provider, multi-tenant
   signals, existing analytics, package manager.
2. UNDERSTAND — build the integration model (what runs where).
3. ANALYZE — pick client install path (npm vs `<script>` vs RN vs skip),
   backend path (Node / Python / both / skip), distinctId source, group
   dimensions, starter custom-event set, session config.
4. PLAN — combined file-level plan covering all of the above. Modules under
   `trodo-events/modules/` provide the deep-dive content.
5. CONFIRM — show plan, wait for explicit user approval.
6. EXECUTE — install SDKs → init → identify → groups → custom events →
   sessions, in order.

## Step 3 — Phase B: trodo-tracing (only if on)

Delegate to [`trodo-tracing`](../trodo-tracing/SKILL.md). That skill:

1. DETECT — LLM SDKs, framework (Vercel AI / LangChain / LlamaIndex /
   OpenAI Agents / raw provider / MCP), existing OTel pipeline, module
   system (ESM vs CJS), Next.js presence.
2. UNDERSTAND — auto-vs-manual instrumentation, run-scope shape.
3. ANALYZE — load **exactly one** framework module from
   `trodo-tracing/frameworks/`: `vercel-ai.md`, `otel.md`, `langchain.md`,
   `openai.md`, or `mcp.md`. Asks the always-ask questions (distinctId, run
   scope). For multi-framework codebases asks which to instrument.
4. PLAN — env-var OTLP vs `registerOTel({ mode: 'otlp' })` vs raw-SDK wrap
   vs MCP runless spans vs ESM `register.mjs` bootstrap.
5. CONFIRM → EXECUTE.

## Step 4 — Phase C: heal / developer skills (future)

When `trodo-heal-*` skills exist, this orchestrator also dispatches
diagnose-mode requests like *"my LLM calls aren't showing as child spans"*
or *"why are my events under server_global"* to the right heal skill. Same
6-phase contract; the heal skill detects the symptom in real code,
identifies which invariant is broken, plans a diff, confirms, applies.

## Direct invocation also works

Users can skip the orchestrator entirely and call a master skill directly:

- `/trodo-events siteId=XXXX` — full events install
- `/trodo-tracing` — full agent-tracing install

Either master skill runs its comprehensive flow on its own. The orchestrator
is for combined or unscoped install requests.

## What you must not do

- Do not write integration code yourself — delegate to `trodo-events` /
  `trodo-tracing`.
- Do not silently skip identity wiring.
- Do not silently pick an identifier; the user must confirm at CONFIRM.
- Do not run EXECUTE before showing a combined PLAN and getting explicit
  approval.
- Do not run both tracks' EXECUTE in one pass — confirm A, execute A, then
  confirm B, execute B.
