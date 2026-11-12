'use strict';

// History mutations belong to the archive, independent of a model session.
const conversationTitles = require('../conversation/titles');
const fs = require('node:fs/promises');
const path = require('node:path');
const historyAccess = require('../conversation/history-access');

// Prepare the current user's local recycle directory before asking the shell
// to delete anything. A failed preparation must leave the archive untouched.
const SID_PATTERN = /^S-1-\d+(?:-\d+)+$/;
function currentWindowsSid() {
  if (process.platform !== 'win32') return Promise.resolve('');
  return new Promise(resolve => {
    /* Use an absolute executable path to avoid incompatible Git Bash or MSYS tools on PATH. */
    const whoami = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe');
    require('node:child_process').execFile(whoami, ['/user', '/fo', 'csv', '/nh'],
      { timeout: 4000, windowsHide: true }, (error, stdout) => {
        if (error) return resolve('');
        const found = String(stdout || '').trim().match(/^"[^"\r\n]*","(S-1-\d+(?:-\d+)+)"$/);
        resolve(found ? found[1] : '');
      });
  });
}
async function ensureRecycleBinFor(volumeRoot) {
  if (process.platform !== 'win32' || !/^[a-z]:[\\/]$/i.test(volumeRoot)) return false;
  const sid = await currentWindowsSid();
  if (!SID_PATTERN.test(sid)) return false;
  try {
    // Do not follow a junction/symlink or recursively create arbitrary parents.
    for (const dir of [path.join(volumeRoot, '$Recycle.Bin'), path.join(volumeRoot, '$Recycle.Bin', sid)]) {
      let stat;
      try { stat = await fs.lstat(dir); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        try { await fs.mkdir(dir); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        stat = await fs.lstat(dir);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    }
    return true;
  } catch (_) { return false; }
}
async function trashWithRecovery(shell, filePath) {
  if (process.platform !== 'win32') return shell.trashItem(filePath);
  const volumeRoot = path.parse(String(filePath)).root;
  if (!await ensureRecycleBinFor(volumeRoot)) {
    throw Error('系统回收站尚未就绪，会话存档已保留，请检查回收站后重试');
  }
  if (String(filePath).length >= 260) {
    return require('./recycle-long-path.cjs').recycleLongPath(shell, filePath);
  }
  try {
    await shell.trashItem(filePath);
  } catch (error) {
    const restored = await ensureRecycleBinFor(volumeRoot)
      .catch(() => false);
    if (!restored) throw error;
    try {
      await shell.trashItem(filePath);
    } catch (_) { throw error; /* If retry fails, preserve the original error rather than replacing it with a generic retry failure. */ }
  }
}

function install({ app, ipcMain, session, BrowserWindow, dialog, shell, cloudHistory, accountHistory, sharedHistory, trash = trashWithRecovery }) {
  const localAction = sharedHistory ? require('./local-history-actions.cjs').create({
    app, session, history: sharedHistory, BrowserWindow, shell, trash }) : async () => null;
  const { authorize } = require('./history-lifecycle.cjs').create({ app, session, accountHistory, BrowserWindow });
  function deletionFailure(guard, result, staged) {
    if (!staged?.found) return result;
    // Keep an actionable archive if local cleanup or the final Hub deletion
    // fails. An irreversible tombstone must not swallow the retry entry.
    guard.complete('archive', {}, staged);
    const { translate } = require('../native-locale.cjs');
    return { ...(result || {}), ok: false,
      reason: translate('删除没有完成。账号会话已归档，请在归档会话中重试。') +
        (result?.reason ? '\n' + translate(String(result.reason)) : '') };
  }
  async function finishDeletion(guard, result, staged, accountOnly = false) {
    if (!result?.ok) return deletionFailure(guard, result, staged);
    const committed = !accountOnly && staged?.found ? await guard.commit('delete') : staged;
    if (committed?.ok && result.retainedManifest) {
      guard();
      const cleaned = await session.removeMissingHistory(app, guard.nativeId);
      guard();
      if (!cleaned?.ok) return cleaned || { ok: false, reason: '清理会话记录失败，请重试' };
    }
    return committed?.ok ? guard.complete('delete', result, committed)
      : deletionFailure(guard, committed, staged);
  }
  async function checkMissing(guard, id) {
    guard.ensureIdle();
    const result = await session.probeMissingHistory(app, id);
    guard.ensureIdle();
    if (!result?.ok) return result || { ok: false, reason: '暂时无法核对会话内容，请稍后重试' };
    if (!result.missing) return { ok: false, reason: '会话状态已变化，请刷新列表后重新删除' };
    return result;
  }
  function removeTitles(ids) {
    for (const id of ids) conversationTitles.remove(app, id);
  }
  ipcMain.handle('pi-session-history-rename', async (_event, rawId, rawTitle) => {
    try {
      if (typeof rawId !== 'string' || !rawId.trim() || rawId.length > 512) throw Error('会话标识无效');
      const guard = await authorize(rawId);
      const title = conversationTitles.normalize(rawTitle);
      const live = session.findBySessionId(rawId);
      const row = live ? live.historyRow() : await session.archivedConversation(app, rawId);
      if (!row) return { ok: false, reason: '找不到这条会话，请刷新列表后重试' };
      guard();
      const saved = conversationTitles.save(app, rawId, title);
      const presence = { ...row, ...saved };
      BrowserWindow.getAllWindows().forEach(win => {
        try {
          if (!win.isDestroyed()) win.webContents.send('pi-session-event', {
            kind: 'renamed', sessionId: rawId, ref: live?.ref || '', presence,
          });
        } catch (_) { /* A closing window must not turn a saved rename into a failure. */ }
      });
      return { ok: true, ...saved };
    } catch (error) {
      return { ok: false, reason: '改名未保存：' + String(error.message || error) };
    }
  });
  ipcMain.handle('pi-session-history-delete', async (event, rawId, rawOptions) => {
    const requestedId = String(rawId || '').trim();
    if (!requestedId) return { ok: false, reason: '没有指定要删除的会话' };
    let staged, target;
    try {
      const local = await localAction('delete', requestedId, rawOptions);
      if (local) return local;
      const canonicalId = await cloudHistory?.resolveDeleteAlias(requestedId);
      const guard = await authorize(canonicalId || requestedId, { allowMissing: !canonicalId });
      target = guard;
      const id = guard.nativeId || canonicalId || requestedId;
      guard.ensureIdle();
      let active = session.findBySessionId(id);
      if (active && typeof active.inFlight === 'function' && active.inFlight()) {
        return { ok: false, reason: '这条会话还在执行，完成或停止后再删除' };
      }
      const missingOnly = guard.missingContent;
      if (rawOptions?.missingOnly === true && !missingOnly)
        return { ok: false, reason: '会话状态已变化，请刷新列表后重新删除' };
      const switched = missingOnly || canonicalId || guard.accountOnly ? null : require('../conversation/runtime-segments').read(app, id);
      const found = missingOnly || switched || canonicalId || guard.accountOnly ? null : await session.historyEntry(app, id, { strict: true });
      if (found?.ok === false && !found.notFound) return found;
      const piEntry = found && found.ok && found.entry && found.entry.path ? found.entry : null;
      /* Search runtime records when the conversation is absent from Pi archives. */
      let runnerRow = missingOnly ? guard.row || { title: '这条会话' } : guard.accountOnly ? guard.row
        : switched || piEntry ? null : await session.findRunnerRow(id, { strict: true });
      const accountOnly = guard.accountOnly || (!switched && !piEntry &&
        (!runnerRow || runnerRow.accountConversation) && guard.account?.found === true);
      if (accountOnly) runnerRow = guard.account?.projection || guard.row || { title: '这条会话' };
      if (!switched && !piEntry && !runnerRow) {
        return (found && found.ok === false && found.reason)
          ? found : { ok: false, reason: '找不到这条会话' };
      }
      /*
       * Return deletion-specific localized text for the renderer's themed confirmation dialog.
       * Keep action classification and translation in the main process.
       */
      const options = missingOnly ? {
        title: '永久删除会话',
        message: '删除“' + String(conversationTitles.decorate(app, { ...runnerRow, id }).title || '这条会话') + '”？',
        detail: guard.account?.found
          ? '未找到这条会话的本地内容。永久删除会清除残留的会话记录，并同步到当前账号；已生成的文件不受影响。'
          : '未找到这条会话的本地内容。永久删除会清除本机列表中的残留记录；已生成的文件不受影响。',
        buttons: ['取消', '永久删除'],
      } : accountOnly ? {
        title: '删除聊天',
        message: '删除“' + String(runnerRow.title || '这条会话') + '”？',
        detail: '该会话将从当前账号的会话列表中删除，其他设备也会同步；需求和成果文件不会删除。',
        buttons: ['取消', '删除会话'],
      } : switched ? {
        title: '删除聊天',
        message: '删除“' + String(switched.title || '这条会话') + '”？',
        detail: '这条会话在各 Agent 中的会话记录将一并删除，无法从回收站恢复；需求和工作目录里的成果文件不会删除。',
        buttons: ['取消', '删除会话'],
      } : piEntry ? {
        title: '删除聊天',
        message: '删除“' + String(piEntry.title || '这条会话') + '”？',
        detail: '会话存档会移到系统回收站；需求和工作目录里的成果文件不会删除。',
        buttons: ['取消', '移到回收站'],
      } : {
        title: '删除聊天',
        message: '删除“' + String(runnerRow.title || '这条会话') + '”？',
        detail: '这条会话会从执行底座的运行记录里移除；需求、底座自己的原生存档和工作目录里的成果文件不会删除。',
        buttons: ['取消', '删除记录'],
      };
      if (!(rawOptions && rawOptions.confirmed === true)) {
        const copy = require('../native-locale.cjs').dialogOptions(options);
        return { ok: false, needsConfirm: true, id, missingContent: missingOnly, confirm: {
          title: copy.title, message: copy.message, detail: copy.detail,
          cancel: copy.buttons[0], confirm: copy.buttons[1],
        } };
      }
      guard();
      active = session.findBySessionId(id);
      if (active && typeof active.inFlight === 'function' && active.inFlight()) {
        return { ok: false, reason: '会话刚刚又开始执行了，请完成或停止后再删除' };
      }
      if (missingOnly) {
        const checked = await checkMissing(guard, id);
        if (!checked.ok) return checked;
        if (guard.cacheOnly) {
          if (active?.close) await active.close();
          return guard.complete('delete', { alreadyDeleted: true, missingContent: true, displayOnly: true });
        }
      }
      const synced = await guard.commit(accountOnly || missingOnly ? 'delete' : 'archive');
      if (!synced?.ok) return synced;
      if (!accountOnly && !missingOnly) staged = synced;
      if (accountOnly) {
        if (active?.close) await active.close();
        return guard.complete('delete', { missingContent: missingOnly }, synced);
      }
      if (active && typeof active.close === 'function') await active.close();
      guard();
      if (missingOnly) {
        const deleted = await session.removeMissingHistory(app, id);
        guard();
        if (!deleted?.ok) return deleted;
        removeTitles(guard.aliasIds);
        return guard.complete('delete', { ...deleted, missingContent: true }, synced);
      }
      if (switched) {
        // Reuse the archive boundary and multi-segment deletion transaction;
        // deleting only the original archive makes the remaining segments
        // resurrect the conversation at the next history refresh.
        if (!session.isArchived(app, id)) {
          const archived = await session.archiveHistory(app, id);
          if (!archived?.ok) return deletionFailure(guard, archived || { ok: false, reason: '会话归档未完成，尚未删除' }, synced);
        }
        const deleted = await session.permanentlyDeleteHistory(app, id, { retainManifest: true });
        if (!deleted?.ok) return deletionFailure(guard, { ...(deleted || {}), ok: false,
          reason: String(deleted?.reason || '删除未完成') + '，请在归档会话中重试' }, synced);
        try { conversationTitles.remove(app, id); } catch (_) { /* title metadata is best effort */ }
        return await finishDeletion(guard, deleted, synced);
      }
      guard();
      if (canonicalId) {
        const deleted = await cloudHistory.forget(canonicalId);
        return await finishDeletion(guard, deleted, synced);
      }
      if (piEntry) await trash(shell, piEntry.path);
      else {
        const forgot = await session.forgetRunner(app, id);
        if (!forgot.ok && !forgot.notFound) return deletionFailure(guard, forgot, synced);
      }
      return await finishDeletion(guard, { ok: true }, synced);
    } catch (error) {
      const failed = { ok: false, reason: '删除没有完成：' + String(error && error.message || error) };
      try { return target ? deletionFailure(target, failed, staged) : failed; }
      catch (_) { return failed; }
    }
  });
  ipcMain.handle('pi-session-history-archive', async (_event, rawId) => {
    const id = String(rawId || '').trim();
    if (!id) return { ok: false, reason: '没有指定要归档的会话' };
    try {
      const local = await localAction('archive', id);
      if (local) return local;
      const guard = await authorize(id);
      guard.ensureIdle();
      const nativeId = guard.nativeId || id;
      const active = session.findBySessionId(nativeId);
      if (active && typeof active.inFlight === 'function' && active.inFlight()) {
        return { ok: false, reason: '这条会话还在执行，完成或停止后再归档' };
      }
      guard();
      const synced = await guard.commit('archive');
      if (!synced?.ok) return synced;
      const result = guard.accountOnly ? { ok: true } : await session.archiveHistory(app, nativeId);
      if (result && result.ok && active && typeof active.close === 'function') await active.close();
      return result?.ok ? guard.complete('archive', result, synced) : result;
    } catch (error) {
      return { ok: false, reason: '归档没有完成：' + String(error && error.message || error) };
    }
  });
  ipcMain.handle('pi-session-history-restore', async (_event, rawId) => {
    const id = String(rawId || '').trim();
    if (!id) return { ok: false, reason: '没有指定要恢复的会话' };
    try {
      const local = await localAction('restore', id);
      if (local) return local;
      const guard = await authorize(id);
      const synced = await guard.commit('restore');
      if (!synced?.ok) return synced;
      const nativeId = guard.nativeId || id;
      // A remote restore may already be authoritative while its native flag
      // was cleared on a previous attempt. Repeating it is harmless.
      const result = guard.accountOnly || (synced.found && !session.isArchived?.(app, nativeId))
        ? { ok: true } : await session.restoreHistory(app, nativeId);
      return result?.ok ? guard.complete('restore', result, synced) : result;
    }
    catch (error) { return { ok: false, reason: '恢复没有完成：' + String(error && error.message || error) }; }
  });
  ipcMain.handle('pi-session-history-archived', async () => {
    try {
      const captured = historyAccess.actor(app);
      const result = await session.archivedHistory(app);
      historyAccess.assertCurrent(app, captured);
      const identity = require('../conversation/requirement-context').cachedIdentity(app);
      const rows = require('../conversation/work-conversation-cards').visibleHistory(app, result.chats || [], identity);
      return { ...result, chats: rows.map(row => conversationTitles.decorate(app,
        require('../conversation/requirement-context').decorate(app, row, identity))) };
    } catch (error) {
      return { ok: false, reason: '读取归档历史失败：' + String(error && error.message || error), chats: [] };
    }
  });
  ipcMain.handle('pi-session-history-permanent-delete', async (_event, rawId) => {
    const id = String(rawId || '').trim();
    if (!id) return { ok: false, reason: '没有指定要彻底删除的会话' };
    let staged, target;
    try {
      const local = await localAction('delete', id, { confirmed: true });
      if (local) return local;
      const guard = await authorize(id, { allowMissing: true });
      target = guard;
      guard.ensureIdle();
      const nativeId = guard.nativeId || id;
      if (!guard.missingContent && typeof session.isArchived === 'function' && !session.isArchived(app, nativeId) &&
          !guard.account?.conversation?.archived && !guard.account?.conversation?.deleted) {
        return { ok: false, reason: '只能从归档历史彻底删除会话' };
      }
      const active = session.findBySessionId(nativeId);
      if (active && typeof active.inFlight === 'function' && active.inFlight()) {
        return { ok: false, reason: '这条会话还在执行，完成或停止后再删除' };
      }
      if (guard.missingContent) {
        const checked = await checkMissing(guard, nativeId);
        if (!checked.ok) return checked;
        if (guard.cacheOnly) {
          if (active?.close) await active.close();
          return guard.complete('delete', { alreadyDeleted: true, missingContent: true, displayOnly: true });
        }
      }
      const synced = await guard.commit(guard.accountOnly || guard.missingContent ? 'delete' : 'archive');
      if (!synced?.ok) return synced;
      if (!guard.accountOnly && !guard.missingContent) staged = synced;
      if (active && typeof active.close === 'function') await active.close();
      guard();
      if (!guard.missingContent && !guard.accountOnly && guard.account?.conversation?.archived && !session.isArchived?.(app, nativeId)) {
        const archived = await session.archiveHistory(app, nativeId);
        if (!archived?.ok) return deletionFailure(guard, archived, synced);
      }
      const result = guard.accountOnly ? { ok: true } : guard.missingContent
        ? await session.removeMissingHistory(app, nativeId) : await session.permanentlyDeleteHistory(app, nativeId, { retainManifest: true });
      if (result && result.ok) {
        removeTitles(guard.aliasIds);
      }
      if (guard.missingContent) return result?.ok
        ? guard.complete('delete', { ...result, missingContent: true }, synced) : result;
      return await finishDeletion(guard, result, synced, guard.accountOnly);
    } catch (error) {
      const failed = { ok: false, reason: '彻底删除没有完成：' + String(error && error.message || error) };
      try { return target ? deletionFailure(target, failed, staged) : failed; }
      catch (_) { return failed; }
    }
  });
  return { localAction };
}

module.exports = { install, trashWithRecovery, currentWindowsSid, ensureRecycleBinFor };
