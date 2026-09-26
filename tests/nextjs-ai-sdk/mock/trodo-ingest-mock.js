// Catch-all ingest sink. Any method/path -> one JSONL line in mock/ingest-log.jsonl.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.INGEST_PORT || 4530);
const LOG = path.join(__dirname, "ingest-log.jsonl");

function siteIdOf(req, body) {
  return (
    req.headers["x-trodo-site-id"] ||
    req.headers["x-site-id"] ||
    (body && (body.site_id || body.siteId)) ||
    null
  );
}

const server = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    let body = null;
    if (data) {
      try { body = JSON.parse(data); } catch { body = { _raw: data }; }
    }
    const line = {
      ts: new Date().toISOString(),
      method: req.method,
      path: req.url,
      site_id: siteIdOf(req, body),
      headers: { authorization: req.headers.authorization ? "<present>" : undefined, "content-type": req.headers["content-type"] },
      body,
    };
    fs.appendFileSync(LOG, JSON.stringify(line) + "\n");
    console.log(`[ingest-mock] ${req.method} ${req.url} (${data.length}b)`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, run_id: (body && (body.run_id || body.runId || (body.run && body.run.run_id))) || crypto.randomUUID() }));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[ingest-mock] listening on http://127.0.0.1:${PORT} -> ${LOG}`);
});
