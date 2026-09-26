#!/usr/bin/env python3
"""Self-test for check_traces.py: build synthetic ideal ingest logs in every payload shape
and confirm the checker PASSES on them, and FAILS on a deliberately broken variant.

Usage: selftest_check_traces.py [--out-dir DIR]   (default: /tmp/python-multiagent-selftest)
"""
import argparse
import json
import os
import subprocess
import sys
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
CHECKER = os.path.join(HERE, "check_traces.py")

TURNS = [
    ("t-1", "alice", "hi, how long do refunds take?", "Refunds take 5 to 7 business days.", []),
    ("t-1", "alice", "what's the balance on my account 9001?", "Account 9001 has a balance of 142.5 USD.", ["get_account"]),
    ("t-1", "alice", "this is a complaint, open a ticket", "I've opened ticket job-1 for you.", ["open_ticket"]),
    ("t-2", "bob", "do you support two-factor authentication?", "Yes, we support two-factor authentication.", []),
]
GEN = [("generate.email", "tell the customer their refund was approved"),
       ("generate.sql", "users who signed up in the last 7 days"),
       ("generate.summary", "We shipped a reliability update and cut support response times in half.")]


def rid():
    return "run_" + uuid.uuid4().hex[:12]


def span(run_id, kind, name, inp, out, **extra):
    return {"span_id": "sp_" + uuid.uuid4().hex[:10], "run_id": run_id, "span_type": kind, "name": name,
            "input": inp, "output": out, "started_at": time.time(), "ended_at": time.time() + 0.01, **extra}


def build_runs(broken=False):
    """Return list of (run_dict, spans) pairs modelling the intended run model."""
    out = []
    history = []
    complaint_id = None
    for cid, uid, msg, reply, tools in TURNS:
        r = rid()
        messages = [{"role": "system", "content": "You are a helpful support assistant."}] + history + [{"role": "user", "content": msg}]
        spans = [span(r, "retrieval", "retrieve_docs", msg, [{"id": "refunds"}])]
        if tools:
            spans.append(span(r, "llm", "ChatOpenAI", messages, {"tool_calls": [{"name": tools[0]}]}))
            if not (broken and tools[0] == "get_account"):
                spans.append(span(r, "tool", tools[0], {"account_id": "9001"} if tools[0] == "get_account" else {"summary": msg}, {"ok": True}))
        spans.append(span(r, "llm", "ChatOpenAI", messages, reply))
        run = {"run_id": r, "agent_name": "support-assistant", "status": "ok", "input": {"messages": messages},
               "output": reply, "conversation_id": cid, "distinct_id": uid}
        if "complaint" in msg:
            complaint_id = r
        history += [{"role": "user", "content": msg}, {"role": "assistant", "content": reply}]
        out.append((run, spans))
    # timeout turn
    r = rid()
    msg = "TIMEOUT_ME please tell me about refunds"
    out.append(({"run_id": r, "agent_name": "support-assistant", "status": "error", "input": {"messages": [{"role": "user", "content": msg}]},
                 "error_message": "OpenAITimeoutError: Request timed out.", "conversation_id": "t-3", "distinct_id": "carol"},
                [span(r, "retrieval", "retrieve_docs", msg, []),
                 span(r, "llm", "ChatOpenAI", msg, None, status="error", error="Request timed out.")]))
    # triage (worker process)
    r = rid()
    summary = "this is a complaint, open a ticket"
    out.append(({"run_id": r, "agent_name": "triage-ticket", "status": "ok", "input": {"summary": summary}, "output": {"category": "billing"},
                 "conversation_id": "t-1", "distinct_id": "alice", "parent_run_id": complaint_id},
                [span(r, "llm", "openai.chat.completions", "classify", "billing"),
                 span(r, "llm", "openai.chat.completions", "policy", "refund policy"),
                 span(r, "llm", "openai.chat.completions", "next action", "escalate")]))
    # generate x3
    for name, inp in GEN:
        r = rid()
        out.append(({"run_id": r, "agent_name": name, "status": "ok", "input": inp, "output": "some text"},
                    [span(r, "llm", "ChatOpenAI", inp, "some text")]))
    # reindex
    r = rid()
    out.append(({"run_id": r, "agent_name": "reindex-docs", "status": "running" if broken else "ok", "input": {"docs": 3}, "output": {"written": 3}},
                [span(r, "llm", "openai.chat.completions", f"doc {i}", "alpha, beta, gamma") for i in range(3)]))
    return out


def rec(method, path, body, site="sandbox-site"):
    return json.dumps({"ts": time.time(), "method": method, "path": path, "site_id": site, "body": body})


def shape_tree(runs):
    for run, spans in runs:
        yield rec("POST", "/api/v1/runs/ingest", {"run": {**run, "spans": spans}})


def shape_lifecycle(runs):
    for run, spans in runs:
        start = {k: v for k, v in run.items() if k not in ("status", "output", "error_message")}
        yield rec("POST", "/api/v1/runs/start", start)
        yield rec("POST", f"/api/v1/runs/{run['run_id']}/spans", {"spans": spans})
        end = {k: run[k] for k in ("status", "output", "error_message") if k in run}
        yield rec("POST", f"/api/v1/runs/{run['run_id']}/end", end)


def shape_runless(runs):
    # runs ingested as a batch without spans; spans appended separately, linked by run_id
    yield rec("POST", "/api/v1/runs/ingest", {"runs": [run for run, _ in runs]})
    for _, spans in runs:
        yield rec("POST", "/api/v1/spans/append", {"spans": spans})


def shape_camel(runs):
    # camelCase everywhere, spans nested in children, error under errorSummary
    def camel(d):
        m = {"run_id": "runId", "agent_name": "agentName", "conversation_id": "conversationId", "distinct_id": "distinctId",
             "parent_run_id": "parentRunId", "error_message": "errorSummary", "span_type": "type", "span_id": "spanId"}
        return {m.get(k, k): v for k, v in d.items()}
    for run, spans in runs:
        yield rec("POST", "/v1/ingest", [{**camel(run), "children": [camel(s) for s in spans]}])


def run_checker(path):
    p = subprocess.run([sys.executable, CHECKER, "--log", path], capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", default="/tmp/python-multiagent-selftest")
    args = ap.parse_args()
    os.makedirs(args.out_dir, exist_ok=True)
    cases = [("tree", shape_tree, False, 0), ("lifecycle", shape_lifecycle, False, 0),
             ("runless-spans", shape_runless, False, 0), ("camelCase-children", shape_camel, False, 0),
             ("broken-missing-tool-and-running", shape_tree, True, 1)]
    ok = True
    for name, shape, broken, want in cases:
        path = os.path.join(args.out_dir, f"ideal-{name}.jsonl")
        with open(path, "w") as f:
            for line in shape(build_runs(broken)):
                f.write(line + "\n")
        code, output = run_checker(path)
        verdict = "ok" if code == want else "UNEXPECTED"
        ok &= code == want
        print(f"[selftest] {name:36s} exit={code} (want {want}) {verdict}  -> {path}")
        if code != want:
            print(output)
        elif broken:
            fails = [l for l in output.splitlines() if l.strip().startswith("- ")]
            print("           detected: " + "; ".join(f.strip()[2:60] for f in fails))
    print("[selftest] " + ("ALL GOOD" if ok else "FAILED"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
