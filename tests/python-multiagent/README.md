# python-multiagent — offline tracing sandbox

A small, fully offline FastAPI app with **several distinct agents across three OS processes**,
plus mock OpenAI and mock Trodo-ingest servers. It ships **un-instrumented**: the point is to
let an instrumenting agent add Trodo tracing and then prove, with `scripts/check_traces.py`,
that the run model it produced is the intended one.

Nothing here imports `trodo` / `trodo-python`. The instrumenting agent installs the SDK itself:

```
.venv/bin/pip install -e <path-to-sdks/trodo-python-sdk>
```

## Commands

```
cd skills/tests/python-multiagent
python3 -m venv .venv && .venv/bin/pip install fastapi uvicorn langchain langchain-openai openai httpx
./scripts/drive.sh                          # start everything, drive traffic, tear down, print ingest-log line count
.venv/bin/python scripts/check_traces.py    # reconstruct runs from mock/ingest-log.jsonl and assert the run model
.venv/bin/python scripts/selftest_check_traces.py   # prove the checker itself on synthetic ideal logs (all payload shapes)
```

`drive.sh` respects an already-exported `TRODO_API_BASE` / `TRODO_SITE_ID`; otherwise it sets
`TRODO_API_BASE=http://127.0.0.1:$INGEST_MOCK_PORT` and `TRODO_SITE_ID=sandbox-site`.
It wipes `queue/` and `logs/` at start and truncates `mock/ingest-log.jsonl`.

## Ports

| env                | default | what                                            |
|--------------------|---------|-------------------------------------------------|
| `PORT`             | 4410    | FastAPI web app (`/health`, `/chat`, `/generate`) |
| `OPENAI_MOCK_PORT` | 4420    | `mock/openai_mock.py` — `POST /v1/chat/completions` (stream + non-stream, usage, deterministic tool calls) |
| `INGEST_MOCK_PORT` | 4430    | `mock/trodo_ingest_mock.py` — any method/path → one line in `mock/ingest-log.jsonl`, replies `{"ok":true,"run_id":...}` |

Other env: `OPENAI_BASE_URL` (default `http://127.0.0.1:4420/v1`), `LLM_TIMEOUT_S` (default `1.0`).

## Processes and agents

| process                              | entry                          | agent(s)                                                     | LLM path |
|--------------------------------------|--------------------------------|--------------------------------------------------------------|----------|
| web (`python -m app.main`)           | `app/agents/assistant/`        | RAG chat assistant: retrieval → hand-rolled tool loop (≤3 iterations) with `get_account`, `open_ticket` | `langchain_openai.ChatOpenAI` |
| web                                  | `app/routes/generate.py`       | multiplexed `/generate` — `email` / `sql` / `summary`, one handler, three system prompts | `ChatOpenAI` one-shot |
| worker (`python -m app.jobs.worker`) | `app/jobs/worker.py`           | triage agent: 1 classify call + 2 "research" calls in a `ThreadPoolExecutor(2)`; reads `queue/jobs.jsonl`, writes `queue/results/<job>.json` | raw `openai` client |
| cron (`python -m app.scheduled.reindex`) | `app/scheduled/reindex.py` | one-shot: 3 raw calls ("3 keywords" per doc), rewrites `data/doc_index.json`, exits | raw `openai` client |

Deliberate pitfalls: `app/llm.py` builds the raw `OpenAI()` client **at import time**; the worker's
two research calls run on **pool threads**; the reindex process **exits immediately** after its
last call; `open_ticket` crosses a **process boundary** via a file queue (the triage run has no
in-process parent).

## Intended run model (what `check_traces.py` asserts)

| runs | agent name should match | count | linkage                                                  | spans |
|------|-------------------------|-------|----------------------------------------------------------|-------|
| assistant `/chat` turns | `/assist\|chat\|support/` | exactly 5 | `conversation_id` = thread (`t-1`×3, `t-2`, `t-3`), `distinct_id` = user | ≥1 llm + ≥1 retrieval each; `get_account` tool span on the account turn; `open_ticket` on the complaint turn; TIMEOUT_ME turn `status=error` with a message |
| triage (worker) | `/triage/` | exactly 1 | `parent_run_id` = complaint run id (fallback: `conversation_id` `t-1`, reported), `distinct_id` `alice` | ≥3 llm (the 2 thread-pool calls must be captured) |
| generate | `/email\|sql\|summar\|generat/` | exactly 3, **three different names** | — | exactly 1 llm each |
| reindex (cron) | `/reindex\|index/` | 1 run with 3 llm (or 3 runs × 1 llm, reported) | — | must be flushed before exit |

Globally: no run left `running`, no orphan spans, input non-empty and containing the user message
(matched on the **last `role:user`** message when the input is a chat array), output non-empty and
not a Python repr.

The checker is payload-shape tolerant: `runs/ingest` trees, `runs/start` + `/runs/<id>/spans` +
`/runs/<id>/end`, and runless `spans/append` (linked by `run_id`); snake_case or camelCase;
error text in `error` / `error_message` / `error_summary` / `errorSummary`.
Run it before instrumenting to see it fail cleanly with `0 runs found`.

## Driven traffic (`scripts/drive.sh`)

1. `/chat` `t-1`/`alice`: "hi, how long do refunds take?" → "what's the balance on my account 9001?" (tool `get_account`) → "this is a complaint, open a ticket" (tool `open_ticket` → enqueues `triage_ticket`)
2. `/chat` `t-2`/`bob`: "do you support two-factor authentication?"
3. `/generate` × 3: `email`, `sql`, `summary`
4. wait ~4 s for the worker to triage
5. `python -m app.scheduled.reindex`
6. `/chat` `t-3`/`carol` containing `TIMEOUT_ME` → mock sleeps 3 s, client times out at 1 s → HTTP 502
7. teardown; print `mock/ingest-log.jsonl` line count

## Layout

```
app/main.py                  FastAPI app, /health
app/llm.py                   shared OpenAI client (import time) + ChatOpenAI factory
app/agents/assistant/        agent.py (loop), retrieval.py, tools.py, router.py (/chat)
app/routes/generate.py       /generate multiplexer
app/jobs/queue.py            JSON-lines file queue (queue/jobs.jsonl, queue/results/)
app/jobs/worker.py           triage worker process
app/scheduled/reindex.py     one-shot reindex process
data/seed.py                 seed docs; data/doc_index.json is generated at runtime
mock/openai_mock.py          deterministic OpenAI-shaped mock
mock/trodo_ingest_mock.py    catch-all ingest sink -> mock/ingest-log.jsonl
scripts/drive.sh             orchestrates the whole run
scripts/check_traces.py      reconstructs runs/spans and asserts the run model
scripts/selftest_check_traces.py   proves the checker on synthetic logs
```
