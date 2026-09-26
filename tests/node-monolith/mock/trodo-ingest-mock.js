#!/usr/bin/env node
'use strict';
// Catch-all ingest mock: records every request to mock/ingest-log.jsonl as
//   { ts, method, path, site_id, content_type, content_length, body, response }
// and answers 200 { ok: true, run_id }. Protobuf bodies (/v1/traces) are not parsed.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const PORT = Number(process.env.INGEST_PORT || 4330);
const LOG = process.env.INGEST_LOG || path.join(__dirname, 'ingest-log.jsonl');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, log: LOG }));
  }

  const raw = await readBody(req);
  const contentType = req.headers['content-type'] || '';
  const isBinary = /protobuf|octet-stream/.test(contentType) || url.pathname.endsWith('/v1/traces');

  let body = null;
  if (!isBinary && raw.length) {
    const text = raw.toString('utf8');
    try { body = JSON.parse(text); } catch { body = text; }
  }

  const bodyRunId = body && typeof body === 'object' && !Array.isArray(body) ? (body.run_id || body.runId || body.id) : undefined;
  const response = { ok: true, run_id: bodyRunId || randomUUID() };

  const entry = {
    ts: new Date().toISOString(),
    method: req.method,
    path: url.pathname,
    query: url.search || undefined,
    site_id: req.headers['x-trodo-site-id'] || null,
    content_type: contentType || null,
    content_length: raw.length,
    body: isBinary ? null : body,
    response,
  };
  fs.appendFileSync(LOG, JSON.stringify(entry) + '\n');
  console.log(`[ingest-mock] ${req.method} ${url.pathname} site=${entry.site_id} bytes=${raw.length}`);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(response));
});

server.listen(PORT, () => console.log(`[ingest-mock] listening on ${PORT}, logging to ${LOG}`));
