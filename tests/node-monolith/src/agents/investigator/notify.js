'use strict';
// Detached side effect: one small LLM call to phrase the Slack message, then "post" it.
const { client } = require('../../llm/client');
const { notifications } = require('../../store');

async function notifySlack(summary) {
  const completion = await client.chat.completions.create({
    model: 'gpt-4.1-nano',
    messages: [
      { role: 'system', content: 'Rewrite the investigation summary as a one-line Slack notification for #support-escalations.' },
      { role: 'user', content: summary },
    ],
  });
  const text = completion.choices[0].message.content;
  notifications.push({ at: new Date().toISOString(), channel: '#support-escalations', text });
  console.log(`[slack] ${text}`);
  return text;
}

module.exports = { notifySlack };
