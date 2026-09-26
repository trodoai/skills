#!/usr/bin/env bash
# Drives the whole sandbox end to end: starts the two mocks + the server, exercises
# every agent, tears everything down, prints the ingest-log line count.
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

PORT="${PORT:-4310}"
MCP_PORT=$((PORT + 1))
OPENAI_MOCK_PORT="${OPENAI_MOCK_PORT:-4320}"
INGEST_PORT="${INGEST_PORT:-4330}"

# Env passthrough: keep TRODO_API_BASE / TRODO_SITE_ID if already exported.
export TRODO_SITE_ID="${TRODO_SITE_ID:-sandbox-site}"
export TRODO_API_BASE="${TRODO_API_BASE:-http://127.0.0.1:$INGEST_PORT}"
export OPENAI_BASE_URL="http://127.0.0.1:$OPENAI_MOCK_PORT/v1"
export INVESTIGATOR_ROUNDS="${INVESTIGATOR_ROUNDS:-3}"
export PORT OPENAI_MOCK_PORT INGEST_PORT

INGEST_LOG="$ROOT/mock/ingest-log.jsonl"
mkdir -p .logs
: > "$INGEST_LOG"
: > .logs/mcp-session-id

PIDS=()
cleanup() {
  echo "--- teardown"
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && wait "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

wait_for() {
  local url="$1" name="$2" i
  for i in $(seq 1 50); do
    if curl -sf "$url" >/dev/null 2>&1; then echo "  $name up"; return 0; fi
    sleep 0.2
  done
  echo "!! $name did not come up at $url" >&2
  echo "--- $name log:" >&2; cat ".logs/$name.log" >&2 || true
  exit 1
}

echo "--- starting mocks + server (TRODO_API_BASE=$TRODO_API_BASE TRODO_SITE_ID=$TRODO_SITE_ID)"
node mock/openai-mock.js > .logs/openai-mock.log 2>&1 & PIDS+=($!)
node mock/trodo-ingest-mock.js > .logs/ingest-mock.log 2>&1 & PIDS+=($!)
node src/server.js > .logs/server.log 2>&1 & PIDS+=($!)

wait_for "http://127.0.0.1:$OPENAI_MOCK_PORT/health" openai-mock
wait_for "http://127.0.0.1:$INGEST_PORT/health" ingest-mock
wait_for "http://127.0.0.1:$PORT/health" server

# chat <conversationId> <userId> <message>: prints the final text (from the done event) or the error.
chat() {
  local conv="$1" user="$2" msg="$3"
  local payload out
  payload=$(node -e 'process.stdout.write(JSON.stringify({conversationId:process.argv[1], message:process.argv[2]}))' "$conv" "$msg")
  out=$(curl -sN -X POST "http://127.0.0.1:$PORT/api/chat" \
    -H 'content-type: application/json' -H "x-user-id: $user" \
    --data "$payload")
  printf '%s\n' "$out" | awk '
    /^event: done/  { mode="done" }
    /^event: error/ { mode="error" }
    /^data: /       { if (mode!="") { print "  [" mode "] " substr($0, 7); mode="" } }'
}

task() {
  local type="$1" text="$2" payload
  payload=$(node -e 'process.stdout.write(JSON.stringify({type:process.argv[1], text:process.argv[2]}))' "$type" "$text")
  echo "  [$type] $(curl -s -X POST "http://127.0.0.1:$PORT/api/tasks/run" -H 'content-type: application/json' --data "$payload")"
}

echo "--- chat conv-1 (u-42), 3 turns"
chat conv-1 u-42 "hi, how long do refunds take?"
chat conv-1 u-42 "where is my order 5512?"
chat conv-1 u-42 "I'm angry, escalate this"
echo "--- chat conv-2 (u-7), 1 turn"
chat conv-2 u-7 "help with my account"

echo "--- tasks"
task summarize "The customer reported a double charge on order 5512 and asked for a refund of the duplicate."
task classify "I cannot log in after resetting my password."
task translate "Your order has shipped and will arrive in two days."

echo "--- waiting 3s for the investigator job + detached notify"
sleep 3

echo "--- cron digest"
echo "  $(curl -s -X POST "http://127.0.0.1:$PORT/internal/cron/digest")"

echo "--- mcp"
MCP_URL="http://127.0.0.1:$MCP_PORT/mcp"
INIT_HEADERS=$(curl -s -D - -o .logs/mcp-init.json -X POST "$MCP_URL" -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"drive.sh","version":"1"}}}')
MCP_SESSION=$(printf '%s' "$INIT_HEADERS" | tr -d '\r' | awk 'tolower($1)=="mcp-session-id:" {print $2}')
echo "  session: $MCP_SESSION"
printf '%s' "$MCP_SESSION" > .logs/mcp-session-id
echo "  initialize: $(cat .logs/mcp-init.json)"
echo "  tools/list: $(curl -s -X POST "$MCP_URL" -H 'content-type: application/json' -H "Mcp-Session-Id: $MCP_SESSION" \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')"
echo "  tools/call get_order: $(curl -s -X POST "$MCP_URL" -H 'content-type: application/json' -H "Mcp-Session-Id: $MCP_SESSION" \
  --data '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_order","arguments":{"orderId":"5512"}}}')"
echo "  tools/call search_docs: $(curl -s -X POST "$MCP_URL" -H 'content-type: application/json' -H "Mcp-Session-Id: $MCP_SESSION" \
  --data '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"search_docs","arguments":{"query":"refund"}}}')"

echo "--- backfill"
node scripts/backfill.js 2>&1 | sed 's/^/  /'

echo "--- chat conv-3 (u-99), rate-limited turn"
chat conv-3 u-99 "please RATE_LIMIT_ME now"

echo "--- letting things flush (2s)"
sleep 2

echo "--- server state"
echo "  $(curl -s "http://127.0.0.1:$PORT/internal/state" | head -c 400)"

cleanup
trap - EXIT
PIDS=()

echo "--- ingest log: $(wc -l < "$INGEST_LOG" | tr -d ' ') lines at $INGEST_LOG"
