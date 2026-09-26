"""Background worker: polls the file queue and runs the triage agent.

Run with `python -m app.jobs.worker` (a separate OS process from the web app).
"""
import sys
import time
from concurrent.futures import ThreadPoolExecutor

from app.jobs.queue import iter_new_jobs, write_result
from app.llm import MODEL, client

POLL_S = 0.5


def _raw_call(system: str, user: str) -> str:
    resp = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
    )
    return resp.choices[0].message.content or ""


def triage_ticket(payload: dict) -> dict:
    summary = payload["summary"]
    # 1) classify
    category = _raw_call(
        "Classify the support ticket into one of: billing, bug, feature, other. Reply with one word.",
        summary,
    )
    # 2) research: two calls in a thread pool
    research_prompts = [
        ("Find the relevant policy for this ticket.", summary),
        ("Suggest the next action for the support agent.", summary),
    ]
    with ThreadPoolExecutor(max_workers=2) as pool:
        research = list(pool.map(lambda p: _raw_call(*p), research_prompts))
    return {
        "category": category.strip(),
        "policy": research[0],
        "next_action": research[1],
        "thread_id": payload.get("thread_id"),
        "user_id": payload.get("user_id"),
    }


HANDLERS = {"triage_ticket": triage_ticket}


def main():
    seen = set()
    print("[worker] polling queue", flush=True)
    while True:
        for job in iter_new_jobs(seen):
            handler = HANDLERS.get(job["type"])
            if not handler:
                print(f"[worker] unknown job type {job['type']}", flush=True)
                continue
            print(f"[worker] running {job['type']} {job['id']}", flush=True)
            try:
                result = handler(job["payload"])
                write_result(job["id"], {"ok": True, "job": job, "result": result})
                print(f"[worker] done {job['id']}", flush=True)
            except Exception as exc:
                write_result(job["id"], {"ok": False, "job": job, "error": f"{type(exc).__name__}: {exc}"})
                print(f"[worker] failed {job['id']}: {exc}", file=sys.stderr, flush=True)
        time.sleep(POLL_S)


if __name__ == "__main__":
    main()
