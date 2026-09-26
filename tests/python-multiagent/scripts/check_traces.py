#!/usr/bin/env python3
"""Reconstruct runs + spans from mock/ingest-log.jsonl and assert the intended run model.

Tolerates every payload shape the SDK might emit:
  * full trees:      POST .../runs/ingest    {run:{...,spans:[...]}} | {runs:[...]} | [run,...] | run
  * lifecycle:       POST .../runs/start, POST .../runs/<id>/spans, POST .../runs/<id>/end
  * runless spans:   POST .../spans/append   {spans:[...]} | [span,...] | span   (span.run_id links it)
Field names are matched loosely (snake_case / camelCase / common synonyms).

Usage: check_traces.py [--log PATH] [--site-id ID] [--quiet]
Exit 0 when every assertion holds, 1 otherwise.
"""
import argparse
import json
import os
import re
import sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_LOG = os.path.join(ROOT, "mock", "ingest-log.jsonl")

TURNS = [
    ("refund", "t-1", "alice", "hi, how long do refunds take?"),
    ("account", "t-1", "alice", "what's the balance on my account 9001?"),
    ("complaint", "t-1", "alice", "this is a complaint, open a ticket"),
    ("2fa", "t-2", "bob", "do you support two-factor authentication?"),
    ("timeout", "t-3", "carol", "TIMEOUT_ME"),
]
GENERATE_KINDS = {
    "email": "tell the customer their refund was approved",
    "sql": "users who signed up in the last 7 days",
    "summary": "We shipped a reliability update",
}

AGENT_NAME_RULES = [
    ("triage", re.compile(r"triage", re.I)),
    ("reindex", re.compile(r"reindex|index", re.I)),
    ("generate", re.compile(r"email|sql|summar|generat", re.I)),
    ("assistant", re.compile(r"assist|chat|support", re.I)),
]

LLM_TYPES = {"llm", "chat", "chat_model", "chatmodel", "completion", "generation", "model", "llm_call"}
TOOL_TYPES = {"tool", "function", "tool_call", "function_call"}
RETRIEVAL_TYPES = {"retrieval", "retriever", "retrieve", "search", "rag", "vector_search", "document_search"}


# ----------------------------------------------------------------------------- helpers
def _snake(s):
    return re.sub(r"(?<!^)(?=[A-Z])", "_", s).lower()


def pick(d, *names, default=None):
    """Return the first present key among names, matching snake/camel variants and one level of nesting."""
    if not isinstance(d, dict):
        return default
    normalized = {_snake(k): v for k, v in d.items()}
    for n in names:
        key = _snake(n)
        if key in normalized and normalized[key] is not None:
            return normalized[key]
    # nested: e.g. {"error": {"message": "..."}} or {"metadata": {"distinct_id": ...}}
    for holder in ("metadata", "meta", "attributes", "attrs", "context", "properties", "tags"):
        inner = normalized.get(holder)
        if isinstance(inner, dict):
            found = pick(inner, *names, default=None)
            if found is not None:
                return found
    return default


def text_of(value):
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except Exception:
        return str(value)


def last_user_text(value):
    """If value is (or wraps) a chat message array, return the last role:user content; else the whole text."""
    msgs = None
    if isinstance(value, dict):
        for k in ("messages", "input", "prompt", "history"):
            v = pick(value, k)
            if isinstance(v, list):
                msgs = v
                break
        if msgs is None:
            for k in ("message", "query", "text", "question", "content", "input", "prompt"):
                v = pick(value, k)
                if isinstance(v, str):
                    return v
    elif isinstance(value, list):
        msgs = value
    if msgs:
        users = []
        for m in msgs:
            if not isinstance(m, dict):
                continue
            role = (pick(m, "role", "type") or "").lower()
            if role in ("user", "human"):
                users.append(text_of(pick(m, "content", "text")))
        if users:
            return users[-1]
    return text_of(value)


def looks_like_repr(s):
    return bool(re.search(r"<[\w.]+ object at 0x[0-9a-fA-F]+>", s)
                or re.match(r"^\s*[A-Z]\w*\(\s*\w+=", s)
                or re.match(r"^\s*content='", s))


