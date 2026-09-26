'use strict';
// Fake data-plane tools for the investigator.
function fetchLogs({ conversationId, window }) {
  return {
    window,
    lines: [
      `[warn] payment-service conv=${conversationId} retry=2 latency=2310ms`,
      `[error] refund-worker conv=${conversationId} timeout after 5000ms`,
      `[info] chat-gateway conv=${conversationId} escalation requested`,
    ],
  };
}

function queryMetrics({ service, window }) {
  return {
    service,
    window,
    p95_latency_ms: 2100 + Math.floor(Math.random() * 300),
    error_rate: 0.04,
    saturation: 0.71,
  };
}

module.exports = { fetchLogs, queryMetrics };
