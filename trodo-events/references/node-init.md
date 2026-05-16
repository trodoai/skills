# Node Init

How to install and initialize `trodo-node` per runtime. Goal: **one `trodo.init()` per process, every event bound to a `distinctId` via `forUser`**.

## Install

```bash
npm install trodo-node       # or pnpm add / yarn add / bun add
```

## Env var

`TRODO_SITE_ID` — read only on the server. **Do not** prefix with `NEXT_PUBLIC_` for Node-side code; the browser and Node each read their own env.

If your codebase uses the same value on both sides (typical), set both:

```env
# .env
TRODO_SITE_ID=abc123...
NEXT_PUBLIC_TRODO_SITE_ID=abc123...
```

## Singleton pattern (the only pattern)

Create one module that does init and is imported everywhere else:

```js
// lib/trodo.js (CommonJS)
const trodo = require('trodo-node');

trodo.init({
  siteId: process.env.TRODO_SITE_ID,
  autoEvents: true, // captures server_error (uncaught exceptions + unhandled rejections) — not every caught error
  debug: process.env.TRODO_DEBUG === '1',
});

module.exports = trodo;
```

```ts
// lib/trodo.ts (ESM)
import trodo from 'trodo-node';

trodo.init({
  siteId: process.env.TRODO_SITE_ID!,
  autoEvents: true,
});

export default trodo;
```

Node's module cache ensures init runs once per process — subsequent `require('./lib/trodo')` returns the same module.

## The `forUser` wrapper — always use it

```js
const trodo = require('./lib/trodo');

// ✅ Bound to a user
const u = trodo.forUser(distinctId);
await u.track('checkout_started', { cart_value: 42.5 });
await u.people.set({ email, plan });

// ❌ Unbound — events land under `server_global`
await trodo.track('checkout_started', { cart_value: 42.5 });
```

Or the direct 3-arg form:

```js
await trodo.track(distinctId, 'checkout_started', { cart_value: 42.5 });
```

Wrap this in a small helper that throws if `distinctId` is missing — cheaper than debugging why events are under `server_global` two weeks later:

```js
function analytics(req) {
  const id = req.user?.id ?? req.session?.userId;
  if (!id) throw new Error('analytics() called without authenticated user');
  return trodo.forUser(String(id));
}

// usage
await analytics(req).track('log_in', { login_method: 'password' });
```

## Express

```js
// app.js
const express = require('express');
require('./lib/trodo'); // side-effect: runs init
const trodo = require('./lib/trodo');

const app = express();

app.post('/login', async (req, res) => {
  // ... authenticate ...
  const u = trodo.forUser(user.id);
  await u.identify(user.id);
  await u.track('log_in', { login_method: 'password' });
  await u.people.set({ email: user.email, lastlogin: new Date().toISOString() });
  res.json({ ok: true });
});
```

## Fastify

Same pattern. Register a plugin if you want a request-scoped helper:

```js
fastify.decorateRequest('analytics', null);
fastify.addHook('preHandler', async (req) => {
  if (req.user?.id) req.analytics = trodo.forUser(String(req.user.id));
});

// in a route:
await req.analytics?.track('feature_used', { feature: 'export' });
```

## NestJS

Wrap in an injectable provider:

```ts
// trodo.service.ts
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import trodo from 'trodo-node';

@Injectable()
export class TrodoService implements OnModuleDestroy {
  constructor() {
    trodo.init({ siteId: process.env.TRODO_SITE_ID! });
  }
  forUser(id: string) { return trodo.forUser(id); }
  async onModuleDestroy() { await trodo.shutdown(); }
}
```

## Next.js Route Handlers (App Router)

```ts
// app/api/checkout/route.ts
import trodo from '@/lib/trodo';

export async function POST(req: Request) {
  const { userId, cartValue } = await req.json();
  const u = trodo.forUser(userId);
  await u.track('checkout_started', { cart_value: cartValue });
  return Response.json({ ok: true });
}
```

Make sure `lib/trodo.ts` does `trodo.init` at module top level. Next.js caches the module per Node process.

## Next.js API Routes (Pages Router)

Same — import the singleton module and call `trodo.forUser(id).track(...)`.

## Standalone scripts / workers / queue consumers

Short-lived processes must flush before exit or events in the batch buffer get dropped:

```js
const trodo = require('./lib/trodo');

async function main() {
  const u = trodo.forUser('cron-job-runner');
  await u.track('nightly_rollup_completed', { rows: 123 });
}

main().finally(async () => {
  await trodo.shutdown(); // flushes the batch
});
```

For long-running workers, register a shutdown handler:

```js
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { await trodo.shutdown(); process.exit(0); });
}
```

## `autoEvents: true` — what it actually captures

Only `server_error`:
- uncaught exceptions (`process.on('uncaughtException')`)
- unhandled promise rejections (`process.on('unhandledRejection')`)

It does **not** capture every caught error. If you want to track a caught error:

```js
try {
  await risky();
} catch (err) {
  await trodo.forUser(userId).captureError(err, 'warning');
  throw err;
}
```

## CommonJS named-export gotcha

`trodo-node` ships a default export plus named exports (`forUser`, `track`, `propagationHeaders`, `joinRun`, etc.). With `require()`, both are available:

```js
const trodo = require('trodo-node');        // default export with methods
const { forUser } = require('trodo-node');  // named export
```

But if you do `const trodo = mod.default || mod;` you may lose the named exports that are attached only to the module namespace. When in doubt, use the default export and call `trodo.forUser(...)`.

## Debugging

- `debug: true` logs every API call, batch flush, and error to stderr.
- `TRODO_DEBUG=1` env var is the idiomatic way to toggle without code changes (pair with the config example above).
- If events don't arrive: enable debug, check for 4xx/5xx in logs, verify `TRODO_SITE_ID` is the right site from [app.trodo.ai](https://app.trodo.ai).
