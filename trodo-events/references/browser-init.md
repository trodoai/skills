# Browser Init

How to install and initialize the `trodo` browser SDK per framework. The goal is: **one init call per page lifecycle, idempotent under hot reload and SSR, awaited before any `identify` / `track` call**.

## Install

Use the package manager the project already uses (see [`detect-stack.md`](./detect-stack.md)):

```bash
npm install trodo          # or pnpm add / yarn add / bun add
```

## Env var

Set `NEXT_PUBLIC_TRODO_SITE_ID` (Next.js) / `VITE_TRODO_SITE_ID` (Vite) / `REACT_APP_TRODO_SITE_ID` (CRA) — whichever prefix your bundler exposes to the client. The siteId is **safe to expose publicly** — that's how the browser identifies the site to Trodo. Add the same value to `.env.local` and to the deployment platform env config.

> Note: this differs from the `trodo-tracing` (agent analytics) skill, where the siteId is server-only because it's used by a Node process to export spans. Event tracking from the browser is inherently public — the embed snippet exposes the siteId too.

## The init pattern (applies everywhere)

```ts
import Trodo from 'trodo';

let initPromise: Promise<unknown> | null = null;

export function initTrodo() {
  if (typeof window === 'undefined') return null; // SSR guard
  if (!initPromise) {
    initPromise = Trodo.init({
      siteId: process.env.NEXT_PUBLIC_TRODO_SITE_ID!,
      autoEvents: true, // default page_view, session, etc.
    });
  }
  return initPromise;
}
```

Everywhere else:

```ts
await initTrodo();
await Trodo.identify(userId);
Trodo.track('log_in', { method: 'password' });
```

Store the promise in a module-scoped variable so hot reloads / multiple components all `await` the same in-flight init.

## Next.js App Router

`app/providers/TrodoProvider.tsx`:

```tsx
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

`app/layout.tsx`:

```tsx
import { TrodoProvider } from './providers/TrodoProvider';

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        <TrodoProvider>{children}</TrodoProvider>
      </body>
    </html>
  );
}
```

**Do not** put `Trodo.init` in a Server Component — it throws `ReferenceError: window is not defined` at render.

## Next.js Pages Router

`pages/_app.{js,tsx}`:

```tsx
import { useEffect } from 'react';
import Trodo from 'trodo';

let initPromise: Promise<unknown> | null = null;

export default function MyApp({ Component, pageProps }) {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!initPromise) {
      initPromise = Trodo.init({
        siteId: process.env.NEXT_PUBLIC_TRODO_SITE_ID!,
      });
    }
  }, []);
  return <Component {...pageProps} />;
}
```

## Vite (React)

`src/main.tsx`:

```tsx
import Trodo from 'trodo';

const initPromise = Trodo.init({
  siteId: import.meta.env.VITE_TRODO_SITE_ID,
  autoEvents: true,
});

// ReactDOM.render etc.
```

Vite runs top-level code only in the browser, so no `window` guard is needed (unless using Vite SSR).

## Create React App

`src/index.js`:

```js
import Trodo from 'trodo';

Trodo.init({
  siteId: process.env.REACT_APP_TRODO_SITE_ID,
  autoEvents: true,
});

// ReactDOM.render etc.
```

## Nuxt 3

`plugins/trodo.client.ts` (the `.client.ts` suffix ensures it only runs in the browser):

```ts
import Trodo from 'trodo';

export default defineNuxtPlugin(async () => {
  await Trodo.init({
    siteId: useRuntimeConfig().public.trodoSiteId,
    autoEvents: true,
  });
});
```

`nuxt.config.ts`:

```ts
export default defineNuxtConfig({
  runtimeConfig: {
    public: { trodoSiteId: process.env.NUXT_PUBLIC_TRODO_SITE_ID },
  },
});
```

## SvelteKit

`src/routes/+layout.svelte`:

```svelte
<script lang="ts">
  import { browser } from '$app/environment';
  import { onMount } from 'svelte';
  import Trodo from 'trodo';
  import { PUBLIC_TRODO_SITE_ID } from '$env/static/public';

  onMount(async () => {
    if (!browser) return;
    await Trodo.init({ siteId: PUBLIC_TRODO_SITE_ID, autoEvents: true });
  });
</script>

<slot />
```

## Plain HTML (no bundler)

```html
<!-- In <head>, before any code that calls Trodo.* -->
<script src="https://cdn.trodo.ai/trodo.min.js"></script>
<script>
  Trodo.init({ siteId: 'YOUR_SITE_ID', autoEvents: true });
</script>
```

Or if the user already has the snippet from the dashboard's Integrations → Snippet tab, just use that — it's equivalent.

## SSR / hydration gotchas

- `window`, `document`, `localStorage` are undefined during SSR. Always guard with `typeof window !== 'undefined'` or put init inside `useEffect` / `onMount`.
- Next.js App Router: wrapping the init in a `'use client'` component is the cleanest way. Do **not** try to call `Trodo.init` in a Server Component or at module top-level of a shared file that Server Components also import.
- Framework-specific "client-only" markers (`.client.ts` in Nuxt, `$app/environment → browser` in SvelteKit, `'use client'` in Next) exist precisely for this.

## Hot reload in dev

Dev servers re-execute modules on save. Without a guard, every save creates a new session. Fix options:

```ts
// Module-scoped — sticks across React re-renders but not full module reloads.
let initPromise: Promise<unknown> | null = null;

// Survives HMR — attached to globalThis.
declare global { var __trodoInit: Promise<unknown> | undefined; }
globalThis.__trodoInit ??= Trodo.init({ siteId });
await globalThis.__trodoInit;
```

Use the `globalThis` pattern if the module-scoped version still produces duplicate session warnings in dev.
