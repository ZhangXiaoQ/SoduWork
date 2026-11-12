'use strict';

// Passive text archives and runtime snapshots share the same renderer contract.
// Existing structured blocks remain authoritative; do not duplicate their prose.
function project(message) {
  if (message?.role !== 'assistant' || (Array.isArray(message.blocks) && message.blocks.length) ||
      typeof message.text !== 'string' || !message.text) return message;
  return { ...message, blocks: [{ index: 0, kind: 'text', text: message.text,
    done: message.done !== false, toolCall: null }] };
}

module.exports = { project };
