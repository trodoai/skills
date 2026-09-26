'use strict';
// RLM-style investigator: hydrate -> plan -> N rounds (LLM + tools) -> adjudicate -> persist.
const { v4: uuid } = require('uuid');
const { client } = require('../../llm/client');
const { getHistory } = require('../chat/history');
const { investigations } = require('../../store');
const { fetchLogs, queryMetrics } = require('./tools');
const { notifySlack } = require('./notify');

const PLANNER_MODEL = 'gpt-4.1';
const ROUND_MODEL = 'gpt-4.1-mini';
const ADJUDICATE_MODEL = 'gpt-4.1';

// Generic hydration: gather whatever context exists for the payload.
function hydrate(payload) {
  const { conversationId, userId, reason } = payload;
  const transcript = getHistory(conversationId)
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');
  return { conversationId, userId, reason, transcript, hydratedAt: new Date().toISOString() };
}

async function llm(model, system, user) {
  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  return completion.choices[0].message.content;
}

async function runRound(round, ctx, plan) {
  const logs = fetchLogs({ conversationId: ctx.conversationId, window: `${round * 15}m` });
  let metrics = null;
  if (round % 2 === 1) metrics = queryMetrics({ service: 'payment-service', window: `${round * 15}m` });
  const analysis = await llm(
    ROUND_MODEL,
    `You are investigation round ${round}. Analyse the evidence against the plan and state one finding.`,
    JSON.stringify({ plan, logs, metrics }),
  );
  return { round, logs, metrics, analysis };
}

async function investigate(job) {
  const rounds = Number(process.env.INVESTIGATOR_ROUNDS || 3);
  const ctx = hydrate(job.payload);

  const plan = await llm(
    PLANNER_MODEL,
    'You are an incident planner. Given an escalated support conversation, write a 3-step investigation plan.',
    `Reason: ${ctx.reason}\nUser: ${ctx.userId}\nTranscript:\n${ctx.transcript}`,
  );

  const findings = [];
  for (let r = 1; r <= rounds; r++) {
    findings.push(await runRound(r, ctx, plan));
  }

  const verdict = await llm(
    ADJUDICATE_MODEL,
    'You are the adjudicator. Given the plan and findings, produce a root-cause summary and next action.',
    JSON.stringify({ plan, findings: findings.map((f) => f.analysis) }),
  );

  const record = {
    id: `inv_${uuid()}`,
    jobId: job.id,
    conversationId: ctx.conversationId,
    userId: ctx.userId,
    reason: ctx.reason,
    plan,
    rounds: findings.length,
    verdict,
    createdAt: new Date().toISOString(),
  };
  investigations.set(record.id, record);
  console.log(`[investigator] persisted ${record.id} for ${ctx.conversationId}`);

  // Detached, un-awaited notification. Deliberate: a tracer must not lose this.
  setImmediate(() => {
    notifySlack(`Investigation ${record.id} (${ctx.conversationId}): ${verdict}`).catch((err) =>
      console.error(`[slack] failed: ${err.message}`),
    );
  });

  return record;
}

module.exports = { investigate, hydrate };
