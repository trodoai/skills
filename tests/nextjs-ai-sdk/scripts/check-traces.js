#!/usr/bin/env node
// Reconstructs runs + spans from mock/ingest-log.jsonl regardless of payload shape,
// then asserts the expected run model for scripts/drive.sh. Exit 1 on any failure.
const fs = require("node:fs");
const path = require("node:path");

const LOG = process.argv[2] || path.join(__dirname, "..", "mock", "ingest-log.jsonl");

function fail(msg) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
function pick(o, ...keys) {
  if (!o || typeof o !== "object") return undefined;
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}
function textOf(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(textOf).join("");
  if (typeof v === "object") return textOf(pick(v, "text", "content", "output", "value", "message", "parts", "output_text", "outputText"));
  return String(v);
}
function lower(s) { return String(s || "").toLowerCase(); }

if (!fs.existsSync(LOG)) { console.error(`no ingest log at ${LOG}`); console.error("0 runs found"); process.exit(1); }
const lines = fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l, i) => {
  try { return JSON.parse(l); } catch { fail(`line ${i + 1} is not JSON`); return null; }
}).filter(Boolean);

const runs = new Map();   // run_id -> run
const spans = [];         // flat list of spans with run_id
const orphans = [];
let quickTraced = false;

function runFor(id, create = true) {
  if (!id) return null;
  if (!runs.has(id)) {
    if (!create) return null;
    runs.set(id, { run_id: id, agent_name: undefined, status: undefined, conversation_id: undefined, distinct_id: undefined, output: undefined, input: undefined, metadata: {}, spans: [], sources: new Set() });
  }
  return runs.get(id);
}
function mergeRun(r, obj, source) {
  if (!obj || typeof obj !== "object") return;
  r.sources.add(source);
  const a = pick(obj, "agent_name", "agentName", "agent", "name", "run_name", "runName");
  if (a && !r.agent_name) r.agent_name = typeof a === "object" ? pick(a, "name") : a;
  const st = pick(obj, "status", "state");
  if (st) r.status = st;
  const conv = pick(obj, "conversation_id", "conversationId", "session_id", "sessionId", "thread_id", "threadId");
  if (conv) r.conversation_id = conv;
  const did = pick(obj, "distinct_id", "distinctId", "user_id", "userId", "end_user_id");
  if (did) r.distinct_id = did;
  const out = pick(obj, "output", "output_text", "outputText", "response", "final_output", "result");
  if (out !== undefined) r.output = out;
  const inp = pick(obj, "input", "input_text", "inputText", "prompt");
  if (inp !== undefined && r.input === undefined) r.input = inp;
  const md = pick(obj, "metadata", "meta", "properties", "attributes");
  if (md && typeof md === "object") Object.assign(r.metadata, md);
  const err = pick(obj, "error", "error_message");
  if (err) r.error = err;
}
function normSpan(s, fallbackRun) {
  const run_id = pick(s, "run_id", "runId", "trace_id", "traceId") || fallbackRun;
  // usage_details is the open token map the SDK sends; the backend derives the
  // input/output token columns from it, so it counts as tokens here too.
  const usage = pick(s, "usage_details", "usageDetails", "usage", "token_usage", "tokens", "tokenUsage") || {};
  const inTok = pick(s, "input_tokens", "inputTokens", "prompt_tokens", "promptTokens") ?? pick(usage, "input_tokens", "inputTokens", "prompt_tokens", "promptTokens", "input");
  const outTok = pick(s, "output_tokens", "outputTokens", "completion_tokens", "completionTokens") ?? pick(usage, "output_tokens", "outputTokens", "completion_tokens", "completionTokens", "output");
  const total = pick(s, "total_tokens", "totalTokens") ?? pick(usage, "total_tokens", "totalTokens", "total");
  const type = lower(pick(s, "type", "span_type", "spanType", "kind", "category"));
  const name = pick(s, "name", "span_name", "spanName", "tool_name", "toolName", "model") || "";
  return {
    run_id, type, name: String(name), status: pick(s, "status"),
    tokens: (Number(inTok) || 0) + (Number(outTok) || 0) || Number(total) || 0,
    output: pick(s, "output", "result", "response"),
    raw: s,
  };
}
function addSpans(list, fallbackRun, source) {
  if (!Array.isArray(list)) return;
  for (const s of list) {
    const sp = normSpan(s, fallbackRun);
    spans.push(sp);
    const r = runFor(sp.run_id, false);
    if (r) { r.spans.push(sp); r.sources.add(source); } else orphans.push(sp);
  }
}

