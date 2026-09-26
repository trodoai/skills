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
trodo.init({ siteId: process.env.TRODO_SITE_ID!, disableInstrumentations: ['vercel-ai'] });   // trodo-node ≥ 2.23.4
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
build even when `register()` is guarded. Also add the SDK to
`serverExternalPackages` — it resolves its optional OpenTelemetry peers at runtime,
and bundling it makes the build fail on those optional imports:

```ts
// next.config.ts
const nextConfig: NextConfig = { serverExternalPackages: ['trodo-node'] };
```

On `trodo-node` ≤ 2.23.3 under Next.js (or any ESM app), `init()` cannot load `ai`
and registers nothing — no llm or tool spans, no warning. Upgrade to ≥ 2.23.4, or
register explicitly after `init`: `registerTelemetry(trodo.aiSdkTelemetry())`
(only when `globalThis.AI_SDK_TELEMETRY_INTEGRATIONS` is empty, so it is never
registered twice). Routes on `export const runtime = 'edge'`
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

`wrapAgent`'s callback resolving closes the run, and the AI SDK integration records
spans only while a run's context is active. A route that returns the stream
`Response` immediately therefore needs the wrap kept open and the `Response` handed
out of it:

```ts
// app/api/chat/route.ts — verified against Next.js 16 + ai@7
import { after } from 'next/server';
import { streamText, convertToModelMessages, stepCountIs } from 'ai';
import trodo, { wrapAgent } from 'trodo-node';

export async function POST(req: Request) {
  const { id: chatId, messages: ui } = await req.json();
  const messages = await convertToModelMessages(ui);

  // The route must return the stream Response before the reply exists, but the
  // run must stay open until it does. Hand the Response out of the wrap.
  let resolveResponse!: (r: Response) => void;
  const response = new Promise<Response>((r) => (resolveResponse = r));

  const turn = wrapAgent('support_chat', async (run) => {
    run.setInput(messages);
    const text = await new Promise<string>((resolve, reject) => {
      const result = streamText({
        model, messages, tools, stopWhen: stepCountIs(4),
        onFinish: ({ text, steps, finishReason }) => {
          run.setMetadata({ iterations: steps.length, stop_reason: finishReason });
          resolve(text);
        },
        onAbort: ({ steps }) => {
          run.setErrorSummary('stream aborted by client', { type: 'AbortError' });
          resolve(steps.map((s) => s.text).join(''));
        },
        onError: ({ error }) => reject(error instanceof Error ? error : new Error(String(error))),
      });
      resolveResponse(result.toUIMessageStreamResponse());
    });
    run.setOutput(text);
    return text;
  }, { distinctId: req.headers.get('x-user-id'), conversationId: chatId });

  // A failure before the stream exists must not hang the request.
  turn.catch((err) => resolveResponse(Response.json({ error: String(err) }, { status: 500 })));
  // Keep the function alive for the end of the run and the flush.
  after(async () => { await turn.catch(() => {}); await trodo.flush(); });
  return response;
}
```

Do **not** use `startRun` + `endRun` in `onFinish` here: `startRun` opens the run row
but does not activate its context, so every AI SDK `llm` / `tool` span is dropped.

When the caller can wait for the full text (no browser streaming), the simple form is
fine:

```ts
const { result } = await wrapAgent('support_chat', async (run) => {
  run.setInput(messages);
  const text = await streamText({ model, messages }).text;   // resolves when the stream ends
  run.setOutput(text);
  return text;
}, opts);
```

Never return `streamText(...)` or `result.toUIMessageStreamResponse()` from inside a
`wrapAgent` callback — the run closes with an empty output before a token exists.
Never `setOutput` inside a `for await` loop — that records a partial value.

## Work after the response — `after()`

A webhook that answers `202` and does its LLM work in `after()` opens the run
**inside** the `after()` callback and flushes before it returns:

```ts
after(async () => {
  try {
    await wrapAgent('ticket_summarizer', async (run) => {
      run.setInput(ticket);
      const { text } = await generateText({ model, prompt: ticket.body });
      run.setOutput(text);
      return text;
    }, { conversationId: ticket.id });
  } finally {
    await trodo.flush();
  }
});
return new Response(null, { status: 202 });
```

## Multi-step agents and tools

`tools: {}` with `stopWhen` / `maxSteps` is one run: the SDK's step and tool executions
appear as flat `llm` / `tool` spans under it. Do not add `trodo.tool` around AI-SDK-managed
tools. A hand-rolled loop around several `generateText` calls is still one run.

## Run output vs return value

The callback's return value becomes the run output only when you don't call
`setOutput`. In a route handler always call `run.setOutput(text)` — the handler returns
a `Response`, not the reply.
