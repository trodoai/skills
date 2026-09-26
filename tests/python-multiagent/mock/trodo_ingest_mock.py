"""Catch-all ingest sink: logs every request as one JSON line, replies 200 {ok, run_id}."""
import json
import os
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("INGEST_MOCK_PORT", "4430"))
LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ingest-log.jsonl")


def _site_id(headers, body):
    for h in ("x-trodo-site-id", "x-site-id", "x-trodo-site", "trodo-site-id"):
        if headers.get(h):
            return headers.get(h)
    auth = headers.get("authorization") or ""
    if isinstance(body, dict):
        for k in ("site_id", "siteId", "site"):
            if body.get(k):
                return body[k]
    return auth.split(" ", 1)[-1] if auth else None


class Handler(BaseHTTPRequestHandler):
    server_version = "trodo-ingest-mock/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[ingest-mock] " + (fmt % args) + "\n")

    def _handle(self):
        if self.command == "GET" and self.path.rstrip("/") in ("/health", ""):
            # liveness probe from drive.sh; not an ingest payload, keep the log clean
            return self._reply(None)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            body = {"_raw": raw.decode("utf-8", "replace")}
        headers = {k.lower(): v for k, v in self.headers.items()}
        record = {
            "ts": time.time(),
            "method": self.command,
            "path": self.path,
            "site_id": _site_id(headers, body),
            "headers": {k: v for k, v in headers.items() if k.startswith("x-") or k in ("authorization", "content-type")},
            "body": body,
        }
        with open(LOG_PATH, "a") as f:
            f.write(json.dumps(record) + "\n")
        self._reply(body)

    def _reply(self, body):
        run_id = None
        if isinstance(body, dict):
            run_id = body.get("run_id") or body.get("runId") or body.get("id")
        resp = json.dumps({"ok": True, "run_id": run_id or str(uuid.uuid4())}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = _handle


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    print(f"[ingest-mock] listening on http://127.0.0.1:{PORT} -> {LOG_PATH}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
