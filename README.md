# Trodo Agent Skills

Agent Skills that teach AI coding assistants (Cursor, Claude Code, Windsurf, etc.) how to correctly integrate [Trodo](https://trodo.ai) — agent analytics for LLM apps.

## Skills

| Skill | Description |
|---|---|
| [`trodo-tracing`](./trodo-tracing) | Integrate Trodo tracing into any codebase — detects language, framework, and existing OTel setup to pick the right integration path. |

## Installation

### skills CLI

```bash
npx skills add trodoai/skills --skill "trodo-tracing"
```

### Cursor

```bash
npx skills add trodoai/skills --skill "trodo-tracing" --target cursor
```

Or install manually into your project's `.cursor/rules/` directory:

```bash
mkdir -p .cursor/rules
curl -o .cursor/rules/trodo-tracing.md \
  https://raw.githubusercontent.com/trodoai/skills/main/trodo-tracing/SKILL.md
```

### Claude Code

```bash
npx skills add trodoai/skills --skill "trodo-tracing" --target claude
```

Or install manually:

```bash
git clone https://github.com/trodoai/skills.git
cp -r skills/trodo-tracing ~/.claude/skills/trodo-tracing
```

Per-project instead of global:

```bash
cp -r skills/trodo-tracing .claude/skills/trodo-tracing
```

## Usage

Once installed, the assistant uses the skill automatically when relevant. Some example prompts:

- "Add Trodo tracing to this application."
- "Wrap my agent function with Trodo and capture tool calls."
- "Why aren't my LLM calls showing up as child spans in Trodo?"
- "Add Trodo alongside my existing Datadog OTel setup."

The skill handles:

- Detecting language, framework, and existing OTel setup.
- Installing the right package (`trodo-node` or `trodo-python`).
- Adding `trodo.init()` in the right place with the right import order.
- Wrapping agent entry points with `wrapAgent` / `wrap_agent`.
- Picking manual instrumentation (`tool`, `llm`, `retrieval`, `trace`) only when needed — most providers auto-instrument.
- Debugging missing traces, missing child spans, empty outputs, open spans.

## Versioning

Skills are versioned alongside the Trodo SDK. When the SDK API changes, the skill is updated in the same PR so assistants always generate up-to-date code.

## Feedback

If the skill gives wrong guidance or references a page that no longer exists, open an issue: [trodoai/skills/issues](https://github.com/trodoai/skills/issues). Product issues belong in the [Trodo support channels](https://trodo.ai) instead.
