"""Assistant tools.  open_ticket enqueues a triage job for the worker process."""
from langchain_core.tools import tool

from app.jobs.queue import enqueue

ACCOUNTS = {
    "9001": {"account_id": "9001", "owner": "alice", "balance": 142.50, "currency": "USD"},
    "9002": {"account_id": "9002", "owner": "bob", "balance": 8.00, "currency": "USD"},
}


@tool
def get_account(account_id: str) -> dict:
    """Look up an account by its numeric id and return balance details."""
    acct = ACCOUNTS.get(str(account_id))
    if not acct:
        return {"error": f"account {account_id} not found"}
    return acct


@tool
def open_ticket(summary: str) -> dict:
    """Open a support ticket with the given summary. Use for complaints."""
    # the caller injects thread/user via the module-level context
    ctx = _current_context
    job_id = enqueue("triage_ticket", {"summary": summary, "thread_id": ctx.get("thread_id"), "user_id": ctx.get("user_id")})
    return {"ticket_id": job_id, "status": "queued"}


_current_context = {}


def set_context(thread_id, user_id):
    _current_context.clear()
    _current_context.update({"thread_id": thread_id, "user_id": user_id})


TOOLS = [get_account, open_ticket]
TOOLS_BY_NAME = {t.name: t for t in TOOLS}
