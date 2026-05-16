# Cross-boundary Identity

Keeping the same `distinctId` across browser + backend so events don't split across two profiles.

## The problem

- Browser does `Trodo.identify('user_abc')` → events go under profile `user_abc`.
- Backend does `trodo.forUser('user_abc').track(...)` → events go under the same profile.
- Backend does `trodo.track('purchase_completed', ...)` without binding a user → events go under the synthetic `server_global` profile. **This is the #1 cause of the "my server events are under `server_global`" complaint.**

The fix: **whatever identifier the browser uses, the backend must see the same value on every request**. Below are three patterns for propagating it.

## Pattern 1: JWT / session cookie contains the user id

Most apps already do this — the auth provider issues a cookie or JWT, and the server reads the user id out of it on every request.

**Client:**

```ts
const { user } = useAuth();
if (user) Trodo.identify(user.id);
```

**Server (Express middleware):**

```js
app.use((req, res, next) => {
  const token = req.cookies.session;
  const decoded = jwt.verify(token, SECRET);
  req.user = { id: decoded.userId };
  next();
});

app.post('/api/checkout', async (req, res) => {
  await trodo.forUser(req.user.id).track('checkout_started', { ... });
  res.json({ ok: true });
});
```

The browser and server agree because the cookie is the source of truth, and both sides read the same `userId` claim.

## Pattern 2: Explicit `X-Trodo-Distinct-Id` header

Useful when the client wants to track as the *anonymous* id before login (e.g. a pre-signup tour). The browser auto-assigns an anonymous id on `init`; pass it explicitly to the server so events from server-triggered actions (e.g. a webhook fired mid-tour) associate with the same anonymous profile.

**Client:**

```ts
const distinctId = await Trodo.getSessionData().then((s) => s.distinctId);

fetch('/api/trigger-demo-email', {
  method: 'POST',
  headers: { 'X-Trodo-Distinct-Id': distinctId },
});
```

**Server:**

```js
app.post('/api/trigger-demo-email', async (req, res) => {
  const distinctId = req.header('x-trodo-distinct-id') || req.user?.id;
  if (!distinctId) return res.status(400).json({ error: 'no identity' });
  await trodo.forUser(distinctId).track('demo_email_requested');
  res.json({ ok: true });
});
```

## Pattern 3: Server-set cookie readable by both sides

The server sets an analytics cookie on first visit; the client reads it for `identify` after init resolves.

```js
// server — auth callback
res.cookie('trodo_did', user.id, { httpOnly: false, sameSite: 'lax' });
```

```ts
// client
const did = document.cookie.match(/trodo_did=([^;]+)/)?.[1];
if (did) await Trodo.identify(did);
```

This keeps the browser and server on the same id even if the browser's anonymous assignment would have diverged.

## Anonymous → identified merge

When a user tracks events anonymously and then signs up:

1. Browser calls `Trodo.track('checkout_started', ...)` → event goes to anonymous profile.
2. User completes sign-up; the client calls `Trodo.identify('user_abc')`.
3. The SDK automatically merges the anonymous profile into `user_abc` — past events now show under the identified profile.

**For this to work, `identify` must be called before the anonymous profile is referenced elsewhere (e.g. by a server-side `forUser(anonymousId)` call).** In practice: do identify in the signup-success callback, before the first authenticated API call.

## Server-side-only flows (webhooks, cron, queues)

These have no browser to call `identify`. The distinctId must come from the business object:

```js
// Stripe webhook
app.post('/api/webhook/stripe', async (req, res) => {
  const event = stripe.webhooks.constructEvent(...);
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata.user_id;   // you put this in when creating the session
    await trodo.forUser(userId).track('purchase_completed', {
      order_id: session.id,
      amount: session.amount_total / 100,
      currency: session.currency,
    });
  }
  res.json({ received: true });
});
```

**When creating the Stripe session, pass `metadata: { user_id }` so the webhook can look it up.** Same principle for any third-party callback: store the distinctId on the outbound request so the callback knows who it's for.

## Avoiding `server_global`

`server_global` is the fallback profile when `trodo.track(...)` is called without binding a user. It usually means:

- The server handler didn't have a user in scope (e.g. a healthcheck-like endpoint that somehow still fires events).
- The auth middleware didn't run (e.g. an unauthenticated route doing analytics).
- The code did `trodo.track(eventName, props)` where the first arg is the event name, not a distinctId — confusing the 2-arg and 3-arg forms.

**Enforcement pattern:** wrap the analytics module so every entry requires a distinctId:

```js
// lib/analytics.js
const trodo = require('./trodo');

module.exports = function analytics(distinctId) {
  if (!distinctId) throw new Error('analytics() requires distinctId');
  return trodo.forUser(String(distinctId));
};

// usage
await analytics(req.user.id).track('checkout_started', { ... });
```

A call site missing an id fails loudly at dev time instead of silently landing in `server_global` weeks later.

## Id type discipline

Stringify everywhere. `123` !== `"123"` in Trodo's profile lookup.

```js
trodo.forUser(String(userId))
```

And stringify group ids too:

```js
u.set_group('team', String(teamId))
```
