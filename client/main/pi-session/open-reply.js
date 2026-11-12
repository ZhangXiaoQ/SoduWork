'use strict';
const path = require('path');
const conversationTitles = require('../conversation/titles');
const contextWindow = require('../conversation/context-window');

// IPC replies must be structured-cloneable. The live session UI also carries
// private lifecycle disposers (for example memorySubscription); strip
// functions recursively instead of allowing Electron to reject the reply.
function publicUi(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' || typeof value === 'symbol' ? undefined : value;
  }
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => publicUi(item, seen));
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const clean = publicUi(item, seen);
    if (clean !== undefined) output[key] = clean;
  }
  return output;
}
function openReply(app, handle, extra) {
  const ui = publicUi(handle.ui || {});
  const snapshot = { ...(typeof handle.uiSnapshot === 'function' ? handle.uiSnapshot() : handle.snapshot()),
    ...(handle.deliverySync ? { deliverySync: publicUi(handle.deliverySync) } : {}) };
  const historyRow = typeof handle.historyRow === 'function' ? handle.historyRow(snapshot) : null;
  // A composer can have a title before it becomes a durable history entry.
  const row = conversationTitles.decorate(app, historyRow || { id: handle.sessionId,
    title: (typeof handle.title === 'string' && handle.title) || ui.title || '' });
  const rawModel = handle.model;
  const model = rawModel && typeof rawModel === 'object' ? (() => {
    const resolved = contextWindow.resolveContextWindow(rawModel);
    return {
      id: String(rawModel.id || rawModel.name || ''),
      name: String(rawModel.name || rawModel.id || ''),
      label: String(rawModel.label || rawModel.name || rawModel.id || ''),
      contextWindow: rawModel.modality === 'image' ? 0 : resolved.contextWindow,
      contextWindowKnown: rawModel.modality === 'image' ? false : resolved.contextWindowKnown,
      ...(rawModel.modality === 'image' ? {} : {
        contextWindowEstimated: resolved.contextWindowEstimated,
        contextWindowSource: resolved.contextWindowSource,
      }),
      ...(rawModel.modality ? { modality: rawModel.modality } : {}),
    };
  })() : (rawModel ? {
    id: String(rawModel), name: String(rawModel), label: String(rawModel),
  } : null);
  return {
    ...ui, ...(extra || {}), ok: true,
    ref: handle.ref, cwd: handle.cwd, workspaceName: path.basename(handle.cwd || ''),
    sessionId: handle.sessionId, title: row ? row.title : (ui.title || ''),
    adapterId: handle.adapterId || snapshot.adapterId || 'pi',
    displayName: snapshot.displayName || handle.displayName || 'Pi',
    accessControl: snapshot.accessControl || null,
    model, snapshot, intent: handle.intent,
    goal: typeof handle.goalView === 'function' ? handle.goalView() : handle.goal,
    taskId: String(handle.taskRef || ''),
    taskTitle: String(handle.taskTitle || ''),
    taskIds: Array.isArray(handle.taskIds) ? handle.taskIds.slice() : (handle.taskRef ? [String(handle.taskRef)] : []),
    taskBindings: Array.isArray(handle.taskBindings) ? handle.taskBindings.slice() : [],
    activeTaskId: String(handle.activeTaskId || handle.taskRef || ''),
    collaboration: Boolean((handle.taskIds || []).length || handle.taskRef),
    acceptanceSession: require('../conversation/acceptance-session').get(handle),
  };
}


module.exports = { openReply, publicUi };
