'use strict';
const express = require('express');
const chat = require('./agents/chat');
const tasks = require('./routes/tasks');
const digest = require('./cron/digest');
const worker = require('./jobs/worker');
const { startMcpServer } = require('./mcp/server');
const { investigations, notifications } = require('./store');

const PORT = Number(process.env.PORT || 4310);

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ ok: true, pid: process.pid }));
app.get('/internal/state', (_req, res) =>
  res.json({ investigations: [...investigations.values()], notifications, queued: worker.queue.length }),
);

app.use(chat.router);
app.use(tasks.router);
app.use(digest.router);

app.use((err, _req, res, _next) => {
  console.error(`[server] ${err.stack || err.message}`);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`[server] listening on ${PORT}`);
  worker.start();
  digest.start();
  startMcpServer(PORT + 1);
});
