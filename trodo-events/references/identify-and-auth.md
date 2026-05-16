# Identify and Auth

Where `identify` goes, where `reset` goes, and — most importantly — **what to pass as the distinctId**.

## The golden rule

**Use whatever identifier the app already keys users by.** Do not impose email. Do not impose uuid. Read the app's existing auth / session / user-model code first, and match it.

### How to detect the app's identifier

Look for these in priority order:

1. **The user model primary key.** Open the user schema (Prisma, Mongoose, SQLAlchemy, Django models). If it's `id uuid` / `id int`, that's the identifier. If the model has no `id` and uses `email` as `@id`, use email.
2. **Session / JWT payload.** What does the auth middleware put on `req.user`? If `req.user.id` — use `id`. If only `req.user.email` is available — use email.
3. **Foreign-key references.** If every other table references `user_id` (uuid), that's the canonical identifier — even if the app displays emails to humans.
4. **Auth provider id.** Clerk `user.id`, Supabase `user.id`, Firebase `user.uid`, Auth0 `user.sub` — these are universally safe defaults when the app uses the provider's SDK directly.

When unclear, ask:

> "I see the user model uses `id` (uuid) as primary key but routes pass `email` to the frontend. Which should be the Trodo distinctId? They must match between client and server, so I want to confirm before wiring."

## Per-provider wiring

### Clerk (Next.js App Router)

```tsx
'use client';
import { useUser, useClerk } from '@clerk/nextjs';
import { useEffect } from 'react';
import Trodo from 'trodo';

export function TrodoIdentify() {
  const { user, isLoaded } = useUser();
  const { signOut } = useClerk();

  useEffect(() => {
    if (!isLoaded) return;
    if (user) {
      Trodo.identify(user.id); // or user.primaryEmailAddress?.emailAddress if that's what the app uses
    }
  }, [isLoaded, user?.id]);

  // wrap signOut if you want to intercept:
  // await Trodo.reset(); await signOut();
  return null;
}
```

Server-side (Route Handler):

```ts
import { auth } from '@clerk/nextjs/server';
import trodo from '@/lib/trodo';

export async function POST() {
  const { userId } = auth();
  if (!userId) return new Response('unauthorized', { status: 401 });
  const u = trodo.forUser(userId);
  await u.track('feature_used', { feature: 'export' });
  return Response.json({ ok: true });
}
```

### Supabase Auth

```ts
import { createClient } from '@supabase/supabase-js';
import Trodo from 'trodo';

const supabase = createClient(URL, ANON_KEY);

supabase.auth.onAuthStateChange(async (event, session) => {
  if (event === 'SIGNED_IN' && session?.user) {
    await Trodo.identify(session.user.id); // uuid
  }
  if (event === 'SIGNED_OUT') {
    await Trodo.reset();
  }
});

// On initial load, also fetch current session and identify:
const { data: { session } } = await supabase.auth.getSession();
if (session?.user) await Trodo.identify(session.user.id);
```

### NextAuth

```tsx
// app/providers/TrodoIdentify.tsx
'use client';
import { useSession } from 'next-auth/react';
import { useEffect } from 'react';
import Trodo from 'trodo';

export function TrodoIdentify() {
  const { data, status } = useSession();
  useEffect(() => {
    if (status === 'authenticated' && data.user) {
      Trodo.identify(String(data.user.id ?? data.user.email));
    }
  }, [status, data?.user?.id]);
  return null;
}
```

In the `signOut` handler: `await Trodo.reset(); signOut();`

### Auth0

```tsx
'use client';
import { useUser } from '@auth0/nextjs-auth0/client';
import { useEffect } from 'react';
import Trodo from 'trodo';

export function TrodoIdentify() {
  const { user } = useUser();
  useEffect(() => {
    if (user?.sub) Trodo.identify(user.sub);
  }, [user?.sub]);
  return null;
}
```

Logout: Auth0's default logout URL redirects away — add `Trodo.reset()` to the logout click handler *before* navigating.

### Firebase Auth

```ts
import { onAuthStateChanged } from 'firebase/auth';
import Trodo from 'trodo';

onAuthStateChanged(auth, async (user) => {
  if (user) await Trodo.identify(user.uid);
  else await Trodo.reset();
});
```

### Custom JWT (Express + React)

Client: identify right after the login API returns:

```ts
const res = await fetch('/api/login', { method: 'POST', body: JSON.stringify(creds) });
const { user, token } = await res.json();
localStorage.setItem('token', token);
await Trodo.identify(user.id);
```

Server: identify and track inside the login handler:

```js
app.post('/api/login', async (req, res) => {
  const user = await verifyCredentials(req.body);
  const token = signJwt({ userId: user.id });
  const u = trodo.forUser(user.id);
  await u.identify(user.id);
  await u.track('log_in', { login_method: 'password' });
  res.json({ user, token });
});
```

On app boot (page refresh), re-identify:

```ts
useEffect(() => {
  const token = localStorage.getItem('token');
  if (!token) return;
  fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } })
    .then((r) => r.json())
    .then((u) => Trodo.identify(u.id));
}, []);
```

### Passport / express-session

```js
app.post('/login', passport.authenticate('local'), async (req, res) => {
  const u = trodo.forUser(String(req.user.id));
  await u.identify(String(req.user.id));
  await u.track('log_in', { login_method: 'password' });
  res.redirect('/');
});

app.post('/logout', async (req, res) => {
  const id = req.user?.id;
  req.logout(async () => {
    if (id) await trodo.forUser(String(id)).track('log_out');
    res.redirect('/');
  });
});
```

## When to call identify

- **On successful login** — after the auth library confirms the user, inside the same handler / callback.
- **On session restore / page refresh** — inside the auth provider's "session loaded" hook (e.g. `onAuthStateChanged`, `useSession` becoming `authenticated`, `useUser` returning a user). Don't skip this — without it, events fire under the anonymous profile until the user logs in again.
- **On sign-up** — after the user is created. The SDK merges the anonymous profile into the newly-identified one automatically (if no events have been flushed yet).

## When to call reset

- **On logout** — before navigating away. After `reset`, subsequent events fire under a fresh anonymous id until the next `identify`.
- **Not on page refresh.** If a valid session is still active, you re-identify with the same id; `reset` would create an unnecessary new anonymous profile.

## People properties

Set properties that describe the user (email, name, plan, signup date, role):

```js
await trodo.forUser(user.id).people.set({
  email: user.email,
  name: user.name,
  plan: user.plan,
});
```

Use `set_once` for properties that should never overwrite (`signup_date`):

```js
await trodo.forUser(user.id).people.set_once({
  signup_date: new Date().toISOString(),
});
```

Set people properties on login, on profile update, and on upgrade events — wherever the underlying data changes.

## distinctId type — string everywhere

Always stringify. `123` (number) and `"123"` (string) become different profiles.

```js
trodo.forUser(String(user.id))  // ✅
trodo.forUser(user.id)          // risky if user.id is a number
```
