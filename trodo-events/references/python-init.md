# Python Init

How to install and initialize `trodo-python` per runtime. Goal: **one `trodo.init()` at module load, every event bound to a `distinct_id` via `for_user`, shutdown flushed on exit**.

## Install

```bash
pip install trodo-python       # or poetry add / uv add / pipenv install
```

## Env var

`TRODO_SITE_ID` — server-side only. Read with `os.environ[...]` or `os.getenv(...)`.

## Singleton pattern (module-load init)

Python caches imported modules, so a single `trodo.init()` at module-load time is idempotent:

```python
# app/analytics.py
import os
import atexit
import trodo

trodo.init(
    site_id=os.environ["TRODO_SITE_ID"],
    auto_events=True,
    debug=os.getenv("TRODO_DEBUG") == "1",
)

atexit.register(trodo.shutdown)  # flush on interpreter exit
```

Anywhere else:

```python
from app.analytics import trodo  # import triggers init once
```

## The `for_user` wrapper — always use it

```python
from app.analytics import trodo

# ✅ Bound to a user
u = trodo.for_user(distinct_id)
u.track("checkout_started", {"cart_value": 42.5})
u.people.set({"email": email, "plan": plan})

# ❌ Unbound — events land under `server_global`
trodo.track("checkout_started", {"cart_value": 42.5})
```

Or the direct 3-arg form:

```python
trodo.track(distinct_id, "checkout_started", {"cart_value": 42.5})
```

Wrap in a helper that throws if the caller forgets:

```python
# app/analytics.py (continued)
def analytics_for(request):
    user_id = getattr(request.state, "user_id", None) or request.session.get("user_id")
    if not user_id:
        raise RuntimeError("analytics_for() called without authenticated user")
    return trodo.for_user(str(user_id))
```

## FastAPI

```python
# app/main.py
from fastapi import FastAPI, Depends
from app.analytics import trodo, analytics_for

app = FastAPI()

@app.post("/login")
async def login(creds: LoginBody):
    user = authenticate(creds)
    u = trodo.for_user(str(user.id))
    u.identify(str(user.id))
    u.track("log_in", {"login_method": "password"})
    u.people.set({"email": user.email, "lastlogin": datetime.utcnow().isoformat()})
    if user.team_id:
        u.set_group("team", str(user.team_id))
    return {"ok": True}
```

## Flask

```python
# app/__init__.py
from flask import Flask
from app.analytics import trodo  # init fires on import

app = Flask(__name__)

@app.post("/login")
def login():
    user = authenticate(request.json)
    u = trodo.for_user(str(user.id))
    u.identify(str(user.id))
    u.track("log_in", {"login_method": "password"})
    return {"ok": True}
```

## Django

Put init in `settings.py` or a dedicated app's `apps.py → ready()`:

```python
# myapp/apps.py
from django.apps import AppConfig
import os
import atexit
import trodo

class MyAppConfig(AppConfig):
    name = "myapp"
    def ready(self):
        trodo.init(site_id=os.environ["TRODO_SITE_ID"])
        atexit.register(trodo.shutdown)
```

Usage in a view:

```python
import trodo

def login_view(request):
    # ... authenticate ...
    u = trodo.for_user(str(user.id))
    u.identify(str(user.id))
    u.track("log_in", {"login_method": "password"})
    return redirect("/")
```

## Celery workers

```python
# celery_app.py
from celery import Celery
from celery.signals import worker_process_init, worker_process_shutdown
import os, trodo

app = Celery("worker")

@worker_process_init.connect
def init_trodo(**_):
    trodo.init(site_id=os.environ["TRODO_SITE_ID"])

@worker_process_shutdown.connect
def shutdown_trodo(**_):
    trodo.shutdown()
```

Each worker process initializes its own Trodo client — do not share one across prefork processes.

## Scripts

```python
import trodo, os
trodo.init(site_id=os.environ["TRODO_SITE_ID"])

trodo.for_user("cron-nightly").track("rollup_completed", {"rows": 123})

trodo.shutdown()  # important — scripts exit fast, buffer may not have flushed
```

## Python API surface — the gotcha

Nested (context-bound) form and flat (module-level) form both exist:

| Nested (after `for_user`) | Flat (module-level) |
|---|---|
| `u = trodo.for_user(id)` then `u.track(...)` | `trodo.track(id, ...)` |
| `u.people.set({...})` | `trodo.people_set(id, {...})` |
| `u.people.set_once({...})` | `trodo.people_set_once(id, {...})` |
| `u.set_group(k, v)` | `trodo.set_group(id, k, v)` |
| `u.add_group(k, v)` | `trodo.add_group(id, k, v)` |

Pick one style per codebase and stick with it. The nested form reads better when multiple calls target the same user. Do **not** cross-copy Node snippets — Node uses `user.people.set(...)` (with the dot before `people`); Python's flat form uses `people_set` (underscore), not `people.set`.

## `auto_events=True` — what it captures

Only unhandled errors (uncaught exceptions registered via `sys.excepthook`). Not every `try/except`. Track caught errors explicitly:

```python
try:
    risky()
except Exception as e:
    trodo.for_user(user_id).capture_error(e, severity="warning")
    raise
```

## Debugging

- `debug=True` in `init(...)` logs every API call and batch flush to stderr.
- Set `TRODO_DEBUG=1` env var.
- If events don't arrive: enable debug, check for 4xx/5xx, verify siteId.
- For short scripts: always call `trodo.shutdown()` before exit, or events in the batch buffer get dropped silently.
