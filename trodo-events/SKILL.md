---
name: trodo-events
version: 2.0.0
sdk_version_node: ">=2.1.0"
sdk_version_python: ">=2.1.0"
sdk_version_browser: ">=1.0.12"
last_updated: 2026-05-16
description: >-
  Comprehensive Trodo events install. Detects frontend framework, backend
  runtime, auth provider, multi-tenancy model, and existing analytics, then
  installs the right SDK (client: `trodo` npm for bundler projects, `<script>`
  tag for plain HTML / CMS / no-build; server: `trodo-node` and/or
  `trodo-python` depending on where server events originate), wires `init`
  with SSR / hot-reload guards, runs `identify` against the app's *existing*
  user identifier (never invents a new one), wires `set_group` for multi-tenant
  apps, enables `autoEvents` for sessions / pageviews / clicks, and proposes a
  starter custom-event set tailored to the detected domain. Handles ongoing
  event-tracking tasks too. Use when the user asks to install Trodo, add
  Trodo to a Next.js / Express / FastAPI / Django / Flask app, track signups
  / logins / purchases / feature usage, wire `set_group`, add a custom event,
  or asks "why are my server events showing as server_global" or "how do I
  add a new custom event". Loads deep-dive modules at runtime — see the
  Modules section below.
---

# Trodo Events

> **This skill owns the full app-side install flow end-to-end.** Not a router —
> it executes the entire 6-phase loop
> (DETECT → UNDERSTAND → ANALYZE → PLAN → CONFIRM → EXECUTE) across every
> dimension of events install in one pass.
>
> ## Modules (loaded inline during the relevant phase, not separate skills)
>
> - [`modules/identify.md`](./modules/identify.md) — `distinctId` selection,
>   `identify` / `reset` wiring, cross-boundary id propagation,
>   per-auth-provider hooks (Clerk / Supabase / NextAuth / Auth0 / Firebase /
>   custom JWT).
> - [`modules/groups.md`](./modules/groups.md) — `set_group` / `add_group`,
>   group profile enrichment, hierarchy vs peers, multi-tenant signal table.
> - [`modules/custom-events.md`](./modules/custom-events.md) — event naming
>   (snake_case verb_noun), one-event-one-origin rule, revenue + `trackCharge`,
>   drift audit, domain-tailored starter packs (SaaS / e-commerce / content /
>   marketplace / wallet).
> - [`modules/sessions.md`](./modules/sessions.md) — `autoEvents`, `$pageview`,
>   session timeout, session metadata, first-touch attribution, cross-tab.
>
> Always execute the full flow on install. The user can opt out of individual
> phases at the CONFIRM step but the default is "do everything that
> everything else depends on" (identity + init-guards are non-negotiable).
> For agent-tracing (LLM / tool spans), see the sibling
> [`trodo-tracing`](../trodo-tracing/SKILL.md).
>
> ## Phase 0 always-on prerequisites
> 1. Capture site id (ask once if missing).
> 2. Identity source via [`modules/identify.md`](./modules/identify.md) — required for both events and tracing; never invent a new identifier.
> 3. `init` guards — one init per runtime (browser / Node / Python), SSR + hot-reload safe.

# Trodo Events

## Philosophy

You are an experienced Trodo integrator. Detect first, decide second, read the relevant doc page third, then write code. The docs are the reference; you are the judgment.

**Always:** detect → clarify if ambiguous → pick path → read the doc page → generate code → check pitfalls.

Keep three invariants in mind the whole way through:

1. **One `init` per runtime** — one browser `Trodo.init` call at app boot, one `trodo.init` module singleton on the Node server, one `trodo.init` at module load on Python. Hot-reloads and SSR both will try to re-run init; guard it.
2. **One identity source** — whatever the app already keys users by (email, internal uuid, Clerk `user.id`, Supabase `auth.uid()`, etc.) *is* the Trodo `distinctId`. Never introduce a new identifier just for analytics — that causes split user profiles and is very hard to reconcile later.
3. **One event-name convention** — `snake_case`, verb-then-noun (`log_in`, `checkout_started`, `purchase_completed`). Scan for existing event names before adding new ones so the same concept isn't logged under three spellings.

