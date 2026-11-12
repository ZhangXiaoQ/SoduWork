'use strict';

/* Conversation history is a projection of persisted rows plus live handles.
   Keeping it outside session.js prevents UI presence from leaking into runtime. */
function presenceState(status) {
  if (status === 'streaming' || status === 'compacting') return 'running';
  if (status === 'queued') return 'waiting';
  if (status === 'waiting-user') return 'waiting';
  if (status === 'unreachable' || status === 'no-output' || status === 'incomplete') return 'failed';
  if (status === 'aborted') return 'stopped';
  return status === 'idle' ? 'completed' : 'archived';
}

function messageTitle(snapshot) {
  const first = ((snapshot && snapshot.messages) || []).find(item => item && item.role === 'user');
  const raw = first && (first.text || first.content || first.message);
  const text = Array.isArray(raw)
    ? raw.map(item => item && (item.text || item.content) || '').join(' ')
    : String(raw || '');
  if (!text.trim()) return '';
  // Use the same envelope policy as archived history so live and cold rows cannot disagree.
  return require('./session-helpers').title({ firstMessage: text });
}

function originalMessageTitle(entries, messages) {
  // A restored UI contains only the bounded tail. Resolve the name once from
  // the original archive, stopping at its first visible user request instead
  // of replaying or projecting old assistant/tool receipts.
  const stored = Array.isArray(entries) ? entries : [];
  const archive = stored.some(entry => entry?.type === 'message' && entry.message);
  const acc = require('./event-stream').create();
  for (const entry of archive ? stored : messages || []) {
    const message = archive ? entry?.type === 'message' && entry.message : entry;
    if (message?.role !== 'user') continue;
    acc.push({ type: 'message_end', message, replay: true });
    const text = acc.state.messages.at(-1)?.text;
    if (typeof text === 'string' && text.trim()) return require('./session-helpers').title({ firstMessage: text });
  }
  return '';
}

function mergeHistory(diskRows, handles, limit) {
  const live = new Map((handles || []).map(handle => {
    const row = handle && typeof handle.historyRow === 'function' ? handle.historyRow() : null;
    return row && row.id ? [String(row.id), row] : null;
  }).filter(Boolean));
  const merged = (diskRows || []).map(row => {
    const current = live.get(String(row.id || ''));
    if (!current) return row;
    live.delete(String(row.id));
    return { ...row, ...current, path: row.path || current.path || '' };
  });
  live.forEach(row => merged.push(row));
  return merged.sort((left, right) => Number(right.at || 0) - Number(left.at || 0))
    .slice(0, Math.max(1, Number(limit) || 20));
}

module.exports = { presenceState, messageTitle, originalMessageTitle, mergeHistory };
