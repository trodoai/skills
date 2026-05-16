---
name: trodo-events-custom
version: 2.0.0
last_updated: 2026-05-16
description: >-
  Add or refine a custom Trodo event. Detects the app's domain (commerce /
  SaaS / content / marketplace / wallet) from the codebase, proposes
  snake_case verb-then-noun event names, picks the correct origin (UI →
  client, webhook/queue/cron → server) so events aren't dual-emitted, attaches
  the right `people.trackCharge` call on revenue events, and grep-scans for
  existing event-name variants before adding to prevent naming drift. Use when
  the user asks to track a specific event ("track `purchase_completed` when my
  Stripe webhook fires"), add a starter event set, or audit existing events
  for naming consistency.
---

# Trodo Events Custom

Single-responsibility skill: pick the right event name, pick the right origin, attach the right metadata, and don't drift the naming convention.

## 6-phase loop

### DETECT
- Grep the codebase for existing Trodo event calls: `.track('<name>')`, `trodo.track(...)`, `Trodo.track(...)`. Build the current event list.
- Grep for naming variants of the same concept: `user_signed_up`, `userSignedUp`, `signed_up`, `Signed Up`. Drift = the top source of "my funnel doesn't work" issues.
- Identify the trigger surface for the requested event: UI click? Server handler? Webhook? Cron? Queue consumer?

See [`../trodo-events/references/event-taxonomy.md`](../trodo-events/references/event-taxonomy.md).

### UNDERSTAND
Classify the event:

| Category | Examples | Origin |
|---|---|---|
| UI interaction | `button_clicked`, `modal_opened`, `feature_X_used` | Browser |
| Authoritative business event | `sign_up`, `subscription_started`, `purchase_completed` | Server (single source of truth) |
| Webhook-driven | `stripe_invoice_paid`, `github_pr_merged` | Server (webhook handler) |
| Scheduled / batched | `daily_summary_sent`, `cron_job_completed` | Server (cron / queue) |
| Hybrid (rare) | One-event-one-origin rule still applies — pick UI *or* server, not both |

### ANALYZE
- **Name**: snake_case, verb-then-noun. Reuse an existing name if the concept already exists. If a near-duplicate exists with the wrong casing, propose a rename and warn the user.
- **Origin**: pick exactly one. If the user wants both client-feedback and server-attribution, use *different* event names (e.g. `checkout_clicked` on client, `purchase_completed` on server).
- **Revenue events** also call `user.people.trackCharge(amount)` at the success point (not the intent point — checkout-page view is NOT success).
- **Properties**: pick from the request/session/payload, not from synthetic enrichment. Don't fetch from the DB just to attach properties.

### PLAN
File-level output:
- Final event name.
- File and line where it fires.
- Property bag (keys with example values).
- For revenue events: the `trackCharge` line.
- Any rename of an existing drift variant.

### CONFIRM
Show the user:
- The event name (with rename warning if applicable).
- The chosen origin (client vs server) and why.
- The property bag.

### EXECUTE
Edit the file. Verify:
- For browser events: not called from React render body — must be in a handler or `useEffect`.
- For server events: bound to a user (`trodo.forUser(id).track(...)`), not bare `trodo.track(...)`.
- For revenue: `trackCharge` is in the success handler, not the intent handler.

## Starter event sets by domain

Surface the right starter pack when the orchestrator routes here:

| Domain | Starter events |
|---|---|
| SaaS | `sign_up`, `log_in`, `log_out`, `feature_used`, `invite_sent`, `subscription_started`, `subscription_canceled` |
| E-commerce | `product_viewed`, `cart_updated`, `checkout_started`, `purchase_completed`, `refund_issued` |
| Content / media | `content_viewed`, `content_shared`, `content_favorited`, `subscription_started` |
| Marketplace | `listing_created`, `listing_viewed`, `offer_made`, `offer_accepted`, `transaction_completed` |
| Wallet / crypto | `wallet_connected`, `wallet_disconnected`, `transaction_signed`, `chain_switched` |

## Critical invariants

- **One event, one origin.** UI click → client. Webhook / cron → server. Never both.
- **snake_case verb_noun.** No drift. Scan for variants before adding.
- **`trackCharge` at success.** Inflated revenue is the #1 follow-up bug.
- **No render-body tracking.** React re-renders will fire the event N times.

## Direct invocation prompts

- *"Add a `purchase_completed` event when my Stripe webhook fires"* → server origin, attach `amount`, also call `trackCharge`.
- *"Track sign-ups, logins, and checkouts"* → starter SaaS pack, server-origin for `sign_up`/`log_in`, client for any UI variants.
- *"Why does my funnel show 0 for `sign_up`?"* → DETECT shows the code emits `signed_up`. Rename or alias.