## How to access docs

Base URL: `https://docs.trodo.ai`

Use your available fetch/search tools (WebFetch, mcp_fetch, WebSearch, etc.) in this order:

**1. Start with the index.** Fetch the published list of pages: `https://docs.trodo.ai/llms.txt`. Use this to discover which page covers the topic; don't guess URLs.

**2. Fetch individual pages as markdown.** Append `.md` to any URL from the index: `https://docs.trodo.ai/events/identify.md`.

**3. Search as a fallback.** `site:docs.trodo.ai <query>` if you can't find it from the index.

Read the relevant page before writing code.

## Detect

Inspect imports, file structure, and auth wiring before deciding anything. See [`references/detect-stack.md`](./references/detect-stack.md) for the full signal table.

| Signal | How to detect |
|---|---|
| **Frontend framework** | `next.config.*` + `app/` = Next.js App Router · `next.config.*` + `pages/` = Next.js Pages Router · `vite.config.*` = Vite · `react-scripts` in `package.json` = CRA · `nuxt.config.*` = Nuxt · `svelte.config.*` = SvelteKit · plain `index.html` = static |
| **Backend runtime** | `express()` / `fastify()` / `NestFactory.create` = Node · `FastAPI()` / `Flask(__name__)` / Django `settings.py` = Python |
| **Auth provider** | `@clerk/` imports = Clerk · `@auth0/` or `useUser` from `@auth0/nextjs-auth0` = Auth0 · `next-auth` = NextAuth · `@supabase/supabase-js` + `auth.getUser()` = Supabase · `firebase/auth` = Firebase · JWT middleware / `req.user` / custom session = custom |
| **Multi-tenant signals** | `teamId` / `orgId` / `workspaceId` / `tenantId` in routes, session, or JWT claims · Prisma models named `Team` / `Organization` / `Workspace` · `useOrganization()` from Clerk |
| **Package manager** | `pnpm-lock.yaml` · `yarn.lock` · `package-lock.json` · `bun.lockb` · `poetry.lock` · `uv.lock` · `requirements.txt` |
| **Existing analytics** | `mixpanel-browser` / `mixpanel` · `@amplitude/` · `posthog-js` / `posthog-node` · `@segment/analytics-next` · `react-ga` / `gtag` · see [`references/coexistence.md`](./references/coexistence.md) |
| **SSR vs CSR** | Any `'use client'` directive, `useEffect`, or dynamic `ssr: false` import = mixed; raw `<script>` tags = CSR-only |

## Clarify

> **Ask before deciding.** Even when the codebase makes a choice look obvious, surface it as a confirmation with a recommendation. Imposing identifiers, groups, properties, or custom events is hard to undo later — one extra question now beats a data migration in three months.

Use `AskUserQuestion` when available for these confirmations (multi-choice with the recommendation as the highlighted default). Fall back to plain-text questions otherwise. Batch the always-ask questions below into a single round before writing any code.

### Always ask — even if signals look obvious

These four decisions must be user-confirmed before generating instrumentation code. Detect candidates first, then surface them with a recommendation.

**1. distinctId source.** Read the auth/session code, list every plausible identifier you see, and ask which to use. The chosen value flows into `Trodo.identify(...)` (browser), `trodo.forUser(id)` / `trodo.for_user(id)` (server), and any direct `track(distinct_id, ...)` calls. Template:

> "Your app keys users by `user.id` (uuid) in `lib/auth.ts`, and `user.email` is also on the session. Which should I use as the Trodo `distinctId`? **Recommend: `user.id`** because that's what your DB rows are keyed by. Alternatives: `email`, or supply your own."

**2. Group dimensions.** When team / org / workspace appear in routes, sessions, or schema, ask which is the primary Trodo group and what to do with the others:

> "I found `teamId` and `organizationId` on the session. Which is the primary Trodo group? Should the other be added as a secondary `add_group` dimension, or skipped?"

