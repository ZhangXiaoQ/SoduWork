'use strict';

const crypto = require('node:crypto');
const { fetchWithDeviceAuthRetry, accountScopeKey } = require('../device-auth-request');
const runtime = require('../platform-connections/runtime.cjs');

const MAX_TEXT = 200000;
const MAX_MESSAGES = 1000;

function safeText(value, limit = MAX_TEXT) {
  return String(value == null ? '' : value).slice(0, limit);
}

function messageText(item) {
  const directText = typeof item?.text === 'string' ? item.text : '';
  const directContent = typeof item?.content === 'string' ? item.content : '';
  if (directText) return directText;
  if (directContent) return directContent;
  const blocks = Array.isArray(item?.blocks) ? item.blocks :
    Array.isArray(item?.content) ? item.content : [];
  const blockText = blocks.filter(block => block && (!block.kind || block.kind === 'text'))
    .map(block => typeof block.text === 'string' ? block.text : block.content)
    .filter(value => typeof value === 'string').join('\n\n');
  return blockText || directText || directContent;
}

function syncState(value) {
  const state = String(value || '').trim().toLowerCase();
  if (['streaming', 'running', 'queued', 'starting', 'dispatching', 'waiting-user', 'responding'].includes(state)) return 'responding';
  if (['completed', 'done'].includes(state)) return 'completed';
  if (['aborted', 'canceled', 'cancelled', 'interrupted'].includes(state)) return 'interrupted';
  if (['unreachable', 'error', 'failed'].includes(state)) return 'failed';
  if (['stopped'].includes(state)) return 'stopped';
  return 'idle';
}

function sourceMessage(sessionId, item, position, messageTimes, now) {
  const role = item && (item.role === 'assistant' || item.role === 'user') ? item.role : '';
  if (!role) return null;
  // Pi stores visible assistant prose in text blocks; reasoning and tool
  // arguments must not become the cross-device reply body.
  const text = safeText(messageText(item));
  const id = safeText(item.id || `${sessionId}:${position}:${role}`, 240);
  const rawTime = item.sentAt ?? item.createdAt ?? item.completedAt ?? item.timestamp ?? item.at;
  const numericTime = typeof rawTime === 'number' ? rawTime :
    typeof rawTime === 'string' && rawTime.trim() && Number.isFinite(Number(rawTime))
      ? Number(rawTime) : NaN;
  const parsedTime = Number.isFinite(numericTime) ? numericTime
    : typeof rawTime === 'string' && rawTime.trim() ? Date.parse(rawTime) : NaN;
  // Legacy messages without a timestamp keep their first observed time across
  // polling and restarts; reading a transcript must not change its revision.
  const createdAt = Number.isFinite(parsedTime) && Math.abs(parsedTime) <= 8640000000000000
    ? parsedTime : messageTimes[id] ?? now();
  messageTimes[id] = createdAt;
  return { id, position, role, text, deleted: item.deleted === true, done: item.done === true,
    createdAt: new Date(createdAt).toISOString() };
}

