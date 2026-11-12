'use strict';

// Local operations commit to the workspace first. No Hub request or previous
// account credential participates in authorizing local replica management.
function create({ app, session, history, BrowserWindow, shell, trash }) {
  const queues = new Map();
  function publish(row) {
    for (const win of BrowserWindow?.getAllWindows?.() || []) {
      try { if (!win.isDestroyed()) win.webContents.send('pi-session-event', {
        kind: 'history-lifecycle', sessionId: row.id, ref: '', presence: row,
      }); } catch (_) { /* A closing window does not revert a durable operation. */ }
    }
  }
  function idle(row) {
    for (const id of [row.id, ...(row.historyAliasIds || [])]) {
      if (session.findBySessionId?.(id)?.inFlight?.()) throw Error('这条会话还在执行，完成或停止后再操作');
    }
  }
  async function run(action, id, options = {}) {
    await options.assertCurrent?.(true);
    const row = await history.resolve(id);
    if (!row) return null;
    if (options.expectedRevision !== undefined && options.expectedRevision !== row.revision) {
      const alreadyApplied = action === 'delete' ? row.deleted : !row.deleted && row.archived === (action === 'archive');
      if (alreadyApplied) return { ok: true, id: row.id, conversation: row, unchanged: true, localOnly: true };
      throw Error('会话已在其他窗口更新，请刷新后重试');
    }
    idle(row);
    const identity = require('../conversation/requirement-context').cachedIdentity(app);
    if (action === 'delete' && options.confirmed !== true) {
      const copy = require('../native-locale.cjs').dialogOptions({ title: '删除本地会话',
        message: '删除“' + String(row.title || '这条会话') + '”？',
        detail: '删除本机保存的会话记录，不删除云端原会话、需求或成果文件。重启后不会自动恢复本地副本。',
        buttons: ['取消', '删除本地记录'] });
      return { ok: false, needsConfirm: true, id: row.id, confirm: {
        title: copy.title, message: copy.message, detail: copy.detail,
        cancel: copy.buttons[0], confirm: copy.buttons[1] } };
    }
    if (row.deleted) return action === 'delete'
      ? { ok: true, id: row.id, alreadyDeleted: true, localOnly: true } : { ok: false, reason: '这条会话已经不存在了' };
    const active = session.findBySessionId?.(row.id);
    if (action !== 'restore' && active?.close && await active.close() === false)
      throw Error('会话仍在关闭，请稍后重试');
    idle(row);
    // Stage deletion as an archive. A failed recycle leaves a visible retry
    // entry in archives; a stale directory refresh cannot reactivate it.
    await options.assertCurrent?.(true);
    const staged = await history.lifecycle(row.id, action === 'delete' ? 'archive' : action, identity);
    if (!staged?.ok) return staged;
    publish(staged.conversation);
    if (action === 'delete') {
      if (!row.cached) {
        const record = require('../conversation/runtime-segments').read(app, row.id);
        if (record) {
          session.setArchived?.(app, row.id, true);
          const result = await session.permanentlyDeleteHistory(app, row.id, { localOnly: true });
          if (!result?.ok && !result?.notFound) throw Error(result?.reason || '清理会话记录失败，请重试');
        } else {
          const found = await session.historyEntry?.(app, row.id, { strict: true });
          if (found?.ok && found.entry?.path) await trash(shell, found.entry.path);
          else if (found?.ok === false && !found.notFound) throw Error(found.reason);
          else {
            const result = await session.forgetRunner(app, row.id, { localOnly: true });
            if (!result?.ok && !result?.notFound) throw Error(result?.reason || '清理会话记录失败，请重试');
          }
        }
      }
      const deleted = await history.lifecycle(row.id, 'delete', identity);
      publish(deleted.conversation);
      return { ...deleted, id: row.id, aliasIds: row.historyAliasIds, localOnly: true, deleted: true };
    }
    // Keep legacy native flags aligned so older renderers and adapters agree.
    if (!row.cached) session.setArchived?.(app, row.id, action === 'archive');
    return { ...staged, id: row.id, localOnly: true, archived: action === 'archive' };
  }
  return async (action, id, options) => {
    const settings = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
    const row = await history.resolve(id);
    if (!require('../conversation/shared-history.cjs').isLocalIdentity(row, id)) return null;
    const previous = queues.get(row.id) || Promise.resolve();
    const pending = previous.catch(() => {}).then(() => run(action, row.id, settings));
    queues.set(row.id, pending);
    try { return await pending; }
    finally { if (queues.get(row.id) === pending) queues.delete(row.id); }
  };
}
module.exports = { create };
