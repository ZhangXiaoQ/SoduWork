/* Durable message and receipt reconciliation over the existing notice store.
   The metadata contains only dismissal markers, never a second message list. */
(function (global) {
  'use strict';
  let epoch = 0, requests = new Map(), revisions = new Map(), lastAttempt = 0;
  const markerIndexes = new WeakMap();
  const statusOrder = { accepted: 0, delivered: 1, read: 2 };
  const legacyReceiptKey = /^(mate_receipt_.+)_(accepted|delivered|read)$/;
  const api = () => global.SoduWorkAPI || {};
  const scope = () => api().taskStorageKey?.('notices') || 'soduwork_work_notices_v1';
  const persistence = global.SoduWorkNoticePersistence?.create();
  let durable = null, working = null;
  const capture = () => ({ key: scope(), epoch });
  const current = token => token.key === scope() && token.epoch === epoch;
  const folderOf = row => row.folder === 'sent' ? 'sent' : 'received';
  const stamp = value => Number(value) || (Date.parse(value) || 0);
  const metadataKey = () => scope() + ':sync';
  const ready = key => Boolean(persistence && durable?.scope === key);
  const cacheStamp = () => ready(scope()) ? durable.version + ':' + (localStorage.getItem(scope()) || '') : localStorage.getItem(scope());
  function readRows() { return working ? working.rows : _readNotices(); }
  function saveMetadata(meta) {
    if (working) working.meta = meta;
    else localStorage.setItem(metadataKey(), JSON.stringify(meta));
  }
  function legacy(key) {
    const raw = localStorage.getItem(key), metaRaw = localStorage.getItem(key + ':sync');
    const rows = JSON.parse(raw || '[]'), meta = JSON.parse(metaRaw || '{}') || {};
    if (!Array.isArray(rows)) throw Error('Invalid legacy notice cache');
    if (typeof meta !== 'object' || Array.isArray(meta) || rows.some(row => !row || typeof row !== 'object' || (row.serverMessageId && !row.id)))
      throw Error('Invalid legacy notice records');
    return { rows, meta, retire() {
      if (rows.some(row => row?.serverMessageId) && localStorage.getItem(key) === raw)
        localStorage.setItem(key, JSON.stringify(rows.filter(row => !row?.serverMessageId)));
      if (metaRaw !== null && localStorage.getItem(key + ':sync') === metaRaw) localStorage.removeItem(key + ':sync');
    } };
  }
  function cachedRows(key, local) {
    if (!ready(key)) return local;
    const remote = new Map(durable.rows.map(row => [row.id, row]));
    for (const row of local) if (!remote.has(row.id)) remote.set(row.id, row);
    return [...remote.values()].filter(row => !dismissed(row, durable.meta));
  }
  function modify(token, change) {
    if (!persistence) return change();
    let beforeLocal = [], afterLocal = [];
    return persistence.update(token.key, () => legacy(token.key), state => {
      if (!current(token)) return { stale: true };
      const local = legacy(token.key).rows.filter(row => !row?.serverMessageId);
      working = { rows: [...state.rows, ...local], meta: state.meta };
      beforeLocal = local;
      try {
        const result = change();
        state.rows = working.rows;
        state.meta = working.meta;
        afterLocal = working.rows.filter(row => !row.serverMessageId);
        return result;
      } finally { working = null; }
    }).then(value => {
      if (value.stale) return false;
      // Merge only this operation's local edits after the durable transaction.
      // A new synchronous reminder in another window must survive the await.
      const after = new Map(afterLocal.map(row => [row.id, row]));
      const edits = new Map(beforeLocal.filter(row => JSON.stringify(row) !== JSON.stringify(after.get(row.id)))
        .map(row => [row.id, { before: row, after: after.get(row.id) }]));
      let localWritten = false;
      if (edits.size) {
        const local = legacy(token.key).rows.flatMap(row => {
          const edit = edits.get(row.id);
          if (row.serverMessageId || !edit || JSON.stringify(row) !== JSON.stringify(edit.before)) return [row];
          localWritten = true; return edit.after ? [edit.after] : [];
        });
        if (localWritten) localStorage.setItem(token.key, JSON.stringify(local));
      }
      if (!current(token)) return false;
      const changed = durable?.version !== value.version || durable?.scope !== token.key;
      durable = value;
      const next = cachedRows(token.key, legacy(token.key).rows);
      const localChanged = JSON.stringify(notices.filter(row => !row.serverMessageId)) !==
        JSON.stringify(next.filter(row => !row.serverMessageId));
      notices.length = 0;
      for (const row of next) notices.push(row);
      if (changed || value.changed || localChanged) repaint();
      if ((value.changed || localWritten) && global.WinSync) global.WinSync.pushNotices();
      return value.result;
    }).catch(() => { throw new Error('通知无法保存到本机，请检查存储空间后重试。'); });
  }
  function restore() {
    if (!persistence || typeof notices === 'undefined') return Promise.resolve(true);
    return modify(capture(), () => { metadata(); return true; });
  }
  function metadata() {
    try { return migrateMetadata(working?.meta || (ready(scope()) ? durable.meta : JSON.parse(localStorage.getItem(metadataKey()) || '{}')) || {}); }
    catch (_) { return {}; }
  }
  function migrateMetadata(meta) {
    // Migrate legacy cleared, read, and notified phase markers together to prevent repeated notifications after upgrades.
    let changed = false;
    for (const field of ['ids', 'readIds', 'presentedIds']) {
      if (!Array.isArray(meta[field])) continue;
      meta[field] = [...new Set(meta[field].map(key => {
        const migrated = String(key).replace(legacyReceiptKey, '$1@$2');
        if (migrated !== key) changed = true;
        return migrated;
      }))];
    }
    if (changed) try { saveMetadata(meta); } catch (_) { /* Retry migration on the next read. */ }
    return meta;
  }
  function dismissed(row, meta) {
    // Only dismiss IDs the user actually cleared. Client and server clocks
    // can differ, so legacy clearedAt values must never hide new messages.
    return folderOf(row) !== 'sent' && Boolean(hasMarker(meta.ids, row.id) ||
      (row.kind === 'mate_receipt' && hasReceiptMarker(row, meta.ids)));
  }
  function hasMarker(markers, id) {
    if (!Array.isArray(markers)) return false;
    if (!markerIndexes.has(markers)) markerIndexes.set(markers, new Set(markers));
    return markerIndexes.get(markers).has(id);
  }
  const receiptMarker = row => 'mate_receipt_' + row.serverMessageId + '@' + row.receiptStatus;
  const receiptMarkers = row => Object.keys(statusOrder).filter(state => statusOrder[state] <= statusOrder[row.receiptStatus])
    .map(receiptStatus => receiptMarker({ ...row, receiptStatus }));
  function hasReceiptMarker(row, markers) {
    // Support legacy highest-phase markers: consuming a terminal phase includes earlier phases without suppressing later transitions.
    return Boolean(hasMarker(markers, 'mate_receipt_' + row.serverMessageId) || Object.keys(statusOrder)
      .some(state => statusOrder[state] >= statusOrder[row.receiptStatus] &&
        hasMarker(markers, receiptMarker({ ...row, receiptStatus: state }))));
  }
  function belongsToAccount(row, folder) {
    const auth = api().clientAuthSnapshot?.() || {}, userId = String(auth.user?.id || '');
    const ownerId = row.kind === 'mate_receipt' ? row.ownerId
      : folder === 'sent' ? row.senderId : row.recipientId;
    // An explicit login requirement is different from legacy/bootstrap APIs
    // whose authenticated inbox can succeed before the user snapshot arrives.
    if (ownerId && !userId && auth.state === 'pending') return false;
    return !userId || !ownerId || String(ownerId) === userId;
  }
  function visibleRow(row) {
    if (!belongsToAccount(row, folderOf(row))) return false;
    // Only a current Hub projection can disprove a legacy handoff notice.
    // Missing tasks or direct messages/approvals are not evidence of lost access.
    if (!/^handoff\./.test(row.kind || '') || !row.taskId) return true;
    const task = typeof Store === 'undefined' ? null : Store._shadow?.[row.taskId];
    return !Array.isArray(task?.myRoles) ||
      task.myRoles.some(role => role === 'creator' || role === 'requester');
  }
  function rows(folder) {
    const meta = metadata();
    return (typeof notices === 'undefined' ? [] : notices)
      .filter(row => folderOf(row) === (folder === 'sent' ? 'sent' : 'received') && visibleRow(row) && !dismissed(row, meta))
      .slice().sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
  }
  function repaint() {
    if(typeof global.dispatchEvent==='function'&&typeof global.CustomEvent==='function')global.dispatchEvent(new global.CustomEvent('soduwork-host-data-changed',{detail:{topic:'notifications'}}));
    if (typeof updateNoticeBadge === 'function') updateNoticeBadge();
    const panel = global.document?.getElementById('noticePanel');
    if (panel?.classList?.contains('show') && typeof _renderNoticePanel === 'function') _renderNoticePanel();
  }
  function refreshQuotaNotice() {
    try {
      const pending = global.SoduWorkQuotaNotice?.refreshIfBlocked?.();
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch (_) {}
  }
  function commit(next, token) {
    if (!current(token)) return false;
    if (working) { working.rows = next; return true; }
    const encoded = JSON.stringify(next);
    const memoryChanged = JSON.stringify(notices) !== encoded;
    // Another window may already have persisted these rows. Do not broadcast
    // or rewrite the entire history on each unchanged poll.
    if (localStorage.getItem(token.key) === encoded) {
      if (memoryChanged) { notices.splice(0, notices.length, ...next); repaint(); }
      return true;
    }
    const previous = notices.slice();
    notices.splice(0, notices.length, ...next);
    if (_saveNotices() === false) {
      notices.splice(0, notices.length, ...previous);
      throw new Error('通知无法保存到本机，请检查存储空间后重试。');
    }
    repaint(); return true;
  }
  function match(row, serverId, messageId, folder, item) {
    if (row.kind === 'mate_receipt' || folderOf(row) !== folder) return false;
    if (serverId && row.serverMessageId) return String(row.serverMessageId) === serverId;
    // Client keys are scoped to a sender/recipient pair on the server. Only
    // use one to adopt a legacy local row whose sender identity also matches.
    return Boolean(messageId && String(row.messageId || '') === messageId && item?.senderId &&
      row.senderId && String(row.senderId) === String(item.senderId) &&
      (!row.recipientId || !item.recipientId || String(row.recipientId) === String(item.recipientId)));
  }
  function normalized(item, folder, previous) {
    const old = previous || {}, incoming = item.status in statusOrder ? item.status : 'accepted';
    const status = (statusOrder[old.status] ?? -1) > statusOrder[incoming] ? old.status : incoming;
    const serverId = String(item.id || item.serverMessageId || '');
    const clientId = String(item.messageId || item.clientMessageId || serverId);
    return { ...old, id: old.id || (folder === 'sent' ? 'mate_sent_' : 'mate_') + serverId,
      folder, serverMessageId: serverId, messageId: clientId,
      senderId: String(item.senderId || old.senderId || ''), recipientId: String(item.recipientId || old.recipientId || ''),
      senderName: String(item.senderName || old.senderName || ''), recipientName: String(item.recipientName || old.recipientName || ''),
      taskId: item.taskId || old.taskId || null, kind: item.kind || old.kind || 'mate_message',
      at: stamp(item.createdAt) || Number(old.at) || Date.now(),
      text: String(item.text ?? old.text ?? ''), bodyText: String(item.text ?? old.bodyText ?? old.text ?? ''),
      textMessage: item.textMessage || old.textMessage || null,
      attachments: Array.isArray(item.attachments) ? item.attachments : old.attachments || [],
      website: item.website || old.website || null, status, sentStatus: status,
      deliveredAt: Math.max(stamp(item.deliveredAt), stamp(old.deliveredAt)) || null,
      readAt: Math.max(stamp(item.readAt), stamp(old.readAt)) || null,
      read: folder === 'sent' || Boolean(old.read) || status === 'read' };
  }
  function receiptFor(row, old, meta) {
    // Maintain one receipt per message and merge legacy per-phase records.
    const state = old.reduce((value, item) => statusOrder[item.receiptStatus] > statusOrder[value] ? item.receiptStatus : value,
      row.status in statusOrder ? row.status : 'accepted');
    const id = 'mate_receipt_' + row.serverMessageId;
    const prior = old.find(item => item.receiptStatus === state);
    const at = (state === 'read' ? row.readAt : state === 'delivered' ? row.deliveredAt : row.at) || prior?.at || row.at;
    const who = row.recipientName || '对方';
    const original = String(row.text || '').replace(/\s+/g, ' ').trim();
    const assigned = row.kind === 'task_assignment' && original.match(/^.+?将需求「([\s\S]+)」交给你$/);
    const summary = assigned ? assigned[1] : original;
    const subject = summary ? '\n' + (assigned ? '需求：' : '') + summary.slice(0, 90) + (summary.length > 90 ? '…' : '') : '';
    const text = (state === 'accepted' ? '已发送给' + who + '，等待对方接收。'
      : state === 'delivered' ? who + '已收到你发送的消息。' : who + '已读你发送的消息。') + subject;
    const receipt = { id, folder: 'received', kind: 'mate_receipt', receiptStatus: state, ownerId: row.senderId,
      serverMessageId: row.serverMessageId, messageId: row.messageId, taskId: row.taskId,
      senderName: who, recipientName: row.recipientName, at, text, bodyText: text,
      textMessage: { key: 'notification.receipt.' + state, fallback: text,
        params: { recipient: who, subject: summary ? '\n' + summary.slice(0, 90) + (summary.length > 90 ? '…' : '') : '' } },
      read: Boolean(old.some(item => item.receiptStatus === state && item.read) ||
        hasReceiptMarker({ serverMessageId: row.serverMessageId, receiptStatus: state }, meta.readIds)), attachments: [] };
    return dismissed(receipt, meta) ? null : receipt;
  }
  function merge(items, folder, token, complete = false) {
    return modify(token, () => mergeRows(items, folder, token, complete));
  }
  function mergeRows(items, folder, token, complete) {
    if (!current(token)) return false;
    const meta = metadata(), list = readRows().filter(row => !dismissed(row, meta));
    const server = new Map(), legacy = new Map(), receiptIndexes = new Map(), changedSent = new Map();
    const legacyKey = row => JSON.stringify([folderOf(row), String(row.messageId || ''), String(row.senderId || '')]);
    list.forEach((row, index) => {
      if (row.kind === 'mate_receipt') {
        const indexes = receiptIndexes.get(row.serverMessageId) || [];
        indexes.push(index); receiptIndexes.set(row.serverMessageId, indexes);
      } else {
        if (row.serverMessageId) server.set(folderOf(row) + ':' + row.serverMessageId, index);
        else {
          const key = legacyKey(row), indexes = legacy.get(key) || [];
          indexes.push(index); legacy.set(key, indexes);
        }
      }
    });
    for (const item of items) {
      if (!item?.id || !belongsToAccount(item, folder)) continue;
      const serverId = String(item.id), clientId = String(item.messageId || item.clientMessageId || '');
      const key = folder + ':' + serverId;
      const index = server.get(key) ?? (legacy.get(legacyKey({ ...item, folder, messageId: clientId })) || [])
        .find(index => match(list[index], serverId, clientId, folder, item)) ?? -1;
      const row = normalized(item, folder, list[index]);
      if (dismissed(row, meta)) continue;
      if (index < 0) { server.set(key, list.length); list.push(row); } else { list[index] = row; server.set(key, index); }
      if (folder === 'sent') changedSent.set(serverId, row);
    }
    if (folder === 'sent' && complete) for (const row of list) {
      if (row.kind !== 'mate_receipt' && folderOf(row) === 'sent' && row.serverMessageId && visibleRow(row)) changedSent.set(String(row.serverMessageId), row);
    }
    for (const row of changedSent.values()) {
      const indexes = receiptIndexes.get(row.serverMessageId) || [];
      const receipt = receiptFor(row, indexes.map(index => list[index]), meta);
      if (indexes.length) { list[indexes[0]] = receipt; for (const index of indexes.slice(1)) list[index] = null; }
      else if (receipt) list.push(receipt);
    }
    // Retain legacy receipt state until all sent pages have arrived.
    return commit(list.filter(row => row && (!(folder === 'sent' && complete) || row.kind !== 'mate_receipt' ||
      (row.serverMessageId && row.id === 'mate_receipt_' + row.serverMessageId && !dismissed(row, meta)))), token);
  }
  function updateReceipt(serverId, receipt, token) {
    return updateReceipts([{ serverId, receipt }], token);
  }
  function updateReceipts(updates, token) {
    return modify(token, () => updateReceiptRows(updates, token));
  }
  function updateReceiptRows(updates, token) {
    if (!current(token)) return false;
    const list = readRows().slice(), indexes = new Map();
    list.forEach((row, index) => { if (row.kind !== 'mate_receipt' && folderOf(row) === 'received') indexes.set(String(row.serverMessageId || ''), index); });
    let changed = false;
    for (const { serverId, receipt } of updates) {
      const index = indexes.get(serverId);
      if (index === undefined) continue;
      list[index] = normalized({ ...list[index], ...receipt, id: serverId,
        messageId: list[index].messageId, createdAt: list[index].at }, 'received', list[index]);
      changed = true;
    }
    if (!changed) return false;
    return commit(list, token);
  }
  async function acknowledge(items, token) {
    if (!api().markMateMessageDelivered) return;
    const storedRows = new Map(rows('received').filter(row => row.kind !== 'mate_receipt')
      .map(row => [String(row.serverMessageId), row]));
    for (let offset = 0; offset < items.length; offset += 8) {
      const group = items.slice(offset, offset + 8);
      const results = await Promise.allSettled(group.map(async item => {
        if (!current(token)) return;
        const stored = storedRows.get(String(item.id));
        if (!stored || stored.status !== 'accepted') return;
        const result = await api().markMateMessageDelivered(item.id);
        if (!current(token)) return;
        if (!result || result.ok === false || !['delivered', 'read'].includes(result.status)) throw new Error('送达回执未获服务确认');
        return { serverId: String(item.id), receipt: result };
      }));
      const updates = results.filter(result => result.status === 'fulfilled' && result.value).map(result => result.value);
      if (updates.length) await updateReceipts(updates, token);
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    }
  }
  function refresh(folder, afterCurrent) {
    if (!folder) return Promise.all([refresh('received', afterCurrent), refresh('sent', afterCurrent)]).then(() => ({ ok: true }));
    const target = folder === 'sent' ? 'sent' : 'received', token = capture();
    const key = token.key + ':' + target;
    if (requests.has(key)) return afterCurrent
      ? requests.get(key).catch(() => {}).then(() => current(token) ? refresh(target) : { ok: false, stale: true })
      : requests.get(key);
    const work = (async () => {
      if (persistence) await restore();
      if (!current(token)) return { ok: false, stale: true };
      if (!api().mateMessages) throw new Error('当前版本暂不支持通知同步');
      const cached = revisions.get(key);
      const conditional = cached?.store === cacheStamp() ? cached.revision : '';
      revisions.delete(key);
      let cursor = '', seen = new Set(), revision = '', consistent = true, finalRevision = '';
      do {
        const result = await api().mateMessages(target, 200, cursor, cursor ? '' : conditional);
        if (!current(token)) return { ok: false, stale: true };
        if (!result || result.ok === false || !Array.isArray(result.items)) throw new Error(result?.reason || '通知暂时无法加载，请重试');
        if (result.notModified) {
          if (persistence) await restore();
          if (!current(token)) return { ok: false, stale: true };
          // A revision is useful only with the exact durable cache that was
          // reconciled. Another window may clear/replace that cache in flight.
          if (!cursor && conditional && result.revision === conditional &&
              cached.store === cacheStamp()) {
            revisions.set(key, cached); refreshQuotaNotice();
            return { ok: true, notModified: true };
          }
          if (!cursor && conditional) return refreshUnconditionally();
          throw new Error('通知同步状态已变化，请重试');
        }
        if (!cursor) revision = String(result.revision || '');
        if (result.revision && result.revision !== revision) consistent = false;
        if (!result.nextCursor) finalRevision = String(result.revision || '');
        if (!await merge(result.items, target, token, !result.nextCursor)) return { ok: false, stale: true };
        if (target === 'received') await acknowledge(result.items, token);
        cursor = String(result.nextCursor || '');
        if (cursor && seen.has(cursor)) throw new Error('通知分页没有继续前进，请重试');
        seen.add(cursor);
      } while (cursor && current(token));
      const result = { ok: current(token) };
      if (result.ok) {
        if (revision && consistent && finalRevision === revision) revisions.set(key,
          { revision, store: cacheStamp() });
        refreshQuotaNotice();
      }
      return result;
      async function refreshUnconditionally() {
        // Avoid recursively joining this request when the cache was replaced
        // by another window while the conditional request was in flight.
        requests.delete(key);
        return refresh(target);
      }
    })();
    requests.set(key, work);
    work.finally(() => { if (requests.get(key) === work) requests.delete(key); }).catch(() => {});
    return work;
  }
  async function markRead(serverId) {
    const token = capture(), id = String(serverId || '');
    if (!rows('received').some(row => row.kind !== 'mate_receipt' && row.serverMessageId === id)) return false;
    const result = await api().markMateMessageRead(id);
    if (!current(token)) return false;
    if (!result || result.ok === false || result.status !== 'read') throw new Error('已读状态未获服务确认，请重试');
    return updateReceipt(id, result, token);
  }
  function confirmedRead(messageId, readAt) {
    const token = capture(), key = String(messageId || '');
    if (!key) return false;
    return modify(token, () => {
      let changed = false;
      const next = readRows().map(row => {
        if (row.kind === 'mate_receipt' || folderOf(row) !== 'received' ||
            !(row.messageId === key || row.serverMessageId === key || row.id === 'mate_' + key.slice(0, 64))) return row;
        changed = true;
        return { ...row, read: true, readAt: readAt || Date.now(), status: 'read' };
      });
      return changed && commit(next, token);
    });
  }
  function clear() {
    const token = capture();
    const selected = rows('received');
    const localIds = new Set(_readNotices().filter(row => !row.serverMessageId && folderOf(row) === 'received').map(row => row.id));
    const cleared = selected.flatMap(row => row.kind === 'mate_receipt' ? receiptMarkers(row)
      : row.serverMessageId ? [row.id, 'mate_' + row.serverMessageId] : [row.id]);
    return modify(token, () => {
      const meta = metadata();
      const ids = [...new Set([...(meta.ids || []), ...cleared])];
      delete meta.clearedAt;
      saveMetadata({ ...meta, ids });
      return commit(readRows().filter(row => folderOf(row) === 'sent' ||
        (row.serverMessageId ? !dismissed(row, { ...meta, ids }) : !localIds.has(row.id))), token);
    });
  }
  function markLocalRead(id) {
    const token = capture();
    const selected = rows('received').find(row => row.id === id);
    return modify(token, () => {
      const meta = metadata(), list = readRows().slice();
      const row = list.find(item => item.id === id);
      if (!row || row.read) return false;
      if (!selected) return false;
      meta.readIds = [...new Set([...(meta.readIds || []), ...(selected.kind === 'mate_receipt' ? receiptMarkers(selected) : [id])])];
      saveMetadata(meta);
      list[list.indexOf(row)] = { ...row, read: row.kind !== 'mate_receipt' || hasReceiptMarker(row, meta.readIds) };
      return commit(list, token);
    });
  }
  function tick(force) {
    if (!api().mateMessages) return;
    if (!force && Date.now() - lastAttempt < 60000) return;
    lastAttempt = Date.now();
    void refresh().catch(() => {});
  }
  function canPresent(event) {
    const userId = String(api().clientAuthSnapshot?.().user?.id || '');
    if (!userId) return false;
    // Private message bodies belong only to the recipient; delivery and read receipts appear only for the two participants.
    if (event?.type === 'notice') return String(event.recipientId || '') === userId;
    return /^mate_message_(accepted|delivered|read)$/.test(event?.type || '') &&
      (String(event.senderId || '') === userId || String(event.recipientId || '') === userId);
  }
  async function present(event) {
    const token = capture();
    // Authorize notifications against persisted records before showing content or sound; a socket event alone is insufficient.
    try { await handle(event); } catch (_) { /* If delivery acknowledgment fails, evaluate the saved original message. */ }
    if (!current(token) || !canPresent(event)) return null;
    const isMessage = event.type === 'notice';
    const userId = String(api().clientAuthSnapshot?.().user?.id || '');
    if (!isMessage && String(event.senderId || '') !== userId) return null;
    const serverId = String(isMessage ? event.serverMessageId || '' : event.messageId || '');
    if (!serverId) return null;
    return modify(token, () => {
      const meta = metadata(), list = readRows();
      const row = list.find(item => item.serverMessageId === serverId && folderOf(item) === 'received' &&
        (isMessage ? item.kind !== 'mate_receipt' : item.kind === 'mate_receipt'));
      if (!row || row.read || dismissed(row, meta)) return null;
      const wantedState = String(event.status || event.type.replace('mate_message_', ''));
      if (!isMessage && (statusOrder[row.receiptStatus] ?? -1) < (statusOrder[wantedState] ?? -1)) return null;
      const marker = isMessage ? 'mate_notice_' + serverId : receiptMarker(row);
      if (isMessage ? meta.presentedIds?.includes(marker) : hasReceiptMarker(row, meta.presentedIds)) return null;
      // Persist notification markers per account to deduplicate concurrent callbacks, reopened windows, and phase replays.
      const markers = isMessage ? [marker] : receiptMarkers(row);
      saveMetadata({ ...meta,
        presentedIds: [...new Set([...(meta.presentedIds || []), ...markers])] });
      // Recheck account identity before presentation because it may change before a Promise callback runs.
      return { text: row.bodyText || row.text || '', taskId: row.taskId || null, isCurrent: () => current(token) };
    });
  }
  async function handle(event) {
    if (event?.type === 'notice') {
      const token = capture();
      const userId = String(api().clientAuthSnapshot?.().user?.id || '');
      if (userId && event.recipientId && String(event.recipientId) !== userId) return;
      await api().invalidateMateMessageCache?.('received');
      if (!current(token)) return;
      // Older events omit the recipient: use the authenticated inbox query
      // to establish ownership before persisting their body or acknowledging.
      if (event.serverMessageId && event.recipientId && userId) {
        const item = { ...event, id: event.serverMessageId, createdAt: event.sentAt || event.createdAt };
        if (await merge([item], 'received', token)) await acknowledge([item], token);
      }
      if (current(token)) return refresh('received', true);
      return;
    }
    if (!/^mate_message_(accepted|delivered|read)$/.test(event?.type || '')) return Promise.resolve();
    const userId = String(api().clientAuthSnapshot?.().user?.id || '');
    const folder = userId && String(event.senderId) === userId ? 'sent'
      : userId && String(event.recipientId) === userId ? 'received' : '';
    const token = capture();
    await api().invalidateMateMessageCache?.(folder);
    if (!current(token)) return;
    if (!folder) return refresh(null, true);
    // Full server events can be reconciled immediately; older servers are
    // handled by the same durable list refresh below.
    if (event.text != null && event.messageId) await merge([{ ...event, id: event.messageId,
      messageId: event.clientMessageId }], folder, capture());
    return refresh(folder, true);
  }
  global.MateNoticeSync = { rows, refresh, markRead, markLocalRead, clear, tick, handle, canPresent, present,
    restore, cachedRows, ready, confirmedRead, persistent: Boolean(persistence), dismissedId: id => hasMarker(metadata().ids, id) };
  global.addEventListener?.('soduwork-work-task-change', repaint);
  global.addEventListener?.('soduwork-task-source', repaint);
  global.addEventListener?.('soduwork-device-auth', repaint);
  global.addEventListener?.('soduwork-client-auth-required', repaint);
  global.addEventListener?.('soduwork-domain-changed', event => {
    const domain = event?.detail?.domain;
    if (domain === 'team-messages-received' || domain === 'team-messages-sent') {
      void refresh(domain === 'team-messages-sent' ? 'sent' : 'received', true).catch(() => {});
    }
  });
  global.addEventListener?.('soduwork-data-scope-changed', () => {
    epoch++; requests = new Map(); revisions = new Map(); lastAttempt = 0; durable = null;
    persistence?.reset(); void restore().catch(() => {});
  });
  if (persistence) void restore().catch(() => {});
})(window);
