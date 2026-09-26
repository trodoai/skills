'use strict';
// Shared OpenAI client, constructed at module top level (deliberate: this is the
// usual shape in real apps, and it is a pitfall for instrumentation that wraps
// the client after import).
const OpenAI = require('openai');

const client = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL || 'http://127.0.0.1:4320/v1',
  apiKey: 'test',
  maxRetries: 0,
});

module.exports = { client };
