---
name: trodo-groups
version: 2.0.0
last_updated: 2026-05-16
description: >-
  Wire Trodo's group / multi-tenant layer. Detects `teamId` / `orgId` /
  `workspaceId` / `tenantId` in routes, sessions, JWT claims, Prisma models
  named `Team` / `Organization` / `Workspace`, and Clerk `useOrganization()`,
  then plans `set_group`, `add_group`, and `get_group().set_once()` wiring
  against the primary tenant dimension. Use when the user asks to add Trodo
  groups, set up multi-tenant analytics, wire `set_group` for teams or
  workspaces, enrich a group profile with plan / member-count / created_at,
  or asks why events aren't showing up under their team in Trodo.
---

# Trodo Groups

Single-responsibility skill: pick the primary group dimension, wire `set_group` right after `identify`, enrich the group profile, and (when relevant) layer secondary dimensions via `add_group`.

## 6-phase loop

### DETECT
Grep for multi-tenant signals:

| Signal | Indicates |
|---|---|
| `teamId` / `team_id` in routes, session, JWT | `team` group dimension |
| `orgId` / `organization_id` / `useOrganization()` (Clerk) | `organization` dimension |
| `workspaceId` / `workspace_id` | `workspace` dimension |
| `tenantId` / `tenant_id` | `tenant` dimension |
| Prisma models: `Team`, `Organization`, `Workspace`, `Tenant` | Schema-level tenant |
| Multiple of the above coexist | Pick primary; layer the rest with `add_group` |

See [`../trodo-events/references/groups-and-multitenancy.md`](../trodo-events/references/groups-and-multitenancy.md).

### UNDERSTAND
Determine the tenancy model: single dimension (just `teams`)? Hierarchical (`org` contains `teams`)? Flat-but-multi (`team` AND `workspace` are peers)? This shapes whether you use `set_group` once, `set_group` + `add_group`, or one primary plus secondaries.

### ANALYZE
- **No multi-tenant signal** → ask once whether the user has a dimension you missed; if no, skip groups.
- **One clear dimension** → `user.set_group('<name>', <id>)` right after `identify`.
- **Hierarchy** → primary is the most-specific dimension (usually `team` or `workspace`); secondary is the parent (`organization`) via `add_group`.
- **Peers** → ask which is primary; the others go via `add_group`.

### PLAN
File-level output:
- Primary group dimension name + id source.
- Where `set_group` is called — same handler as `identify`, immediately after.
- Group profile enrichment: `get_group('<name>', id).set_once({ plan, member_count, created_at })` — propose, ask the user to confirm/extend.
- Secondary `add_group` calls if applicable.

### CONFIRM
Surface dimension choice + property bag with `AskUserQuestion`:

> "I found `teamId` and `organizationId` on the session. Primary Trodo group = `team` (recommended) — `organization` added as secondary. Set on the group profile: `plan`, `member_count`, `created_at`. Add anything else?"

### EXECUTE
Edit the login handler (or post-identify hook). Verify:
- `set_group` fires *after* `identify`, not before — group membership is stored against the active profile.
- Group id is stringified (`String(teamId)`), not raw int — type mismatch silently breaks lookups.
- `set_once` (not `set`) for group enrichment unless the user wants every event to overwrite.

## Critical invariants

- **`set_group` must follow `identify`.** Before-identify ordering records the membership but doesn't associate downstream events.
- **Stringify group ids.** `123` ≠ `"123"` in group lookups.
- **One primary group per dimension name.** Re-calling `set_group('team', X)` overwrites; that's correct on team-switch.
- **`get_group().set_once` for enrichment.** Plan / member-count belong on the group profile, not the user profile.

## Direct invocation prompts

- *"Add `set_group` for my Clerk org"* → primary = `organization`, id = `org.id`.
- *"My events don't show under the team in Trodo"* → DETECT order of `set_group` vs `identify`; fix ordering or type.
- *"Enrich the team profile with plan and member count"* → straight to PLAN with `get_group('team', id).set_once({...})`.
