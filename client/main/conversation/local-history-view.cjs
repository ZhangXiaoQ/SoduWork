'use strict';

const { project } = require('./history-message.cjs');

// Passive history never constructs a runtime or imports source credentials.
// Retain only message indexes and page cursors between bounded window reads.
async function create({ row, read }) {
  const MAX_BYTES = 8 * 1024 * 1024, MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
  let closed = false, pending, indexed = false;
  const entries = [], streams = new Map();
  let value = { messages: [], tools: [], status: 'idle', adapterId: row.adapterId || 'pi',
    displayName: row.displayName || row.adapterId || 'Pi', modelSelection: {},
    accessControl: { mode: 'readonly', capabilities: [] },
    execution: { readOnly: true, localReplica: true }, localReplica: true };
  const keyFor = (page, item, cursor, index) => page.format === 'events'
    ? 'stream:' + String(item.streamId || item.id || cursor + ':' + index)
    : 'message:' + cursor + ':' + index;
  function window(limit) {
    const messages = new Map(); let bytes = 2;
    function apply(entry, item) {
      const evicted = [];
      const old = messages.get(entry.index);
      const message = project({ ...item, id: entry.id, done: true,
        text: item.delta === true ? (old?.text || '') + (item.text || '') : item.text || '' });
      const size = Buffer.byteLength(JSON.stringify(message));
      if (size > MAX_MESSAGE_BYTES) throw Error('单条历史消息过大，请在原执行底座查看完整内容');
      // Account for the JSON array brackets and separators sent over IPC.
      bytes += size - (old ? Buffer.byteLength(JSON.stringify(old)) : 0) + (!old && messages.size ? 1 : 0);
      messages.set(entry.index, message);
      while (messages.size > limit || bytes > MAX_BYTES) {
        const first = messages.keys().next().value, removed = messages.get(first);
        bytes -= Buffer.byteLength(JSON.stringify(removed)) + (messages.size > 1 ? 1 : 0); messages.delete(first);
        evicted.push(first);
      }
      return evicted;
    }
    return { apply, has: index => messages.has(index), publish() {
      const indices = [...messages.keys()].sort((a, b) => a - b);
      value = { ...value, messages: indices.map(index => messages.get(index)), history: {
        totalMessages: entries.length, messageLimit: limit, messageIndices: indices,
        messageStart: indices[0] ?? entries.length, truncated: indices.length < entries.length } };
    } };
  }
  async function index(limit) {
    entries.length = 0; streams.clear();
    const output = window(limit); let after = 0;
    while (!closed) {
      const page = await read(row.id, { after, offset: after, limit: 200 });
      for (const [position, item] of (page.items || []).entries()) {
        const key = keyFor(page, item, after, position);
        let entry = streams.get(key);
        const fresh = !entry;
        if (fresh) {
          entry = { index: entries.length, id: String(item.streamId || item.id || key), pages: new Set() };
          entries.push(entry); streams.set(key, entry);
        }
        entry.pages.add(after);
        // A late delta of an evicted stream does not become a new message.
        if (fresh || output.has(entry.index)) output.apply(entry, item);
      }
      if (page.nextCursor == null) break;
      if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor <= after) throw Error('Local history cursor did not advance');
      after = page.nextCursor;
    }
    if (!closed) { indexed = true; output.publish(); }
  }
  async function expand(limit) {
    const selected = new Set(entries.slice(-limit).map(entry => entry.index));
    const cursors = new Set();
    for (const entry of entries.slice(-limit)) for (const cursor of entry.pages) cursors.add(cursor);
    const output = window(limit), evicted = new Set();
    for (const after of [...cursors].sort((a, b) => a - b)) {
      if (closed) return;
      const page = await read(row.id, { after, offset: after, limit: 200 });
      for (const [position, item] of (page.items || []).entries()) {
        const entry = streams.get(keyFor(page, item, after, position));
        if (!entry || !selected.has(entry.index) || evicted.has(entry.index)) continue;
        // The byte bound may evict an older selected message; retain its index
        // so a later delta cannot return a partial prefix to the renderer.
        for (const index of output.apply(entry, item)) evicted.add(index);
      }
    }
    if (!closed) output.publish();
  }
  async function loadHistory(options = {}) {
    const limit = Math.min(2000, Math.max(80, Number(options.messageLimit) || 100));
    const previous = pending;
    const job = (async () => {
      if (previous) await previous;
      if (closed) return;
      if (!indexed) await index(limit);
      else if (limit !== value.history.messageLimit) await expand(limit);
    })();
    pending = job;
    try { await job; } finally { if (pending === job) pending = null; }
  }
  await loadHistory();
  return { ref: 'local-history-' + row.id, sessionId: row.id, adapterId: value.adapterId,
    localReplica: true, readOnly: true, ui: { mode: 'readonly', title: row.title || '', capabilities: [] },
    snapshot: () => value, uiSnapshot: () => value, historyRow: () => row, loadHistory,
    on: () => () => {}, inFlight: () => false, close: async () => { closed = true; streams.clear(); entries.length = 0; return true; },
    send: async () => ({ ok: false, accepted: false, reason: '本地历史为只读，请使用当前账号新建会话继续' }),
    stop: async () => ({ ok: false, reason: '本地历史没有正在执行的任务' }) };
}
module.exports = { create };
