'use strict';
// In-memory conversation history keyed by conversationId.
const conversations = new Map();

function getHistory(conversationId) {
  if (!conversations.has(conversationId)) conversations.set(conversationId, []);
  return conversations.get(conversationId);
}

function append(conversationId, message) {
  getHistory(conversationId).push(message);
}

module.exports = { getHistory, append };
