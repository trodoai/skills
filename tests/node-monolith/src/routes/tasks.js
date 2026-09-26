'use strict';
// Multiplexed one-shot task endpoint: one handler, three different "agents"
// chosen by body.type, each with its own system prompt and model string.
const express = require('express');
const { client } = require('../llm/client');

const TASKS = {
  summarize: {
    model: 'gpt-4.1-mini',
    system: 'You are a summarizer. Summarize the user text in one sentence.',
  },
  classify: {
    model: 'gpt-4.1-nano',
    system: 'You are a classifier. Reply with exactly one label: billing, account, shipping, or other.',
  },
  translate: {
    model: 'gpt-4o-mini',
    system: 'You are a translator. Translate the user text into French.',
  },
};

const router = express.Router();

router.post('/api/tasks/run', async (req, res) => {
  const { type, text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text is required' });

  let spec;
  switch (type) {
    case 'summarize':
    case 'classify':
    case 'translate':
      spec = TASKS[type];
      break;
    default:
      return res.status(400).json({ error: `unknown task type: ${type}` });
  }

  try {
    const completion = await client.chat.completions.create({
      model: spec.model,
      messages: [
        { role: 'system', content: spec.system },
        { role: 'user', content: text },
      ],
    });
    const output = completion.choices[0].message.content;
    res.json({ type, model: spec.model, output, usage: completion.usage });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = { router };
