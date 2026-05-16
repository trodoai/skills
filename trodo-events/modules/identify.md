---
name: trodo-identify
version: 2.0.0
last_updated: 2026-05-16
description: >-
  Wire Trodo's identity layer against the user identifier the app *already*
  uses — Clerk `user.id`, Supabase `auth.uid()`, NextAuth session sub, Auth0
  `useUser`, Firebase `user.uid`, custom JWT claim, plain email. Detects the
  auth provider, surfaces the candidate identifiers, asks the user to confirm,
  then wires `Trodo.identify()` into the post-login path and `Trodo.reset()`
  into logout. Use when the user asks to wire identify, fix split user profiles,
  align `distinctId` between browser and server, or asks "why are my server
  events showing as server_global". Never invents a new identifier just for
  analytics — profile fragmentation is hard to undo.
---

# Trodo Identify

Single-responsibility skill: pick the right `distinctId`, wire `identify` and `reset`, and propagate the id across the browser ↔ server boundary so events don't split into two profiles.

## 6-phase loop

### DETECT
Grep auth/session code. Cheat sheet:

| Signal | Auth provider |
|---|---|
| `@clerk/` imports, `useUser()` | Clerk → identifier `user.id` |
| `@supabase/supabase-js` + `auth.getUser()` | Supabase → identifier `user.id` (uuid) |
| `next-auth` / `getServerSession` | NextAuth → identifier `session.user.id` or `email` |
| `@auth0/nextjs-auth0` | Auth0 → identifier `user.sub` |
| `firebase/auth` | Firebase → identifier `user.uid` |
| JWT middleware, `req.user`, custom session | Custom → grep the JWT claim used elsewhere |

See [`../trodo-events/references/identify-and-auth.md`](../trodo-events/references/identify-and-auth.md) for per-provider hooks.

### UNDERSTAND
Decide: is there ONE obvious identifier the app already keys users by, or several candidates? Read DB models, ORM types, and where the user object is read at server boundaries. The right `distinctId` is whatever the app's own user table is keyed by.

### ANALYZE
- **Browser only** → `Trodo.identify(<id>)` in the auth callback, `Trodo.reset()` on logout.
- **Server only** → `trodo.forUser(<id>).identify(<id>)` in the login handler / request middleware.
- **Both** → same id on both ends, propagated via JWT claim, server-set cookie, or `X-Trodo-Distinct-Id` header. See [`../trodo-events/references/cross-boundary-identity.md`](../trodo-events/references/cross-boundary-identity.md).

### PLAN
Output, file-level:
- Which identifier (with the user's confirmation).
- Exact files to edit: auth callback / login handler / logout handler / SSR session-restore.
- Exact propagation mechanism for full-stack.
- People-properties starter set (`email`, `name`, `plan`, `created_at`, `last_login`) — ask user to add/remove.

### CONFIRM
Use `AskUserQuestion` (multi-choice) to confirm the identifier. Show candidates and recommend one. Never pick silently — imposing the wrong id is the most expensive mistake to undo.

> "Your app keys users by `user.id` (uuid) in `lib/auth.ts`. Use that as the Trodo `distinctId`? Recommend yes. Alternatives: `email`, or supply your own."

### EXECUTE
Edit the files in the plan. After EXECUTE, verify:
- `identify` is called *after* `init` resolves (browser: `await` the init promise).
- `reset()` is in the logout handler.
- Server emits use `trodo.forUser(id).track(...)` not bare `trodo.track(...)` — otherwise events fall back to `server_global`.

## Critical invariants

- **One identity source.** Whatever the app already keys users by IS the Trodo `distinctId`. Never introduce a new identifier just for analytics.
- **Browser ↔ server alignment.** The id passed to `Trodo.identify(X)` in the browser must equal the id passed to `forUser(X)` on the server.
- **Reset on logout.** Without it, the next login on the same browser inherits the previous user's anonymous distinct id.
- **Identify on session-restore.** Page refresh re-creates the browser SDK instance; call `identify` again on auth-state restore, not just on initial login.

## When users ask this skill directly

- *"Wire trodo identify against my Clerk session"* → straight to PLAN with Clerk-specific hooks.
- *"Why are my server events under `server_global`?"* → DETECT shows the server is calling `trodo.track()` without `forUser(id)`. PLAN: wrap server emissions, propagate id from request context.
- *"Two profiles for what should be one user"* → DETECT shows browser uses `email`, server uses `uuid`. PLAN: align on one (recommend whichever the auth provider issues).
