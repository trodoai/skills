'use strict';
const { enqueue } = require('../../jobs/worker');

const ORDERS = {
  '5512': { orderId: '5512', status: 'shipped', carrier: 'UPS', eta: '2 days', items: ['Desk lamp', 'USB-C cable'] },
  '7781': { orderId: '7781', status: 'processing', carrier: null, eta: '5 days', items: ['Standing mat'] },
};

const KB = [
  { id: 'kb-refunds', title: 'Refund policy', text: 'Refunds are processed within 5-7 business days after the return is received.' },
  { id: 'kb-shipping', title: 'Shipping times', text: 'Standard shipping takes 3-5 business days. Express shipping takes 1-2 business days.' },
  { id: 'kb-account', title: 'Account help', text: 'You can reset your password from the login page. Account emails can be changed in Settings.' },
  { id: 'kb-returns', title: 'Returns', text: 'Items can be returned within 30 days of delivery in original packaging.' },
];

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'lookup_order',
      description: 'Look up an order by id',
      parameters: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_kb',
      description: 'Search the knowledge base',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalate',
      description: 'Escalate the conversation to a human investigator',
      parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
    },
  },
];

// Each tool receives (args, ctx) where ctx = { conversationId, userId }.
const TOOLS = {
  lookup_order: async ({ orderId }) => {
    const order = ORDERS[String(orderId)];
    return order ? { found: true, order } : { found: false, orderId };
  },
  search_kb: async ({ query }) => {
    const words = String(query || '').toLowerCase().split(/\W+/).filter(Boolean);
    const hits = KB.map((doc) => {
      const hay = `${doc.title} ${doc.text}`.toLowerCase();
      const score = words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
      return { doc, score };
    })
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((h) => h.doc);
    return { hits };
  },
  escalate: async ({ reason }, ctx) => {
    const jobId = enqueue('investigate_issue', {
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      reason: reason || 'unspecified',
    });
    return { queued: true, jobId };
  },
};

module.exports = { TOOL_DEFS, TOOLS };
