---
name: trodo-tracing-vercel-ai
version: 2.0.0
sdk_version_node: ">=2.1.0"
sdk_version_node_register_otel: ">=2.4.0"
last_updated: 2026-05-16
description: >-
  Add Trodo agent tracing to a Next.js / Vercel AI SDK app — the `@vercel/otel`
  or `instrumentation.ts` path. Prefers the env-var OTLP route (no Trodo SDK
  install required, `OTEL_EXPORTER_OTLP_ENDPOINT=https://sdkapi.trodo.ai` +
  `Authorization=Bearer <site_id>` + `experimental_telemetry.isEnabled: true`
  on every Vercel AI call), with `experimental_telemetry.metadata.userId` etc.
  mapping to runs. Use when `@vercel/otel` is in `package.json`, an
  `instrumentation.ts` / `instrumentation.js` file exists at the project root,
  or the app uses `generateText` / `streamText` from the `ai` package on
  Next.js. Handles the Edge-vs-Node-runtime split so `trodo-node` isn't
  imported at the top of `instrumentation.ts` (Edge bundler breaks).
---

# Trodo Tracing — Vercel AI SDK / @vercel/otel

Focused recipe for the Vercel AI SDK + Next.js path. Full reference: [`../trodo-tracing/references/vercel-ai-sdk.md`](../trodo-tracing/references/vercel-ai-sdk.md).

## 6-phase loop

### DETECT
- `@vercel/otel` in `package.json` **OR** root `instrumentation.ts` / `instrumentation.js` present.
- App uses `ai` package (`generateText`, `streamText`, `streamObject`).
- Next.js App Router or Pages Router (both supported).

### UNDERSTAND
This stack already speaks OTel. You should **not** install `trodo-node` if you can avoid it — env vars are enough. Trodo's `/v1/traces` endpoint accepts OTLP/protobuf and maps `ai.*` semconv to runs and spans automatically.

### ANALYZE
- **Path A (default, recommended): env-var-only.** No SDK install. Two env vars + `experimental_telemetry` on each Vercel AI call.
- **Path A+: register `@vercel/otel`.** If `instrumentation.ts` doesn't exist yet, create one that calls `registerOTel({ serviceName: '<app>' })`.
- **Edge-runtime safety.** Never `import trodo-node` at the top of `instrumentation.ts` — Next.js compiles for both runtimes and the Edge bundler can't resolve `@opentelemetry/sdk-node`. Use the dynamic-import split if Node-only logic is needed.

### PLAN
File-level diff:

```
# .env.local
OTEL_EXPORTER_OTLP_ENDPOINT=https://sdkapi.trodo.ai
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer ${TRODO_SITE_ID}"
```

```ts
// instrumentation.ts (create if missing)
import { registerOTel } from '@vercel/otel';
export function register() {
  registerOTel({ serviceName: 'support-bot' });
}
```

```ts
// Every Vercel AI call — pass metadata so runs are grouped.
const result = await generateText({
  model: openai('gpt-4o'),
  messages,
  experimental_telemetry: {
    isEnabled: true,
    metadata: {
      userId: session.user.id,    // → distinct_id
      sessionId: chatId,          // → conversation_id
      agentName: 'support_chat',  // → agent_name
    },
  },
});
```

### CONFIRM
Show the env vars, the (new or existing) `instrumentation.ts`, and every Vercel AI call that needs `experimental_telemetry.isEnabled: true`. Ask the user whether to opt-in only the entry agent or every call.

### EXECUTE
- Write env vars.
- Create / update `instrumentation.ts`.
- Add `experimental_telemetry` to the confirmed call sites.

## Edge-runtime pitfall (the critical one)

If you must do anything Node-specific in `instrumentation.ts`, **dynamic-import** it inside a runtime guard. Top-level imports are evaluated by the Edge bundler too:

```ts
// instrumentation.ts — top-level imports must stay Edge-safe.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const mod = await import('@/lib/node-instrumentation');
  await mod.registerNodeInstrumentation();
}
```

`serverExternalPackages` does NOT fix this — it's a Node-bundling option, not an Edge-bundling option.

## Critical pitfalls

- **`experimental_telemetry.isEnabled: true` is required on every call.** Forgetting it = zero spans. Single most common reason a Vercel AI app shows nothing in Trodo.
- **`NEXT_PUBLIC_TRODO_SITE_ID` is wrong here.** Site id for tracing is server-only. Use `TRODO_SITE_ID` in `.env.local` and read it on the server. (Events does it the other way — different concern.)
- **No double-init.** If `@vercel/otel` is already registered, don't call `trodo.init()` too — that creates a second tracer provider.