If you see no multi-tenant signals at all, still surface it once: "I see no team/org context in the codebase. Should I skip groups, or do you have a tenant dimension I missed?"

**3. User properties for `people.set`.** Propose a starter set with rationale, ask the user to add or remove:

> "On identify I'll set these on the people profile: `email`, `name`, `plan`, `created_at`, `last_login`. Any to remove? Anything from your User schema to add — e.g. `country`, `referrer`, `subscription_tier`, `wallet_address`?"

**4. Custom events.** Infer the domain (commerce / SaaS / content / marketplace / wallet-based / etc.) from the codebase, propose 5–8 events with a one-line rationale per event, and ask the user to add/remove. Template:

> "Based on this looking like a SaaS-with-payments app, I'd track:
> - `sign_up` — acquisition funnel start
> - `log_in` — engagement / DAU
> - `subscription_started` / `subscription_canceled` — revenue
> - `feature_X_used` — activation
> - `invite_sent` — virality
>
> Anything to remove? Anything domain-specific to add (e.g. `wallet_connected`, `model_switched`, `gift_redeemed`)?"

### Also ask when…

These are situational triggers — fire on top of the always-ask checklist when the signal is present:

- **Both a browser and a server are present** but it's unclear who should emit a given event (sign-up is server-authoritative; button clicks are client-authoritative — rule: **one event, one origin**, don't emit from both).
- **Multiple auth providers** appear in the codebase (e.g. `next-auth` + `@clerk/`). Pick the primary flow.
- **Existing analytics tool detected** — ask whether to install Trodo alongside (default), replace (warn loudly, out of scope), or dual-send.
- **Vague "just install" request** — combine with the always-ask checklist; don't write a single line until those four are confirmed.

## Decision tree

Check in this order — sequence matters.

### 1. Browser runtime present?

→ **YES:** Install `trodo` (browser). Add a single `Trodo.init({ siteId })` at app boot, guarded for SSR. Wire `Trodo.identify(id)` into the authenticated-user code path (post-login, session-restore on refresh). Wire `Trodo.reset()` into logout. Never call `identify` before `init` resolves — `await` it.

→ Read: [`references/browser-init.md`](./references/browser-init.md) and [`references/identify-and-auth.md`](./references/identify-and-auth.md).

### 2. Node backend present?

→ **YES:** Install `trodo-node`. Create a singleton module (`lib/trodo.js` or `server/analytics.ts`) that calls `trodo.init({ siteId })` once; the module's `import` idempotency is your guard. Every server event must be emitted via `trodo.forUser(distinctId).track(...)` — plain `trodo.track(...)` without a distinctId falls back to `server_global` (undesirable, see pitfalls).

→ Read: [`references/node-init.md`](./references/node-init.md).

### 3. Python backend present?

→ **YES:** Install `trodo-python`. Call `trodo.init(site_id=...)` at module load — Python import caching handles singleton-ness. Use `trodo.for_user(distinct_id).track(...)` or the direct `trodo.track(distinct_id, name, props)` form. Register `atexit.register(trodo.shutdown)` to flush.

→ Read: [`references/python-init.md`](./references/python-init.md).

### 4. Full-stack — how does distinctId cross the boundary?

→ The browser and the backend must agree on the same `distinctId` or user events appear under two different profiles. Pick one of: (a) the auth provider's user id inside a JWT / session cookie, (b) a server-set cookie the browser also reads, (c) a custom `X-Trodo-Distinct-Id` header forwarded on every request.

→ Read: [`references/cross-boundary-identity.md`](./references/cross-boundary-identity.md).

### 5. Auth wiring — where does `identify` go?

→ Identify fires once per session on successful auth, and once on session-restore (page refresh). `reset()` fires on logout. The exact hook differs per provider — see the per-provider table in [`references/identify-and-auth.md`](./references/identify-and-auth.md).

