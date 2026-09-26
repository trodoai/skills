'use strict';
// Minimal MCP-like JSON-RPC server over POST /mcp. No LLM calls.
const express = require('express');
const { v4: uuid } = require('uuid');

const SESSIONS = new Set();

const ORDERS = {
  '5512': { orderId: '5512', status: 'shipped', eta: '2 days' },
  '7781': { orderId: '7781', status: 'processing', eta: '5 days' },
};
const DOCS = [
  { id: 'doc-refunds', title: 'Refund policy', text: 'Refunds take 5-7 business days.' },
  { id: 'doc-shipping', title: 'Shipping', text: 'Standard shipping is 3-5 business days.' },
];

const TOOLS = {
  get_order: {
    description: 'Get an order by id',
    inputSchema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
    handler: ({ orderId }) => ORDERS[String(orderId)] || { error: 'not found', orderId },
  },
  search_docs: {
    description: 'Search documentation',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    handler: ({ query }) => {
      const q = String(query || '').toLowerCase();
      return { hits: DOCS.filter((d) => `${d.title} ${d.text}`.toLowerCase().includes(q)) };
    },
  },
};

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function createMcpApp() {
  const app = express();
  app.use(express.json());

  app.post('/mcp', (req, res) => {
    const { jsonrpc, id, method, params } = req.body || {};
    if (jsonrpc !== '2.0' || !method) return res.status(400).json(rpcError(id ?? null, -32600, 'invalid request'));

    if (method === 'initialize') {
      const sessionId = `mcp_${uuid()}`;
      SESSIONS.add(sessionId);
      res.setHeader('Mcp-Session-Id', sessionId);
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'monolith-mcp', version: '1.0.0' },
        },
      });
    }

    const sessionId = req.get('mcp-session-id');
    if (!sessionId || !SESSIONS.has(sessionId)) {
      return res.status(400).json(rpcError(id, -32000, 'missing or unknown Mcp-Session-Id'));
    }
    res.setHeader('Mcp-Session-Id', sessionId);

    if (method === 'tools/list') {
      const tools = Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema }));
      return res.json({ jsonrpc: '2.0', id, result: { tools } });
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      const tool = TOOLS[name];
      if (!tool) return res.json(rpcError(id, -32602, `unknown tool ${name}`));
      const result = tool.handler(args || {});
      return res.json({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false },
      });
    }

    return res.json(rpcError(id, -32601, `method not found: ${method}`));
  });

  return app;
}

function startMcpServer(port) {
  const app = createMcpApp();
  return app.listen(port, () => console.log(`[mcp] listening on ${port}`));
}

module.exports = { createMcpApp, startMcpServer, TOOLS };