function snapshot(handle, messageTimes, now, metadataOnly = false) {
  const sessionId = safeText(handle.sessionId, 180);
  const raw = typeof handle.snapshot === 'function' ? handle.snapshot() : {};
  const rows = Array.isArray(raw.messages) ? raw.messages : [];
  // A silently truncated checkpoint is worse than a delayed checkpoint: the
  // Hub would retain an incomplete transcript and other devices could render
  // it as the source of truth. Refuse the snapshot and let the source device
  // report the bounded-sync error instead.
  if (!metadataOnly && rows.length > MAX_MESSAGES) throw Error('source conversation exceeds the sync message limit');
  const messages = metadataOnly ? [] : rows.map((item, index) => sourceMessage(sessionId, item, index, messageTimes, now)).filter(Boolean);
  const history = typeof handle.historyRow === 'function' ? handle.historyRow(raw) : {};
  const title = safeText(history && history.title || raw.title || '本地会话', 200);
  const state = syncState(raw.status || history && history.state || 'idle');
  // A dedicated task view can have a native session id but no independent
  // transcript. Preserve its explicit binding instead of cloning the task.
  const taskIds = [...new Set([
    ...(Array.isArray(history?.taskIds) ? history.taskIds : []),
    history?.taskId, handle.taskRef,
  ].filter(Boolean).map(String))];
  const taskProjectionId = !handle.acceptanceSession && taskIds.length === 1 &&
    rows.every(item => String(item?.taskId || '') === taskIds[0]) ? taskIds[0] : '';
  return { sessionId, title, state, messages, taskProjectionId,
    ...(metadataOnly ? { messageCount: rows.length,
      tailDigest: digest(rows.slice(-10).map(item => [item.id, item.role, messageText(item)])) } : {}) };
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isProjection(handle) {
  if (handle.passiveCloudView || handle.localReplica) return true;
  const view = typeof handle.snapshot === 'function' ? handle.snapshot() : {};
  return view?.execution?.accountConversation === true || view?.cloudHandoff?.phase === 'committed';
}

function historyRow(item, identity) {
  return {
    id: item.id, title: item.title || '账号会话', at: item.updatedAt || '',
    createdAt: item.createdAt || item.updatedAt || '',
    state: item.state || 'idle', adapterId: 'account-sync', accountConversation: true,
    accountProjection: true, archived: item.archived === true, owner: runtime.connectionScope(identity),
    deleted: item.deleted === true, revision: Number(item.revision || 0),
    emptyPlaceholder: item.messageCount === 0 && !item.taskProjectionId && item.state === 'idle',
    lifecycleRevision: Number(item.lifecycleRevision || 0),
    historyAliasIds: [...new Set([item.id, ...(item.historyAliasIds || [])].filter(Boolean))],
    accountCanSend: item.canSend === true, sourceClientId: item.sourceClientId,
    sourceSessionId: item.sourceSessionId, locationMode: 'account', location: 'account', cloud: false,
  };
}

function create({ app, identityOf, localIdentityOf, store, resolveNativeSource, retryMs = 5000,
  fetch = fetchWithDeviceAuthRetry, now = () => Date.now(), realtime = false,
  discovery = require('../native-discovery.cjs'), refreshOptions = {}, metadataOnly = false, preserveLegacyOutbox }) {
  const bound = new Map();
  let closed = false;
  let timer = null;
  let flushing = null;
  let closing = null;
  const lifetime = new AbortController();
  const recordQueue = [];
  let recordingScheduled = false;
  function deferRecord(action) {
    return new Promise((resolve, reject) => {
      recordQueue.push({ action, resolve, reject });
      if (recordingScheduled) return;
      recordingScheduled = true;
      const next = () => {
        const job = recordQueue.shift();
        if (!job) { recordingScheduled = false; return; }
        // Bound both serialization bursts and payloads waiting for the worker.
        // Start the next snapshot only after this durability operation settles.
        Promise.resolve().then(job.action).then(job.resolve, job.reject)
          .finally(() => setImmediate(next));
      };
      setImmediate(next);
    });
  }
  const accountIds = new Set();
  const accountRows = new Map();
  // Keep every authenticated directory alias addressable. A sidebar row may
  // outlive a refresh and still carry a native/session alias instead of the
  // Hub conversation id; opening it must resolve the same account record.
  const accountAliasRows = new Map();
  const sourceRows = new Map();
  const listeners = new Set();
  let socket = null;
  let socketScope = '';
  let socketTimer = null;
  let socketAttempt = 0;
  let socketGeneration = 0;
  let nativeDiscovery = null;
  let socketReady = false, socketRefresh = null;
  let socketHandshakeTimer = null;
  let reconcileTimer = null;
  let historyPromise = null;
  let historyAt = 0;
  let historyScope = '';
  let directoryClientId = '';
  let historyGeneration = 0, directoryLoaded = false;
  let historyCursor = 0, historyHasMore = false;
  let historyEpoch = 0, loadedEpoch = -1, historyInitialized = false;
  let historyFailures = 0, historyRetryAt = 0;
  const directoryChanges = new Set();
  const deletedIds = new Set();
  const historyTtl = 3000;
  const historyPageSize = 100;
  const historyMaxPages = 5;
  const nativeProjections = new Map(), nativeQueue = [];
  let nativeActive = 0;

  function identityKey(identity) {
    try { return accountScopeKey(identity); } catch (_) { return ''; }
  }

  function directoryScope(identity) {
    // Directory permissions such as canSend depend on the current device.
    return identity ? JSON.stringify([String(identity.hub || '').replace(/\/+$/, ''),
      identityKey(identity), identity.clientId]) : '';
  }

  function selectDirectory(identity) {
    const scope = directoryScope(identity);
    directoryClientId = String(identity?.clientId || '');
    if (scope !== historyScope) {
      historyGeneration++;
      historyScope = scope;
      historyPromise = null;
      accountRows.clear(); accountAliasRows.clear(); sourceRows.clear(); accountIds.clear(); deletedIds.clear();
      historyCursor = 0; historyHasMore = false; historyAt = 0; directoryLoaded = false;
      historyInitialized = false; directoryChanges.clear(); loadedEpoch = -1;
      historyFailures = 0; historyRetryAt = 0;
    }
    return scope;
  }

  function nativeProjection(item, identity) {
    if (!resolveNativeSource || item.sourceClientId !== identity.clientId) return Promise.resolve(null);
    const scope = directoryScope(identity), generation = historyGeneration;
    const key = JSON.stringify([scope, generation, item.id, item.revision || 0]);
    if (nativeProjections.has(key)) return nativeProjections.get(key);
    const drain = () => {
      while (nativeActive < 4 && nativeQueue.length) {
        const job = nativeQueue.shift(); nativeActive++;
        Promise.resolve().then(() => closed || job.generation !== historyGeneration || job.scope !== historyScope
          ? null : resolveNativeSource(job.item, job.identity)).catch(() => null)
          .then(job.resolve).finally(() => { nativeActive--; drain(); });
      }
    };
    const pending = new Promise(resolve => { nativeQueue.push({ item, identity, scope, generation, resolve }); });
    const tracked = pending.finally(() => { if (nativeProjections.get(key) === tracked) nativeProjections.delete(key); });
    nativeProjections.set(key, tracked); drain();
    return tracked;
  }

  function endpoint(identity, route) {
    const hub = String(identity && identity.hub || '').replace(/\/+$/, '');
    if (!hub || !identity.clientId || !identity.session) throw Error('请先登录 SoduWork 后再同步本地会话');
    return hub + '/api/v1' + route;
  }

  function schedule() {
    if (closed || timer) return;
    timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, retryMs);
    if (timer.unref) timer.unref();
  }

  async function projectedRow(item, identity) {
    const native = await nativeProjection(item, identity);
    const lifecycle = { revision: Number(item.revision || 0), lifecycleRevision: Number(item.lifecycleRevision || 0),
      deleted: item.deleted === true };
    return native ? { ...native, ...lifecycle,
      emptyPlaceholder: item.messageCount === 0 && !item.taskProjectionId && item.state === 'idle' &&
        !(native.count > 0) && !['running', 'waiting', 'starting'].includes(native.state),
      archived: item.archived === true || !lifecycle.lifecycleRevision && native.archived === true,
      owner: runtime.connectionScope(identity), accountId: item.id,
      sourceSessionId: item.sourceSessionId, sourceClientId: item.sourceClientId,
      historyAliasIds: [...new Set([...(native.historyAliasIds || []), ...(item.historyAliasIds || []), native.id, item.id].filter(Boolean))] }
      : historyRow(item, identity);
  }

  function rememberDirectory(item) {
    if (!item?.id) return;
    const id = String(item.id), previous = accountRows.get(id);
    if (previous && Number(previous.revision || 0) > Number(item.revision || 0)) return;
    if (previous) {
      for (const alias of directoryAliases(previous))
        if (accountAliasRows.get(alias) === previous) accountAliasRows.delete(alias);
    }
    accountRows.set(id, item);
    for (const alias of directoryAliases(item)) {
      const existing = accountAliasRows.get(alias);
      const owned = item.sourceClientId === directoryClientId;
      const existingOwned = existing?.sourceClientId === directoryClientId;
      const newer = Number(item.revision || 0) > Number(existing?.revision || 0);
      if (!existing || owned && !existingOwned || owned === existingOwned && newer)
        accountAliasRows.set(alias, item);
    }
    sourceRows.set(JSON.stringify([item.sourceClientId, item.sourceSessionId]), item);
    if (item.deleted) { accountIds.delete(id); deletedIds.add(id); }
    else { accountIds.add(id); deletedIds.delete(id); }
  }

  function directoryAliases(item) {
    return [...new Set([item?.id, item?.sourceSessionId,
      ...(Array.isArray(item?.historyAliasIds) ? item.historyAliasIds : []),
      ...(Array.isArray(item?.aliasIds) ? item.aliasIds : [])].filter(Boolean).map(value => String(value)))];
  }

  function directoryRow(id) {
    const wanted = String(id || '');
    // Alias rows carry the newest authenticated directory version. Prefer
    // that mapping when a stale canonical id is retained in the sidebar.
    return accountAliasRows.get(wanted) || accountRows.get(wanted) || null;
  }

  async function emitChanged(id, row, identity, projected) {
    const captured = directoryScope(identity), generation = historyGeneration;
    const current = async () => !closed && generation === historyGeneration && captured === historyScope &&
      captured === directoryScope(await (localIdentityOf || identityOf)?.(app)) &&
      (!row || accountRows.get(String(id)) === row);
    if (!await current()) return;
    const presence = projected || (row ? await projectedRow(row, identity) : {
      id, deleted: true, accountConversation: true, owner: runtime.connectionScope(identity),
    });
    for (const listener of listeners) {
      if (!await current()) return;
      try { await listener(String(presence.id || id || ''), row, presence); } catch (_) {}
    }
  }

  function stopRealtime() {
    ++socketGeneration;
    socketReady = false;
    socketRefresh?.stop(); socketRefresh = null;
    nativeDiscovery?.close();
    nativeDiscovery = null;
    if (socketHandshakeTimer) clearTimeout(socketHandshakeTimer);
    socketHandshakeTimer = null;
    if (socketTimer) clearTimeout(socketTimer);
    socketTimer = null;
    socketScope = '';
    const current = socket;
    socket = null;
    try { current?.close(); } catch (_) {}
  }

  function scheduleReconcile() {
    if (!realtime || closed || reconcileTimer) return;
    reconcileTimer = setTimeout(async () => {
      reconcileTimer = null;
      try { await refreshDirectory(); } catch (_) {}
      scheduleReconcile();
    }, 30000);
    reconcileTimer.unref?.();
  }

  async function refreshDirectory(hintedIds = [], current = () => !closed) {
    // The running request may have taken its server snapshot before the hint.
    // Wait for it, then start a new incremental read. history() publishes its
    // single-flight promise before resolving identity, so concurrent UI reads
    // cannot interleave a second, older load here.
    while (historyPromise && current()) await historyPromise;
    if (!current()) return { ok: true };
    return history({ force: true, notify: true, hintedIds });
  }

  function scheduleRealtime(identity, generation) {
    if (!realtime || closed || generation !== socketGeneration || socketTimer) return;
    const seconds = Math.min(30, Math.max(1, 1 << Math.min(socketAttempt, 5)));
    socketAttempt = Math.min(socketAttempt + 1, 8);
    socketTimer = setTimeout(() => {
      socketTimer = null;
      Promise.resolve((localIdentityOf || identityOf)(app)).then(current => {
        if (closed || generation !== socketGeneration) return;
        if (current?.session && current?.hub && current?.clientId) return connectRealtime(current);
      }).catch(() => {});
    }, seconds * 1000 * (0.8 + 0.2 * Math.random()));
    socketTimer.unref?.();
  }

  async function connectRealtime(identity) {
    if (!realtime || closed || typeof WebSocket !== 'function') return;
    const scope = require('../native-discovery.cjs').scopeOf(identity);
    if (!scope || ((socket || socketTimer) && socketScope === scope)) return;
    if (socketScope && socketScope !== scope) socketAttempt = 0;
    stopRealtime();
    const generation = socketGeneration;
    socketScope = scope;
    let url;
    try {
      url = new URL('/api/v1/ws', String(identity.hub));
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('device', String(identity.clientId || ''));
    } catch (_) { return; }
    let current;
    try { current = new WebSocket(url); } catch (_) { scheduleRealtime(identity, generation); return; }
    socket = current;
    socketScope = scope;
    const isCurrent = () => !closed && generation === socketGeneration && socket === current;
    const refresh = require('./directory-refresh.cjs').create({ ...refreshOptions, now,
      refresh: ids => refreshDirectory(ids, isCurrent) });
    socketRefresh = refresh;
    const discoveryConnection = discovery.attach(current, identity, () => (localIdentityOf || identityOf)(app));
    nativeDiscovery = discoveryConnection;
    // A transport that opens but never authenticates is not a healthy socket.
    socketHandshakeTimer = setTimeout(() => {
      if (socket === current && generation === socketGeneration) {
        try { current.close(); } catch (_) {}
      }
    }, 12000);
    socketHandshakeTimer.unref?.();
    current.onopen = () => {
      if (closed || generation !== socketGeneration || socket !== current) return;
      scheduleReconcile();
      current.send(JSON.stringify({ t: 'auth', device: identity.clientId, session: identity.session }));
    };
    current.onmessage = event => {
      if (closed || generation !== socketGeneration || socket !== current) return;
      let value;
      try { value = JSON.parse(String(event.data || '')); } catch (_) { return; }
      if (value?.type === 'ready') {
        socketAttempt = 0;
        if (socketHandshakeTimer) clearTimeout(socketHandshakeTimer);
        socketHandshakeTimer = null;
        if (!socketReady) {
          socketReady = true;
          historyEpoch++;
          refresh.wake(); // Close the initial handshake/reconnect delivery gap.
        }
      }
      discoveryConnection.message(value);
      if (value?.type !== 'account-conversation') return;
      // Replayed hints already covered by the durable directory cursor need
      // neither HTTP nor another repaint. Older Hubs may omit the revision.
      if (historyInitialized && Number.isSafeInteger(value.revision) &&
          value.revision > 0 && value.revision <= historyCursor) return;
      historyEpoch++;
      refresh.wake(safeText(value.conversationId, 180));
    };
    current.onerror = () => { try { current.close(); } catch (_) {} };
    current.onclose = () => {
      discoveryConnection.close();
      refresh.stop();
      if (generation === socketGeneration) socketReady = false;
      if (generation === socketGeneration && socketHandshakeTimer) clearTimeout(socketHandshakeTimer);
      if (generation === socketGeneration) socketHandshakeTimer = null;
      if (socket === current) socket = null;
      if (!closed && generation === socketGeneration) scheduleRealtime(identity, generation);
    };
  }

  function bind(handle, identity, options = {}) {
    if (!handle || !identity || closed || isProjection(handle)) return null;
    const sourceSessionId = safeText(handle.sessionId, 180), ownerKey = identityKey(identity);
    if (!sourceSessionId) throw Error('本地会话标识无效');
    if (!ownerKey) throw Error('当前账号身份无效');
    const hub = String(identity.hub || '').replace(/\/+$/, '');
    const key = JSON.stringify([hub, ownerKey, identity.clientId, sourceSessionId]);
    const existing = bound.get(key);
    if (existing?.handle === handle) { existing.identity = { ...identity }; return existing; }
    existing?.dispose?.();
    if (existing?.recordTimer) clearTimeout(existing.recordTimer);
    const state = { handle, identity: { ...identity }, key, ownerKey, sourceSessionId,
      sourceEpoch: safeText(sourceSessionId + ':desktop', 180), sourceRevision: 0, contentDigest: '', digest: '',
      messageTimes: Object.create(null), recordTimer: null, dispose: null, pending: null };
    bound.set(key, state);
    handle.accountSync = { state: 'pending', sourceSessionId, ownerKey };
    const record = (final = false) => {
      if (closed && !final || bound.get(key) !== state) return;
      try {
        if (state.pending) return state.pending;
        const result = store.asynchronous ? deferRecord(() => {
          if (bound.get(key) === state) return enqueue(state);
        }) : enqueue(state);
        if (result?.then) {
          state.pending = result.catch(error => { state.error = error.message;
            handle.accountSync = { ...handle.accountSync, state: 'error', reason: error.message };
          }).finally(() => { state.pending = null; });
          return state.pending;
        }
      } catch (error) {
        state.error = error.message;
        handle.accountSync = { ...handle.accountSync, state: 'error', reason: error.message };
      }
    };
    state.record = record;
    const initialize = previous => {
      if (bound.get(key) !== state) return;
      previous ||= {};
      if (previous.hub && String(previous.hub).replace(/\/+$/, '') !== hub ||
          previous.clientId && previous.clientId !== identity.clientId) previous = {};
      Object.assign(state, { deleted: previous.deleted === true, sourceEpoch: previous.sourceEpoch || state.sourceEpoch,
        sourceRevision: Number(previous.sourceRevision || 0), contentDigest: previous.contentDigest || '',
        digest: previous.digest || '', ackedRevision: Number(previous.ackedRevision || 0),
        conversationId: previous.conversationId || '',
        legacy: previous.legacy === true, messageTimes: Object.assign(Object.create(null), previous.messageTimes || {}) });
      if (!closed && typeof handle.on === 'function') state.dispose = handle.on(() => {
        if (state.recordTimer) clearTimeout(state.recordTimer);
        state.recordTimer = setTimeout(() => { state.recordTimer = null; record(); schedule(); }, 200);
        state.recordTimer.unref?.();
      });
      return record();
    };
    const previous = existing ? Promise.resolve(existing.ready).then(() => existing.pending)
      .then(() => store.session(key)) : store.session(key);
    if (previous?.then) {
      state.ready = previous.then(async value => value || await store.session(ownerKey + ':' + sourceSessionId))
        .then(initialize).catch(error => { state.error = error.message;
          handle.accountSync = { ...handle.accountSync, state: 'error', reason: error.message }; });
    } else state.ready = Promise.resolve(initialize(previous || store.session(ownerKey + ':' + sourceSessionId)));
    connectRealtime(state.identity).catch(() => {}); scheduleReconcile(); schedule();
    return state;
  }

  function enqueue(state) {
    if (state.deleted || isProjection(state.handle)) return;
    const times = { ...state.messageTimes };
    const view = snapshot(state.handle, times, now, metadataOnly);
    // Opening a review composer must not publish a durable empty chat.
    // Existing checkpoints still reconcile; the first submitted turn starts sync.
    if (!state.sourceRevision && state.handle.acceptanceSession && view.state === 'idle' &&
        (metadataOnly ? view.messageCount === 0 : view.messages.length === 0)) return;
    const content = { sourceClientId: state.identity.clientId, sourceSessionId: view.sessionId,
      sourceEpoch: state.sourceEpoch, title: view.title, state: view.state,
      archived: false, deleted: false, snapshotComplete: !metadataOnly, messages: view.messages,
      ...(metadataOnly ? { storageMode: 'endpoint', messageCount: view.messageCount, tailDigest: view.tailDigest } : {}),
      taskProjectionId: view.taskProjectionId };
    const contentDigest = digest(content);
    if (contentDigest === state.contentDigest && !state.legacy) return;
    // An orphaned legacy checkpoint has no ACK proof. Replay its original
    // revision; Hub's existing digest/epoch fences reject conflicting history.
    const revision = state.legacy && contentDigest === state.contentDigest
      ? state.sourceRevision : state.sourceRevision + 1;
    const body = { ...content, sourceRevision: Math.max(1, revision) };
    if (Buffer.byteLength(JSON.stringify(body)) > 2 * 1024 * 1024)
      throw Error('source conversation exceeds the sync message limit');
    const requestDigest = digest(body);
    const checkpoint = { sourceEpoch: state.sourceEpoch, sourceRevision: body.sourceRevision,
      contentDigest, digest: requestDigest, messageTimes: times, sourceSessionId: state.sourceSessionId,
      ackedRevision: state.ackedRevision || 0, hub: state.identity.hub,
      conversationId: state.conversationId || '',
      clientId: state.identity.clientId, ownerKey: state.ownerKey };
    const job = { id: state.key + ':' + body.sourceRevision + ':' + requestDigest.slice(0, 12),
      ownerKey: state.ownerKey, hub: state.identity.hub, clientId: state.identity.clientId, body, createdAt: now() };
    const commit = () => {
      const ackedRevision = Math.max(state.ackedRevision || 0, checkpoint.ackedRevision);
      const conversationId = state.conversationId || checkpoint.conversationId;
      Object.assign(state, checkpoint, { ackedRevision, conversationId, legacy: false, error: '' });
      state.handle.accountSync = { ...state.handle.accountSync, state: 'queued', sourceRevision: body.sourceRevision };
    };
    // The fallback supports external in-memory adapters; production always
    // persists the checkpoint and outbox in one SQLite transaction.
    const result = store.checkpointAndEnqueue ? store.checkpointAndEnqueue(state.key, checkpoint, job)
      : (store.enqueue(job), store.setSession(state.key, checkpoint));
    if (result?.then) return result.then(commit);
    commit();
  }

  async function send(job, identity) {
    // Older outboxes may contain native states rejected by the Hub. Normalize
    // on every retry, preserving the source revision, epoch and message IDs.
    const body = { ...job.body, state: syncState(job.body.state) };
    if (metadataOnly && body.storageMode !== 'endpoint') {
      if (body.messages?.length) {
        if (!preserveLegacyOutbox) throw Error('Legacy conversation content requires durable local migration');
        await preserveLegacyOutbox(job, identity);
      }
      body.storageMode = 'endpoint'; body.snapshotComplete = false; body.messages = [];
    }
    const response = await fetch(identity, endpoint(identity, '/account-conversations/sync'), {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(30000)]),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok !== true || data.sourceRevision !== job.body.sourceRevision || !data.conversationId ||
        job.conversationId && data.conversationId !== job.conversationId) {
      const error = Error(typeof data.detail === 'string' ? data.detail : '本地会话同步未确认');
      error.status = response.status; throw error;
    }
    return data;
  }

  async function deletedHistory(id, row, identity) {
    if (historyPromise) await historyPromise;
    const current = await (localIdentityOf || identityOf)?.(app);
    const scope = directoryScope(identity);
    if (closed || directoryScope(current) !== scope) return;
    const tombstone = { ...directoryRow(id), ...row, id, deleted: true };
    const cursor = (await store.directory?.(scope))?.cursor ?? (historyScope === scope ? historyCursor : 0);
    if (store.saveDirectory) await store.saveDirectory(scope, [tombstone], cursor);
    if (closed || directoryScope(await (localIdentityOf || identityOf)?.(app)) !== scope) return;
    selectDirectory(identity);
    rememberDirectory(tombstone);
    for (const state of bound.values()) if (directoryScope(state.identity) === scope &&
        state.sourceSessionId === row.sourceSessionId) state.deleted = true;
    historyAt = 0;
    await emitChanged(id, tombstone, identity);
  }

  async function flush() {
    if (closed) return { ok: false, closed: true };
    if (flushing) return flushing;
    flushing = (async () => {
      let inspected = 0;
      for (const state of bound.values()) {
        await state.ready;
        if (state.pending) await state.pending;
        await state.record();
        if (++inspected % 8 === 0) await new Promise(resolve => setImmediate(resolve));
      }
      let activeIdentity;
      try { activeIdentity = await identityOf?.(app); } catch (_) {}
      const jobs = store.batch && typeof identityOf === 'function'
        ? activeIdentity ? await store.batch({ ...activeIdentity, ownerKey: identityKey(activeIdentity) }) : []
        : await store.jobs(100);
      for (const job of jobs) {
        if (closed) break;
        const state = [...bound.values()].find(item => item.ownerKey === job.ownerKey &&
          item.identity.clientId === job.clientId && item.sourceSessionId === job.body.sourceSessionId &&
          String(item.identity.hub).replace(/\/+$/, '') === String(job.hub).replace(/\/+$/, ''));
        let identity = state && state.identity;
        if (typeof identityOf === 'function') {
          try { identity = await identityOf(app); } catch (_) { identity = null; }
          if (!identity || identityKey(identity) !== job.ownerKey || identity.clientId !== job.clientId ||
              String(identity.hub).replace(/\/+$/, '') !== String(job.hub).replace(/\/+$/, '')) continue;
        }
        if (!identity) continue;
        if (job.blocked) continue;
        try {
          const receipt = await send(job, identity);
          await store.ack(job.id, receipt);
          if (job.body.deleted === true) await deletedHistory(receipt.conversationId,
            { ...job.body, id: receipt.conversationId, deleted: true }, identity);
          if (state && state.sourceEpoch === job.body.sourceEpoch) {
            state.conversationId = receipt.conversationId;
            state.ackedRevision = Math.max(state.ackedRevision || 0, job.body.sourceRevision);
            if (!state.pending && state.sourceRevision === job.body.sourceRevision)
              state.handle.accountSync = { ...state.handle.accountSync, state: 'synced', sourceRevision: job.body.sourceRevision };
          }
        } catch (error) {
          const blocked = [409, 413, 422].includes(error.status);
          await store.fail(job.id, blocked);
          if (state) state.handle.accountSync = { ...state.handle.accountSync,
            state: blocked ? 'error' : 'queued', reason: error.message };
          if (blocked) continue;
          schedule();
          break;
        }
      }
      const remaining = await (store.pending ? store.pending() : store.jobs());
      // Login can become available after startup. Keep pending jobs durable
      // and retry without requiring another native conversation event.
      if (remaining.some(job => !job.blocked) || [...bound.values()].some(state => state.error)) schedule();
      for (const state of bound.values()) {
        const waiting = remaining.some(job => job.ownerKey === state.ownerKey &&
          job.clientId === state.identity.clientId && job.body.sourceSessionId === state.sourceSessionId &&
          String(job.hub).replace(/\/+$/, '') === String(state.identity.hub).replace(/\/+$/, ''));
        if (!waiting && !state.pending && !state.error && state.ackedRevision === state.sourceRevision && state.sourceRevision > 0) {
          state.handle.accountSync = { ...state.handle.accountSync, state: 'synced',
            sourceRevision: state.sourceRevision };
        }
      }
      return { ok: remaining.length === 0 && ![...bound.values()].some(state => state.error), pending: remaining.length };
    })().catch(error => { schedule(); throw error; }).finally(() => { flushing = null; });
    return flushing;
  }

  async function loadHistory(options = {}) {
    if (closed) return { ok: false, chats: [] };
    if (historyPromise) return historyPromise;
    // Callers select their authenticated directory before entering this shared
    // read. Capture it before identity lookup yields so old callers cannot join
    // or reset a newer account's in-flight load.
    const load = readHistory(options, historyScope, historyGeneration);
    historyPromise = load;
    try { return await load; }
    finally { if (historyPromise === load) historyPromise = null; }
  }

  async function readHistory({ force = false, notify = false, hintedIds = [], source } = {}, captured, generation) {
    const currentIdentity = () => typeof localIdentityOf === 'function'
      ? localIdentityOf(app) : typeof identityOf === 'function' ? identityOf(app) : null;
    const identity = await currentIdentity();
    if (closed || !identity) return { ok: false, chats: [] };
    const scope = directoryScope;
    const currentScope = scope(identity);
    if (generation !== historyGeneration || captured !== currentScope || captured !== historyScope)
      return { ok: false, chats: [] };
    const capturedEpoch = historyEpoch;
    const publishChanges = notify || historyInitialized;
    const cachedResult = async () => {
      return closed || generation !== historyGeneration || captured !== scope(await currentIdentity())
        ? { ok: false, chats: [] }
        : { ok: false, stale: true, partial: historyHasMore, cursor: historyCursor };
    };
    async function failedResult(reason) {
      if (closed || generation !== historyGeneration || captured !== scope(await currentIdentity())) return { ok: false, chats: [] };
      historyFailures++;
      historyRetryAt = now() + Math.min(60000, 5000 * 2 ** Math.min(historyFailures - 1, 4));
      return { ...await cachedResult(), ...(reason ? { reason } : {}) };
    }
    // Every network entry point shares the failure deadline: UI reads and
    // periodic reconciliation cannot bypass the socket queue's retry backoff.
    if (historyRetryAt > now()) return cachedResult();
    const cacheTtl = socketReady ? 30000 : historyTtl;
    if (!force && directoryLoaded && !historyHasMore && loadedEpoch === historyEpoch && currentScope === historyScope && now() - historyAt < cacheTtl) {
      return closed || generation !== historyGeneration || currentScope !== scope(await currentIdentity())
        ? { ok: false, chats: [] } : { ok: true };
    }
    return (async () => {
      connectRealtime(identity).catch(() => {});
      scheduleReconcile(); // Also repairs changes while no socket can connect.
      if (!directoryLoaded && store.directory) {
        const saved = await store.directory(captured);
        if (closed || generation !== historyGeneration || captured !== scope(await currentIdentity())) return { ok: false, chats: [] };
        for (const item of saved.items) rememberDirectory(item);
        historyCursor = saved.cursor;
      }
      directoryLoaded = true;
      let after = historyCursor;
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]);
      // Each page commits independently and yields to the event loop. Never
      // report a fixed prefix as a complete directory to the sidebar.
      for (let page = 0; !closed && page < historyMaxPages; page++) {
        const response = await fetch(identity,
          endpoint(identity, '/account-conversations?after=' + after + '&limit=' + historyPageSize), {
            method: 'GET', redirect: 'error', signal });
        const data = await response.json().catch(() => ({}));
        if (closed || generation !== historyGeneration || captured !== scope(await currentIdentity())) {
          return { ok: false, chats: [], reason: '账号或服务已切换' };
        }
        if (!response.ok || !Array.isArray(data.items)) return failedResult();
        const next = data.cursor == null ? after : Number(data.cursor);
        if (!Number.isSafeInteger(next) || next < after || data.hasMore === true && next <= after) {
          return failedResult('账号会话分页无效');
        }
        if (store.saveDirectory) await store.saveDirectory(captured, data.items, next);
        if (closed || generation !== historyGeneration || captured !== scope(await currentIdentity())) return { ok: false, chats: [] };
        for (const item of data.items) {
          if (!item?.id) continue;
          const id = String(item.id);
          if (publishChanges && (item.deleted ? !deletedIds.has(id) :
              JSON.stringify(accountRows.get(id)) !== JSON.stringify(item))) directoryChanges.add(id);
          rememberDirectory(item);
        }
        after = next;
        historyCursor = next;
        historyHasMore = data.hasMore === true;
        if (!historyHasMore) break;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (closed || generation !== historyGeneration || captured !== scope(await currentIdentity())) return { ok: false, chats: [] };
      historyAt = now();
      historyScope = currentScope;
      historyFailures = 0; historyRetryAt = 0;
      loadedEpoch = capturedEpoch;
      historyInitialized = true;
      const projections = new Map();
      for (const id of hintedIds) if (accountRows.has(id) || deletedIds.has(id)) directoryChanges.add(id);
      const changedIds = [...directoryChanges];
      await Promise.all(changedIds.map(async id => {
        const item = accountRows.get(id);
        if (item) projections.set(id, { item, presence: source === 'account'
          ? historyRow(item, identity) : await projectedRow(item, identity) });
      }));
      for (const id of changedIds) {
        if (closed || generation !== historyGeneration || captured !== scope(await currentIdentity())) return { ok: false, chats: [] };
        directoryChanges.delete(id);
        const item = accountRows.get(id) || null;
        const cached = projections.get(id);
        await emitChanged(id, item, identity, cached?.item === item ? cached.presence : undefined);
      }
      scheduleReconcile();
      return { ok: true, projections, projectionSource: source, partial: historyHasMore, cursor: historyCursor };
    })().catch(() => failedResult());
  }

  function directoryIdentity(item) {
    const source = String(item?.sourceSessionId || '').trim();
    return source ? 'source:' + source : 'account:' + String(item?.id || '');
  }

  function directoryVersion(item) {
    const revision = Number(item?.revision || 0);
    const lifecycleRevision = Number(item?.lifecycleRevision || 0);
    const updatedAt = Date.parse(item?.updatedAt || item?.updated || '') || 0;
    return [lifecycleRevision, revision, updatedAt, String(item?.id || '')];
  }

  function collapseDirectoryRows(items, identity) {
    const groups = new Map();
    for (const item of items || []) {
      if (!item?.id) continue;
      const key = directoryIdentity(item);
      const group = groups.get(key) || [];
      group.push(item);
      groups.set(key, group);
    }
    return [...groups.values()].map(group => {
      const owned = group.filter(item => item.sourceClientId && item.sourceClientId === identity.clientId);
      const candidates = owned.length ? owned : group;
      const winner = [...candidates].sort((left, right) => {
        const a = directoryVersion(left), b = directoryVersion(right);
        for (let index = 0; index < a.length - 1; index++) {
          if (a[index] !== b[index]) return b[index] - a[index];
        }
        return a.at(-1).localeCompare(b.at(-1));
      })[0];
      const aliases = [...new Set(group.flatMap(item => [item.id, ...(item.historyAliasIds || [])])
        .filter(Boolean).map(String))];
      const revision = Math.max(...group.map(item => Number(item.revision || 0)), 0);
      const lifecycleRevision = Math.max(...group.map(item => Number(item.lifecycleRevision || 0)), 0);
      // A cloud tombstone or archive is authoritative for the shared source
      // identity, even if another device still reports stale active metadata.
      return { ...winner,
        archived: group.some(item => item.archived === true),
        deleted: group.some(item => item.deleted === true),
        revision, lifecycleRevision,
        historyAliasIds: aliases.filter(id => id !== String(winner.id)),
      };
    });
  }

  async function history({ archived = false, source, ...options } = {}) {
    const identity = await (localIdentityOf || identityOf)?.(app);
    const captured = selectDirectory(identity), generation = historyGeneration;
    if (!captured || closed) return { ok: false, chats: [], lifecycle: [] };
    const { projections, projectionSource, ...result } = await loadHistory({ ...options, source });
    const current = () => (localIdentityOf || identityOf)?.(app);
    if (closed || generation !== historyGeneration || captured !== historyScope || captured !== directoryScope(await current()))
      return { ok: false, chats: [], lifecycle: [] };
    const values = collapseDirectoryRows([...accountRows.values()], identity);
    const rows = await Promise.all(values.map(item => {
      if (source === 'account') return historyRow(item, identity);
      // Concurrent callers share the authorized directory load, not its view.
      const cached = projectionSource === 'account' ? null : projections?.get(String(item.id));
      return cached?.item === item ? cached.presence : projectedRow(item, identity);
    }));
    if (closed || generation !== historyGeneration || captured !== directoryScope(await current())) return { ok: false, chats: [], lifecycle: [] };
    // A lifecycle response can overtake a slow native projection. Overlay its
    // authoritative flags before publishing this directory snapshot.
    for (let index = 0; index < values.length; index++) {
      const latest = accountRows.get(String(values[index].id));
      if (!latest || latest === values[index]) continue;
      values[index] = latest;
      rows[index] = { ...rows[index], revision: Number(latest.revision || 0),
        lifecycleRevision: Number(latest.lifecycleRevision || 0), deleted: latest.deleted === true,
        archived: latest.archived === true || !latest.lifecycleRevision && rows[index].archived === true };
    }
    const lifecycle = values.map((item, index) => {
      const projected = rows[index];
      const nativeIds = !projected.accountProjection ? projected.nativeIds || [projected.id] : [];
      return { id: item.id, sourceSessionId: item.sourceSessionId, sourceClientId: item.sourceClientId,
        ...(nativeIds.length ? { nativeId: nativeIds[0] } : {}), nativeIds,
        historyAliasIds: [...new Set([item.id, ...nativeIds, ...(projected.historyAliasIds || [])])],
        archived: projected.archived === true, deleted: item.deleted === true,
        revision: Number(item.revision || 0), lifecycleRevision: Number(item.lifecycleRevision || 0) };
    });
    return { ...result, chats: rows.filter(item => !item.deleted && item.archived === archived), lifecycle };
  }

  function sameRoute(value, identity) {
    return value.ownerKey === identityKey(identity) && value.clientId === identity.clientId &&
      String(value.hub || '').replace(/\/+$/, '') === String(identity.hub || '').replace(/\/+$/, '');
  }

  async function lifecycleTarget(id, identity, prepare) {
    const wanted = String(id || '').trim();
    if (!wanted || wanted.length > 512) throw Error('会话标识无效');
    const captured = selectDirectory(identity), generation = historyGeneration;
    const check = async () => {
      if (closed || generation !== historyGeneration || captured !== directoryScope(await (localIdentityOf || identityOf)?.(app)))
        throw Error('账号或服务已切换，请重新打开会话');
    };
    const aliases = require('./account-native-source.cjs').aliases({ app, id: wanted, identity });
    const states = [...bound.values()].filter(state => sameRoute({ ...state.identity, ownerKey: state.ownerKey }, identity) &&
      aliases.includes(state.sourceSessionId));
    const pending = async () => (await (store.pending ? store.pending() : store.jobs())).filter(job =>
      sameRoute(job, identity) && aliases.includes(job.body?.sourceSessionId));
    let jobs = await pending();
    if (prepare && (states.length || jobs.length)) {
      for (const state of states) {
        await state.ready;
        if (state.pending) await state.pending;
        await state.record();
        if (state.error) throw Error('本地会话尚未同步，请重试后再操作：' + state.error);
      }
      await check();
      await flush();
      await check();
      jobs = await pending();
      if (jobs.length || states.some(state => state.error))
        throw Error('本地会话尚未同步成功，本次操作未完成，请联网后重试');
    }
    const checkpointIds = new Set(states.map(state => state.conversationId).filter(Boolean));
    for (const sourceSessionId of aliases) {
      const key = JSON.stringify([String(identity.hub).replace(/\/+$/, ''), identityKey(identity), identity.clientId, sourceSessionId]);
      const saved = await store.session?.(key) || await store.session?.(identityKey(identity) + ':' + sourceSessionId);
      if (saved?.conversationId && (!saved.hub || String(saved.hub).replace(/\/+$/, '') === String(identity.hub).replace(/\/+$/, '')) &&
          (!saved.clientId || saved.clientId === identity.clientId)) checkpointIds.add(saved.conversationId);
    }
    await check();
    const loaded = await loadHistory({ force: true });
    await check();
    let item = historyScope === captured && [...accountRows.values()].find(value => value.id === wanted ||
      value.sourceClientId === identity.clientId && (aliases.includes(value.sourceSessionId) || checkpointIds.has(value.id)));
    if (checkpointIds.size) {
      // ACK may arrive before a directory page. Resolve its authenticated ID
      // directly rather than treating the native archive as local-only.
      for (const accountId of checkpointIds) {
        if (accountRows.has(accountId)) continue;
        const response = await fetch(identity, endpoint(identity, '/account-conversations/' + encodeURIComponent(accountId) + '/source'),
          { method: 'GET', redirect: 'error', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]) });
        const data = await response.json().catch(() => ({}));
        await check();
        if (!response.ok || data.conversation?.id !== accountId) throw Error('无法确认账号会话状态，请稍后重试');
        const value = data.conversation;
        if (value.sourceClientId !== identity.clientId || !aliases.includes(value.sourceSessionId))
          throw Error('账号会话来源不匹配，请刷新后重试');
        rememberDirectory(value); item ||= accountRows.get(accountId);
      }
    }
    if (!item) {
      if (states.length || jobs.length) {
        if (prepare) throw Error('本地会话同步尚未确认，本次操作未完成，请稍后重试');
        return { ok: true, found: true, pending: true, conversation: null, projection: null,
          aliasIds: aliases, nativeIds: aliases };
      }
      if (!loaded.ok || loaded.stale || loaded.partial)
        throw Error('账号会话目录尚未完整确认，本次操作未完成，请稍后重试');
      return { ok: true, found: false, aliasIds: [wanted], nativeIds: [] };
    }
    const native = await projectedRow(item, identity);
    await check();
    const sourceAliases = item.sourceClientId === identity.clientId
      ? require('./account-native-source.cjs').aliases({ app, id: item.sourceSessionId, identity }) : [];
    if (prepare && sourceAliases.length && (!loaded.ok || loaded.stale || loaded.partial))
      throw Error('这条本地会话的同步来源尚未完整确认，本次操作未完成，请稍后重试');
    if (prepare && sourceAliases.some(alias => !aliases.includes(alias)))
      return lifecycleTarget(sourceAliases[0], identity, true);
    const conversations = [item, ...[...accountRows.values()].filter(value => value.id !== item.id &&
      value.sourceClientId === identity.clientId && sourceAliases.includes(value.sourceSessionId))];
    const nativeIds = !native.accountProjection ? native.nativeIds || sourceAliases : [];
    const aliasIds = [...new Set([wanted, ...conversations.map(value => value.id), ...sourceAliases, ...(native.historyAliasIds || [])])];
    const projection = historyRow({ ...item, historyAliasIds: aliasIds }, identity);
    return { ok: true, found: true, conversation: item, conversations, projection, aliasIds, nativeIds };
  }

  async function resolveLifecycle(id, { prepare = false } = {}) {
    try {
      const identity = await (localIdentityOf || identityOf)?.(app);
      if (closed || !identity?.session || !identityKey(identity)) throw Error('请先登录 SoduWork 后操作会话');
      return await lifecycleTarget(id, identity, prepare);
    } catch (error) { return { ok: false, reason: String(error.message || error) }; }
  }

  const lifecycleMutations = new Map();
  async function setLifecycle(id, action) {
    if (!['archive', 'restore', 'delete'].includes(action)) return { ok: false, reason: '会话操作无效' };
    const locks = [];
    const confirmed = [];
    try {
      const identity = await (localIdentityOf || identityOf)?.(app);
      if (closed || !identity?.session || !identityKey(identity)) throw Error('请先登录 SoduWork 后操作会话');
      const captured = directoryScope(identity);
      const resolved = await lifecycleTarget(id, identity, true);
      const generation = historyGeneration;
      if (!resolved.found) return { ...resolved, localOnly: true };
      const targets = resolved.conversations || [resolved.conversation];
      const keys = targets.map(item => captured + ':' + item.id);
      if (keys.some(key => lifecycleMutations.has(key))) throw Error('这条会话正在更新，请稍后重试');
      for (const key of keys) { locks.push(key); lifecycleMutations.set(key, true); }
      const check = async () => {
        if (closed || generation !== historyGeneration || captured !== directoryScope(await (localIdentityOf || identityOf)?.(app)))
          throw Error('账号或服务已切换，请重新打开会话');
      };
      for (const target of targets) {
        await check();
        const item = accountRows.get(target.id) || target;
        const response = await fetch(identity, endpoint(identity, '/account-conversations/' + encodeURIComponent(item.id) + '/lifecycle'), {
          method: 'POST', redirect: 'error', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]),
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, expectedRevision: Number(item.revision || 0) }) });
        const data = await response.json().catch(() => ({}));
        await check();
        const conversation = data.conversation;
        if (!response.ok || data.ok !== true || conversation?.id !== item.id ||
            !Number.isSafeInteger(conversation.revision) || conversation.revision < Number(item.revision || 0) ||
            !Number.isSafeInteger(conversation.lifecycleRevision) || conversation.lifecycleRevision <= 0 ||
            (action === 'delete' ? conversation.deleted !== true : conversation.deleted === true || conversation.archived !== (action === 'archive')))
          throw Error(typeof data.detail === 'string' ? data.detail : '账号会话操作未确认，请刷新后重试');
        if (store.saveDirectory) await store.saveDirectory(captured, [conversation]);
        await check();
        rememberDirectory(conversation);
        confirmed.push(conversation);
        await emitChanged(item.id, accountRows.get(item.id), identity);
        await check();
      }
      // Other devices can publish a newer lifecycle while native projection or
      // notification work yields. Never apply an obsolete local action then.
      for (const item of confirmed) {
        const latest = accountRows.get(item.id);
        if (Number(latest?.lifecycleRevision || 0) > item.lifecycleRevision &&
            (latest.deleted !== item.deleted || latest.archived !== item.archived))
          throw Error('会话状态已更新，本次操作未全部完成，请刷新后重试');
      }
      const conversation = confirmed[0], lifecycleRevision = Math.max(...confirmed.map(item => item.lifecycleRevision));
      const projection = historyRow({ ...conversation, lifecycleRevision, historyAliasIds: resolved.aliasIds }, identity);
      return { ...resolved, id: conversation.id, conversation, conversations: confirmed, projection,
        archived: conversation.archived === true, deleted: conversation.deleted === true, lifecycleRevision };
    } catch (error) { return { ok: false, reason: String(error.message || error), ...(confirmed.length ? { partial: true } : {}) }; }
    finally { for (const key of locks) lifecycleMutations.delete(key); }
  }

  async function row(id) {
    const wanted = safeText(id, 180);
    if (!wanted) return null;
    const identity = typeof localIdentityOf === 'function'
      ? await localIdentityOf(app)
      : typeof identityOf === 'function' ? await identityOf(app) : null;
    if (!identity) return null;
    const currentScope = selectDirectory(identity), generation = historyGeneration;
    const cached = directoryRow(wanted);
    if (cached && currentScope === historyScope) return cached;
    const response = await fetch(identity,
      endpoint(identity, '/account-conversations/' + encodeURIComponent(wanted) + '/source'), {
        method: 'GET', redirect: 'error', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]) });
    const data = await response.json().catch(() => ({}));
    if (response.status === 404) {
      await loadHistory({ force: true });
      return directoryRow(wanted);
    }
    if (!response.ok || data.conversation?.id !== wanted) return null;
    const current = await (localIdentityOf || identityOf)(app);
    if (closed || generation !== historyGeneration || currentScope !== directoryScope(current)) return null;
    rememberDirectory(data.conversation);
    return directoryRow(wanted);
  }

  async function openProjection(id) {
    const wanted = safeText(id, 180);
    if (!wanted) return null;
    const identity = typeof identityOf === 'function' ? await identityOf(app) : null;
    if (!identity) return null;
    const captured = selectDirectory(identity), generation = historyGeneration;
    const current = async () => !closed && generation === historyGeneration &&
      captured === directoryScope(await (localIdentityOf || identityOf)?.(app));
    // A restored sidebar can carry an alias before the authenticated directory
    // has been loaded in this process. Resolve it through the same single-flight
    // directory read used by the sidebar before constructing the messages URL.
    let cached = directoryRow(wanted);
    if (!cached) cached = await row(wanted);
    if (!await current()) return null;
    let accountId = String(cached?.id || wanted);
    let metadata = null;
    let snapshotValue = null;
    let refreshPromise = null;
    async function refresh() {
      if (refreshPromise) return refreshPromise;
      refreshPromise = (async () => {
        let recovered = false;
        let messages = [];
        let nextMetadata = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          let after = 0;
          nextMetadata = null;
          messages = [];
          let missing = false;
          const base = endpoint(identity, '/account-conversations/' + encodeURIComponent(accountId) + '/messages');
          for (let page = 0; page < 200; page++) {
            if (!await current()) return false;
            const response = await fetch(identity, base + '?after=' + after + '&limit=100', {
              method: 'GET', redirect: 'error', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]) });
            const data = await response.json().catch(() => ({}));
            if (!await current()) return false;
            if (response.status === 404) { missing = true; break; }
            if (!response.ok || !data.conversation || !Array.isArray(data.items) || typeof data.cursor !== 'number') {
              throw Error('跨设备会话正文读取失败');
            }
            nextMetadata = data.conversation;
            for (const item of data.items) {
              if (!item || typeof item.id !== 'string' || item.deleted) continue;
              const at = Date.parse(String(item.createdAt || ''));
              messages.push({ id: item.id, role: item.role, text: safeText(item.text), position: Number(item.position || 0),
                sentAt: Number.isFinite(at) ? at : now(), done: item.done === true });
            }
            if (messages.length > MAX_MESSAGES || messages.reduce((n, item) => n + item.text.length, 0) > 32 * 1024 * 1024) {
              throw Error('跨设备会话正文超过桌面端读取上限');
            }
            const next = data.cursor;
            if (next <= after || data.hasMore !== true) break;
            after = next;
          }
          if (!missing) break;
          if (recovered) return false;
          recovered = true;
          await loadHistory({ force: true });
          const refreshed = directoryRow(wanted) || await row(wanted);
          if (!refreshed || refreshed.deleted) return false;
          accountId = String(refreshed.id || accountId);
        }
        if (!nextMetadata || nextMetadata.id !== accountId || !await current()) return false;
        metadata = nextMetadata;
        rememberDirectory(metadata);
        metadata = directoryRow(wanted) || accountRows.get(accountId);
        if (metadata.deleted) return false;
        snapshotValue = {
          messages: messages.sort((a, b) => a.position - b.position).map(require('./history-message.cjs').project),
          status: safeText(metadata.state || 'idle', 24),
          adapterId: 'account-sync', displayName: '账号会话',
          modelSelection: {}, execution: { accountConversation: true, readOnly: true },
          accessControl: { mode: 'readonly', capabilities: [] },
        };
        return true;
      })().finally(() => { refreshPromise = null; });
      return refreshPromise;
    }
    if (!await refresh()) return null;
    const title = () => safeText(metadata?.title || '账号会话', 200);
    return {
      ref: 'account-view-' + wanted,
      sessionId: wanted,
      adapterId: 'account-sync', displayName: '账号会话', cwd: '',
      ui: { get title() { return title(); }, mode: 'readonly', selectedSkills: [], capabilities: [] },
      snapshot: () => snapshotValue,
      uiSnapshot: () => snapshotValue,
      historyRow: () => historyRow({ ...metadata, id: accountId, title: title(), state: snapshotValue.status }, identity),
      refresh,
      on: () => () => {},
      status: () => snapshotValue.status,
      inFlight: () => false,
      send: async () => ({ ok: false, accepted: false, reason: '跨设备会话是只读投影，请在来源设备继续' }),
      stop: async () => ({ ok: false, reason: '跨设备会话是只读投影' }),
      close: async () => true,
    };
  }

  function close() {
    if (closing) return closing;
    closed = true;
    while (nativeQueue.length) nativeQueue.shift().resolve(null);
    lifetime.abort();
    stopRealtime();
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = null;
    if (timer) clearTimeout(timer);
    closing = (async () => {
      let inspected = 0;
      for (const state of bound.values()) {
        if (state.recordTimer) clearTimeout(state.recordTimer);
        try { state.dispose && state.dispose(); } catch (_) {}
        await state.ready;
        if (state.pending) await state.pending;
        await state.record(true);
        if (++inspected % 8 === 0) await new Promise(resolve => setImmediate(resolve));
      }
      if (flushing) await flushing.catch(() => {});
      bound.clear();
      await store.close?.();
    })();
    return closing;
  }

  Promise.resolve(store.jobs(1)).then(jobs => { if (jobs.length) schedule(); }).catch(() => {});
  return { bind, flush, close, history, row, openProjection, resolveLifecycle, setLifecycle,
    sourceProjection(id, identity) {
      if (directoryScope(identity) !== historyScope) return null;
      const row = sourceRows.get(JSON.stringify([identity.clientId, id]));
      return row && !row.deleted ? row : null;
    }, onChange(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener); return () => listeners.delete(listener);
    }, isRemote: () => false,
    isAccountConversation: id => {
      const row = directoryRow(id);
      return Boolean(row && !row.deleted && accountIds.has(String(row.id)));
    }, jobs: () => store.jobs() };
}

module.exports = { create };