def norm_status(s, ended):
    if s is None:
        return "ok" if ended else "running"
    s = str(s).lower()
    if s in ("error", "failed", "failure", "err", "exception"):
        return "error"
    if s in ("ok", "success", "succeeded", "completed", "complete", "done", "finished", "end", "ended"):
        return "ok"
    if s in ("running", "started", "start", "in_progress", "pending", "open"):
        return "running"
    return s


def span_kind(span):
    t = str(pick(span, "span_type", "type", "kind", "category", "op") or "").lower()
    name = str(pick(span, "name", "span_name", "label") or "").lower()
    if t in LLM_TYPES or re.search(r"chat_?openai|chatcompletion|openai|llm", name) and t in ("", "custom", "unknown"):
        return "llm"
    if t in TOOL_TYPES:
        return "tool"
    if t in RETRIEVAL_TYPES or (t in ("", "custom", "unknown", "step") and re.search(r"retriev|rag|search", name)):
        return "retrieval"
    if t in ("", "custom", "unknown", "step") and re.search(r"tool", name):
        return "tool"
    return t or "unknown"


# ----------------------------------------------------------------------------- model
class Run:
    def __init__(self, rid):
        self.id = rid
        self.name = None
        self.status_raw = None
        self.ended = False
        self.input = None
        self.output = None
        self.error = None
        self.conversation_id = None
        self.distinct_id = None
        self.parent_run_id = None
        self.spans = []
        self.sources = set()
        self.category = None
        self.label = None

    def absorb(self, obj, source):
        self.sources.add(source)
        name = pick(obj, "agent_name", "agent", "name", "run_name", "workflow")
        if isinstance(name, dict):
            name = pick(name, "name", "id")
        if name:
            self.name = str(name)
        st = pick(obj, "status", "state", "outcome")
        if st is not None:
            self.status_raw = st
        if source == "end" or pick(obj, "ended_at", "end_time", "finished_at", "completed_at", "end") is not None:
            self.ended = True
        for attr, keys in (
            ("input", ("input", "inputs", "prompt", "request", "messages")),
            ("output", ("output", "outputs", "response", "result", "reply", "completion")),
            ("conversation_id", ("conversation_id", "thread_id", "session_id", "conversation")),
            ("distinct_id", ("distinct_id", "user_id", "user", "end_user_id", "customer_id")),
            ("parent_run_id", ("parent_run_id", "parent_id", "parent", "parentRunId", "caller_run_id")),
        ):
            v = pick(obj, *keys)
            if isinstance(v, dict) and attr in ("distinct_id", "conversation_id", "parent_run_id"):
                v = pick(v, "id", "run_id")
            if v is not None and v != "":
                setattr(self, attr, v)
        err = pick(obj, "error", "error_message", "error_summary", "errorSummary", "errorMessage", "exception", "failure")
        if isinstance(err, dict):
            err = pick(err, "message", "summary", "text", "error") or text_of(err)
        if err:
            self.error = str(err)
            if st is None:
                self.status_raw = "error"

    @property
    def status(self):
        return norm_status(self.status_raw, self.ended)

    def spans_of(self, kind):
        return [s for s in self.spans if span_kind(s) == kind]


def flatten_spans(items, run_id=None):
    out = []
    for s in items or []:
        if not isinstance(s, dict):
            continue
        s = dict(s)
        if run_id and not pick(s, "run_id", "runId"):
            s["run_id"] = run_id
        out.append(s)
        for key in ("spans", "children", "steps", "child_spans"):
            kids = pick(s, key)
            if isinstance(kids, list):
                out.extend(flatten_spans(kids, run_id or pick(s, "run_id")))
    return out


def is_span_like(obj):
    return isinstance(obj, dict) and (
        pick(obj, "span_type", "span_id", "spanId", "parent_span_id") is not None
        or (pick(obj, "type", "kind") is not None and pick(obj, "agent_name", "spans", "distinct_id", "conversation_id") is None
            and str(pick(obj, "type", "kind")).lower() in LLM_TYPES | TOOL_TYPES | RETRIEVAL_TYPES | {"custom", "chain", "agent", "step"})
    )


