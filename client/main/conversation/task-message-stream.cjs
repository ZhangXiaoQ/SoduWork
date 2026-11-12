'use strict';
const source = require('./agent-source.cjs');
const { epoch } = require('./message-time');

// A node streams into ordinary assistant rows. Only completed paragraphs enter
// model history/storage; a token never becomes another paragraph or disk write.
function create(state, persist) {
  const rows = new Map();
  function apply(item, taskId) {
    if (!['text', 'thinking'].includes(item.kind) || !item.streamId) return false;
    const key = 'task-stream:' + item.kind + ':' + item.streamId;
    let message = rows.get(key) || state.messages.find(row => row.taskOutputKey === key);
    if (message?.done) return true; // Native replay of a completed stream.
    const previous = message?.blocks?.[0]?.text || '';
    const incoming = String(item.full ?? item.text ?? '');
    const text = String(item.delta ? previous + incoming : incoming || (item.done ? previous : ''));
    if (!text) return true;
    const completedAt = item.done ? epoch(item.at) || Date.now() : 0;
    const record = { kind: 'message', role: 'assistant', text, blockKind: item.kind,
      taskId, taskOutputKey: key, completedAt, ...source.fields(item.sourceAgent) };
    // Commit before exposing completion. A failed save can safely retry the
    // final snapshot without duplicating a message or losing partial content.
    if (item.done) persist(record);
    if (!message) {
      message = { role: 'assistant', taskId, taskOutputKey: key, scope: 'normal',
        ...source.fields(item.sourceAgent), blocks: [{ index: 0, kind: item.kind, text: '' }], done: false };
      state.messages.push(message); rows.set(key, message);
    }
    message.blocks[0].text = text;
    Object.assign(message, source.fields(item.sourceAgent));
    message.blocks[0].done = item.done === true;
    message.done = item.done === true;
    message.completedAt = completedAt;
    if (state._snapshotCache) state._snapshotCache.messages.delete(message);
    return true;
  }
  function finish(prefix) {
    for (const [key, message] of rows) {
      const streamId = key.slice(('task-stream:' + message.blocks[0].kind + ':').length);
      if (message.done || !streamId.startsWith(prefix + ':')) continue;
      apply({ kind: message.blocks[0].kind, streamId, text: message.blocks[0].text,
        sourceAgent: message.sourceAgent, done: true }, message.taskId);
    }
  }
  return { apply, finish };
}
function nativeMessage(row, model) {
  return { role: 'assistant', taskId: row.taskId, taskOutputKey: row.taskOutputKey,
    ...source.fields(row.sourceAgent), timestamp: row.completedAt, completedAt: row.completedAt,
    api: model.api || 'openai-completions', provider: model.provider, model: model.id,
    stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    content: row.blockKind === 'thinking' ? [{ type: 'thinking', thinking: row.text }]
      : [{ type: 'text', text: row.text }] };
}
module.exports = { create, nativeMessage };
