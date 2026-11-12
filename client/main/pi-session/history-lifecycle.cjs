'use strict';

// Resolve lifecycle targets in the main process. Renderer IDs are lookup keys,
// never ownership evidence or filesystem paths.
const access = require('../conversation/history-access');

function create({ app, session, accountHistory, BrowserWindow }) {
  async function nativeRow(id) {
    return session.archivedConversation?.(app, id, { nativeOnly: true, strict: true }) || null;
  }
  async function authorize(id, { allowMissing = false } = {}) {
    if (typeof id !== 'string' || !id.trim() || id.length > 512) throw Error('会话标识无效');
    const captured = access.actor(app);
    const connection = value => JSON.stringify([String(value?.identity?.hub || '').replace(/\/+$/, ''),
      value?.identity?.clientId || '']);
    const capturedConnection = connection(captured);
    const guard = () => {
      access.assertCurrent(app, captured);
      if (connection(access.actor(app)) !== capturedConnection) throw Error('账号或服务已切换，请重新打开会话');
    };
    let owned = false, originalError;
    try { access.assertOwner(app, id, captured); owned = true; }
    catch (error) { originalError = error; }
    const account = accountHistory ? await accountHistory.resolveLifecycle(id) : null;
    guard();
    if (account?.ok === false) throw Error(account.reason || '无法核对账号会话状态，请稍后重试');
    const projection = account?.projection;
    let row = null, nativeId = '';
    if (projection?.id === id && projection.accountProjection) {
      access.assertOwner(app, id, captured, projection);
      owned = true; row = projection;
      // A foreign device's native ID is never a local deletion target.
      for (const candidate of (account.nativeIds || []).slice(0, 1)) {
        const local = await nativeRow(candidate);
        guard();
        if (!local) continue;
        access.assertOwner(app, candidate, captured, local);
        nativeId = candidate;
      }
    } else {
      row = await nativeRow(id);
      guard();
      if (row) {
        access.assertOwner(app, id, captured, row, { allowLegacy: true });
        owned = true;
      }
      nativeId = id;
    }
    let accountOnly = Boolean(projection?.id === id && !nativeId);
    let missing = null, cacheOnly = false;
    if (allowMissing && !accountOnly && (owned || (!row && originalError?.code === 'HISTORY_OWNER_MISSING'))) {
      missing = await session.probeMissingHistory?.(app, nativeId || id);
      guard();
      if (missing?.ok === false) throw Error(missing.reason || '暂时无法核对会话内容，请稍后重试');
      if (!owned && missing?.missing === true) {
        if (account?.found && projection?.accountProjection && account.aliasIds?.includes(id)) {
          // A verified source alias may outlive its native files and ownership
          // sidecars. It authorizes only this account's directory mutation.
          access.assertOwner(app, projection.id, captured, projection);
          row = projection; nativeId = ''; accountOnly = true; owned = true;
        } else if (!account?.found) {
          // No native content or account record exists. Permit removal of the
          // current account's UI cache only, never global files or metadata.
          cacheOnly = true; owned = true;
        }
      }
    }
    if (!owned) throw originalError || Error('无法确认这条会话属于当前账号，请切回原账号');
    const aliasIds = cacheOnly ? [id] : [...new Set([id, nativeId,
      ...(account?.aliasIds || []), ...(missing?.aliasIds || [])].filter(Boolean))];
    const ensureIdle = () => {
      guard();
      for (const alias of aliasIds) {
        if (session.findBySessionId?.(alias)?.inFlight?.()) throw Error('这条会话还在执行，完成或停止后再操作');
      }
    };
    return Object.assign(guard, { row, nativeId, account, aliasIds, ensureIdle, accountOnly, cacheOnly,
      missingContent: missing?.missing === true,
      async commit(action) {
        ensureIdle();
        const result = accountHistory && !cacheOnly ? await accountHistory.setLifecycle(id, action)
          : { ok: true, localOnly: true };
        guard();
        if (!result?.ok) return result || { ok: false, reason: '账号会话状态未保存，请重试' };
        ensureIdle();
        return result;
      },
      complete(action, result = {}, synced = {}) {
        guard();
        const aliases = [...new Set([...aliasIds, ...(synced.aliasIds || [])])];
        const presence = { ...(row || {}), id,
          archived: action === 'archive', deleted: action === 'delete',
          historyAliasIds: aliases.filter(alias => alias !== id),
          ...(synced.lifecycleRevision ? { lifecycleRevision: synced.lifecycleRevision } : {}),
          ...(synced.revision || synced.conversation?.revision
            ? { revision: synced.revision || synced.conversation.revision } : {}),
        };
        for (const win of BrowserWindow?.getAllWindows?.() || []) {
          try { if (!win.isDestroyed()) win.webContents.send('pi-session-event', {
            kind: 'history-lifecycle', sessionId: id, ref: '', presence,
          }); } catch (_) { /* A closing renderer does not undo a durable operation. */ }
        }
        return { ...result, ok: true, id, aliasIds: aliases, archived: presence.archived,
          deleted: presence.deleted, lifecycleRevision: presence.lifecycleRevision,
          revision: presence.revision };
      },
    });
  }
  return { authorize };
}

module.exports = { create };