def is_run_like(obj):
    return isinstance(obj, dict) and (
        pick(obj, "agent_name", "agentName", "spans", "status", "conversation_id", "distinct_id", "run_id", "runId") is not None
    ) and not is_span_like(obj)


def run_id_of(obj):
    return pick(obj, "run_id", "runId", "id", "trace_id", "traceId")


def extract_runs(body):
    """Yield run dicts (each with a flattened 'spans' list) from an ingest-shaped body."""
    if isinstance(body, list):
        for item in body:
            yield from extract_runs(item)
        return
    if not isinstance(body, dict):
        return
    for key in ("runs", "data", "items", "batch", "traces"):
        v = pick(body, key)
        if isinstance(v, list):
            for item in v:
                yield from extract_runs(item)
            return
    single = pick(body, "run", "trace")
    if isinstance(single, dict):
        run = dict(single)
        extra = pick(body, "spans")
        if isinstance(extra, list):
            run["spans"] = list(pick(run, "spans") or []) + extra
        yield run
        return
    if is_run_like(body):
        yield body


class Reconstruction:
    def __init__(self):
        self.runs = {}
        self.orphan_spans = []
        self.records = 0
        self.payloads = 0
        self.paths = defaultdict(int)
        self.site_ids = defaultdict(int)
        self.pending_spans = []

    def run(self, rid):
        rid = str(rid)
        if rid not in self.runs:
            self.runs[rid] = Run(rid)
        return self.runs[rid]

    def add_spans(self, spans, default_run_id=None):
        for s in flatten_spans(spans, default_run_id):
            self.pending_spans.append(s)

    def ingest_record(self, rec):
        self.records += 1
        body = rec.get("body")
        path = (rec.get("path") or "").lower()
        method = (rec.get("method") or "").upper()
        if body is None or method in ("GET", "OPTIONS"):
            return
        self.payloads += 1
        self.paths[f"{method} " + re.sub(r"(/runs?/)[^/]+(/)", r"\1<id>\2", rec.get("path") or "")] += 1
        self.site_ids[str(rec.get("site_id"))] += 1

        m_spans = re.search(r"/runs?/([^/]+)/spans?", path)
        m_end = re.search(r"/runs?/([^/]+)/(end|finish|complete|close)", path)
        m_start = re.search(r"/runs?/(start|begin|open|create)", path)
        if m_spans:
            rid = m_spans.group(1)
            self.run(rid).sources.add("spans")
            spans = pick(body, "spans", "data", "items") if isinstance(body, dict) else body
            if isinstance(spans, dict):
                spans = [spans]
            if isinstance(spans, list):
                self.add_spans(spans, rid)
            return
        if m_end:
            rid = m_end.group(1)
            self.run(rid).absorb(body if isinstance(body, dict) else {}, "end")
            if isinstance(body, dict) and isinstance(pick(body, "spans"), list):
                self.add_spans(pick(body, "spans"), rid)
            return
        if m_start:
            rid = run_id_of(body)
            if rid:
                self.run(rid).absorb(body, "start")
                if isinstance(pick(body, "spans"), list):
                    self.add_spans(pick(body, "spans"), rid)
            return
        if re.search(r"spans?(/append|/batch|/ingest)?$", path) and not re.search(r"runs?/(ingest|batch)", path):
            spans = pick(body, "spans", "data", "items") if isinstance(body, dict) else body
            if isinstance(spans, dict):
                spans = [spans]
            if isinstance(spans, list):
                self.add_spans(spans)
            elif is_span_like(body):
                self.add_spans([body])
            return
        # anything else: treat as an ingest tree (runs/ingest, /ingest, /v1/traces, ...)
        found = False
        for run_obj in extract_runs(body):
            found = True
            rid = run_id_of(run_obj)
            if not rid:
                rid = f"anon-{len(self.runs)+1}"
            r = self.run(rid)
            r.absorb(run_obj, "ingest")
            r.ended = True if pick(run_obj, "status") not in (None, "running", "started") else r.ended
            for key in ("spans", "children", "steps", "events"):
                if isinstance(pick(run_obj, key), list):
                    self.add_spans(pick(run_obj, key), rid)
        if not found and isinstance(body, dict):
            spans = pick(body, "spans")
            if isinstance(spans, list):
                self.add_spans(spans)

    def finalize(self):
        for s in self.pending_spans:
            rid = pick(s, "run_id", "runId", "trace_id", "traceId")
            if rid is not None and str(rid) in self.runs:
                self.runs[str(rid)].spans.append(s)
            else:
                self.orphan_spans.append(s)
        # runs that only ever appeared as span/end targets but were never started/ingested
        for r in self.runs.values():
            if r.sources <= {"spans"}:
                r.status_raw = r.status_raw or "running"


