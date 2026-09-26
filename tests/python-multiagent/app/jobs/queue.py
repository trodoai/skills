"""Tiny JSON-lines file queue shared between the web and worker processes."""
import json
import os
import time
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
QUEUE_DIR = os.path.join(ROOT, "queue")
JOBS_PATH = os.path.join(QUEUE_DIR, "jobs.jsonl")
RESULTS_DIR = os.path.join(QUEUE_DIR, "results")


def enqueue(job_type: str, payload: dict) -> str:
    os.makedirs(QUEUE_DIR, exist_ok=True)
    job_id = f"job-{uuid.uuid4().hex[:12]}"
    record = {"id": job_id, "type": job_type, "payload": payload, "enqueued_at": time.time()}
    with open(JOBS_PATH, "a") as f:
        f.write(json.dumps(record) + "\n")
    return job_id


def iter_new_jobs(seen: set):
    if not os.path.exists(JOBS_PATH):
        return
    with open(JOBS_PATH) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            job = json.loads(line)
            if job["id"] in seen:
                continue
            seen.add(job["id"])
            yield job


def write_result(job_id: str, result: dict):
    os.makedirs(RESULTS_DIR, exist_ok=True)
    with open(os.path.join(RESULTS_DIR, f"{job_id}.json"), "w") as f:
        json.dump(result, f, indent=2)
