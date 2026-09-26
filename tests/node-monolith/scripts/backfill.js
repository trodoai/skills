#!/usr/bin/env node
'use strict';
// One-shot CLI: classify each fixture ticket with one LLM call, print, exit.
const path = require('path');
const fs = require('fs');
const { client } = require('../src/llm/client');

async function classifyTicket(ticket) {
  const completion = await client.chat.completions.create({
    model: 'gpt-4.1-nano',
    messages: [
      { role: 'system', content: 'Classify the support ticket. Reply with one label: billing, account, shipping, feature, other.' },
      { role: 'user', content: `Ticket ${ticket.id}: ${ticket.subject}\n\n${ticket.body}` },
    ],
  });
  return completion.choices[0].message.content.trim();
}

async function main() {
  const tickets = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'tickets.json'), 'utf8'));
  for (const ticket of tickets) {
    const label = await classifyTicket(ticket);
    console.log(`${ticket.id}\t${label}\t${ticket.subject}`);
  }
  console.log(`[backfill] classified ${tickets.length} tickets`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[backfill] failed: ${err.message}`);
    process.exit(1);
  });
