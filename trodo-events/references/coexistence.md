# Coexistence with Existing Analytics

When the target codebase already uses Mixpanel, Amplitude, PostHog, Segment, or Google Analytics, **install Trodo alongside without modifying the existing calls**. The user owns the decision to deprecate or dual-send.

## Detection rules

Grep for these in `package.json` / imports / script tags:

| Tool | Signals |
|---|---|
| **Mixpanel** | `mixpanel-browser`, `mixpanel` (Node), `mixpanel-python`, `<script src="...mixpanel.com/...">` |
| **Amplitude** | `@amplitude/analytics-browser`, `@amplitude/node`, `amplitude-python` |
| **PostHog** | `posthog-js`, `posthog-node`, `posthog-python` |
| **Segment** | `@segment/analytics-next`, `analytics-node`, `analytics-python`, `<script src="...segment.com/...">` |
| **Google Analytics** | `react-ga`, `react-ga4`, `gtag`, `window.dataLayer`, `<script src="...googletagmanager.com/...">` |
| **Heap** | `heap`, `window.heap` |
| **LogRocket / FullStory** | Session replay, not direct analytics — informational only |

## Non-invasive install rule

1. **Do not modify existing `.track()` / `.identify()` calls.** They belong to the existing tool.
2. **Add Trodo's `Trodo.init`, `identify`, and `track` as *parallel* calls.** Same event names are fine — both tools receive them.
3. **Do not attempt a wholesale migration** unless the user explicitly asks. The original analytics may be load-bearing for dashboards, alerts, or attribution.
4. **Warn once, clearly.** After installing, surface the double-tracking implication so the user can decide what to do.

## Warning the user

After installing Trodo alongside an existing tool, print a warning similar to:

> "I detected Mixpanel (`mixpanel-browser`) in this project. I've installed Trodo alongside it without modifying your Mixpanel calls. Both tools will receive the same events — this is fine for comparison but doubles your tracking volume. When you're ready to cut over to Trodo only, remove the Mixpanel `track`/`identify` calls. Let me know if you want help with that, or want a dual-send wrapper so you only call `track` once."

## The non-invasive pattern (client)

```ts
// Existing Mixpanel code — leave alone
import mixpanel from 'mixpanel-browser';
mixpanel.init(MP_TOKEN);
// ...
mixpanel.track('log_in', { method: 'password' });

// New Trodo code — add alongside
import Trodo from 'trodo';
await Trodo.init({ siteId: process.env.NEXT_PUBLIC_TRODO_SITE_ID });
// On login success:
await Trodo.identify(user.id);
await Trodo.track('log_in', { login_method: 'password' });  // same event, both destinations
```

## The non-invasive pattern (server)

Same: add a parallel Trodo import and a parallel `track` next to the existing one. Do not wrap or proxy unless asked.

## Optional: dual-send wrapper (only if user asks)

If the user wants to write one call that routes to both, propose a thin wrapper:

```ts
// lib/analytics.ts
import mixpanel from 'mixpanel-browser';
import Trodo from 'trodo';

export async function trackDual(event: string, props: Record<string, unknown>) {
  mixpanel.track(event, props);
  await Trodo.track(event, props);
}

export async function identifyDual(id: string) {
  mixpanel.identify(id);
  await Trodo.identify(id);
}
```

**Only write this if explicitly requested.** Don't rewrite every existing call site automatically — diffs that large are disruptive and easy to get wrong.

## One-event-one-origin still applies

The rule from `event-taxonomy.md` stands: if the browser emits `purchase_completed`, the backend must not also emit it — regardless of whether the existing tool is Mixpanel or not. Double-tracking from two tools is expected with coexistence; double-tracking from two origins (client + server) is a bug.

## Segment-specific note

If the app uses Segment as a *router* (all events go through Segment, which forwards to Mixpanel / Amplitude / etc.), the cleanest path is to **add Trodo as another downstream destination from Segment**, not to install the Trodo SDK directly. This is an infrastructure change the user must do in the Segment dashboard — out of scope for the skill to automate. Surface it as a recommendation.

## GA-specific note

Google Analytics is a different category (aggregate web analytics, not user-level event tracking). Coexistence is natural — GA handles pageview / acquisition, Trodo handles product / funnel / user-level. Usually no double-tracking concern because the events are different.

## Rollout sequence (for the user, after install)

1. Install Trodo alongside; let both tools run for ~1 week.
2. Compare daily active users, key funnel steps, revenue totals between the two dashboards.
3. If the numbers match, either keep both (redundancy) or switch fully to Trodo by removing the old SDK's calls.
4. Dashboards / alerts built on the old tool need to be rebuilt against Trodo before removing the old SDK.
