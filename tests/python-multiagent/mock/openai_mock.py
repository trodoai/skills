"""Deterministic OpenAI-shaped chat.completions mock (stdlib only).

Rules (evaluated on the request's `messages`):
  * any message content contains TIMEOUT_ME     -> sleep 3s, then respond normally
  * tools include get_account AND last user message contains "account"
    AND no tool result (role=tool) yet          -> tool_calls: get_account(account_id=<digits>)
  * tools include open_ticket AND last user message contains "complaint"
    AND no tool result yet                      -> tool_calls: open_ticket(summary=<message>)
  * otherwise                                   -> plain text answer
Supports stream=true (SSE chunks) and stream=false. Always includes usage.
"""
import json
import os
import re
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("OPENAI_MOCK_PORT", "4420"))
TIMEOUT_MARKER = "TIMEOUT_ME"
TIMEOUT_SLEEP_S = 3.0


def _content_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(part.get("text", "") for part in content if isinstance(part, dict))
    return "" if content is None else str(content)


def _last_user(messages):
    for m in reversed(messages):
        if m.get("role") == "user":
            return _content_text(m.get("content"))
    return ""


def _has_tool_result(messages):
    return any(m.get("role") == "tool" for m in messages)


def _tool_names(body):
    names = set()
    for t in body.get("tools") or []:
        fn = t.get("function") if isinstance(t, dict) else None
        if fn and fn.get("name"):
            names.add(fn["name"])
    return names


def _answer_text(messages):
    last = _last_user(messages).lower()
    system = " ".join(_content_text(m.get("content")) for m in messages if m.get("role") == "system").lower()
    if _has_tool_result(messages):
        tool_msgs = [m for m in messages if m.get("role") == "tool"]
        try:
            payload = json.loads(_content_text(tool_msgs[-1].get("content")))
        except (json.JSONDecodeError, TypeError):
            payload = {}
        if "balance" in payload:
            return f"Account {payload.get('account_id')} has a balance of {payload['balance']} {payload.get('currency', '')}.".strip()
        if "ticket_id" in payload:
            return f"I've opened ticket {payload['ticket_id']} for you; our team will follow up."
        return "Done."
    if "classify" in system:
        return "billing"
    if "keywords" in system:
        return "alpha, beta, gamma"
    if "policy" in system:
        return "The refund policy applies; refunds take 5-7 business days."
    if "next action" in system:
        return "Escalate to tier 2 and reply within 24 hours."
    if "email" in system:
        return "Hi there,\n\nThanks for reaching out. We've looked into this and will follow up shortly.\n\nBest,\nSupport"
    if "sql" in system:
        return "SELECT id, email FROM users WHERE created_at > now() - interval '7 days';"
    if "summar" in system:
        return "The text describes a product update. It highlights improved reliability and faster support."
    if "refund" in last:
        return "Refunds take 5 to 7 business days to appear on your statement."
    if "two-factor" in last or "2fa" in last:
        return "Yes, we support two-factor authentication via authenticator apps and SMS."
    return "Hello! How can I help you today?"


def _usage(messages, out_text):
    prompt_tokens = sum(len(_content_text(m.get("content")).split()) for m in messages) + 8
    completion_tokens = max(1, len(out_text.split()))
    return {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens}


def build_response(body):
    messages = body.get("messages") or []
    model = body.get("model", "gpt-4o-mini")
    tools = _tool_names(body)
    last = _last_user(messages)
    rid = "chatcmpl-" + uuid.uuid4().hex[:24]
    created = int(time.time())

    if any(TIMEOUT_MARKER in _content_text(m.get("content")) for m in messages):
        time.sleep(TIMEOUT_SLEEP_S)

    tool_call = None
    if not _has_tool_result(messages):
        if "get_account" in tools and "account" in last.lower():
            m = re.search(r"\b(\d{3,})\b", last)
            tool_call = ("get_account", {"account_id": m.group(1) if m else "9001"})
        elif "open_ticket" in tools and "complaint" in last.lower():
            tool_call = ("open_ticket", {"summary": last})

    if tool_call:
        name, args = tool_call
        message = {
            "role": "assistant",
            "content": None,
            "tool_calls": [{
                "id": "call_" + uuid.uuid4().hex[:16],
                "type": "function",
                "function": {"name": name, "arguments": json.dumps(args)},
            }],
        }
        finish = "tool_calls"
        out_text = json.dumps(args)
    else:
        out_text = _answer_text(messages)
        message = {"role": "assistant", "content": out_text}
        finish = "stop"

    return {
        "id": rid,
        "object": "chat.completion",
        "created": created,
        "model": model,
        "choices": [{"index": 0, "message": message, "finish_reason": finish, "logprobs": None}],
        "usage": _usage(messages, out_text),
        "system_fingerprint": "fp_mock",
    }


def to_stream_chunks(resp):
    """Split a full completion into SSE chunks (role, content/tool_calls, finish+usage)."""
    base = {"id": resp["id"], "object": "chat.completion.chunk", "created": resp["created"],
            "model": resp["model"], "system_fingerprint": "fp_mock"}
    msg = resp["choices"][0]["message"]
    yield {**base, "choices": [{"index": 0, "delta": {"role": "assistant", "content": ""}, "finish_reason": None}]}
    if msg.get("tool_calls"):
        tc = msg["tool_calls"][0]
        yield {**base, "choices": [{"index": 0, "delta": {"tool_calls": [{"index": 0, "id": tc["id"], "type": "function",
                "function": {"name": tc["function"]["name"], "arguments": ""}}]}, "finish_reason": None}]}
        yield {**base, "choices": [{"index": 0, "delta": {"tool_calls": [{"index": 0,
                "function": {"arguments": tc["function"]["arguments"]}}]}, "finish_reason": None}]}
    else:
        words = (msg.get("content") or "").split(" ")
        for i, w in enumerate(words):
            piece = w if i == len(words) - 1 else w + " "
            yield {**base, "choices": [{"index": 0, "delta": {"content": piece}, "finish_reason": None}]}
    yield {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": resp["choices"][0]["finish_reason"]}]}
    yield {**base, "choices": [], "usage": resp["usage"]}


class Handler(BaseHTTPRequestHandler):
    server_version = "openai-mock/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[openai-mock] " + (fmt % args) + "\n")

    def _json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.rstrip("/") in ("/health", ""):
            return self._json(200, {"ok": True})
        if self.path.startswith("/v1/models"):
            return self._json(200, {"object": "list", "data": [{"id": "gpt-4o-mini", "object": "model"}]})
        self._json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        if not self.path.startswith("/v1/chat/completions"):
            return self._json(404, {"error": {"message": f"unknown path {self.path}"}})
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self._json(400, {"error": {"message": "invalid json"}})
        resp = build_response(body)
        if not body.get("stream"):
            return self._json(200, resp)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        for chunk in to_stream_chunks(resp):
            self.wfile.write(b"data: " + json.dumps(chunk).encode() + b"\n\n")
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    print(f"[openai-mock] listening on http://127.0.0.1:{PORT}/v1", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
