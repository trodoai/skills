# nextjs-ai-sdk — offline tracing sandbox

An **un-instrumented** Next.js 16 (App Router, TypeScript, `src/`) app built on
Vercel AI SDK **v7** (`ai@7.0.116`, `@ai-sdk/openai@4.0.77`, `@ai-sdk/react@4.0.119`,
`zod@4`). It talks to a local OpenAI-shaped mock, so it runs fully offline. It is
the fixture the `trodo-tracing` skill is exercised against: an instrumenting agent
adds `trodo-node` + `instrumentation.ts`, then `scripts/check-traces.js` asserts
what reached the ingest mock.

Nothing in here traces anything. There is no `instrumentation.ts`, no `trodo-node`.

## Commands

| Command | What |
| --- | --- |
| `npm install` | deps |
| `npm run dev` | `next dev` on **:3456** |
| `npm run build` | `next build` (must stay green) |
| `npm run mock` | both mocks in the foreground |
| `scripts/drive.sh` | mocks + dev server, scripted traffic, teardown, ingest line count |
| `node scripts/check-traces.js` | reconstruct runs from `mock/ingest-log.jsonl`, assert, print table |

Un-instrumented, `check-traces.js` must fail with `0 runs found`.

## Ports and env

| Port | Process | Env |
| --- | --- | --- |
| 3456 | `next dev` | |
| 4520 | `mock/openai-mock.js` | app reads `OPENAI_BASE_URL=http://127.0.0.1:4520/v1` |
| 4530 | `mock/trodo-ingest-mock.js` | `INGEST_PORT`; app-side `TRODO_API_BASE=http://127.0.0.1:4530` |

`drive.sh` exports `TRODO_SITE_ID` (default `sandbox-site`) and `TRODO_API_BASE`
(default above) but never overrides values already exported in your shell.

## Intended run model (what the instrumented app should produce per `drive.sh`)

| Trigger | Route / entry | Runtime | Runs | Spans | Identity |
| --- | --- | --- | --- | --- | --- |
| `POST /api/chat` x3 | `streamText` + tools, `stopWhen: stepCountIs(4)`, `toUIMessageStreamResponse()` | Node | 1 per POST turn (3) | ≥1 llm w/ tokens; the "order 5551" turn also has a `tool` span `lookupOrder` | `conversation_id` = body `id` (`c-1`,`c-1`,`c-2`); `distinct_id` = `x-user-id` (`u-1`,`u-1`,`u-2`) |
| `generateTitle` server action (`POST /api/title` wrapper) | one `generateText` | Node | 1 | 1 llm | — |
| `POST /api/webhooks/support` → 202, then `after()` summarises | one `generateText` inside `after()` | Node | 1 | 1 llm | must be **flushed** even though the 202 returned first |
| `GET /api/quick` | one `generateText` | **Edge** | 0 (acceptable) or 1 via an alternative | — | must never crash; curl returns 200 |

Total: **5 runs** (+1 if quick is traced). No orphan spans, no run left `running`,
streaming runs must carry non-empty output (finish before close).

Expected payload shape for the streaming route: `runs/start` + `/spans` + `/end`.
`runs/ingest` (whole run in one POST) and runless `spans/append` are also accepted by
the checker, which is field-name tolerant and classifies runs by `agent_name` first.

## Responses-API note

`src/lib/llm.ts` creates the provider once at module top level and exports `MODEL`.
Call sites **must** use `openai.chat(MODEL)`. The bare `openai(MODEL)` form in
`@ai-sdk/openai@4` targets the Responses API (`/v1/responses`), which the mock does
not implement — you would get a 404 from the mock.

## Mock behaviour (`mock/openai-mock.js`)

`POST /v1/chat/completions`, stream and non-stream, OpenAI-shaped with `usage`
(streaming sends the trailing usage chunk). Decision on the last user message:

- tools declared **and** text contains `order` **and** no tool result yet → `tool_calls` for `lookupOrder`
- a tool result is present → "Your order is in_transit via FakeEx, ETA 2 days."
- contains `title` (user or system) → `Order Status Inquiry`
- contains `summar` → fixed one-sentence summary
- otherwise → `Echo: <text>`

`mock/trodo-ingest-mock.js` accepts any method/path, appends
`{ts, method, path, site_id, headers, body}` to `mock/ingest-log.jsonl` and answers
`200 {ok:true, run_id}`.

## For the instrumenting agent

Install the SDK from the monorepo without publishing:

```
npm install --install-links <path-to-sdks/trodo-node-sdk>
```

Then add `src/instrumentation.ts` (or `instrumentation.ts` at the project root) and
whatever wrapping the skill prescribes. Run `scripts/drive.sh` followed by
`node scripts/check-traces.js`. Do not commit `node_modules/`, `.next/`, `.logs/`,
`mock/ingest-log.jsonl`, or the Next-generated `AGENTS.md` / `CLAUDE.md` (all ignored).
