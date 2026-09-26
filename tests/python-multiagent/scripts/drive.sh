#!/usr/bin/env bash
# Drive the sandbox end to end: mocks + web + worker, scripted traffic, reindex, teardown.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PY="${PY:-$ROOT/.venv/bin/python}"
[ -x "$PY" ] || PY=python3

export PORT="${PORT:-4410}"
export OPENAI_MOCK_PORT="${OPENAI_MOCK_PORT:-4420}"
export INGEST_MOCK_PORT="${INGEST_MOCK_PORT:-4430}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-http://127.0.0.1:$OPENAI_MOCK_PORT/v1}"
export LLM_TIMEOUT_S="${LLM_TIMEOUT_S:-1.0}"
# never clobber values the caller already exported
export TRODO_API_BASE="${TRODO_API_BASE:-http://127.0.0.1:$INGEST_MOCK_PORT}"
export TRODO_SITE_ID="${TRODO_SITE_ID:-sandbox-site}"
export PYTHONPATH="$ROOT${PYTHONPATH:+:$PYTHONPATH}"
export PYTHONUNBUFFERED=1

WEB="http://127.0.0.1:$PORT"
INGEST_LOG="$ROOT/mock/ingest-log.jsonl"

rm -rf "$ROOT/queue" "$ROOT/logs"
mkdir -p "$ROOT/logs" "$ROOT/queue"
: > "$INGEST_LOG"

PIDS=()
cleanup() {
  echo "--- teardown"
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  sleep 0.5
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

start() { # name, cmd...
  local name="$1"; shift
  "$@" >"$ROOT/logs/$name.log" 2>&1 &
  local pid=$!
  PIDS+=("$pid")
  echo "$pid" > "$ROOT/logs/$name.pid"
  echo "started $name pid=$pid"
}

wait_for() { # url, label
  local url="$1" label="$2" i
  for i in $(seq 1 60); do
    if curl -sf -o /dev/null "$url"; then echo "$label ready"; return 0; fi
    sleep 0.25
  done
  echo "!! $label did not come up at $url" >&2
  cat "$ROOT/logs/$label.log" 2>/dev/null >&2
  exit 1
}

post() { # path, json
  local out
  out=$(curl -s -w '\n%{http_code}' -X POST "$WEB$1" -H 'content-type: application/json' -d "$2")
  local code="${out##*$'\n'}" body="${out%$'\n'*}"
  echo "POST $1 -> $code $body"
}

echo "--- starting processes (TRODO_API_BASE=$TRODO_API_BASE TRODO_SITE_ID=$TRODO_SITE_ID)"
start openai-mock "$PY" mock/openai_mock.py
start ingest-mock "$PY" mock/trodo_ingest_mock.py
wait_for "http://127.0.0.1:$OPENAI_MOCK_PORT/health" openai-mock
wait_for "http://127.0.0.1:$INGEST_MOCK_PORT/health" ingest-mock
start web "$PY" -m app.main
start worker "$PY" -m app.jobs.worker
wait_for "$WEB/health" web

echo "--- chat turns"
post /chat '{"thread_id":"t-1","user_id":"alice","message":"hi, how long do refunds take?"}'
post /chat '{"thread_id":"t-1","user_id":"alice","message":"what'"'"'s the balance on my account 9001?"}'
post /chat '{"thread_id":"t-1","user_id":"alice","message":"this is a complaint, open a ticket"}'
post /chat '{"thread_id":"t-2","user_id":"bob","message":"do you support two-factor authentication?"}'

echo "--- generate"
post /generate '{"kind":"email","input":"tell the customer their refund was approved"}'
post /generate '{"kind":"sql","input":"users who signed up in the last 7 days"}'
post /generate '{"kind":"summary","input":"We shipped a reliability update and cut support response times in half."}'

echo "--- waiting for worker"
sleep 4
ls -1 "$ROOT/queue/results" 2>/dev/null | sed 's/^/result: /' || echo "no results yet"

echo "--- reindex (one-shot)"
"$PY" -m app.scheduled.reindex 2>&1 | tee "$ROOT/logs/reindex.log"

echo "--- timeout turn"
post /chat '{"thread_id":"t-3","user_id":"carol","message":"TIMEOUT_ME please tell me about refunds"}'

# give async exporters a moment to flush before we tear down
sleep 2
cleanup
trap - EXIT
sleep 1

LINES=$(wc -l < "$INGEST_LOG" | tr -d ' ')
echo "--- ingest-log lines: $LINES ($INGEST_LOG)"
