---
module: sessions
parent: trodo-events
---

# Sessions & Auto-events

How Trodo records browser sessions and which auto-events fire by default. This module is loaded by `trodo-events/SKILL.md` during EXECUTE — not invoked directly.

## What Trodo tracks automatically

When `Trodo.init({ siteId, autoEvents: true })` runs in the browser, the SDK emits a baseline event stream without further wiring:

| Auto-event | Fires when |
|---|---|
| `$pageview` | First load + every history-API navigation in SPAs (Next.js, React Router, Vue Router, etc.) |
| `$session_start` | First event in a session (idle gap > 30 min creates a new session) |
| `$session_end` | Inferred server-side from inactivity timeout |
| `$click` | Click on tagged elements (anchor, button, or `data-trodo-event`) — opt-in via init flag |
| `$form_submit` | Form submit on tagged forms — opt-in |
| `$server_error` (Node) | Uncaught exception + unhandledRejection — Node-side only |

The session is keyed by `distinctId` once `identify` has fired; before that, it's keyed by an anonymous cookie. The SDK merges anonymous → known on the first `identify` if the anonymous profile's first event hasn't yet flushed.

## What the install flow should do

1. **Enable `autoEvents: true`** on browser `init` unless the user has a strong reason to disable. It's the cheapest source of analytics signal.
2. **Set the session timeout** only if the app has a non-standard expectation (default is 30 min idle = new session). Pass `sessionTimeout: <ms>` to `init`.
3. **`Trodo.reset()` on logout** ends the current session for that distinctId; the next event creates a fresh session attributed to the next `identify`.
4. **Page-view tagging in Next.js App Router** — `$pageview` auto-fires on `router.push` / `router.replace` via the history API. No manual wiring needed. Pages Router behaves the same.
5. **SPA caveat — silent route changes via state replacement** (rare; some custom routers don't go through History API). If `$pageview` doesn't fire on route change, emit `Trodo.track('$pageview', { path: window.location.pathname })` manually in the route-change effect.

## Session metadata worth attaching

Recommend attaching the following on `identify` so sessions are queryable in the dashboard:

```ts
Trodo.identify(userId, {
  email,
  plan,                    // free / pro / enterprise — for plan-segmented funnels
  signup_date,             // for cohort analysis
  utm_source,              // marketing attribution carried from first touch
  referrer,                // first-touch referrer if you persist it
});
```

The first-touch attribution (`utm_source`, `referrer`) survives `reset()` only if the app re-applies them after the next `identify`. Pulling them from `localStorage` or a server-side first-touch table is the usual pattern.

## Cross-tab / cross-window sessions

The SDK keys session continuity off the browser-local distinct id (cookie + localStorage). Open tabs share a session as long as they share the cookie domain. Sessions DO NOT carry across browsers or devices — they re-merge into the same user profile via `identify`, but each device gets its own session record.

## Server-side sessions

`trodo-node` and `trodo-python` have no session concept of their own — server events bind to the `distinctId` passed via `forUser(id)` and attach to whatever browser session is currently open for that user (if any). For pure backend services with no browser (webhooks, queue consumers, cron), session aggregation happens at the dashboard layer keyed by `distinctId` + emit time.

## Pitfalls

- **`autoEvents: false` then complaining about empty dashboards.** Enable autoEvents unless privacy law forces otherwise.
- **Treating `$session_start` as a sign-up event.** Sign-up is `sign_up` (custom, server-authoritative). Session start is the visitor opening the app — pre-auth and post-auth both fire it.
- **Long-running tabs**. Trodo doesn't end a session client-side; the inactivity timeout is dashboard-inferred. A tab open for 8 hours with one click at the start and one click at the end = two sessions if the gap exceeded the timeout.
- **Forgetting `reset()` on logout** keeps the session attributed to the previous user until idle timeout. Always call `reset()`.
- **Re-emitting `$pageview` manually on Next.js** — the SDK already emits it via the History API. Manual re-emission double-counts.

## What the orchestrator should do

`trodo-install` should:
1. Default `autoEvents: true` in the proposed init.
2. Surface session-timeout as a question only if the app's domain suggests a non-default (B2B SaaS dashboards → longer; banking → shorter).
3. Recommend attaching `plan` / `signup_date` / `utm_source` in the `identify` people-properties step (delegated to `modules/identify.md`).
4. NOT add manual `$pageview` calls unless the SPA uses a non-History-API router.
