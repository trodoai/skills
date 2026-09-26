'use strict';
// In-process job queue: a plain array polled by setInterval.
const { v4: uuid } = require('uuid');

const queue = [];
let timer = null;
let busy = false;

function enqueue(type, payload) {
  const job = { id: `job_${uuid()}`, type, payload, enqueuedAt: new Date().toISOString() };
  queue.push(job);
  console.log(`[worker] enqueued ${type} ${job.id}`);
  return job.id;
}

const HANDLERS = {
  // required lazily to avoid an import cycle (chat tools -> worker -> investigator -> chat history)
  investigate_issue: (job) => require('../agents/investigator').investigate(job),
};

async function tick() {
  if (busy || queue.length === 0) return;
  busy = true;
  const job = queue.shift();
  const handler = HANDLERS[job.type];
  try {
    if (!handler) throw new Error(`no handler for job type ${job.type}`);
    console.log(`[worker] running ${job.type} ${job.id}`);
    await handler(job);
    console.log(`[worker] done ${job.type} ${job.id}`);
  } catch (err) {
    console.error(`[worker] failed ${job.type} ${job.id}: ${err.message}`);
  } finally {
    busy = false;
  }
}

function start(intervalMs = 250) {
  if (timer) return;
  timer = setInterval(tick, intervalMs);
  timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { enqueue, start, stop, queue };
