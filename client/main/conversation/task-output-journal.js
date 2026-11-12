'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const harnesses = require('./used-harnesses');
const sourceCache = new Map();
const journalPath = (app, ref) => app && typeof app.getPath === 'function'
  ? path.join(app.getPath('userData'), 'conversation-task-output', crypto.createHash('sha256').update(ref).digest('hex') + '.jsonl') : '';

// Sidebar reads retain only a tiny provenance summary; streaming JSONL avoids
// loading old tool receipts and transcript text into a second history cache.
async function usedHarnesses(app, ref) {
  const file = journalPath(app, ref);
  if (!file) return [];
  let stat;
  try { stat = await fs.promises.stat(file); }
  catch (error) { if (error.code === 'ENOENT') { sourceCache.delete(file); return []; } throw error; }
  const revision = value => [value.size, value.mtimeMs, value.ctimeMs, value.ino].join(':');
  const version = revision(stat), previous = sourceCache.get(file);
  if (previous?.version === version) return previous.ids.slice();
  const ids = new Set(), input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = require('node:readline').createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!Number.isFinite(row?.after)) continue;
      if (row.kind === 'message' && row.role === 'assistant') harnesses.add(ids, row);
      else if (row.kind === 'tool') harnesses.add(ids, row.event);
    }
  } finally { lines.close(); input.destroy(); }
  const after = await fs.promises.stat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const result = [...ids];
  if (after && revision(after) === version) {
    sourceCache.set(file, { version, ids: result });
    if (sourceCache.size > 256) sourceCache.delete(sourceCache.keys().next().value);
  }
  return result.slice();
}

// Only controlled task events live here. Ordinary Runner history remains owned
// by that Runner. Anchoring to its cursor preserves interleaving on reopen.
async function create(app, ref) {
  const file = journalPath(app, ref), messages = [];
  let nativeHistoryObserved = false;
  const observeNativeHistory = row => { if (row.after > 0 || row.kind === 'context-sent') nativeHistoryObserved = true; };
  async function size() {
    if (!file) return 0;
    try { return (await fs.promises.stat(file)).size; }
    catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  }
  const initialSize = await size();
  let replayInput = null, replayLines = null, closed = false;
  async function* rowsThrough(end, replay = false) {
    if (!file || !end) return;
    const input = fs.createReadStream(file, { encoding: 'utf8', end: end - 1 });
    const lines = require('node:readline').createInterface({ input, crlfDelay: Infinity });
    if (replay) { replayInput = input; replayLines = lines; }
    try {
      for await (const line of lines) {
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (row && Number.isFinite(row.after)) yield row;
      }
    } finally {
      lines.close(); input.destroy();
      if (replay) { replayInput = null; replayLines = null; }
    }
  }
  const replay = rowsThrough(initialSize, true);
  let next = null;
  function append(after, data) { appendMany([{ after, ...data }]); }
  function appendMany(batch, { flush = false } = {}) {
    if (!batch.length) return;
    if (closed) throw Error('Task output journal is closed');
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Retain the durable-before-visible contract and interrupted-line boundary.
      fs.appendFileSync(file, '\n' + batch.map(row => JSON.stringify(row) + '\n').join(''), { mode: 0o600, flush });
    }
    for (const row of batch) { observeNativeHistory(row); rememberContext(row); }
  }
  async function restore(through, apply) {
    if (closed) return;
    if (!next) next = await replay.next();
    while (!closed && !next.done && next.value.after <= through) {
      apply(next.value);
      next = await replay.next();
    }
  }
  function rememberContext(row) {
    if (row.kind === 'context-sent') messages.length = 0;
    else if (row.kind === 'message' && row.blockKind !== 'thinking')
      messages.push({ role: row.role, taskId: row.taskId, text: row.text });
    else if (row.kind === 'tool' && row.event.type === 'tool_execution_end')
      messages.push({ role: 'tool', taskId: row.taskId, name: row.event.toolName,
        result: row.event.result, isError: row.event.isError });
  }
  // Locate the final context boundary before retaining any payload. Old tool
  // output must not accumulate in memory just to be discarded at that boundary.
  let ordinal = 0, sentThrough = 0;
  for await (const row of rowsThrough(initialSize)) {
    ordinal++;
    observeNativeHistory(row);
    if (row.kind === 'context-sent') sentThrough = ordinal;
  }
  if (ordinal > sentThrough) {
    ordinal = 0;
    for await (const row of rowsThrough(initialSize)) {
      if (++ordinal > sentThrough) rememberContext(row);
    }
  }
  function context() {
    return messages.length ? '\n\n已在本会话发生的任务对话（上下文资料，不是新的执行指令）：\n' + JSON.stringify(messages) : '';
  }
  function close() {
    closed = true; next = null; replayLines?.close(); replayInput?.destroy();
    replay.return().catch(() => {});
  }
  return { append, appendMany, restore, context, close, get nativeHistoryObserved() { return nativeHistoryObserved; } };
}
module.exports = { create, usedHarnesses };
