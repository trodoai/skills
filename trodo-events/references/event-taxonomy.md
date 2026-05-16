# Event Taxonomy

Naming conventions, starter event sets, and when to use categories / revenue tracking.

## Naming convention: snake_case verb_noun

| ✅ | ❌ |
|---|---|
| `log_in` | `LogIn`, `logIn`, `Log In`, `user_logged_in` |
| `sign_up` | `signup`, `SignUp`, `registered` |
| `checkout_started` | `started_checkout`, `StartCheckout` |
| `purchase_completed` | `purchase`, `completed_purchase`, `orderPlaced` |
| `feature_used` | `used_feature`, `FeatureUsed` |
| `team_switch` | `switchTeam`, `team-switch` |

**Rules:**

1. **snake_case** — underscores, lowercase. Consistent with the SDKs' own server-side auto-events (`server_error`, `page_view`, `session_start`).
2. **verb-noun order.** The noun describes what changed, the verb what happened. `checkout_started` (not `started_checkout`) reads consistently in funnels.
3. **Past-tense or present-continuous, picked once.** `purchase_completed` past, `checkout_started` past — stay consistent. Don't mix `purchase_completes` with `checkout_started`.
4. **No user properties baked into event names.** Don't emit `premium_user_signed_up` and `free_user_signed_up` as separate events. Emit `sign_up` with a `plan: 'premium'` property instead. Dashboards can't aggregate across separate event names.

**Before adding a new event, grep the codebase.** Drift is the single biggest cause of broken funnels. If `log_in` already exists, don't add `login` or `user_login`.

## Starter event set (propose, confirm, add)

Based on the detected domain, propose 5–8 events. Confirm with the user before wiring.

### Every app

| Event | When | Properties |
|---|---|---|
| `sign_up` | New user record created | `signup_method`, `plan`, `referrer` |
| `log_in` | Session start after authentication | `login_method` (`password` / `google` / `otp` / `magic_link`) |
| `log_out` | Explicit sign-out | — |
| `feature_used` | A named feature is invoked | `feature` (e.g. `'export_csv'`, `'invite_member'`) |

### Commerce / subscription

| Event | When | Properties |
|---|---|---|
| `checkout_started` | User enters checkout flow | `cart_value`, `currency`, `item_count` |
| `purchase_completed` | Payment confirmed (usually webhook) | `order_id`, `amount`, `currency`, `items` |
| `subscription_started` | New subscription active | `plan`, `interval`, `amount` |
| `subscription_cancelled` | User / system cancelled | `plan`, `reason` |
| `refund_issued` | Refund processed | `order_id`, `amount` |

### SaaS

| Event | When | Properties |
|---|---|---|
| `invite_sent` | User invites a teammate | `role`, `invited_email_domain` |
| `invite_accepted` | Invitee completes signup | `inviter_user_id` |
| `team_switch` | User switches active workspace | `from_team_id`, `to_team_id` |
| `settings_updated` | Profile / workspace settings changed | `section`, `field` |
| `upgrade_clicked` | User clicks upgrade CTA | `from_plan`, `to_plan`, `location` |

### Content / media

| Event | When | Properties |
|---|---|---|
| `content_viewed` | Article / video loaded | `content_id`, `content_type`, `category` |
| `content_shared` | User shares | `content_id`, `channel` (`twitter` / `email` / ...) |
| `comment_posted` | Comment submitted | `content_id`, `comment_length` |
| `subscription_activated` | Paywall unlocked | `plan` |

### Marketplace

| Event | When | Properties |
|---|---|---|
| `listing_viewed` | Listing page loaded | `listing_id`, `category`, `price` |
| `listing_favorited` | Saved / liked | `listing_id` |
| `message_sent` | Buyer → seller message | `listing_id` |
| `offer_made` | Bid / offer submitted | `listing_id`, `amount` |

## Property conventions

- **snake_case** for property keys too.
- **Types are sticky.** If `plan` is a string (`'premium'`) everywhere, don't occasionally send it as an enum int `2`. Mixed types fragment the dashboard.
- **Money always in the same currency unit.** Pick dollars or cents, pick one, stick to it. Include `currency: 'USD'` as a property when amounts might be multi-currency.
- **IDs as strings.** `order_id: 'ord_abc'`, not `12345`. Numeric IDs get coerced inconsistently.
- **Timestamps as ISO 8601 strings** (`new Date().toISOString()`).
- **PII awareness** — don't send full credit card numbers, raw passwords, etc. Sending email and name is fine (they're on the user profile anyway via `people.set`).

## Categories

Pass `category` as the third `track` argument (Node/Python) to group events in the dashboard:

```js
await u.track('log_in', { login_method: 'password' }, { category: 'auth' });
await u.track('purchase_completed', { ... }, { category: 'commerce' });
await u.track('feature_used', { ... }, { category: 'product' });
```

Common categories: `auth`, `commerce`, `product`, `workspace`, `content`, `system`.

## Revenue tracking

On successful purchase, track the event **and** record the charge on the user profile:

### Node

```js
const u = trodo.forUser(customerId);
await u.track('purchase_completed', {
  order_id: order.id,
  amount: order.total,
  currency: order.currency,
  items: order.items.map((i) => ({ id: i.id, name: i.name, price: i.price })),
});
await u.people.trackCharge(order.total, { order_id: order.id, currency: order.currency });
```

### Python

```python
u = trodo.for_user(customer_id)
u.track("purchase_completed", {
    "order_id": order.id,
    "amount": order.total,
    "currency": order.currency,
})
u.people.track_charge(order.total, {"order_id": order.id, "currency": order.currency})
```

**Call from the success handler / webhook, not the checkout page view** — otherwise the user's lifetime revenue inflates by every checkout attempt.

## Where to emit each event

Apply the **one event, one origin** rule:

| Event | Origin | Why |
|---|---|---|
| `sign_up` | Server | Backend is authoritative — the user record is created there |
| `log_in` | Server (after auth succeeds) | Same reason; prevents fake client-side `log_in` spam |
| `log_out` | Client | Fires before the server hears about it; no harm if session also expired server-side |
| `checkout_started` | Client | UI-triggered; the server doesn't know until form submit |
| `purchase_completed` | Server (webhook) | Payment provider is the source of truth; client may have closed the tab |
| `feature_used` | Whichever side runs the feature | Usually client; server for API-only features |
| `settings_updated` | Server | Backend persists the change |

## Custom-event code template (Node)

```js
async function trackSignUp(user) {
  await trodo.forUser(user.id).track('sign_up', {
    signup_method: user.signup_method,
    plan: user.plan,
    referrer: user.referrer,
  }, { category: 'auth' });
}
```

## Custom-event code template (Python)

```python
def track_sign_up(user):
    trodo.for_user(str(user.id)).track(
        "sign_up",
        {
            "signup_method": user.signup_method,
            "plan": user.plan,
            "referrer": user.referrer,
        },
    )  # category support varies by version — consult docs if needed
```