// Pass 1: run-creating payloads. Pass 2: spans (so runless spans can attach to runs created later in the log).
const spanPayloads = [];
for (const line of lines) {
  const p = lower(line.path);
  const b = line.body || {};
  const isRunish = /run/.test(p) && !/spans?(\/|$)/.test(p);
  if (Array.isArray(b.runs)) {
    for (const r of b.runs) { const id = pick(r, "run_id", "runId", "id"); const run = runFor(id); mergeRun(run, r, line.path); if (Array.isArray(r.spans)) spanPayloads.push([r.spans, id, line.path]); }
    continue;
  }
  const runObj = b.run && typeof b.run === "object" ? b.run : null;
  const runId = pick(b, "run_id", "runId") || (runObj && pick(runObj, "run_id", "runId", "id")) || (isRunish ? pick(b, "id") : undefined);
  if (isRunish || (runObj && runId)) {
    const run = runFor(runId);
    mergeRun(run, runObj || b, line.path);
    if (runObj) mergeRun(run, b, line.path);
    if (Array.isArray(b.spans)) spanPayloads.push([b.spans, runId, line.path]);
    if (runObj && Array.isArray(runObj.spans)) spanPayloads.push([runObj.spans, runId, line.path]);
    continue;
  }
  if (Array.isArray(b.spans)) { spanPayloads.push([b.spans, runId, line.path]); continue; }
  if (Array.isArray(b)) { spanPayloads.push([b, undefined, line.path]); continue; }
  if (b && (b.span_id || b.spanId || b.type)) { spanPayloads.push([[b], runId, line.path]); continue; }
  // Unknown line shape: report but don't fail.
  console.warn(`note: unclassified payload ${line.method} ${line.path}`);
}
for (const [list, rid, src] of spanPayloads) addSpans(list, rid, src);

const all = [...runs.values()];
if (all.length === 0) { console.error("0 runs found"); process.exit(1); }

// Classification: agent_name first, then metadata/route hints.
function classify(r) {
  const n = lower(r.agent_name);
  const route = lower(pick(r.metadata, "route", "path", "url", "http.route", "endpoint"));
  const hay = `${n} ${route}`;
  // Most specific first: "support_chat" is a chat agent, not the support webhook.
  if (/title/.test(hay)) return "title";
  if (/chat/.test(hay)) return "chat";
  if (/webhook|summar|ticket/.test(hay)) return "webhook";
  if (/quick|edge|answer/.test(hay)) return "quick";
  return "unknown";
}
for (const r of all) r.kind = classify(r);

// Table
const rows = all.map((r) => ({
  kind: r.kind, run_id: String(r.run_id).slice(0, 14), agent: r.agent_name || "-", status: r.status || "-",
  conv: r.conversation_id || "-", user: r.distinct_id || "-",
  llm: r.spans.filter((s) => /llm|generation|model|completion/.test(s.type)).length,
  tool: r.spans.filter((s) => /tool/.test(s.type)).map((s) => s.name).join(",") || "-",
  tokens: r.spans.reduce((a, s) => a + s.tokens, 0),
  out: textOf(r.output).slice(0, 32).replace(/\n/g, " ") || "-",
  shape: [...r.sources].map((s) => s.replace(/^.*\/(runs?|spans?)/, "$1")).join("+"),
}));
console.table(rows);

