---
name: trodo-tracing-openai
version: 2.0.0
sdk_version_node: ">=2.1.0"
sdk_version_python: ">=2.1.0"
last_updated: 2026-05-16
description: >-
  Add Trodo agent tracing to code using the raw provider SDKs — `openai`,
  `@anthropic-ai/sdk`, `@google/generative-ai` / `@google-cloud/vertexai`,
  `@aws-sdk/client-bedrock-runtime`, `cohere-ai`, `@mistralai/mistralai`.
  LLM calls auto-instrument once `trodo.init()` runs. Tool calls do NOT
  auto-instrument when using raw provider SDKs — wrap local tool execution
  with `trodo.tool()` or `trodo.withSpan({ kind: 'tool' })`. Wrap the outermost
  agent function with `wrapAgent` / `wrap_agent` so child LLM/tool spans
  attach to a run. Use when none of: Vercel AI SDK, OpenAI Agents SDK,
  LangChain, LlamaIndex, Haystack, MCP server.
---

# Trodo Tracing — Raw Provider SDKs

Focused recipe for code that calls provider SDKs directly without an agent framework owning the call site.

Full reference: [`../trodo-tracing/references/auto-instrumentation.md`](../trodo-tracing/references/auto-instrumentation.md), [`../trodo-tracing/references/manual-instrumentation.md`](../trodo-tracing/references/manual-instrumentation.md).

## 6-phase loop

### DETECT
- Imports: `from 'openai'`, `from '@anthropic-ai/sdk'`, `from '@google/generative-ai'`, `import boto3` + bedrock, `from cohere-ai'`, `from '@mistralai/mistralai'`.
- No framework imports (Vercel AI SDK / LangChain / etc.).
- Tool-use pattern: model returns a `tool_calls` array, app dispatches locally, sends results back.

### UNDERSTAND
**Auto-instrumentation works for the LLM call itself** once `trodo.init()` has run. Each provider request becomes an `llm` span automatically.

**Auto-instrumentation does NOT work for tool calls** in raw-SDK mode — there's no framework owning the dispatch loop, so Trodo can't see when "the tool runs." You must wrap the local tool execution manually.

### ANALYZE
- Wrap the **outermost agent function** with `trodo.wrapAgent('<agent_name>', fn, { distinctId })`. This creates the run that all child spans attach to.
- Wrap each **local tool execution** with `trodo.tool('<tool_name>', async () => { ... })` or `trodo.withSpan({ kind: 'tool', name: '<tool_name>' }, ...)`.
- LLM calls inside the wrapped agent auto-attach as child spans — do NOT add manual `trodo.llm()` wrappers.

### PLAN

```ts
import trodo from 'trodo-node';
import OpenAI from 'openai';

trodo.init({ siteId: process.env.TRODO_SITE_ID });

const openai = new OpenAI();

async function supportAgent(userMessage: string, userId: string) {
  return trodo.wrapAgent('support_agent', async () => {
    const resp = await openai.chat.completions.create({ ... });  // auto-instrumented LLM span

    for (const call of resp.choices[0].message.tool_calls ?? []) {
      const result = await trodo.tool(call.function.name, async () => {
        return runTool(call.function.name, JSON.parse(call.function.arguments));
      });
      // feed result back to the model...
    }
  }, { distinctId: userId });
}
```

### CONFIRM
Show the user:
- Where `wrapAgent` goes (outermost function).
- Which tool dispatches get wrapped.
- That LLM calls are auto-instrumented — no manual `llm()` calls needed.
- The `distinctId` source (delegated to `trodo-identify`).

### EXECUTE
Apply the diff. Verify in the Trodo dashboard: one run per agent invocation; LLM spans appear as children; tool spans appear as children.

## Critical pitfalls

- **Manual `trodo.llm()` wrappers on auto-instrumented providers** → double-counted spans. Just call the SDK normally inside `wrapAgent`.
- **Unwrapped tool execution** → tool calls appear in the LLM span's `output.tool_calls` but no tool span fires. Wrap with `trodo.tool()` to get the latency + I/O.
- **Streamed replies truncated.** `await` the full result before `setOutput` — never write partial text mid-stream.
- **Putting summaries in `setOutput`.** The full structured payload goes in output; short summaries belong in `setAttribute(...)`. The SDK caps at 64KB — don't pre-slice.
- **Pure-ESM Node (`"type": "module"`).** SDK ≥ 2.4.2 works inline; on ≤ 2.4.1 use `node --import register.mjs`.
