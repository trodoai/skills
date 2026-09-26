#!/usr/bin/env node
'use strict';
// Deterministic OpenAI-shaped mock: POST /v1/chat/completions, non-stream and stream:true.
const http = require('http');
const { randomUUID } = require('crypto');

const PORT = Number(process.env.OPENAI_MOCK_PORT || 4320);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p.text || '')).join(' ');
  return content == null ? '' : JSON.stringify(content);
}

function estimateTokens(s) {
  return Math.max(1, Math.ceil(String(s).length / 4));
}

// Decide what the "model" says.
function decide(body) {
  const messages = body.messages || [];
  const toolNames = (body.tools || []).map((t) => t.function && t.function.name).filter(Boolean);
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const lastUserText = lastUser ? textOf(lastUser.content) : '';
  const lower = lastUserText.toLowerCase();
  const hasToolResult = messages.some((m) => m.role === 'tool');

  if (!hasToolResult && toolNames.includes('lookup_order') && lower.includes('order')) {
    const m = lastUserText.match(/\d{3,}/);
    return { toolCall: { name: 'lookup_order', args: { orderId: m ? m[0] : 'unknown' } } };
  }
  if (!hasToolResult && toolNames.includes('escalate') && /escalate|angry/.test(lower)) {
    return { toolCall: { name: 'escalate', args: { reason: lastUserText } } };
  }

  let text;
  if (hasToolResult) {
    const lastTool = [...messages].reverse().find((m) => m.role === 'tool');
    text = `[${body.model}] Based on the tool result: ${textOf(lastTool.content).slice(0, 120)}`;
  } else {
    text = `[${body.model}] Reply to: ${lastUserText.slice(0, 120)}`;
  }
  return { text };
}

function usageFor(body, completionText) {
  const prompt_tokens = estimateTokens(JSON.stringify(body.messages || []));
  const completion_tokens = estimateTokens(completionText);
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
}

function nonStream(res, body, decision) {
  const id = `chatcmpl-${randomUUID().slice(0, 12)}`;
  const created = Math.floor(Date.now() / 1000);
  let message;
  let finish_reason;
  let completionText;
  if (decision.toolCall) {
    const args = JSON.stringify(decision.toolCall.args);
    message = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: decision.toolCall.name, arguments: args } }],
    };
    finish_reason = 'tool_calls';
    completionText = args;
  } else {
    message = { role: 'assistant', content: decision.text };
    finish_reason = 'stop';
    completionText = decision.text;
  }
  const payload = {
    id,
    object: 'chat.completion',
    created,
    model: body.model,
    choices: [{ index: 0, message, finish_reason, logprobs: null }],
    usage: usageFor(body, completionText),
  };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function stream(res, body, decision) {
  const id = `chatcmpl-${randomUUID().slice(0, 12)}`;
  const created = Math.floor(Date.now() / 1000);
  const base = { id, object: 'chat.completion.chunk', created, model: body.model };
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });

  let completionText;
  if (decision.toolCall) {
    const args = JSON.stringify(decision.toolCall.args);
    completionText = args;
    send({
      ...base,
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: decision.toolCall.name, arguments: '' } }] },
        finish_reason: null,
      }],
    });
    const half = Math.ceil(args.length / 2);
    for (const piece of [args.slice(0, half), args.slice(half)]) {
      send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] }, finish_reason: null }] });
    }
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    completionText = decision.text;
    const words = decision.text.split(/(?<=\s)/);
    for (const w of words) {
      send({ ...base, choices: [{ index: 0, delta: { content: w }, finish_reason: null }] });
    }
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }

  // Usage chunk: sent regardless of stream_options.include_usage so the app always sees it.
  send({ ...base, choices: [], usage: usageFor(body, completionText) });
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (req.method !== 'POST' || !/\/v1\/chat\/completions\/?$/.test(req.url)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: `no route ${req.method} ${req.url}`, type: 'invalid_request_error' } }));
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'invalid JSON', type: 'invalid_request_error' } }));
  }

  const allText = (body.messages || []).map((m) => textOf(m.content)).join('\n');
  if (allText.includes('RATE_LIMIT_ME')) {
    console.log(`[openai-mock] 429 for model=${body.model}`);
    res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '1' });
    return res.end(JSON.stringify({
      error: {
        message: 'Rate limit reached for gpt-4.1-mini in organization org-test on requests per min (RPM): Limit 3, Used 3. Please try again in 20s.',
        type: 'rate_limit_error',
        param: null,
        code: 'rate_limit_exceeded',
      },
    }));
  }

  const decision = decide(body);
  console.log(`[openai-mock] model=${body.model} stream=${!!body.stream} -> ${decision.toolCall ? `tool:${decision.toolCall.name}` : 'text'}`);
  if (body.stream) return stream(res, body, decision);
  return nonStream(res, body, decision);
});

server.listen(PORT, () => console.log(`[openai-mock] listening on ${PORT}`));