// Assertions
const chats = all.filter((r) => r.kind === "chat");
const titles = all.filter((r) => r.kind === "title");
const hooks = all.filter((r) => r.kind === "webhook");
const quick = all.filter((r) => r.kind === "quick");
const unknown = all.filter((r) => r.kind === "unknown");
quickTraced = quick.length > 0;
const llmSpans = (r) => r.spans.filter((s) => /llm|generation|model|completion/.test(s.type));

if (chats.length !== 3) fail(`expected 3 chat runs, got ${chats.length}`);
const c1 = chats.filter((r) => r.conversation_id === "c-1");
const c2 = chats.filter((r) => r.conversation_id === "c-2");
if (c1.length !== 2) fail(`expected 2 runs with conversation_id c-1, got ${c1.length}`);
if (!c1.every((r) => r.distinct_id === "u-1")) fail("c-1 runs must have distinct_id u-1");
if (c2.length !== 1) fail(`expected 1 run with conversation_id c-2, got ${c2.length}`);
if (!c2.every((r) => r.distinct_id === "u-2")) fail("c-2 run must have distinct_id u-2");
for (const r of chats) {
  const l = llmSpans(r);
  if (l.length < 1) fail(`chat run ${r.run_id} has no llm span`);
  if (!l.some((s) => s.tokens > 0)) fail(`chat run ${r.run_id} llm spans carry no tokens`);
  if (!textOf(r.output).trim()) fail(`chat run ${r.run_id} has empty output (stream not finished before close?)`);
  if (lower(r.status) === "running") fail(`chat run ${r.run_id} still running`);
}
const orderRun = chats.find((r) => /order/.test(lower(textOf(r.input))) || r.spans.some((s) => /tool/.test(s.type) && /lookuporder/i.test(s.name)));
if (!orderRun) fail("no chat run carries the lookupOrder tool span");
else if (!orderRun.spans.some((s) => /tool/.test(s.type) && /lookuporder/i.test(s.name))) fail("order turn lacks a tool span named lookupOrder");

if (titles.length !== 1) fail(`expected 1 title run, got ${titles.length}`);
else if (llmSpans(titles[0]).length !== 1) fail(`title run should have exactly 1 llm span, got ${llmSpans(titles[0]).length}`);

if (hooks.length !== 1) fail(`expected 1 webhook/summary run, got ${hooks.length} (after() work not flushed?)`);
else if (llmSpans(hooks[0]).length !== 1) fail(`webhook run should have exactly 1 llm span, got ${llmSpans(hooks[0]).length}`);

// drive.sh probes /api/quick?q=warmup until the dev server answers, so a traced
// quick route legitimately emits warm-up runs; only the real call counts.
const warmups = quick.filter((r) => /warmup/.test(lower(textOf(r.input))));
const quickReal = quick.filter((r) => !warmups.includes(r));
if (quickReal.length > 1) fail(`expected at most 1 quick run (excluding warm-up probes), got ${quickReal.length}`);
console.log(quickTraced ? "note: edge /api/quick WAS traced (alternative path)" : "note: edge /api/quick not traced (acceptable: SDK cannot run on Edge)");

for (const r of all) if (lower(r.status) === "running") fail(`run ${r.run_id} (${r.kind}) left in status running`);
if (orphans.length) fail(`${orphans.length} orphan spans (run_id not matched): ${orphans.slice(0, 3).map((s) => `${s.type}:${s.name}@${s.run_id}`).join(", ")}`);
if (unknown.length) fail(`${unknown.length} runs could not be classified: ${unknown.map((r) => r.agent_name || r.run_id).join(", ")}`);
const expectedTotal = 5 + (quickTraced ? 1 : 0) + warmups.length;
if (all.length !== expectedTotal) fail(`expected ${expectedTotal} runs total, got ${all.length}`);

console.log(`${all.length} runs, ${spans.length} spans, ${orphans.length} orphans, ${lines.length} ingest lines`);
if (process.exitCode) { console.error("CHECK FAILED"); process.exit(1); }
console.log("CHECK OK");
