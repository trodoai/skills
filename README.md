# Trodo Skills

One repo. Agent Skills that teach AI coding assistants (Claude Code, Cursor, Windsurf, etc.) how to install [Trodo](https://trodo.ai) into any codebase — events, identity, groups, sessions, custom events, agent tracing — and, over time, how to *fix* Trodo integration issues like a developer would.

Consolidates and replaces the old two-repo split (`trodoai/skills` agent + `trodoai/skills-setup` events). One install command, two comprehensive master skills, one orchestrator.

## Install

```bash
# Installs the swarm into .claude/skills/ and .cursor/rules/
npx skills add trodoai/skills --all

# Equivalent — --all is the default
npx skills add trodoai/skills
```

Per-skill install also works (`npx skills add trodoai/skills --skill trodo-events`), but the design assumption is **install everything, dispatch on intent**.

## How to use

```text
"install trodo, siteId XXXX"                          → trodo-install runs both tracks
"install trodo events, siteId XXXX"                   → trodo-events comprehensive flow
"install trodo agent tracing"                         → trodo-tracing comprehensive flow
"add a `purchase_completed` event"                    → trodo-events (custom-events module)
"wire trodo identify against my Clerk session"        → trodo-events (identify module)
"add trodo alongside my Datadog OTel"                 → trodo-tracing (otel framework)
"trace my Vercel AI SDK app"                          → trodo-tracing (vercel-ai framework)
"trace my MCP server"                                 → trodo-tracing (mcp framework)
"why are my server events showing as server_global"   → trodo-events (identify module)
```

`/trodo-install`, `/trodo-events`, `/trodo-tracing` work as direct slash invocations too.

## Architecture

Every skill in this repo honors a single 6-phase contract:

```
DETECT  →  UNDERSTAND  →  ANALYZE  →  PLAN  →  CONFIRM  →  EXECUTE
```

- **`trodo-install`** is the orchestrator. It parses intent from the prompt, captures the site id, runs Phase 0 prerequisites (identity, init-guards), and delegates to one or both master skills. Never writes integration code.
- **`trodo-events`** is the **comprehensive events master**. End-to-end install: client (npm vs `<script>`), backend (Node / Python / both / skip), `init` guards, identify, groups, custom events, sessions. Sub-areas live as modules inside the skill — they're not separate top-level skills, because app-side install always wires them together.
- **`trodo-tracing`** is the **comprehensive tracing master**. Detects the LLM framework + existing OTel pipeline, loads exactly one inline framework module from `frameworks/`, wires `wrapAgent` + `distinctId` + run scope.

Identity and init-guards are **Phase 0 prerequisites** — always run unless the user opts out at CONFIRM.

## Skills

### `trodo-install` (orchestrator)

[`trodo-install/SKILL.md`](./trodo-install/SKILL.md) — intent parsing + multi-phase plan + confirmation + delegation.

### `trodo-events` (comprehensive events master)

[`trodo-events/SKILL.md`](./trodo-events/SKILL.md) — full app-side install.

Inline modules (loaded by the master during the relevant phase):

| Module | Owns |
|---|---|
| [`modules/identify.md`](./trodo-events/modules/identify.md) | `distinctId` selection, `identify` / `reset`, cross-boundary id propagation, per-auth-provider hooks |
| [`modules/groups.md`](./trodo-events/modules/groups.md) | `set_group` / `add_group`, group profile enrichment, multi-tenant signal table |
| [`modules/custom-events.md`](./trodo-events/modules/custom-events.md) | Event naming, one-event-one-origin, revenue + `trackCharge`, drift audit, domain-tailored starter packs |
| [`modules/sessions.md`](./trodo-events/modules/sessions.md) | `autoEvents`, `$pageview`, session timeout, first-touch attribution, cross-tab continuity |

Reference content under [`trodo-events/references/`](./trodo-events/references) is preserved from the original skill (browser-init, node-init, python-init, identify-and-auth, groups-and-multitenancy, event-taxonomy, coexistence, cross-boundary-identity, detect-stack, skill-feedback).

### `trodo-tracing` (comprehensive agent-tracing master)

[`trodo-tracing/SKILL.md`](./trodo-tracing/SKILL.md) — full tracing install. Detects framework + existing OTel pipeline, then loads one of:

| Framework module | Loaded when |
|---|---|
| [`frameworks/vercel-ai.md`](./trodo-tracing/frameworks/vercel-ai.md) | `@vercel/otel` or `instrumentation.ts` present (Next.js + Vercel AI SDK) |
| [`frameworks/otel.md`](./trodo-tracing/frameworks/otel.md) | Existing Datadog / Jaeger / Honeycomb / custom OTel pipeline |
| [`frameworks/langchain.md`](./trodo-tracing/frameworks/langchain.md) | LangChain / LlamaIndex / Haystack imports |
| [`frameworks/openai.md`](./trodo-tracing/frameworks/openai.md) | Raw `openai` / Anthropic / Gemini / Bedrock / Cohere / Mistral |
| [`frameworks/mcp.md`](./trodo-tracing/frameworks/mcp.md) | MCP server (`@modelcontextprotocol/sdk`) — runless `trackMcp` per `tools/call` |

Reference content under [`trodo-tracing/references/`](./trodo-tracing/references) is preserved (auto-instrumentation, manual-instrumentation, streaming, long-session, mcp-runless, dual-export, cross-service, vercel-ai-sdk, skill-feedback).

### Future: heal / developer skills

The same 6-phase contract applies to non-installation work. Planned top-level skills:

- `trodo-heal-missing-spans`
- `trodo-heal-server-global-events`
- `trodo-heal-double-tracking`
- `trodo-heal-init-loop`

Each will diagnose a symptom in real code, identify the broken invariant, propose a diff, confirm, apply. The orchestrator gains a diagnose-mode entrypoint (*"something is wrong with my Trodo setup, fix it"*) and routes to the right heal skill.

## Manifest

[`manifest.json`](./manifest.json) lists every skill, the modules inside each master, and the bundles: `all` (default), `events`, `agents`, plus a reserved `heal` slot.

## Versioning

All skills released together at `2.0.0` to mark the swarm consolidation. SDK version floors are unchanged from the previous single-skill repos.

## Feedback

If a skill gives wrong guidance or references a page that no longer exists, open an issue at [trodoai/skills/issues](https://github.com/trodoai/skills/issues). Product issues with Trodo itself belong in the [Trodo support channels](https://trodo.ai) instead.
