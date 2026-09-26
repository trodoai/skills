'use strict';
// In-memory persistence for the whole monolith.
const investigations = new Map(); // id -> record
const notifications = [];         // { at, channel, text }

module.exports = { investigations, notifications };
