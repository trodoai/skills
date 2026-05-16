---
name: trodo-tracing-langchain
version: 2.0.0
sdk_version_node: ">=2.1.0"
sdk_version_python: ">=2.1.0"
last_updated: 2026-05-16
description: >-
  Add Trodo agent tracing to LangChain / LlamaIndex / Haystack codebases.
  These frameworks own the dispatch loop, so both LLM calls AND tool calls
  auto-instrument once `trodo.init()` runs — no manual `tool()` wrapping
  needed. Wrap the outermost agent / chain / pipeline entry function with
  `wrapAgent` so all the framework's internal spans attach to one run. Use
  when imports include `from langchain` / `from llamaindex` /
  `from llama_index` / `from haystack`, or when chains, query engines, or
  pipelines are the call shape.
---

# Trodo Tracing — LangChain / LlamaIndex / Haystack

Focused recipe for framework-owned dispatch where both LLM and tool spans auto-instrument.

Full reference: [`../trodo-tracing/references/auto-instrumentation.md`](../trodo-tracing/references/auto-instrumentation.md).

## 6-phase loop

### DETECT
- `from 'langchain'` / `from langchain.*` — LangChain (Node or Python).
- `from 'llamaindex'` / `from llama_index` — LlamaIndex.
- `from haystack` — Haystack (Python only).
- Chain / Agent / Tool / QueryEngine / Pipeline objects defined.

### UNDERSTAND
These frameworks own the entire dispatch loop. Trodo's auto-instrumentation hooks the framework's Tool/Agent/Chain base classes, so:
- LLM calls auto-instrument.
- Tool calls auto-instrument.
- Chain steps auto-instrument as nested spans.

The only thing you do is **`trodo.init()` once** and **wrap the outermost entry function** so spans attach to a run.

### ANALYZE
- Wrap the outermost chain `.invoke()` / `.run()` / agent `executor.invoke()` / query engine `.query()` / pipeline `.run()` call with `wrapAgent`.
- Do NOT add manual `trodo.tool()` or `trodo.llm()` wrappers — that double-counts.
- If multiple chains coexist (e.g. a router chain that calls sub-chains), `wrapAgent` only the outermost.

### PLAN

```python
import trodo
from langchain.agents import AgentExecutor

trodo.init(site_id=os.environ["TRODO_SITE_ID"])

executor = AgentExecutor(...)

@trodo.wrap_agent("support_agent")
def run(message: str, user_id: str):
    return executor.invoke({"input": message})
# trodo.wrap_agent picks up distinct_id from the function call context
```

```ts
import trodo from 'trodo-node';
import { AgentExecutor } from 'langchain/agents';

trodo.init({ siteId: process.env.TRODO_SITE_ID });

const executor = new AgentExecutor({ ... });

async function run(message: string, userId: string) {
  return trodo.wrapAgent('support_agent', async () => {
    return executor.invoke({ input: message });
  }, { distinctId: userId });
}
```

### CONFIRM
Show the user:
- Single `trodo.init()` call placement.
- Outermost entry function gets `wrapAgent`.
- Inner chain / tool / LLM spans auto-attach.
- `distinctId` source confirmed via `trodo-identify`.

### EXECUTE
Apply the diff. Verify in the dashboard: one run per invocation, chain steps appear as nested spans, tools as children, LLMs as children of the relevant chain step.

## Critical pitfalls

- **Adding manual `tool()` / `llm()` wrappers on top of framework auto-instrumentation** → double-counted spans.
- **Wrapping sub-chains as well as the outer chain** → two runs per request, the inner one orphaned. Wrap only the outermost.
- **LlamaIndex async query engines** → `wrapAgent` must `await` the async call; sync wrapping silently completes the span before the work finishes.
- **Pure-ESM Node** → SDK ≥ 2.4.2 inline; older needs `--import register.mjs`.
