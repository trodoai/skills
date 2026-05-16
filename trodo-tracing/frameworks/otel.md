---
name: trodo-tracing-otel
version: 2.0.0
sdk_version_node_register_otel: ">=2.4.0"
sdk_version_python: ">=2.1.0"
last_updated: 2026-05-16
description: >-
  Add Trodo agent tracing to a codebase that ALREADY has an OTel pipeline —
  Datadog, Jaeger, Honeycomb, Grafana, or any custom OTLP exporter. Uses
  `registerOTel({ mode: 'otlp' })` on Node SDK 2.4.0+ (or the dual-export
  recipe on older SDKs) so Trodo observes via a parallel OTLP exporter without
  disturbing the existing pipeline. Use when the codebase imports
  `@opentelemetry/sdk-node`, has `NodeTracerProvider` / `TracerProvider` /
  `BatchSpanProcessor` / `OTLPTraceExporter`, or uses
  `tracer.start_as_current_span` (Python). Never replace the existing exporter
  — always add a parallel one.
---

# Trodo Tracing — Existing OTel Pipeline (Datadog / Jaeger / Honeycomb / custom)

Focused recipe for codebases that already speak OTel and just need Trodo as a parallel destination.

Full reference: [`../trodo-tracing/references/dual-export.md`](../trodo-tracing/references/dual-export.md), [`../trodo-tracing/references/cross-service.md`](../trodo-tracing/references/cross-service.md).

## 6-phase loop

### DETECT
- `@opentelemetry/` imports.
- `NodeTracerProvider`, `TracerProvider`, `BatchSpanProcessor`, `OTLPTraceExporter`.
- Python: `tracer.start_as_current_span`, `opentelemetry.sdk.trace`.
- Existing exporter destination: Datadog agent (`:4318`), Jaeger collector, Honeycomb (`api.honeycomb.io`), Grafana, custom.

### UNDERSTAND
The team already invested in OTel. The right answer is **add a parallel Trodo OTLP exporter**, not replace what's there. Spans will fan out to both destinations.

### ANALYZE
- **Node 2.4.0+** → `trodo.registerOTel({ mode: 'otlp' })` adds a parallel `BatchSpanProcessor` + `OTLPTraceExporter` pointing at Trodo. Existing exporter stays.
- **Node ≤ 2.3.x** → manual dual-export: construct a second `OTLPTraceExporter` with Trodo's endpoint + auth and add it to the existing provider.
- **Python** → add a second `BatchSpanProcessor` to the existing `TracerProvider` pointed at `https://sdkapi.trodo.ai`.

### PLAN

```ts
// Node 2.4.0+
import trodo from 'trodo-node';
trodo.init({ siteId: process.env.TRODO_SITE_ID });
trodo.registerOTel({ mode: 'otlp' });  // attaches to existing global provider
```

```python
# Python
from opentelemetry import trace
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

provider = trace.get_tracer_provider()
provider.add_span_processor(BatchSpanProcessor(
    OTLPSpanExporter(
        endpoint="https://sdkapi.trodo.ai/v1/traces",
        headers={"Authorization": f"Bearer {os.environ['TRODO_SITE_ID']}"},
    )
))
```

### CONFIRM
Show the user:
- That the existing exporter is untouched.
- The new parallel exporter is additive.
- Spans will appear in BOTH dashboards.

### EXECUTE
Apply the diff. Verify the existing pipeline still emits (don't break Datadog).

## Critical pitfalls

- **Never replace the existing exporter.** Add a parallel one.
- **Don't call `trodo.init()` AND register OTel twice** — `registerOTel({ mode: 'otlp' })` is the single integration point.
- **OTLP/HTTP vs OTLP/gRPC.** Trodo accepts OTLP/protobuf over HTTP at `/v1/traces`. Use the HTTP exporter, not gRPC.
- **Authorization header is `Bearer <site_id>`.** The site id IS the token — no separate API key.
