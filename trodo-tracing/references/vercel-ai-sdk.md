# Vercel AI SDK — Integration Notes

Targets `trodo-node` >= 2.1.0.

Docs: `https://docs.trodo.ai/agent-analytics/integrations/vercel-ai-sdk.md`.

---

## `experimental_telemetry` must be on every call

This is the #1 missed step. Every single `generateText`, `streamText`, or `generateObject` call needs it. Miss it on one call inside a multi-step agent and that call produces no child spans — the root `wrapAgent` span appears but the LLM work looks invisible.

```ts
experimental_telemetry: { isEnabled: true }
```

AI SDK tool calls are also captured automatically when this flag is set — you do **not** need the `trodo.tool()` helper for AI-SDK-managed tool calls.

---

## The base pattern

```ts
// instrumentation.ts (project root, sibling of package.json)
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const trodo = (await import('trodo-node')).default;
    trodo.init({ siteId: process.env.TRODO_SITE_ID! });
  }
}
```

```ts
// app/api/chat/route.ts
import { wrapAgent } from 'trodo-node';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

export async function POST(req: Request) {
  const { question, userId } = await req.json();

  const { result } = await wrapAgent(
    'chat-agent',
    async (run) => {
      run.setInput({ question });
      const { text } = await generateText({
        model: openai('gpt-4o'),
        prompt: question,
        experimental_telemetry: { isEnabled: true },   // required
      });
      run.setOutput({ answer: text });
      return text;
    },
    { distinctId: userId },
  );

  return Response.json({ answer: result });
}
```

---

## `instrumentation.ts` location

Must be at the **project root** — the same level as `package.json`. If using a `src/` directory layout, place it at `src/instrumentation.ts`.

Next.js runs `register()` **twice** in development (once for `edge`, once for `nodejs`). Without the `NEXT_RUNTIME === "nodejs"` guard, `trodo.init()` runs in the edge runtime where the Node OTel SDK is not supported and will throw.

---

## Streaming — `onFinish` is where `setOutput` belongs

For `streamText`, the `onFinish` callback fires once the full output is assembled. Call `run.setOutput()` there, not inside the loop consuming the stream.

```ts
import { wrapAgent } from 'trodo-node';
import { streamText } from 'ai';
import { openai } from '@ai-sdk/openai';

export async function POST(req: Request) {
  const { question } = await req.json();

  const result = streamText({
    model: openai('gpt-4o'),
    prompt: question,
    experimental_telemetry: { isEnabled: true },
  });

  // The run is fully owned inside wrapAgent — stream the response back
  // while the agent span stays open until onFinish.
  return wrapAgent('chat-agent', async (run) => {
    run.setInput({ question });
    const stream = streamText({
      model: openai('gpt-4o'),
      prompt: question,
      experimental_telemetry: { isEnabled: true },
      onFinish({ text }) {
        run.setOutput({ answer: text });   // record once, after assembly
      },
    });
    return stream.toTextStreamResponse();
  }).then((r) => r.result);
}
```

Avoid calling `run.setOutput()` inside a `for await` loop over the stream — `onFinish` fires after the loop ends, so calling it mid-loop records a partial value.

---

## Env vars: `TRODO_SITE_ID`, never `NEXT_PUBLIC_`

`TRODO_SITE_ID` is a server-only value read inside `instrumentation.ts` / API routes / server actions. Never prefix it with `NEXT_PUBLIC_` — that embeds it into the client bundle where it's both unnecessary and wrong. Auto-instrumentation runs on the server.

```bash
# .env.local
TRODO_SITE_ID=your-site-id
```

---

## `wrapAgent` is always the trace root

`wrapAgent` starts a new run from a clean context. If you call `wrapAgent` **inside** another `wrapAgent`, you get two separate runs in Trodo, not a parent-child span. For sub-steps use `trodo.trace(name, fn)` or `trodo.tool(name, fn)` instead. For a genuine linked child run, use the `parentRunId` option.

---

## Return value → run output

In non-streaming mode, the wrapped function's return value is recorded as the run output automatically. Calling `run.setOutput()` is only needed when you want to record a **different** value than the return value — e.g. return the full `generateText` result object to the caller but record only the text in Trodo.

---

## Edge runtime caveat

If your route is configured for the `edge` runtime (`export const runtime = 'edge'`), auto-instrumentation does not run — the Node OTel SDK requires Node APIs. Either move the route to the default Node runtime, or use `trodo.trackLlmCall()` manually inside the edge handler after each LLM call.
