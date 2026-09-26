#!/usr/bin/env bash
# Drives the sandbox end-to-end: mocks + next dev, scripted traffic, teardown.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p .logs

export TRODO_SITE_ID="${TRODO_SITE_ID:-sandbox-site}"
export TRODO_API_BASE="${TRODO_API_BASE:-http://127.0.0.1:4530}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-http://127.0.0.1:4520/v1}"
export INGEST_PORT="${INGEST_PORT:-4530}"
APP="http://127.0.0.1:3456"
PIDS=()

cleanup() {
  echo "--- teardown"
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  # next dev spawns children; kill anything still bound to our ports.
  for port in 3456 4520 "$INGEST_PORT"; do
    lsof -ti tcp:"$port" 2>/dev/null | xargs kill -9 2>/dev/null
  done
  sleep 0.5
  echo "ingest-log lines: $(wc -l < mock/ingest-log.jsonl 2>/dev/null | tr -d ' ' || echo 0)"
}
trap cleanup EXIT

: > mock/ingest-log.jsonl
rm -f .logs/*.log

node mock/openai-mock.js > .logs/openai-mock.log 2>&1 & PIDS+=($!)
node mock/trodo-ingest-mock.js > .logs/ingest-mock.log 2>&1 & PIDS+=($!)
npm run dev > .logs/next.log 2>&1 & PIDS+=($!)
echo "pids: ${PIDS[*]}  (logs in .logs/)"
echo "env: TRODO_SITE_ID=$TRODO_SITE_ID TRODO_API_BASE=$TRODO_API_BASE OPENAI_BASE_URL=$OPENAI_BASE_URL"

echo "--- waiting for $APP/api/quick"
ok=0
for i in $(seq 1 90); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$APP/api/quick?q=warmup" || true)
  if [ "$code" = "200" ]; then ok=1; break; fi
  sleep 1
done
if [ "$ok" != "1" ]; then echo "next dev did not come up (last code=$code); see .logs/next.log"; exit 1; fi
echo "up after ${i}s"

FAIL=0
chat_turn() { # chat_id user_id messages_json
  local out code
  out=$(curl -s -N --max-time 60 -w '\n%{http_code}' -X POST "$APP/api/chat" \
    -H 'content-type: application/json' -H "x-user-id: $2" \
    -d "{\"id\":\"$1\",\"messages\":$3}")
  code=$(printf '%s' "$out" | tail -n1)
  local body; body=$(printf '%s' "$out" | sed '$d')
  local nchunks; nchunks=$(printf '%s' "$body" | grep -c '^data:' || true)
  echo "chat $1/$2 -> $code, $nchunks stream events, finish=$(printf '%s' "$body" | grep -c '"type":"finish"' || true)"
  [ "$code" = "200" ] || FAIL=1
  printf '%s' "$body" | grep -q '"type":"finish"' || { echo "  !! stream did not finish"; FAIL=1; }
}

msg() { # role text id
  printf '{"id":"%s","role":"%s","parts":[{"type":"text","text":"%s"}]}' "$3" "$1" "$2"
}

echo "--- chat c-1 / u-1 turn 1"
M1="[$(msg user 'hello there' m1)]"
chat_turn c-1 u-1 "$M1"
echo "--- chat c-1 / u-1 turn 2 (order -> tool)"
M2="[$(msg user 'hello there' m1),$(msg assistant 'Echo: hello there' a1),$(msg user 'where is my order 5551?' m2)]"
chat_turn c-1 u-1 "$M2"
echo "--- chat c-2 / u-2 turn 1"
chat_turn c-2 u-2 "[$(msg user 'hi from another chat' m3)]"

echo "--- webhook POST T-3"
code=$(curl -s -o .logs/webhook-post.json -w '%{http_code}' -X POST "$APP/api/webhooks/support" \
  -H 'content-type: application/json' \
  -d '{"id":"T-3","subject":"Order late","body":"My order 5551 has not arrived and the tracking has not moved in 4 days. Please summarize and advise."}')
echo "webhook POST -> $code $(cat .logs/webhook-post.json)"
[ "$code" = "202" ] || FAIL=1
sleep 3
out=$(curl -s -w '\n%{http_code}' "$APP/api/webhooks/support?id=T-3")
echo "webhook GET  -> $(printf '%s' "$out" | tail -n1) $(printf '%s' "$out" | sed '$d')"
printf '%s' "$out" | tail -n1 | grep -q '^200$' || { echo "  !! summary not readable"; FAIL=1; }

echo "--- /api/quick (edge)"
out=$(curl -s -w '\n%{http_code}' "$APP/api/quick?q=quick%20check")
echo "quick -> $(printf '%s' "$out" | tail -n1) $(printf '%s' "$out" | sed '$d')"
printf '%s' "$out" | tail -n1 | grep -q '^200$' || FAIL=1

echo "--- /api/title (wraps the generateTitle server action)"
out=$(curl -s -w '\n%{http_code}' -X POST "$APP/api/title" -H 'content-type: application/json' \
  -d "{\"messages\":$M2}")
echo "title -> $(printf '%s' "$out" | tail -n1) $(printf '%s' "$out" | sed '$d')"
printf '%s' "$out" | tail -n1 | grep -q '^200$' || FAIL=1

if [ "$FAIL" = "1" ]; then echo "DRIVE FAILED"; exit 1; fi
echo "DRIVE OK"
