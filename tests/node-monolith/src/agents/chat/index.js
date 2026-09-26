'use strict';
// Support chat agent: streaming tool-calling loop over the raw openai SDK.
const express = require('express');
const { client } = require('../../llm/client');
const { TOOL_DEFS, TOOLS } = require('./tools');
const { getHistory, append } = require('./history');

const MODEL = 'gpt-4.1-mini';
const MAX_ITERATIONS = 4;
const SYSTEM_PROMPT =
  'You are a friendly support agent for an online store. Use tools when useful. Keep answers short.';

function sse(res, event, data) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function runChatTurn({ conversationId, userId, message, onToken }) {
  const history = getHistory(conversationId);
  append(conversationId, { role: 'user', content: message });

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history];
  let finalText = '';

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const stream = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: TOOL_DEFS,
      stream: true,
      stream_options: { include_usage: true },
      user: userId,
    });

    let content = '';
    const toolCalls = []; // accumulated by index
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        if (onToken) onToken(delta.content);
      }
      for (const tc of delta.tool_calls || []) {
        const slot = (toolCalls[tc.index] ||= { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.function.name += tc.function.name;
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
      }
    }

    if (toolCalls.length === 0) {
      finalText = content;
      break;
    }

    messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });
    for (const call of toolCalls) {
      const fn = TOOLS[call.function.name];
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = {}; }
      let result;
      if (!fn) result = { error: `unknown tool ${call.function.name}` };
      else result = await fn(args, { conversationId, userId });
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  if (!finalText) finalText = 'Sorry, I could not complete that request.';
  append(conversationId, { role: 'assistant', content: finalText });
  return finalText;
}

const router = express.Router();

router.post('/api/chat', async (req, res) => {
  const { conversationId, message } = req.body || {};
  const userId = req.get('x-user-id') || (req.body && req.body.userId) || 'anonymous';
  if (!conversationId || !message) {
    return res.status(400).json({ error: 'conversationId and message are required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const text = await runChatTurn({
      conversationId,
      userId,
      message,
      onToken: (delta) => sse(res, 'token', { delta }),
    });
    sse(res, 'done', { conversationId, userId, text });
  } catch (err) {
    sse(res, 'error', { message: err.message, status: err.status || null });
  } finally {
    res.end();
  }
});

module.exports = { router, runChatTurn };
