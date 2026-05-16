# Detect Stack

Signals to read off the codebase before deciding what to install and where. Always inspect first — don't guess from filenames.

## Frontend framework

| Signal | Framework |
|---|---|
| `next.config.{js,mjs,ts}` + `app/` directory | Next.js **App Router** |
| `next.config.{js,mjs,ts}` + `pages/` directory | Next.js **Pages Router** |
| Both `app/` and `pages/` | Mixed Next.js — init goes in App Router root; Pages Router still needs `_app.{js,tsx}` client init |
| `vite.config.{js,ts}` | Vite (React / Vue / Svelte / Solid — check `package.json` dependencies to disambiguate) |
| `react-scripts` in `package.json` | Create React App |
| `nuxt.config.{js,ts}` | Nuxt |
| `svelte.config.{js,ts}` | SvelteKit |
| `angular.json` | Angular |
| `remix.config.{js,ts}` | Remix |
| Plain `index.html` + `<script>` tags | Static / vanilla |

## Next.js router flavor

- **App Router (`app/`)** → init in a Client Component mounted in `app/layout.tsx`.
- **Pages Router (`pages/`)** → init in `pages/_app.{js,tsx}` inside `useEffect`.
- Look for `'use client'` directives — presence indicates App Router conventions are in use.

## Backend runtime

| Signal | Runtime |
|---|---|
| `express()` / `app.use(...)` | Express |
| `fastify()` | Fastify |
| `NestFactory.create(...)` / `@nestjs/` | NestJS |
| `export async function GET / POST` under `app/api/` | Next.js Route Handlers (App Router) |
| `export default function handler` under `pages/api/` | Next.js API Routes (Pages Router) |
| `FastAPI()` / `@app.get(...)` | FastAPI |
| `Flask(__name__)` | Flask |
| `django-admin` / `manage.py` / `settings.py` | Django |
| `celery` imports | Celery worker |
| No server code, just browser | SPA |

## Auth provider

Grep these imports / call patterns:

| Signal | Provider | Typical distinctId |
|---|---|---|
| `@clerk/nextjs`, `@clerk/clerk-react`, `useUser()` returning `user.id` | Clerk | `user.id` (Clerk's id, prefixed `user_...`) |
| `@auth0/nextjs-auth0`, `useUser()` returning `sub` | Auth0 | `user.sub` |
| `next-auth`, `getServerSession`, `useSession` | NextAuth | `session.user.id` (varies by provider config) |
| `@supabase/supabase-js`, `supabase.auth.getUser()` | Supabase | `user.id` (uuid) |
| `firebase/auth`, `onAuthStateChanged` | Firebase | `user.uid` |
| Custom JWT middleware attaching `req.user` | Custom | Whatever the `user` record keys on (check the user model) |
| Passport / express-session | Passport | `req.user.id` (check serializeUser) |

**Always read the app's existing user model first.** If the app stores users with `{ id: uuid, email }` and keys foreign keys on `id`, the distinctId is `id`. If the app keys on `email` (e.g. no uuid), use email. Never impose.

## Multi-tenant signals

| Signal | Group key |
|---|---|
| `teamId` in routes / JWT / session | `team` |
| `orgId` / `organizationId` | `organization` |
| `workspaceId` | `workspace` |
| `tenantId` | `tenant` |
| Prisma / ORM models named `Team`, `Organization`, `Workspace`, `Tenant` | Use model name lowercased |
| Clerk `useOrganization()` | `organization` |
| Multiple of the above → ask user which is primary; add others via `add_group` |

## Existing analytics tools

If any of these are imported or loaded via script tag, the install mode is **coexistence** — don't modify their calls. See [`coexistence.md`](./coexistence.md).

- `mixpanel-browser`, `mixpanel` (Node)
- `@amplitude/analytics-browser`, `@amplitude/node`
- `posthog-js`, `posthog-node`
- `@segment/analytics-next`, `analytics-node`
- `react-ga`, `react-ga4`
- `gtag`, `window.dataLayer` (GA4 / GTM)
- `heap` / `window.heap`

## Package manager

| Lockfile | Install command |
|---|---|
| `pnpm-lock.yaml` | `pnpm add trodo` / `pnpm add trodo-node` |
| `yarn.lock` | `yarn add trodo` / `yarn add trodo-node` |
| `package-lock.json` | `npm install trodo` / `npm install trodo-node` |
| `bun.lockb` | `bun add trodo` / `bun add trodo-node` |
| `poetry.lock` | `poetry add trodo-python` |
| `uv.lock` | `uv add trodo-python` |
| `requirements.txt` | `pip install trodo-python` (then add to file) |
| `Pipfile` | `pipenv install trodo-python` |

## SSR vs CSR

- **`'use client'` directive present** → mixed SSR+CSR (Next.js App Router). Init goes in a client-marked component.
- **`useEffect` everywhere, no `'use client'`** → likely Pages Router or CRA/Vite. Init inside `useEffect` is fine.
- **Plain `<script>` in HTML** → CSR only. No guard needed.
- **`getServerSideProps` / `getStaticProps`** → Pages Router SSR. Don't call `Trodo.init` from these.

## Session / refresh handling

After detection, confirm how the app re-establishes the user session on page refresh:

- Server-rendered session cookie → identify happens on `useEffect` once the client reads `/api/me` or similar.
- JWT in localStorage → identify happens on app-boot effect that reads localStorage.
- OAuth redirect flow → identify happens in the callback handler after token exchange.

This is where the `identify` call goes — not at the raw login form submit, but at the point the app considers the user "known".
