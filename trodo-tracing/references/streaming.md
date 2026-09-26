# Streaming — Integration Notes

Targets `trodo-node` / `trodo-python` ≥ 2.23.

Docs: `https://docs.trodo.ai/observability/features/instrumentation/long-running-runs`.

---

## The rule

In streaming mode, the LLM response is delivered piece by piece. The run span must stay open until the **full** output is assembled, at which point you record the output and close the run.

Where you record the output depends on the framework:

| Framework | Finish signal | Action |
|---|---|---|
| Vercel AI SDK | `onFinish({ text })` callback | `run.setOutput({ answer: text })` inside `onFinish` |
| Anthropic SDK | `await stream.finalMessage()` after iterating | `run.setOutput(finalMessage)` after the await |
| OpenAI SDK | Last chunk with `stream_options: { include_usage: true }` provides final usage | Accumulate `choices[0].delta.content` during iteration, `run.setOutput(assembled)` after the loop |
| Python `anthropic.Messages.stream` | `async for event in stream: ...` then `message = await stream.get_final_message()` | `run.set_output(...)` after `get_final_message()` |

---

## Vercel AI SDK

Two patterns work; both ensure the run stays open until the full text is assembled. Pick the one that fits the call shape:

**Pattern A — non-SSE handler that just needs the text:** `await result.text` resolves only after the stream has fully produced its tokens. Works when the wrapper isn't returning the stream to a browser; you can `setOutput` and return the text.

```ts
await wrapAgent('chat-agent', async (run) => {
  run.setInput({ question });
  const result = streamText({
    model: openai('gpt-4o'),
    prompt: question,
    experimental_telemetry: { isEnabled: true },
  });
  const text = await result.text;             // ✅ resolves only when stream is done
  run.setOutput({ answer: text });
  return text;
});
```

**Pattern B — SSE / streaming response handler:** the wrapper has to forward chunks to the client *and* keep the run open until the stream finishes. Use `onFinish` to capture the assembled text, and have the wrapper await a promise that resolves there.

```ts
await wrapAgent('chat-agent', async (run) => {
  run.setInput({ question });

  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });

  const stream = streamText({
    model: openai('gpt-4o'),
    prompt: question,
    experimental_telemetry: { isEnabled: true },
    onFinish({ text }) {
      run.setOutput({ answer: text });        // ✅ record once, fully assembled
      resolveDone();
    },
  });

  // Forward to client elsewhere (or return stream.toTextStreamResponse() to a route).
  // Critically: don't let the wrapAgent callback resolve before onFinish fires.
  await done;
});
```

**Anti-pattern.** Returning `streamText(...)` directly from the callback. The callback resolves to a stream handle while the model is still generating; `wrapAgent` closes the run, and the dashboard records partial / empty output.

```ts
// ❌ wrapAgent callback resolves before any token has been produced
return await wrapAgent('chat', async (run) => {
  return streamText({ ... });
});
```

Avoid calling `run.setOutput()` inside `for await (const chunk of stream.textStream)` — the loop runs before `onFinish`, so mid-loop records are partial.

---

## Anthropic SDK (Node)

```ts
import Anthropic from '@anthropic-ai/sdk';
import { wrapAgent } from 'trodo-node';

const anthropic = new Anthropic();

await wrapAgent('summariser', async (run) => {
  run.setInput({ doc });

  const stream = anthropic.messages.stream({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [{ role: 'user', content: doc }],
  });

  // Optional: forward chunks to the user as they arrive.
  for await (const event of stream) {
    // stream chunks to client
  }

  const finalMessage = await stream.finalMessage();
  run.setOutput(finalMessage);
  return finalMessage;
});
```

Auto-instrumentation captures the LLM span itself (model, tokens, prompt, completion). `run.setOutput` is for the **run** output, which is what shows on the run row in the dashboard.

---

## OpenAI SDK — include usage

Streaming chat completions skip token totals by default. Enable them:

```ts
const stream = await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [...],
  stream: true,
  stream_options: { include_usage: true },   // sends a final chunk with usage
});

let assembled = '';
for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta?.content ?? '';
  assembled += delta;
}
run.setOutput({ answer: assembled });
```

Without `include_usage: true`, the auto-captured LLM span will have `input_tokens` / `output_tokens` missing.

---

## Python — Anthropic

```python
import anthropic, trodo, os

trodo.init(site_id=os.environ["TRODO_SITE_ID"])
client = anthropic.Anthropic()

with trodo.wrap_agent("summariser") as run:
    run.set_input({"doc": doc})
    with client.messages.stream(
        model="claude-sonnet-4-20250514",
        max_tokens=1024,
        messages=[{"role": "user", "content": doc}],
    ) as stream:
        for event in stream:
            ...   # forward to client if needed
        final = stream.get_final_message()
    run.set_output(final.model_dump())
```

---

## SSE / server endpoints

The run must stay open until the server has finished streaming, not until the handler
returns. Two shapes work (full code in `runtimes.md` §Streaming and `long-session.md`):

- **Express / raw SSE:** keep `wrapAgent` around the whole `for await` loop that writes
  chunks, call `run.setOutput(full)` after the loop, then return.
- **Next.js / any handler that must return a `Response` before the stream ends:**
  keep `wrapAgent` open, resolve the text in `onFinish`, hand the `Response` out of the
  callback, and hold the function with `after()` for the flush — `vercel-ai-sdk.md`
  §Streaming. Not `startRun`/`endRun`: `startRun` does not activate the run context,
  so the AI SDK's spans would be dropped.

Never return the stream object from inside a `wrapAgent` callback.

**Streams relayed through a bus** (Redis pub/sub, an events table, a websocket fan-out):
the run belongs to the process that produces the answer, not the one relaying it. If
that producer finishes the full answer before it ends the run, nothing special is
needed; the relay needs no tracing.

## Pitfalls

- **Calling `run.setOutput` mid-stream.** Records a partial value; the dashboard shows half the answer.
- **Returning the stream object from `wrapAgent` without awaiting completion.** The callback resolves immediately, the run closes before the stream has produced tokens, and the persisted output is empty or partial. Always `await result.text` (or wait for `onFinish`) before returning.
- **Hand-slicing the assembled text before `setOutput` (`text.slice(0, 500)`).** Caps the persisted run output for no reason; the SDK already truncates at 1 MB. Pass the full string.
- **Capturing the run output from a function that returns the *promise* of the result.** The promise resolves to a stream / future result; what's captured is the promise itself or whatever it resolves to *at that instant*. Resolve / await first, then `setOutput`.
- **Missing `stream_options.include_usage`** (OpenAI streaming). LLM span is created but tokens are zero.
- **Missing `experimental_telemetry`** (Vercel AI SDK streaming). Same as non-streaming — no child LLM spans. See [`vercel-ai-sdk.md`](./vercel-ai-sdk.md).
