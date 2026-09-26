#!/usr/bin/env node
'use strict';
// Reads mock/ingest-log.jsonl, reconstructs runs + spans from every payload shape
// the SDK might send, and asserts the intended run model for the sandbox.
// Usage: node scripts/check-traces.js [path-to-ingest-log]
//   env: INGEST_LOG, INVESTIGATOR_ROUNDS (default 3), TRODO_SITE_ID (default sandbox-site), MCP_SESSION_ID
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOG = process.argv[2] || process.env.INGEST_LOG || path.join(ROOT, 'mock', 'ingest-log.jsonl');
const ROUNDS = Number(process.env.INVESTIGATOR_ROUNDS || 3);
const EXPECTED_SITE = process.env.TRODO_SITE_ID || 'sandbox-site';
const MCP_SESSION_ID = process.env.MCP_SESSION_ID || readOptional(path.join(ROOT, '.logs', 'mcp-session-id'));

const TURNS = [
  { key: 'refunds', conv: 'conv-1', user: 'u-42', text: 'hi, how long do refunds take?' },
  { key: 'order', conv: 'conv-1', user: 'u-42', text: 'where is my order 5512?' },
  { key: 'escalate', conv: 'conv-1', user: 'u-42', text: "I'm angry, escalate this" },
  { key: 'account', conv: 'conv-2', user: 'u-7', text: 'help with my account' },
  { key: 'ratelimit', conv: 'conv-3', user: 'u-99', text: 'RATE_LIMIT_ME' },
];

// ---------------------------------------------------------------- helpers

function readOptional(p) {
  try { const s = fs.readFileSync(p, 'utf8').trim(); return s || null; } catch { return null; }
}

function camel(s) { return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); }
function snake(s) { return s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase()); }

// Tolerant getter: tries snake_case and camelCase of every name, top-level first,
// then inside common metadata containers.
function get(obj, ...names) {
  if (!obj || typeof obj !== 'object') return undefined;
  const variants = [];
  for (const n of names) variants.push(n, camel(n), snake(n));
  for (const v of variants) if (obj[v] !== undefined && obj[v] !== null) return obj[v];
  for (const box of ['metadata', 'meta', 'properties', 'attributes', 'attrs', 'context', 'tags']) {
    const inner = obj[box];
    if (inner && typeof inner === 'object') {
      for (const v of variants) if (inner[v] !== undefined && inner[v] !== null) return inner[v];
    }
  }
  return undefined;
}

function maybeJson(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return v;
  try { return JSON.parse(t); } catch { return v; }
}

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function textOfContent(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : (p && (p.text || p.content)) || '')).join(' ');
  if (c && typeof c === 'object') return c.text || c.content || JSON.stringify(c);
  return c == null ? '' : String(c);
}

function messagesOf(input) {
  const v = maybeJson(input);
  if (Array.isArray(v) && v.length && v.every((m) => m && typeof m === 'object' && 'role' in m)) return v;
  if (v && typeof v === 'object') {
    for (const k of ['messages', 'input', 'prompt', 'history']) {
      const inner = maybeJson(v[k]);
      if (Array.isArray(inner) && inner.length && inner.every((m) => m && typeof m === 'object' && 'role' in m)) return inner;
    }
  }
  return null;
}

// The NEW user turn: last role:'user' message when the input is a chat array, else the whole input.
function userTurnText(input) {
  const msgs = messagesOf(input);
  if (msgs) {
    const last = [...msgs].reverse().find((m) => m.role === 'user');
    return last ? textOfContent(last.content) : '';
  }
  const v = maybeJson(input);
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const k of ['message', 'text', 'query', 'question', 'input', 'prompt']) {
      if (typeof v[k] === 'string') return v[k];
    }
  }
  return typeof v === 'string' ? v : JSON.stringify(v ?? '');
}

function wholeText(v) {
  const j = maybeJson(v);
  return typeof j === 'string' ? j : JSON.stringify(j ?? '');
}

function outputText(output) {
  const v = maybeJson(output);
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    for (const k of ['text', 'content', 'output', 'answer', 'message', 'result']) {
      if (typeof v[k] === 'string') return v[k];
      if (v[k] && typeof v[k] === 'object' && typeof v[k].content === 'string') return v[k].content;
    }
    return JSON.stringify(v);
  }
  return v == null ? '' : String(v);
}