# ----------------------------------------------------------------------------- classification
def classify(run):
    name = run.name or ""
    for cat, rx in AGENT_NAME_RULES:
        if rx.search(name):
            return cat
    text = last_user_text(run.input).lower() + " " + text_of(run.input).lower()
    if "keywords" in text or "reindex" in text:
        return "reindex"
    if "classify" in text or "support ticket" in text or "next action" in text or "policy for this ticket" in text:
        return "triage"
    for kind, snippet in GENERATE_KINDS.items():
        if snippet.lower() in text:
            return "generate"
    for _label, _cid, _uid, msg in TURNS:
        if msg.lower() in text:
            return "assistant"
    return None


def match_turn(run):
    last = last_user_text(run.input).lower()
    for label, cid, uid, msg in TURNS:
        if msg.lower() in last:
            return label
    whole = text_of(run.input).lower()
    for label, cid, uid, msg in TURNS:
        if msg.lower() in whole:
            return label
    return None


def match_generate_kind(run):
    text = (run.name or "").lower() + " " + text_of(run.input).lower()
    for kind, snippet in GENERATE_KINDS.items():
        if kind in (run.name or "").lower() or snippet.lower() in text:
            return kind
    return None


def span_names(run, kind):
    return [str(pick(s, "name", "span_name", "tool_name", "function", "label") or "") for s in run.spans_of(kind)]


def has_tool_span(run, tool):
    for s in run.spans_of("tool"):
        if tool in text_of(s):
            return True
    return False


# ----------------------------------------------------------------------------- checks
class Checker:
    def __init__(self):
        self.failures = []
        self.notes = []

    def check(self, cond, msg):
        if not cond:
            self.failures.append(msg)
        return cond

    def note(self, msg):
        self.notes.append(msg)


def short(v, n=14):
    v = "" if v is None else str(v)
    return v if len(v) <= n else v[: n - 1] + "…"