→ **Detect candidates, then ask the user to confirm** (per Clarify §1). Never pick silently — even when only one candidate appears, surface it for confirmation. Imposing an identifier is the single most expensive mistake to undo later (profile fragmentation, broken funnels, manual reconciliation). If the app keys users by email, propose email; if by uuid, propose uuid; if by Clerk `user.id`, propose that — but always with the user's explicit "yes".

### 6. Multi-tenant?

→ If team / org / workspace context exists, call `user.set_group('team', teamId)` right after `identify` (primary dimension). Add secondary dimensions with `add_group`. Enrich the group profile via `get_group('team', teamId).set_once({...})` — plan, member count, created_at.

→ Read: [`references/groups-and-multitenancy.md`](./references/groups-and-multitenancy.md).

### 7. Custom events — already confirmed at Clarify §4.

→ The starter event list is selected with the user during Clarify §4, not here. Apply the rules: snake_case verb-noun names, scan the codebase for existing variants before adding (don't drift `user_signed_up` vs `signed_up`), revenue events also call `people.trackCharge(amount)` at the success point.

→ Read: [`references/event-taxonomy.md`](./references/event-taxonomy.md).

### 8. Existing analytics detected?

→ Warn about double-tracking. Install Trodo alongside without modifying existing calls. Note one-event-one-origin rule still applies.

→ Read: [`references/coexistence.md`](./references/coexistence.md).

## Recipes

| Recipe | Pattern |
|---|---|
| Browser-only SPA | React/Vue/Svelte + Clerk or Supabase on the client only |
| Next.js full-stack (App Router) | Client Component init + API routes emit server events |
| Express + React | Separate client + server; cross-boundary `distinctId` via cookie/JWT |
| FastAPI + Vue | Same, Python backend |
| Server-only worker | Queue consumer, webhook handler, cron — no browser |
| Anonymous → identified | Track events before login, call `identify` on sign-up (SDK merges anonymous → known profile) |
| Migration (existing analytics) | Warn, install alongside, don't modify existing calls |

## Minimal install — what the generated code should look like

### Browser (Next.js App Router example)

```tsx
// app/providers/TrodoProvider.tsx
'use client';
import { useEffect } from 'react';
import Trodo from 'trodo';

let initPromise: Promise<unknown> | null = null;

export function TrodoProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!initPromise) {
      initPromise = Trodo.init({
        siteId: process.env.NEXT_PUBLIC_TRODO_SITE_ID!,
        autoEvents: true,
      });
    }
  }, []);
  return <>{children}</>;
}
```

Wire `Trodo.identify(<whatever the app uses as user.id>)` into your auth callback, and `Trodo.reset()` into logout. See [`references/identify-and-auth.md`](./references/identify-and-auth.md) for per-provider patterns.

### Node (Express + singleton module)

```js
// lib/trodo.js
const trodo = require('trodo-node');
trodo.init({ siteId: process.env.TRODO_SITE_ID, autoEvents: true });
module.exports = trodo;

// In your login handler (after authentication succeeds):
const trodo = require('./lib/trodo');
const user = trodo.forUser(session.userId);
await user.identify(session.userId);
await user.track('log_in', { login_method: 'password' }, { category: 'auth' });
await user.people.set({ email: session.email, lastlogin: new Date().toISOString() });
if (session.teamId) await user.set_group('team', String(session.teamId));
```

### Python (FastAPI + module-load init)

```python
# app/analytics.py
import os, atexit, trodo
trodo.init(site_id=os.environ["TRODO_SITE_ID"], auto_events=True)
atexit.register(trodo.shutdown)

# In your login endpoint (after authentication succeeds):
from app.analytics import trodo as _  # ensure init has run
u = trodo.for_user(session.user_id)
u.identify(session.user_id)
u.track("log_in", {"login_method": "password"})
u.people.set({"email": session.email})
if session.team_id:
    u.set_group("team", str(session.team_id))
```

Tell the user to set `NEXT_PUBLIC_TRODO_SITE_ID` (browser; siteId is a public client-side identifier — this differs from agent-tracing where the site id is server-only) and `TRODO_SITE_ID` (server). Both typically hold the same value. Grab it from [app.trodo.ai](https://app.trodo.ai) → your site.

## Critical constraints

Rules the docs mention that assistants routinely miss:

- **Browser init is async; `identify` and `track` should wait.** `await Trodo.init(...)` before any subsequent `Trodo.identify` / `Trodo.track` call. Store the init promise in a module-scoped variable so subsequent callers `await` the same promise rather than re-initialising.
- **One event, one origin.** If the browser emits `purchase_completed` on the success page, the server webhook must not emit it again. Rule of thumb: UI-triggered events → client; backend-authoritative events (webhooks, cron, queue consumers) → server. Don't dual-emit.
- **Server events need `forUser(distinctId)`.** `trodo.track(...)` without binding a user falls back to a synthetic `server_global` profile that you can't filter meaningfully. Always bind first: `trodo.forUser(id).track(...)` or use the direct `trodo.track(distinctId, name, props)` form.
- **Same distinctId browser ↔ server.** Whatever the browser calls `Trodo.identify(X)` with must match the `X` the server passes to `forUser(X)`, or events split across two profiles. Propagate via JWT claim, session cookie, or an explicit header. See [`references/cross-boundary-identity.md`](./references/cross-boundary-identity.md).
- **Next.js: init in a Client Component.** Calling `Trodo.init()` in a Server Component throws `window is not defined`. Put init inside a component marked `'use client'`, typically a top-level provider wrapped around `{children}` in `app/layout.tsx`. `NEXT_PUBLIC_TRODO_SITE_ID` for the browser; `TRODO_SITE_ID` for Route Handlers / server actions. The site id is safe to expose publicly — that's why the browser uses `NEXT_PUBLIC_`. (This differs from the `trodo-tracing` skill, which warns against `NEXT_PUBLIC_` — because there, siteId is used server-side only.)
- **`reset()` on logout.** Without it, the next user to log in on the same browser inherits the previous user's anonymous distinct id, polluting their profile.
- **Event-name consistency.** Before adding a new event, grep the codebase for variants (`user_signed_up`, `userSignedUp`, `signed_up`, `Signed Up`). Pick one — snake_case, verb-then-noun — and use it everywhere. Drift is the single biggest source of "my funnel doesn't work" issues.
- **Node vs Python API shape.** Node: `trodo.forUser(id).people.set({...})` (nested). Python: `user.people.set({...})` on a `for_user(id)` context, or the direct `trodo.people_set(id, {...})`. Don't cross-copy snippets between the two languages.
- **`set_group` must follow an active identify / track.** Group membership is stored against the current profile — set the group right after `identify` (or as part of the same login flow), otherwise the membership is recorded but never associated with downstream events.
- **`people.trackCharge` at the success point, not the intent point.** Call it in the payment-success handler (webhook, post-checkout redirect), not on the checkout-page view, or revenue inflates wildly.
- **Idempotent init across hot reload.** Dev servers reload modules; every reload will try to `init` again. Guard with a module-scoped boolean (`globalThis.__trodoInitialized`) or `sys.modules` check.
- **Never impose an identifier, group, user property, or event list.** Read the app's existing auth/session code to see what it keys users by, then **ask** which to use. Same for group dimensions, the `people.set` property bag, and the custom-event starter set — propose with a recommendation, let the user accept, modify, or override. Imposing email on an app that internally uses uuid causes profile-merge headaches later; imposing the wrong group dimension or a noisy property bag is harder to clean up than to get right the first time.

## Known pitfalls

| Pitfall | Symptom | Fix |
|---|---|---|
| `Trodo.init` in a Next.js Server Component | `ReferenceError: window is not defined` at build / render | Move init into a `'use client'` provider mounted in `app/layout.tsx` |
| No `await` on browser init before `identify` | `identify` silently queues, then fires against an uninitialised client | Store init promise; `await` it in every entry point that calls `identify` / `track` |
| No `Trodo.reset()` on logout | User B's events attributed to User A | Call `Trodo.reset()` in the logout handler; pair with `Trodo.identify()` on login |
| Double `Trodo.init()` (hot reload / SSR+CSR) | Duplicate session rows, warnings in dev | Module-singleton guard: `if (!globalThis.__trodo) { globalThis.__trodo = await Trodo.init(...) }` |
| Server `trodo.track()` without distinctId | Events land under `server_global` profile | Wrap all server emissions in `trodo.forUser(id).track(...)`; enforce via a helper module that throws if no id |
| `NEXT_PUBLIC_TRODO_SITE_ID` missing on client, set on server | Browser init fails silently, server events work | Copy the value to both envs (it's public-safe) |
| Event-name drift (`user_signed_up` vs `signed_up`) | Funnels break; `count(event='sign_up')` returns 0 | Grep for variants before adding; pick one snake_case verb_noun form |
| Browser emits `purchase_completed`, webhook also emits it | 2× revenue, 2× count | One event, one origin — UI → client; webhook → server; not both |
| `set_group` before `identify` | Group membership recorded but events unassociated | Call `set_group` *after* `identify` in the same handler |
| `people.trackCharge` on checkout-page view | Inflated revenue metric | Call only in the payment-success handler |
| Python `user.people.set` vs `user.people_set` | `AttributeError` | Context-bound is `user.people.set(...)`; the direct module-level form is `trodo.people_set(distinct_id, {...})` |
| Node `autoEvents: true` + you think it captures every error | Only `server_error` (uncaught exceptions + unhandled rejections) is auto-tracked — caught errors are not | Track caught errors explicitly via `user.captureError(err)` |
| `Trodo.track` inside React render body | Event fires on every re-render | Move into an event handler or `useEffect` with a stable dependency list |
| Existing Mixpanel / Amplitude left in place, Trodo added | Both fire for the same action | Warn user about double-tracking; don't touch the existing calls unless asked — see `references/coexistence.md` |
| Imposed email as distinctId on an app keyed by uuid | Profile fragmentation; impossible to reconcile later | Always detect the existing identifier first; match it |

## When things go wrong

Before suggesting code changes, check in this order:

1. **No events at all.**
   - Is `NEXT_PUBLIC_TRODO_SITE_ID` (browser) / `TRODO_SITE_ID` (server) set in the running process?
   - Has `Trodo.init` resolved? In dev, add a `console.log('trodo ready')` inside the `.then(...)`.
   - For short-lived scripts: call `await trodo.shutdown()` before exit, or events in the buffer get dropped.
2. **Events showing up under `server_global`.**
   - Server code is calling `trodo.track(...)` directly without binding a user. Switch to `trodo.forUser(id).track(...)` or pass distinctId explicitly.
   - distinctId is undefined/null at the call site — dig back to where the request arrives and make sure the auth middleware put the user on `req.user` / `session.user_id` before tracking runs.
3. **Two profiles for what should be one user.**
   - Anonymous → identified: make sure `identify` is called on sign-up (the SDK will merge if you identify before the anonymous profile's first event leaves the buffer).
   - Browser and server use different ids: align on a single id source (usually the auth provider's user id); propagate via JWT / cookie / header.
4. **`identify` appears to do nothing.**
   - Called before `init` resolved — `await` init first.
   - Called with `null` / `undefined` / empty string — guard with a truthy check.
5. **Group membership set but events don't show under the group.**
   - `set_group` was called before `identify`; reverse the order.
   - Group id type mismatch (e.g. `123` vs `"123"`) — always stringify.
6. **Duplicate events.**
   - Both client and server emit — pick one origin.
   - React component re-renders are calling `Trodo.track` from render body — move to handler / effect.

**If the user has the Trodo MCP connected**, query the last few events and profiles directly to confirm symptoms before writing code.

**Enable debug mode** (`trodo.init({ siteId, debug: true })`) for stderr logs of every API call and batch flush.

## Skill feedback

If the skill gives incorrect guidance, references a page that doesn't exist, or is missing a scenario you encountered — offer to submit feedback. See [`references/skill-feedback.md`](./references/skill-feedback.md).

Do **not** trigger feedback for issues with Trodo itself (the product) — only for issues with this skill's instructions.
