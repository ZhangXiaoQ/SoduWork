/* Pure history reconciliation, shared by the sidebar and its contract tests. */
(function (global) {
  'use strict';
  const MAX_CHAT_ITEMS = 50;
  const HISTORY_GAP_GRACE_MS = 30000;
  const DRAFT_GRACE_MS = 120000;
  const CHAT_STATE = {
    starting: '正在启动', running: '正在执行', waiting: '等待你确认', completed: '已完成',
    failed: '执行失败', stopped: '已停止',
  };
  const CHAT_STATE_ALIAS = {
    queued: 'starting', streaming: 'running', working: 'running', compacting: 'running',
    'waiting-user': 'waiting', paused: 'waiting', idle: 'completed', done: 'completed',
    archived: 'completed', released: 'completed',
    error: 'failed', unreachable: 'failed', incomplete: 'failed', 'no-output': 'failed',
    cancelled: 'stopped', aborted: 'stopped',
  };
  function chatState(item) {
    if (item && item.pending) return 'starting';
    /* Runner and cloud adapters historically used `status` while the Pi
       history bridge uses `state`. Prefer the canonical state but accept the
       legacy field so an active cloud session cannot look completed in the
       sidebar (and become deletable while it is still running). */
    const raw = String(item && (item.state || item.status) || '');
    const normalized = CHAT_STATE_ALIAS[raw] || raw;
    return CHAT_STATE[normalized] ? normalized : 'completed';
  }

  function _chatAt(item) {
    const value = item && (item.at || item.updatedAt || item.createdAt);
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : Date.parse(value) || 0;
  }
  function _replicaOriginIds(item) {
    if (!item?.cached && !item?.localReplica) return [];
    return [...new Set([item.source?.id, item.source?.conversationId, item.sourceSessionId]
      .filter(Boolean).map(String))];
  }
  function _syncedCopy(row, canonical) {
    // Opening a linked task can publish a partial row before runtime presence.
    // Use aliases resolved by the authenticated history source even when that
    // partial row does not yet carry its cloud/projection flags.
    if (row?.id && row.id !== canonical?.id && !row.archived && !canonical?.archived &&
        !canonical?.accountConversation && canonical?.historyAliasIds?.includes(row.id)) return true;
    // Directory presence may arrive before or after the replayable local
    // receipt. Collapse only exact Hub task aliases, never matching titles.
    if (row?.cloud === true && row.remoteProjection === true && !row.archived &&
        canonical?.cloud === true && canonical.remoteProjection !== true &&
        !canonical.archived && canonical.taskId && row.taskId === canonical.taskId) return true;
    // A local replay copy can arrive before the authenticated account
    // projection. Join only by its persisted origin ID; a matching title is
    // never sufficient because users may intentionally create namesake chats.
    const rowReplicaOrigins = _replicaOriginIds(row), canonicalReplicaOrigins = _replicaOriginIds(canonical);
    if (row?.accountConversation && (canonical?.cached || canonical?.localReplica) &&
        (canonicalReplicaOrigins.includes(String(row.id)) ||
         row.sourceSessionId && canonicalReplicaOrigins.includes(String(row.sourceSessionId)))) return true;
    if (canonical?.accountConversation && (row?.cached || row?.localReplica) &&
        (rowReplicaOrigins.includes(String(canonical.id)) ||
         canonical.sourceSessionId && rowReplicaOrigins.includes(String(canonical.sourceSessionId)))) return true;
    // Hub may contain one projection per historical device for the same
    // authenticated source session. Keep that logical conversation singular
    // while preserving distinct sessions that merely share a title.
    if (row?.id && row.id !== canonical?.id && row?.accountConversation && canonical?.accountConversation &&
        !row.archived && !canonical.archived && row.sourceSessionId &&
        String(row.sourceSessionId) === String(canonical.sourceSessionId) &&
        row.accountCanSend === true && canonical.accountCanSend === true) {
      const rowAt = _chatAt(row), canonicalAt = _chatAt(canonical);
      return rowAt < canonicalAt || rowAt === canonicalAt && String(row.id) > String(canonical.id);
    }
    if (rowReplicaOrigins.length && !row?.accountConversation && canonical?.id &&
        rowReplicaOrigins.includes(String(canonical.id))) return true;
    if (canonicalReplicaOrigins.length && !canonical?.accountConversation && row?.id &&
        canonicalReplicaOrigins.includes(String(row.id))) return true;
    if (!row?.accountConversation || row.archived || !row.sourceSessionId) return false;
    if (!canonical?.id || canonical.accountConversation || canonical.archived || canonical.pending) return false;
    // An explicitly foreign source must remain independently reachable even
    // when its local session ID happens to match a native session here.
    if (!canonical.cloud && row.accountCanSend === false) return false;
    // Exact source identity joins a sync projection to its native or cloud session.
    // Titles and task IDs alone cannot identify a conversation.
    return row.sourceSessionId === canonical.id || (canonical.cloud === true && canonical.taskId &&
      row.sourceSessionId === 'cloud-task:' + canonical.taskId);
  }
  function _withoutSyncedCopies(rows, available = rows) {
    return rows.filter(row => !available.some(canonical => _syncedCopy(row, canonical)));
  }
  function _chatUiKey(item, previous) {
    const kept = String(previous && previous._uiKey || item && item._uiKey || '');
    if (kept) return kept;
    const local = String(item && item.localId || '');
    if (local) return 'draft:' + local;
    const id = String(item && item.id || '');
    return id ? 'chat:' + id : '';
  }
  function _withChatUiKey(item, previous) {
    const row = { ...(item || {}) };
    const key = _chatUiKey(row, previous);
    if (key) row._uiKey = key;
    return row;
  }
  function _sameDraft(draft, real) {
    if (!draft || !real) return false;
    const direct = String(draft.id || '') && String(draft.id) === String(real.id || '');
    if (direct) return true;
    if (!draft.pending || String(draft.title || '') !== String(real.title || '')) return false;
    return Math.abs(_chatAt(real) - _chatAt(draft)) <= DRAFT_GRACE_MS;
  }
  function _settleDraft(draft, real) {
    const merged = _withChatUiKey({ ...draft, ...real, id: real.id, pending: false }, draft);
    delete merged.localId;
    return merged;
  }
  function _emptyPlaceholderIds(items) {
    return new Set((items || []).filter(row => row?.emptyPlaceholder === true)
      .flatMap(row => [row.id, row.sourceSessionId, ...(row.historyAliasIds || [])]).filter(Boolean).map(String));
  }
  function _canonicalHistoryRows(rows, canonicalId) {
    const indexed = new Map();
    for (const row of rows || []) {
      const id = String(canonicalId(row?.id) || row?.id || '');
      if (!id) continue;
      const previous = indexed.get(id);
      // Only the main-process catalog may supply this resolver. Preserve the
      // existing DOM identity when a retired runtime ID joins its public row.
      if (!previous || row.id === id) indexed.set(id, _withChatUiKey({ ...row, id }, previous));
    }
    return [...indexed.values()];
  }
  function _reconcileChats(current, items, now, { limit = MAX_CHAT_ITEMS, canonicalId } = {}) {
    const maximum = Number.isSafeInteger(limit) && limit > 0 ? limit : MAX_CHAT_ITEMS;
    // Empty metadata is not a deletion. Suppress only exact source identities;
    // drafts remain intact and the first submitted turn can appear normally.
    const emptyIds = _emptyPlaceholderIds(items);
    current = (current || []).filter(row => !emptyIds.has(String(row.id)));
    items = (items || []).filter(row => !row.emptyPlaceholder);
    const clock = Number(now || Date.now());
    const canonical = typeof canonicalId === 'function';
    if (canonical) {
      current = _canonicalHistoryRows(current, canonicalId);
      items = _canonicalHistoryRows(items, canonicalId);
    }
    const available = canonical ? [] : [...(current || []), ...(items || [])];
    const retained = new Set((current || []).filter(row =>
      !available.some(canonical => _syncedCopy(row, canonical))).map(row => row.id));
    current = (current || []).flatMap(row => {
      const canonical = available.find(candidate => _syncedCopy(row, candidate));
      if (!canonical) return [row];
      if (retained.has(canonical.id)) return [];
      retained.add(canonical.id);
      return [_withChatUiKey(canonical, row)];
    });
    const incoming = canonical ? items : _withoutSyncedCopies((items || []).filter((item) => item && item.id), available);
    const incomingById = new Map();
    for (const item of incoming) if (!incomingById.has(String(item.id))) incomingById.set(String(item.id), item);
    const used = new Set();
    const stable = [];
    (current || []).forEach((row) => {
      const id = String(row && row.id || '');
      let found = used.has(id) ? null : incomingById.get(id);
      if (!found && row && row.pending) {
        found = incoming.find((item) => !used.has(String(item.id)) && _sameDraft(row, item));
      }
      if (found) {
        used.add(String(found.id));
        const merged = row && row.pending ? _settleDraft(row, found)
          : _withChatUiKey({ ...row, ...found, pending: false }, row);
        delete merged._missingAt;
        stable.push(merged);
      } else if (row) {
        const state = chatState(row);
        const grace = row.pending || state === 'starting' || state === 'running' || state === 'waiting'
          ? DRAFT_GRACE_MS : HISTORY_GAP_GRACE_MS;
        const missingAt = Number(row._missingAt || clock);
        if ((row.pending && clock - _chatAt(row) < DRAFT_GRACE_MS) || clock - missingAt < grace) {
          stable.push(_withChatUiKey({ ...row, _missingAt: missingAt }, row));
        }
      }
    });
    const fresh = incoming.filter((item) => !used.has(String(item.id)))
      .sort((a, b) => _chatAt(b) - _chatAt(a))
      .map((item) => _withChatUiKey({ ...item, pending: false }));
    if (!(current || []).length) return fresh.slice(0, maximum);

    /*
     * History pages contain at most 50 records. Preserve existing row positions, move
     * genuinely updated conversations to the top, and append older history without truncating
     * visible records.
     */
    const newestVisibleAt = Math.max(0, ...(current || []).map(_chatAt));
    const promoted = fresh.filter((item) => _chatAt(item) > newestVisibleAt);
    const promotedIds = new Set(promoted.map((item) => String(item.id)));
    const next = promoted.concat(stable);
    for (const item of fresh) {
      if (next.length >= maximum) break;
      if (!promotedIds.has(String(item.id))) next.push(item);
    }
    return next.slice(0, maximum);
  }
  function _upsertChatItems(current, item, { deferUnconfirmedCloudTasks = false, limit = MAX_CHAT_ITEMS, canonicalId } = {}) {
    const maximum = Number.isSafeInteger(limit) && limit > 0 ? limit : MAX_CHAT_ITEMS;
    if (!item) return (current || []).slice(0, maximum);
    if (item.emptyPlaceholder) {
      const ids = _emptyPlaceholderIds([item]);
      return (current || []).filter(row => !ids.has(String(row.id)));
    }
    const canonical = typeof canonicalId === 'function';
    const previous = canonical ? _canonicalHistoryRows(current, canonicalId) : current || [];
    if (canonical) item = _canonicalHistoryRows([item], canonicalId)[0];
    if (!canonical && previous.some(row => _syncedCopy(item, row))) return _withoutSyncedCopies(previous);
    const rows = canonical ? previous.slice() : _withoutSyncedCopies(previous, [...previous, item]);
    let index = rows.findIndex((row) => {
      const direct = String(item.id || '') && String(row && row.id || '') === String(item.id);
      const local = String(item.localId || '') &&
        String(row && (row.localId || row.id) || '') === String(item.localId);
      return direct || local;
    });
    if (index < 0 && item.id) index = rows.findIndex((row) => _sameDraft(row, item));
    if (index < 0) {
      // Replace an already-visible sync alias in place when its source entry
      // arrives; receiving metadata must not look like a newly created chat.
      const alias = canonical ? -1 : previous.findIndex(row => _syncedCopy(row, item));
      // A task can span multiple conversations. Let account history resolve an
      // unknown live session before inserting it alongside the visible cloud row.
      if (deferUnconfirmedCloudTasks && alias < 0 && item.id && item.taskId &&
          (item.cloud || item.collaboration) && !item.pending && !item.localId &&
          !item.archived && !item.accountConversation &&
          rows.some(row => row.cloud && !row.archived && row.taskId === item.taskId)) return null;
      const entry = _withChatUiKey(item, previous[alias]);
      // Restoring a task binding is not new activity. Only date a new, undated entry.
      if (entry.collaboration && !entry.at && !entry.createdAt && !entry.updatedAt) {
        entry.at = alias >= 0 ? _chatAt(previous[alias]) : Date.now();
      }
      rows.splice(alias < 0 ? 0 : Math.min(alias, rows.length), 0, entry);
      return rows.slice(0, maximum);
    }
    rows[index] = rows[index] && rows[index].pending && item.id
      ? _settleDraft(rows[index], item)
      : _withChatUiKey({ ...rows[index], ...item }, rows[index]);
    return rows.slice(0, maximum);
  }

  global.WorkspaceChatHistory = { MAX_CHAT_ITEMS, CHAT_STATE, chatState, _chatAt, _chatUiKey, _withChatUiKey, _sameDraft, _settleDraft, _reconcileChats, _upsertChatItems };
})(window);
