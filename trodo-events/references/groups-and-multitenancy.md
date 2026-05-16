# Groups and Multi-tenancy

How to wire `set_group`, `add_group`, and `get_group().set_once()` for apps with teams, organizations, or workspaces.

## Concept

- A **user** belongs to one or more **groups**.
- The **group key** identifies the dimension (e.g. `team`, `organization`, `workspace`).
- The **group id** identifies the specific group within that dimension (e.g. `team_abc123`).
- `set_group(key, id)` sets the **primary / active** group for that key — events associate with this id.
- `add_group(key, id)` adds a membership without changing the active group — useful when the user belongs to multiple groups in the same dimension.
- `get_group(key, id).set(...)` / `.set_once(...)` enriches the group's own profile (plan, member count, etc.).

## When to call

**On login / session start**, after `identify`:

```js
const u = trodo.forUser(userId);
await u.identify(userId);
await u.set_group('team', String(activeTeamId)); // primary dimension
```

**When the user switches tenants / workspaces** (active group changes):

```js
await u.set_group('team', String(newTeamId));
```

**When the user belongs to multiple teams**, record the full list so you can query membership:

```js
for (const t of userMemberships) {
  await u.add_group('team', String(t.id));
}
```

**After `set_group`, enrich the group profile once** (plan, member count, created_at, etc.):

```js
const group = u.get_group('team', String(teamId));
await group.set_once({
  plan: team.plan_type,
  team_members: team.users.length,
  created_at: team.createdAt,
});
```

`set_once` means: don't overwrite if already set — safe to call every login without clobbering later explicit updates.

## Reference implementation — login + team sync (Node)

From the real Trodo dashboard codebase (`backend/services/trodoAnalytics.js`), this is the canonical shape:

```js
const GROUP_KEY = 'team';

async function syncTeamGroupsForUser(u, userId, activeTeamId) {
  const activeIdStr = String(activeTeamId);
  const fullTeam = await Team.findById(activeTeamId);
  if (!fullTeam) return;

  // Primary active group
  await u.set_group(GROUP_KEY, activeIdStr);

  // All memberships (enumerate so queries can filter by team)
  const memberships = await Team.findByUserId(userId);
  const seen = new Set();
  for (const t of memberships || []) {
    const gid = String(t.id);
    if (seen.has(gid)) continue;
    seen.add(gid);
    await u.add_group(GROUP_KEY, gid);
  }

  // Group profile — set_once so login doesn't clobber
  const memberCount = Array.isArray(fullTeam.users) ? fullTeam.users.length : 0;
  const plan = fullTeam.plan_type || 'FREE';
  const groupProfile = u.get_group(GROUP_KEY, activeIdStr);
  await groupProfile.set_once({ plan, team_members: memberCount });
}

// Login path:
const u = trodo.forUser(distinctId);
await u.track('log_in', { ... }, { category: 'auth' });
await u.people.set({ lastlogin: new Date().toISOString() });
if (defaultTeam?.id) await syncTeamGroupsForUser(u, userId, defaultTeam.id);

// Team-switch path:
await trodo.track(distinctId, 'team_switch', { to_team_id: team.id, from_team_id: prevTeamId });
await syncTeamGroupsForUser(u, userId, team.id);
```

## Python equivalent

```python
GROUP_KEY = "team"

def sync_team_groups(u, user_id, active_team_id):
    team = Team.find_by_id(active_team_id)
    if not team:
        return
    active_id = str(active_team_id)

    u.set_group(GROUP_KEY, active_id)
    for t in Team.find_by_user_id(user_id) or []:
        u.add_group(GROUP_KEY, str(t.id))

    group = u.get_group(GROUP_KEY, active_id)
    group.set_once({"plan": team.plan_type or "FREE", "team_members": len(team.users or [])})

# login path
u = trodo.for_user(distinct_id)
u.track("log_in", {...})
u.people.set({"lastlogin": datetime.utcnow().isoformat()})
if default_team_id:
    sync_team_groups(u, user_id, default_team_id)
```

## Browser equivalent

The browser SDK does not expose `set_group` / `people` / `get_group` directly — group membership is a server concern because it often requires reading the full membership list from the database. The pattern is:

1. Client calls `Trodo.identify(userId)`.
2. Client calls an authenticated backend endpoint (e.g. `/api/session-start`) right after.
3. The backend handler does `trodo.forUser(userId).set_group(...)` / `add_group(...)` / `get_group().set_once(...)`.

Don't try to smuggle full team lists into the browser just to set groups — it's a leak and it's slower.

## Multiple group dimensions

When the app has both team AND organization (e.g. multi-org SaaS where orgs contain teams):

```js
await u.set_group('organization', String(orgId));
await u.set_group('team', String(teamId));
```

Both are independent — events record both group associations. In the dashboard you can filter by either.

## Group switch on tenant swap

When a user switches between teams / orgs, call `set_group` again with the new id. You don't need to `remove_group` the old one — `set_group` replaces the active id for that key.

If you're modelling "the user left this team", use `remove_group(key, id)`:

```js
await u.remove_group('team', String(leftTeamId));
```

## Pitfalls

| Pitfall | Symptom | Fix |
|---|---|---|
| `set_group` called before `identify` | Group set on anonymous profile; disappears when user identifies | Always call after `identify` in the same handler |
| Group id type mismatch (number vs string) | Two group profiles for what should be one | Always `String(id)` |
| `people.set` on the group profile instead of `people.set_once` | Group plan / member count overwritten on every login | Use `set_once` for static metadata; use `set` only when the value is meant to update |
| Setting only the primary but not membership | Queries like "members of team X" miss users who have a different active team | Enumerate full membership and `add_group` each |
| Forgetting to update on team-switch | Events after switch still associate with old team id | Re-run `set_group` in the team-switch handler |
| Setting groups on the browser | Leaks membership data + doesn't always have full context | Do group wiring server-side |