function isEmpty(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '' || v === '{}' || v === '[]' || v === 'null';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

function streamLike(s) {
  return /\[object|ReadableStream|AsyncGenerator|AsyncIterator|"_events"|Stream \{|Symbol\(/.test(s);
}

function errorText(run) {
  const e = get(run, 'error', 'error_message', 'error_summary', 'error_text', 'exception', 'failure');
  if (e === undefined) return '';
  if (typeof e === 'string') return e;
  if (typeof e === 'object') return e.message || e.summary || e.error || JSON.stringify(e);
  return String(e);
}

function statusOf(run) {
  const s = get(run, 'status', 'state', 'outcome');
  if (typeof s === 'string') return s.toLowerCase();
  if (run.error || run.error_message || run.errorMessage || run.error_summary || run.errorSummary) return 'error';
  return s == null ? '' : String(s).toLowerCase();
}

function kindOf(span) {
  const k = get(span, 'kind', 'type', 'span_type', 'span_kind', 'category');
  return (k == null ? '' : String(k)).toLowerCase();
}

function nameOf(span) {
  const n = get(span, 'name', 'span_name', 'tool_name', 'function_name', 'operation');
  return n == null ? '' : String(n);
}

function toolNameOf(span) {
  const n = get(span, 'tool_name', 'tool', 'function_name');
  if (n) return String(n);
  const inp = maybeJson(get(span, 'input', 'inputs', 'arguments'));
  if (inp && typeof inp === 'object' && (inp.tool || inp.name || inp.tool_name)) return String(inp.tool || inp.name || inp.tool_name);
  return nameOf(span);
}

function isLlm(span) {
  const k = kindOf(span);
  if (/llm|generation|chat|completion|model/.test(k)) return true;
  if (!k) return /openai|chat\.completions|completion|llm/i.test(nameOf(span));
  return false;
}
function isTool(span) { return /tool|function/.test(kindOf(span)); }
function isAgentKind(span) { return /agent|round|step|chain/.test(kindOf(span)) || /round/i.test(nameOf(span)); }
function hasTool(spans, tool) {
  return spans.some((s) => isTool(s) && (toolNameOf(s).includes(tool) || nameOf(s).includes(tool)));
}

// ---------------------------------------------------------------- reconstruction

const runs = new Map();   // id -> merged run object (with _spans array, _sources set)
const spans = [];         // every span seen, each with _runId
let protobufEntries = 0;
const siteIds = new Set();
const unknownPaths = new Map();

function runIdOf(obj) {
  return get(obj, 'run_id', 'id', 'trace_id') || undefined;
}

function upsertRun(obj, source, forcedId) {
  const id = String(forcedId || runIdOf(obj) || `anon_${runs.size + 1}`);
  const run = runs.get(id) || { id, _spans: [], _sources: new Set(), _raw: [] };
  for (const [k, v] of Object.entries(obj || {})) {
    if (k === 'spans' || k === 'children' || k === 'child_runs' || k === 'runs') continue;
    if (v !== undefined && v !== null) run[k] = v;   // later payloads (end) override earlier (start)
  }
  run._sources.add(source);
  run._raw.push(obj);
  runs.set(id, run);
  return run;
}

function collectSpans(list, runId, source) {
  for (const raw of asArray(list)) {
    const sp = maybeJson(raw);
    if (!sp || typeof sp !== 'object') continue;
    const declared = get(sp, 'run_id');
    const rid = runId !== undefined ? runId : (declared === undefined ? null : declared);
    const span = { ...sp, _runId: rid === null || rid === undefined ? null : String(rid), _source: source };
    spans.push(span);
    if (sp.children || sp.spans) collectSpans(sp.children || sp.spans, span._runId, source);
  }
}

function ingestFullRun(obj, source) {
  const r = maybeJson(obj);
  if (!r || typeof r !== 'object') return;
  if (Array.isArray(r)) { r.forEach((x) => ingestFullRun(x, source)); return; }
  if (Array.isArray(r.runs)) { r.runs.forEach((x) => ingestFullRun(x, source)); if (r.spans) collectSpans(r.spans, undefined, source); return; }
  if (r.run && typeof r.run === 'object') {
    const run = upsertRun(maybeJson(r.run), source);
    collectSpans(r.spans || r.run.spans, run.id, source);
    return;
  }
  const run = upsertRun(r, source);
  collectSpans(r.spans || r.children, run.id, source);
  for (const child of asArray(r.child_runs || r.runs)) {
    const c = upsertRun(maybeJson(child), source);
    if (!get(c, 'parent_run_id')) c.parent_run_id = run.id;
    collectSpans(child.spans, c.id, source);
  }
}

function spansPayload(body) {
  const b = maybeJson(body);
  if (Array.isArray(b)) return b;
  if (b && typeof b === 'object') {
    if (Array.isArray(b.spans)) return b.spans;
    if (b.span) return [b.span];
    if (b.name || b.kind || b.type) return [b];
  }
  return [];
}

function ingestEntry(entry) {
  const p = String(entry.path || '');
  const body = maybeJson(entry.body);
  if (entry.site_id) siteIds.add(entry.site_id);

  if (/\/v1\/traces\/?$/.test(p) || entry.content_type && /protobuf/.test(entry.content_type)) {
    protobufEntries++;
    return;
  }
  let m;
  if (/\/runs\/ingest\/?$/.test(p) || /\/runs\/?$/.test(p) && entry.method === 'POST' && !/start/.test(p)) {
    ingestFullRun(body, 'ingest');
  } else if (/\/runs\/start\/?$/.test(p)) {
    const b = body && typeof body === 'object' ? (body.run && typeof body.run === 'object' ? body.run : body) : {};
    const id = runIdOf(b) || (entry.response && entry.response.run_id);
    const run = upsertRun(b, 'start', id);
    if (!get(run, 'status')) run.status = 'running';
    if (b.spans) collectSpans(b.spans, run.id, 'start');
  } else if ((m = p.match(/\/runs\/([^/]+)\/spans\/?$/))) {
    const id = decodeURIComponent(m[1]);
    if (!runs.has(id)) upsertRun({}, 'spans-only', id);
    collectSpans(spansPayload(body), id, 'runs/:id/spans');
  } else if ((m = p.match(/\/runs\/([^/]+)\/end\/?$/))) {
    const id = decodeURIComponent(m[1]);
    const b = body && typeof body === 'object' ? (body.run && typeof body.run === 'object' ? body.run : body) : {};
    const run = upsertRun(b, 'end', id);
    if (!get(b, 'status') && !errorText(b)) run.status = run.status === 'running' ? 'completed' : run.status || 'completed';
    if (b.spans) collectSpans(b.spans, id, 'end');
  } else if (/\/spans\/append\/?$/.test(p) || /\/spans\/?$/.test(p)) {
    collectSpans(spansPayload(body), undefined, 'spans/append');
  } else if (body && typeof body === 'object' && (body.runs || body.run || body.spans || body.agent_name || body.agentName)) {
    unknownPaths.set(p, (unknownPaths.get(p) || 0) + 1);
    ingestFullRun(body, `unknown:${p}`);
  } else {
    unknownPaths.set(p, (unknownPaths.get(p) || 0) + 1);
  }
}

// ---------------------------------------------------------------- classification

const AGENT_RULES = [
  ['investigator', /investigat|issue/i],
  ['notify', /notify|slack/i],
  ['digest', /digest/i],
  ['mcp', /mcp/i],
  ['backfill', /backfill|ticket/i],
  ['tasks', /summar|classif|translat|task/i],
  ['chat', /chat|support/i],
];

function classifyByName(name) {
  if (!name) return null;
  for (const [cls, re] of AGENT_RULES) if (re.test(name)) return cls;
  return null;
}

function classifyRun(run) {
  const agent = get(run, 'agent_name', 'agent', 'name');
  const byName = classifyByName(typeof agent === 'string' ? agent : '');
  if (byName) return byName;
  const text = wholeText(get(run, 'input', 'inputs', 'prompt')) + ' ' + wholeText(get(run, 'output', 'outputs'));
  if (hasTool(run._spans, 'fetch_logs') || hasTool(run._spans, 'query_metrics') || /investigation plan|adjudicator|incident planner/i.test(text)) return 'investigator';
  if (/slack notification|#support-escalations/i.test(text)) return 'notify';
  if (/digest/i.test(text)) return 'digest';
  if (/Ticket T-\d+|classify the support ticket/i.test(text)) return 'backfill';
  if (/You are a (summarizer|classifier|translator)/i.test(text)) return 'tasks';
  if (TURNS.some((t) => text.toLowerCase().includes(t.text.toLowerCase())) || /support agent/i.test(text)) return 'chat';
  return 'unknown';
}

function matchTurn(run) {
  const turnText = userTurnText(get(run, 'input', 'inputs', 'prompt')).toLowerCase();
  return TURNS.find((t) => turnText.includes(t.text.toLowerCase())) || null;
}

// ---------------------------------------------------------------- main

function main() {
  if (!fs.existsSync(LOG)) {
    console.error(`FAIL: ingest log not found at ${LOG} (run bash scripts/drive.sh first)`);
    process.exit(1);
  }
  const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => l.trim());
  let bad = 0;
  for (const line of lines) {
    try { ingestEntry(JSON.parse(line)); } catch (err) { bad++; console.error(`  unparsable log line: ${err.message}`); }
  }

  // attach spans to runs
  for (const sp of spans) {
    if (sp._runId !== null && runs.has(sp._runId)) runs.get(sp._runId)._spans.push(sp);
  }
  const runList = [...runs.values()];
  for (const r of runList) { r._class = classifyRun(r); r._turn = r._class === 'chat' ? matchTurn(r) : null; }

  console.log(`ingest log: ${LOG}`);
  console.log(`entries: ${lines.length} (${bad} unparsable, ${protobufEntries} protobuf/OTLP skipped), site ids: ${[...siteIds].join(', ') || 'none'}`);
  if (unknownPaths.size) console.log(`unrecognised paths: ${[...unknownPaths].map(([p, n]) => `${p} x${n}`).join(', ')}`);
  console.log(`reconstructed: ${runList.length} runs, ${spans.length} spans (${spans.filter((s) => s._runId === null).length} runless)`);

  if (runList.length === 0 && spans.length === 0) {
    console.error(`\nFAIL: 0 runs found in ${LOG} (${lines.length} log lines). The app is not sending traces to the ingest mock.`);
    process.exit(1);
  }

  const failures = [];
  const notes = [];
  const check = (cond, msg) => { if (!cond) failures.push(msg); return !!cond; };

  // ---- run table
  const short = (v) => (v == null ? '-' : String(v).length > 14 ? String(v).slice(0, 12) + '..' : String(v));
  const rows = runList.map((r) => ({
    id: short(r.id),
    class: r._class,
    agent: short(get(r, 'agent_name', 'agent', 'name')),
    status: statusOf(r) || '-',
    conv: short(get(r, 'conversation_id')),
    distinct: short(get(r, 'distinct_id', 'user_id')),
    parent: short(get(r, 'parent_run_id')),
    llm: r._spans.filter(isLlm).length,
    tool: r._spans.filter(isTool).length,
    agentk: r._spans.filter(isAgentKind).length,
    turn: r._turn ? r._turn.key : '-',
    src: [...r._sources].join('+'),
  }));
  console.log('\nrun table:');
  console.table(rows);

  // ---- site id
  if (siteIds.size && ![...siteIds].includes(EXPECTED_SITE)) notes.push(`site ids seen (${[...siteIds].join(',')}) do not include expected ${EXPECTED_SITE}`);
  if (!siteIds.size) notes.push('no x-trodo-site-id header seen on any ingest request');

  // ---- chat
  const chatRuns = runList.filter((r) => r._class === 'chat');
  check(chatRuns.length === 5, `expected exactly 5 chat runs (one per turn), found ${chatRuns.length}`);
  const byTurn = {};
  for (const r of chatRuns) {
    if (!r._turn) { failures.push(`chat run ${r.id} does not match any driven turn (user turn: ${JSON.stringify(userTurnText(get(r, 'input', 'inputs', 'prompt')).slice(0, 80))})`); continue; }
    (byTurn[r._turn.key] ||= []).push(r);
  }
  for (const t of TURNS) {
    const list = byTurn[t.key] || [];
    if (!check(list.length === 1, `turn "${t.key}" should have exactly 1 chat run, found ${list.length}`)) continue;
    const r = list[0];
    const conv = get(r, 'conversation_id');
    const distinct = get(r, 'distinct_id', 'user_id');
    check(conv === t.conv, `turn "${t.key}": conversation_id should be ${t.conv}, got ${JSON.stringify(conv)}`);
    check(distinct === t.user, `turn "${t.key}": distinct_id should be ${t.user}, got ${JSON.stringify(distinct)}`);
    check(r._spans.filter(isLlm).length >= 1, `turn "${t.key}": expected >=1 llm span, found ${r._spans.filter(isLlm).length}`);
    const input = get(r, 'input', 'inputs', 'prompt');
    check(!isEmpty(input), `turn "${t.key}": run input is empty`);
    if (t.key === 'order') check(hasTool(r._spans, 'lookup_order'), `turn "order": expected a tool span named lookup_order; tool spans: ${r._spans.filter(isTool).map(toolNameOf).join(',') || 'none'}`);
    if (t.key === 'escalate') check(hasTool(r._spans, 'escalate'), `turn "escalate": expected a tool span named escalate; tool spans: ${r._spans.filter(isTool).map(toolNameOf).join(',') || 'none'}`);
    if (t.key === 'ratelimit') {
      const st = statusOf(r);
      const err = errorText(r);
      check(/error|fail/.test(st), `turn "ratelimit": status should be error, got ${JSON.stringify(st)}`);
      check(/429|rate.?limit/i.test(err), `turn "ratelimit": error text should mention 429 or rate limit, got ${JSON.stringify(err.slice(0, 120))}`);
    } else {
      const out = outputText(get(r, 'output', 'outputs', 'response'));
      check(!isEmpty(out), `turn "${t.key}": run output is empty`);
      check(!streamLike(out), `turn "${t.key}": run output looks like a serialised stream/object: ${JSON.stringify(out.slice(0, 80))}`);
    }
  }

  // ---- investigator
  const escalateRun = (byTurn.escalate || [])[0];
  const invRuns = runList.filter((r) => r._class === 'investigator');
  check(invRuns.length === 1, `expected exactly 1 investigator run, found ${invRuns.length}`);
  const inv = invRuns[0];
  let notifyLanded = 'lost';
  if (inv) {
    const parent = get(inv, 'parent_run_id');
    const conv = get(inv, 'conversation_id');
    if (escalateRun && parent && String(parent) === String(escalateRun.id)) notes.push('investigator linked to escalate chat run via parent_run_id');
    else if (conv === 'conv-1') notes.push(`investigator linked via conversation_id conv-1 (acceptable alternative; parent_run_id=${JSON.stringify(parent)})`);
    else failures.push(`investigator run not linked: parent_run_id=${JSON.stringify(parent)} (escalate run ${escalateRun ? escalateRun.id : 'missing'}), conversation_id=${JSON.stringify(conv)}`);
    check(get(inv, 'distinct_id', 'user_id') === 'u-42', `investigator distinct_id should be u-42, got ${JSON.stringify(get(inv, 'distinct_id', 'user_id'))}`);
    const agentSpans = inv._spans.filter(isAgentKind).length;
    const llmSpans = inv._spans.filter(isLlm).length;
    const toolSpans = inv._spans.filter(isTool).length;
    check(agentSpans >= 2, `investigator: expected >=2 agent-kind (or round-named) spans, found ${agentSpans}`);
    check(llmSpans >= 3, `investigator: expected >=3 llm spans, found ${llmSpans}`);
    check(toolSpans >= 2, `investigator: expected >=2 tool spans, found ${toolSpans}`);

    const notifyRuns = runList.filter((r) => r._class === 'notify');
    const notifyLlmInRuns = notifyRuns.reduce((n, r) => n + r._spans.filter(isLlm).length, 0);
    const notifySpanInside = inv._spans.filter((s) => /notify|slack/i.test(nameOf(s) + ' ' + wholeText(get(s, 'agent_name', 'input')))).length;
    const total = llmSpans + notifyLlmInRuns;
    const need = 2 + ROUNDS + 1;
    if (notifyRuns.length) notifyLanded = `separate notify run(s): ${notifyRuns.map((r) => r.id).join(', ')} (${notifyLlmInRuns} llm)`;
    else if (notifySpanInside || llmSpans >= need) notifyLanded = `inside the investigator run (${notifySpanInside} notify-named spans)`;
    check(total >= need, `detached notify lost: llm spans in investigator (${llmSpans}) + notify runs (${notifyLlmInRuns}) = ${total} < ${need} (2 + INVESTIGATOR_ROUNDS=${ROUNDS} + 1)`);
    notes.push(`detached notify landed: ${notifyLanded}`);
    for (const nr of notifyRuns) {
      if (get(nr, 'parent_run_id') && String(get(nr, 'parent_run_id')) === String(inv.id)) notes.push(`notify run ${nr.id} has parent_run_id = investigator`);
    }
  }

  // ---- tasks
  const taskRuns = runList.filter((r) => r._class === 'tasks');
  check(taskRuns.length === 3, `expected exactly 3 task runs, found ${taskRuns.length}`);
  const taskNames = new Set(taskRuns.map((r) => get(r, 'agent_name', 'agent', 'name')));
  check(taskNames.size === 3, `task runs should have 3 different agent names, got ${JSON.stringify([...taskNames])}`);
  for (const r of taskRuns) check(r._spans.filter(isLlm).length === 1, `task run ${r.id} (${get(r, 'agent_name')}) should have exactly 1 llm span, found ${r._spans.filter(isLlm).length}`);

  // ---- digest
  const digestRuns = runList.filter((r) => r._class === 'digest');
  check(digestRuns.length === 1, `expected exactly 1 digest run, found ${digestRuns.length}`);
  if (digestRuns[0]) check(digestRuns[0]._spans.filter(isLlm).length === 1, `digest run should have exactly 1 llm span, found ${digestRuns[0]._spans.filter(isLlm).length}`);

  // ---- backfill
  const backfillRuns = runList.filter((r) => r._class === 'backfill');
  const bfLlm = backfillRuns.map((r) => r._spans.filter(isLlm).length);
  if (backfillRuns.length === 3 && bfLlm.every((n) => n === 1)) notes.push('backfill: 3 runs x 1 llm (one run per ticket)');
  else if (backfillRuns.length === 1 && bfLlm[0] === 3) notes.push('backfill: 1 run x 3 llm (one run for the whole CLI)');
  else failures.push(`backfill: expected 3 runs x 1 llm or 1 run x 3 llm, found ${backfillRuns.length} runs with llm counts ${JSON.stringify(bfLlm)}`);

  // ---- MCP
  const mcpSpans = spans.filter((s) => classifyByName(String(get(s, 'agent_name', 'agent') || '')) === 'mcp' || (s._runId === null && /mcp/i.test(nameOf(s) + wholeText(get(s, 'metadata')))));
  const runlessMcp = mcpSpans.filter((s) => s._runId === null);
  check(runlessMcp.length === 2, `expected exactly 2 runless MCP tool spans (run_id null), found ${runlessMcp.length} (of ${mcpSpans.length} MCP spans total)`);
  for (const s of runlessMcp) {
    check(isTool(s), `MCP span ${nameOf(s)} should be tool-kind, got ${JSON.stringify(kindOf(s))}`);
    check(/mcp/i.test(String(get(s, 'agent_name', 'agent') || '')), `MCP span ${nameOf(s)} should carry agent_name MCP, got ${JSON.stringify(get(s, 'agent_name', 'agent'))}`);
  }
  const mcpConvs = new Set(runlessMcp.map((s) => get(s, 'conversation_id')).filter(Boolean));
  if (runlessMcp.length) {
    check(mcpConvs.size === 1, `MCP spans should share one conversation_id (the Mcp-Session-Id), got ${JSON.stringify([...mcpConvs])}`);
    if (MCP_SESSION_ID) check(mcpConvs.has(MCP_SESSION_ID), `MCP conversation_id should equal Mcp-Session-Id ${MCP_SESSION_ID}, got ${JSON.stringify([...mcpConvs])}`);
    else notes.push('MCP session id not available (.logs/mcp-session-id / MCP_SESSION_ID); only checked that both spans share a conversation_id');
  }
  const mcpRuns = runList.filter((r) => r._class === 'mcp');
  check(mcpRuns.length === 0, `expected zero MCP runs (MCP is runless), found ${mcpRuns.length}`);

  // ---- hygiene
  const running = runList.filter((r) => /running|in_progress|started|pending/.test(statusOf(r)) || !statusOf(r));
  check(running.length === 0, `runs still running / never ended: ${running.map((r) => `${r.id}(${r._class}:${statusOf(r) || 'no status'})`).join(', ')}`);
  const orphans = spans.filter((s) => s._runId !== null && !runs.has(s._runId));
  check(orphans.length === 0, `orphan spans (run_id points at an unknown run): ${orphans.map((s) => `${nameOf(s)}->${s._runId}`).join(', ')}`);
  const runlessOther = spans.filter((s) => s._runId === null && !runlessMcp.includes(s));
  check(runlessOther.length === 0, `runless spans that are not MCP: ${runlessOther.map((s) => `${kindOf(s)}:${nameOf(s)}`).join(', ')}`);
  const unknown = runList.filter((r) => r._class === 'unknown');
  if (unknown.length) notes.push(`unclassified runs: ${unknown.map((r) => `${r.id}(agent=${get(r, 'agent_name')})`).join(', ')}`);

  // ---- report
  console.log('\nnotes:');
  for (const n of notes) console.log(`  - ${n}`);
  if (failures.length) {
    console.log(`\nFAIL (${failures.length}):`);
    for (const f of failures) console.log(`  x ${f}`);
    process.exit(1);
  }
  console.log('\nPASS: run model matches the intended shape.');
}

main();
