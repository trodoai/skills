# Vercel AI SDK — integration notes

Targets `trodo-node` ≥ 2.23.

Docs: `https://docs.trodo.ai/observability/features/instrumentation/frameworks/vercel-ai-sdk`.

## Which version

| `ai` version | What you do |
|---|---|
| **v7+** | Nothing per call. `trodo.init()` registers Trodo's telemetry integration when `ai` is installed. Model calls → `llm` spans, tool executions → `tool` spans, nested under the active run. |
| **v5 / v6** | `experimental_telemetry: { isEnabled: true }` on **every** `generateText` / `streamText` / `generateObject` / `embed` call. Miss one and that call is invisible. |

If the app already calls `registerTelemetry(...)` itself (v7), add Trodo there and stop
init from doing it too — registering twice doubles every span:

```ts
import trodo from 'trodo-node';
import { registerTelemetry } from 'ai';
trodo.init({ siteId: process.env.TRODO_SITE_ID!, disableInstrumentations: ['vercel-ai'] });
registerTelemetry(trodo.aiSdkTelemetry());
```

Do not also install `@ai-sdk/otel` — it routes the same events into OpenTelemetry, which Trodo already consumes.

## Next.js placement

```ts
// instrumentation.ts (project root, or src/ if the app uses src/)
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { initTrodo } = await import('./lib/trodo-init');   // dynamic: keeps the Edge bundle clean
  initTrodo();
}
```
```ts
// lib/trodo-init.ts
import trodo from 'trodo-node';
export function initTrodo() {
  trodo.init({ siteId: process.env.TRODO_SITE_ID! });
}
```

A top-level `import trodo from 'trodo-node'` in `instrumentation.ts` breaks the Edge
build even when `register()` is guarded. Routes on `export const runtime = 'edge'`
cannot use the SDK. `TRODO_SITE_ID` is server-side only.

With `@vercel/otel` already in place, see [`dual-export.md`](./dual-export.md) — but
prefer the SDK when the user wants `wrapAgent` run boundaries.

## Non-streaming handler

```ts
import { wrapAgent } from 'trodo-node';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

export async function POST(req: Request) {
  const { messages, userId, chatId } = await req.json();
  const { result } = await wrapAgent('support_chat', async (run) => {
    run.setInput(messages);
    const { text } = await generateText({ model: openai('gpt-4o'), messages, tools });
    run.setOutput(text);
    return text;
  }, { distinctId: userId, conversationId: chatId, metadata: { channel: 'web' } });
  return Response.json({ reply: result });
}
```

## Streaming handler — the run must outlive the handler

`wrapAgent`'s callback resolving closes the run. A route that returns the stream
`Response` immediately therefore cannot use `wrapAgent` around the return. Two correct
shapes:

**A. `startRun` / `endRun` in `onFinish`** (preferred for route handlers)

```ts
export async function POST(req: Request) {
  const { messages, userId, chatId } = await req.json();
  const runId = await trodo.startRun('support_chat', {
    distinctId: userId, conversationId: chatId, input: messages,
  });
  const result = streamText({
    model: openai('gpt-4o'), messages, tools,
    onFinish: async ({ text }) => { await trodo.endRun(runId, { output: text }); },
    onError: async ({ error }) => {
      await trodo.endRun(runId, { status: 'error', errorSummary: String(error) });
    },
  });
  return result.toUIMessageStreamResponse();
}
```

**B. `wrapAgent` that waits for the stream** (when the caller can wait for the full text)

```ts
const { result } = await wrapAgent('support_chat', async (run) => {
  run.setInput(messages);
  const result = streamText({ model: openai('gpt-4o'), messages });
  const text = await result.text;      // resolves only when the stream is done
  run.setOutput(text);
  return text;
}, opts);
```

Never return `streamText(...)` or `result.toUIMessageStreamResponse()` from inside a
`wrapAgent` callback — the run closes with an empty output before a token exists.
Never `setOutput` inside the `for await` loop — that records a partial value.

## Multi-step agents and tools

`tools: {}` with `stopWhen` / `maxSteps` is one run: the SDK's step and tool executions
appear as flat `llm` / `tool` spans under it. Do not add `trodo.tool` around AI-SDK-managed
tools. A hand-rolled loop around several `generateText` calls is still one run.

## Run output vs return value

The callback's return value becomes the run output only when you don't call
`setOutput`. In a route handler always call `run.setOutput(text)` — the handler returns
a `Response`, not the reply.
