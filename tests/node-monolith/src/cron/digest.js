'use strict';
// Periodic digest: one LLM call summarising all investigations so far.
const express = require('express');
const { client } = require('../llm/client');
const { investigations } = require('../store');

async function runDigest() {
  const items = [...investigations.values()].map((r) => ({
    id: r.id,
    conversationId: r.conversationId,
    userId: r.userId,
    reason: r.reason,
    verdict: r.verdict,
  }));
  const completion = await client.chat.completions.create({
    model: 'gpt-4.1-mini',
    messages: [
      { role: 'system', content: 'You write the daily support-escalation digest. Summarise the investigations in 3 bullets.' },
      { role: 'user', content: items.length ? JSON.stringify(items) : 'No investigations today.' },
    ],
  });
  const text = completion.choices[0].message.content;
  console.log(`[digest] ${items.length} investigations -> ${text.slice(0, 80)}`);
  return { count: items.length, digest: text };
}

let timer = null;
function start() {
  const every = Number(process.env.DIGEST_INTERVAL_MS || 0);
  if (!every) return;
  timer = setInterval(() => runDigest().catch((e) => console.error(`[digest] failed: ${e.message}`)), every);
  timer.unref();
}

const router = express.Router();
router.post('/internal/cron/digest', async (_req, res) => {
  try {
    res.json(await runDigest());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = { router, runDigest, start };
