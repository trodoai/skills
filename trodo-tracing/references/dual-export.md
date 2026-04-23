# Dual export — Integration Notes

Targets `trodo-node` >= 2.1.0 and `trodo-python` >= 2.1.0.

Docs: `https://docs.trodo.ai/recipes/dual-export.md`.

---

## The problem

The user already runs OpenTelemetry — Honeycomb, Datadog, Grafana Tempo, Jaeger — and wants to add Trodo without tearing that down. The constraint: don't replace their global tracer provider.

Trodo's SDK doesn't claim ownership of the global provider. It registers its own span processor + exporter against whatever provider is active. Your existing exporter keeps receiving every span; Trodo's exporter receives the same spans in parallel. One network egress per exporter, both backends see identical `trace_id` / `span_id`.

---

## Pattern A — side-by-side (recommended)

Keep the user's OTel setup exactly as-is. Add Trodo after it.

### Node

```ts
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import trodo from 'trodo-node';

// 1. Existing OTel setup — unchanged.
const provider = new NodeTracerProvider();
provider.addSpanProcessor(
  new BatchSpanProcessor(
    new OTLPTraceExporter({ url: 'https://api.honeycomb.io/v1/traces' }),
  ),
);
provider.register();

// 2. Trodo attaches its own processor/exporter to the same provider.
trodo.init({ siteId: process.env.TRODO_SITE_ID! });

// 3. Instrument as normal. Every span reaches both backends.
await trodo.wrapAgent('support-bot', async () => {
  // ...
});
```

### Python

```python
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
import os, trodo

provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint="https://api.honeycomb.io/v1/traces")))
trace.set_tracer_provider(provider)

trodo.init(site_id=os.environ["TRODO_SITE_ID"])

with trodo.wrap_agent("support-bot") as run:
    ...
```

**Order matters.** The user's provider must be registered before `trodo.init()` runs. Otherwise Trodo falls back to creating its own provider and the user's exporter isn't wired up.

---

## What each backend sees

- **User's OTel collector.** Standard spans with `gen_ai.*` semantic-convention attributes. Existing dashboards keep working — no mapping changes.
- **Trodo.** The same spans, grouped into runs, with Trodo-specific rollups on top (tokens, cost, feedback, clusters, semantic search).

Both use the same `trace_id` / `span_id`, so you can cross-reference a run in Trodo against a trace in the user's OTel backend by copying the trace ID.

---

## Pattern B — forward through the existing OTLP collector

If the user would rather have all telemetry egress through their own collector and let it forward to Trodo (one network path instead of two), point an OTLP exporter at Trodo's ingest endpoint and drop Trodo's built-in exporter.

Trodo's OTLP endpoint:

- URL: `https://sdkapi.trodo.ai/otlp/v1/traces`
- Required header: `X-Trodo-Site-Id: <site-id>`

In the user's collector config (or an OTLP exporter pointed at Trodo), add a second pipeline that forwards everything to Trodo's endpoint with the site-ID header.

Note: the current `trodo-node` / `trodo-python` SDKs don't expose an `exporter: 'none'` config flag. For Pattern B, the Trodo-owned span processor still runs and sends spans. If that's not desired, skip `trodo.init()` entirely and rely on the user's OTLP forwarder — `wrapAgent` will not be available in that setup, and you're limited to whatever OTel semantic-convention instrumentation the user has configured.

If the user explicitly wants `wrapAgent`-style runs **and** a single egress path, prefer Pattern A — the doubled egress is tiny compared to maintaining a custom collector config.

---

## How to decide

| Situation | Pattern |
|---|---|
| User wants `wrapAgent` + existing Datadog/Honeycomb/Jaeger working unchanged. | **A** (side-by-side) |
| User is already standardised on a custom collector for egress + audit. | **B** (forward through collector) — no `wrapAgent`. |
| User asks to "add Trodo to an OTel-first codebase". | **A**. Default here. |

---

## Pitfalls

- **Calling `trodo.init()` before the user's provider is registered.** Trodo creates its own provider as a fallback, and the user's existing exporter never receives Trodo-instrumented spans.
- **Two `NodeTracerProvider` instances.** If existing code accidentally creates the provider twice, Trodo attaches to whichever one was registered most recently with `provider.register()`. Fix the duplication first.
- **Missing `X-Trodo-Site-Id` header in Pattern B.** Spans arrive at `sdkapi.trodo.ai` but get dropped — no site ID means nothing to route them to.