def print_table(runs):
    cols = ["run_id", "agent", "name", "status", "conv", "distinct", "parent", "llm", "tool", "retr", "label", "error"]
    rows = []
    for r in sorted(runs, key=lambda r: (r.category or "zz", r.label or "", r.id)):
        rows.append([
            short(r.id), r.category or "?", short(r.name, 22), r.status, short(r.conversation_id, 8),
            short(r.distinct_id, 8), short(r.parent_run_id), str(len(r.spans_of("llm"))),
            str(len(r.spans_of("tool"))), str(len(r.spans_of("retrieval"))), r.label or "", short(r.error, 28),
        ])
    widths = [max(len(c), *(len(row[i]) for row in rows)) if rows else len(c) for i, c in enumerate(cols)]
    fmt = "  ".join("{:<%d}" % w for w in widths)
    print(fmt.format(*cols))
    print(fmt.format(*("-" * w for w in widths)))
    for row in rows:
        print(fmt.format(*row))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", default=DEFAULT_LOG)
    ap.add_argument("--site-id", default=os.environ.get("TRODO_SITE_ID", "sandbox-site"))
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(args.log):
        print(f"FAIL: ingest log not found at {args.log} (run ./scripts/drive.sh first) — 0 runs found")
        return 1

    rec = Reconstruction()
    bad_lines = 0
    with open(args.log) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec.ingest_record(json.loads(line))
            except json.JSONDecodeError:
                bad_lines += 1
    rec.finalize()

    print(f"ingest log: {args.log}")
    print(f"records={rec.records} payloads={rec.payloads} runs={len(rec.runs)} "
          f"spans={sum(len(r.spans) for r in rec.runs.values())} orphan_spans={len(rec.orphan_spans)} bad_lines={bad_lines}")
    if rec.paths:
        print("paths: " + ", ".join(f"{p} x{n}" for p, n in sorted(rec.paths.items())))
    if rec.site_ids:
        print("site_ids: " + ", ".join(f"{s} x{n}" for s, n in sorted(rec.site_ids.items())))

    if not rec.runs:
        print("\nFAIL: 0 runs found — nothing was ingested (app is not instrumented, or the SDK is not pointed at the mock)")
        return 1

    c = Checker()
    runs = list(rec.runs.values())
    for r in runs:
        r.category = classify(r)
    by_cat = defaultdict(list)
    for r in runs:
        by_cat[r.category].append(r)

    # ---- assistant
    assistant = by_cat["assistant"]
    for r in assistant:
        r.label = match_turn(r)
    c.check(len(assistant) == 5, f"expected exactly 5 assistant runs, found {len(assistant)}")
    turns = {}
    for r in assistant:
        if r.label:
            c.check(r.label not in turns, f"turn '{r.label}' matched more than one assistant run ({turns.get(r.label) and turns[r.label].id}, {r.id})")
            turns[r.label] = r
        else:
            c.check(False, f"assistant run {r.id} did not match any driven turn (input={short(text_of(r.input), 80)})")
    for label, cid, uid, msg in TURNS:
        r = turns.get(label)
        if not c.check(r is not None, f"no assistant run for turn '{label}' ({msg})"):
            continue
        c.check(str(r.conversation_id) == cid, f"[{label}] conversation_id={r.conversation_id!r}, expected {cid!r}")
        c.check(str(r.distinct_id) == uid, f"[{label}] distinct_id={r.distinct_id!r}, expected {uid!r}")
        inp = text_of(r.input)
        c.check(bool(inp.strip()), f"[{label}] input is empty")
        c.check(msg.lower() in inp.lower(), f"[{label}] input does not contain the user message {msg!r}")
        c.check(len(r.spans_of("llm")) >= 1, f"[{label}] expected >=1 llm span, got {len(r.spans_of('llm'))}")
        c.check(len(r.spans_of("retrieval")) >= 1, f"[{label}] expected >=1 retrieval span, got {len(r.spans_of('retrieval'))} (span kinds: {[span_kind(s) for s in r.spans]})")
        if label == "timeout":
            c.check(r.status == "error", f"[{label}] status={r.status!r}, expected 'error'")
            c.check(bool(r.error and r.error.strip()), f"[{label}] error message is empty")
        else:
            c.check(r.status == "ok", f"[{label}] status={r.status!r}, expected 'ok'")
            out = text_of(r.output)
            c.check(bool(out.strip()), f"[{label}] output is empty")
            c.check(not looks_like_repr(out), f"[{label}] output looks like a Python repr: {short(out, 60)}")
        if label == "account":
            c.check(has_tool_span(r, "get_account"), f"[account] no tool span for get_account (tool spans: {span_names(r, 'tool')})")
        if label == "complaint":
            c.check(has_tool_span(r, "open_ticket"), f"[complaint] no tool span for open_ticket (tool spans: {span_names(r, 'tool')})")
    t1 = [r for r in assistant if r.label in ("refund", "account", "complaint")]
    c.check(len({str(r.conversation_id) for r in t1}) == 1 and t1 and str(t1[0].conversation_id) == "t-1",
            f"the three t-1 turns do not share conversation_id 't-1': {[r.conversation_id for r in t1]}")

    # ---- triage
    triage = by_cat["triage"]
    for r in triage:
        r.label = "triage"
    c.check(len(triage) == 1, f"expected exactly 1 triage run, found {len(triage)}")
    if triage:
        t = triage[0]
        complaint = turns.get("complaint")
        linked_parent = complaint is not None and t.parent_run_id is not None and str(t.parent_run_id) == complaint.id
        linked_conv = str(t.conversation_id) == "t-1"
        if linked_parent:
            c.note("triage linked to complaint via parent_run_id (preferred)")
        elif linked_conv:
            c.note(f"triage NOT linked via parent_run_id (parent_run_id={t.parent_run_id!r}); linked only via conversation_id 't-1' (acceptable alternative)")
        c.check(linked_parent or linked_conv,
                f"triage run is linked to neither the complaint run (parent_run_id={t.parent_run_id!r}, complaint={complaint and complaint.id}) nor conversation 't-1' (conversation_id={t.conversation_id!r})")
        c.check(str(t.distinct_id) == "alice", f"triage distinct_id={t.distinct_id!r}, expected 'alice'")
        c.check(len(t.spans_of("llm")) >= 3, f"triage expected >=3 llm spans (1 classify + 2 thread-pool research), got {len(t.spans_of('llm'))}")
        c.check(t.status == "ok", f"triage status={t.status!r}, expected 'ok'")

    # ---- generate
    gen = by_cat["generate"]
    for r in gen:
        r.label = match_generate_kind(r) or "?"
    c.check(len(gen) == 3, f"expected exactly 3 generate runs, found {len(gen)}")
    names = {r.name for r in gen}
    c.check(len(names) == len(gen) and len(names) >= 3, f"generate runs must have three different names, got {sorted(map(str, names))}")
    for r in gen:
        c.check(len(r.spans_of("llm")) == 1, f"generate[{r.label}] expected exactly 1 llm span, got {len(r.spans_of('llm'))}")
        c.check(r.status == "ok", f"generate[{r.label}] status={r.status!r}")
        c.check(bool(text_of(r.output).strip()), f"generate[{r.label}] output is empty")
    c.check({r.label for r in gen} >= {"email", "sql", "summary"} or len(gen) != 3,
            f"generate runs do not cover email/sql/summary: {[r.label for r in gen]}")

    # ---- reindex
    ridx = by_cat["reindex"]
    for r in ridx:
        r.label = "reindex"
    total_llm = sum(len(r.spans_of("llm")) for r in ridx)
    if len(ridx) == 1:
        c.note("reindex modelled as 1 run with all 3 llm spans (preferred)")
        c.check(total_llm == 3, f"reindex run expected 3 llm spans, got {total_llm}")
    elif len(ridx) == 3:
        c.note("reindex modelled as 3 runs (one per doc) — acceptable alternative, report it")
        c.check(all(len(r.spans_of("llm")) == 1 for r in ridx), f"reindex 3-run shape expects 1 llm each, got {[len(r.spans_of('llm')) for r in ridx]}")
    else:
        c.check(False, f"expected 1 reindex run (or 3), found {len(ridx)}")
    for r in ridx:
        c.check(r.status == "ok", f"reindex run {r.id} status={r.status!r} (was it flushed before the process exited?)")

    # ---- global
    unclassified = by_cat[None]
    c.check(not unclassified, f"{len(unclassified)} run(s) could not be classified: {[(r.id, r.name) for r in unclassified]}")
    running = [r for r in runs if r.status == "running"]
    c.check(not running, f"{len(running)} run(s) still 'running' (never ended/flushed): {[(r.id, r.name) for r in running]}")
    c.check(not rec.orphan_spans, f"{len(rec.orphan_spans)} orphan span(s) reference no known run: {[short(text_of(s), 80) for s in rec.orphan_spans[:5]]}")
    if args.site_id:
        wrong = {s: n for s, n in rec.site_ids.items() if s != args.site_id}
        if wrong:
            c.note(f"site_id mismatch on some payloads (expected {args.site_id!r}): {wrong} — check header/body convention")

    print()
    print_table(runs)
    print()
    for n in c.notes:
        print(f"NOTE: {n}")
    if c.failures:
        print(f"\nFAIL ({len(c.failures)} assertion(s)):")
        for f_ in c.failures:
            print(f"  - {f_}")
        return 1
    print("\nPASS: run model matches (5 assistant, 1 triage, 3 generate, reindex flushed; no running runs, no orphans)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
