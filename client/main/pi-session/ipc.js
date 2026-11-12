/*
 * Main-process conversation bridge keeps runtime and credentials out of renderers. Batch
 * text deltas and publish structural or status changes promptly to bound repeated snapshot
 * serialization.
 */
const path = require('path');
const runtimeSession = require('../agent-runtime/pi-session-bridge');
const pluginDraft = require('./plugin-draft');
const pluginGrant = require('./plugin-grant');
const attachments = require('./attachments');
const attachmentContract = require('./attachment-contract');
const taskInput = require('./task-input');
const modelConfig = require('./model-config');
const capabilities = require('../conversation/capabilities');
const skillRoots = require('../conversation/skill-roots');
const skillTurn = require('./skill-turn');
const sessionSpec = require('../conversation/session-spec');
const updateWorkloads = require('../update-workloads');
const usageReporter = require('../agent-runtime/usage-reporter');
const artifactRuntime = require('../conversation/artifact-runtime');
const { shell, dialog } = require('electron');
const conversationTitles = require('../conversation/titles');
const eventPublication = require('./event-publication');
const _uiWindow = require('./ui-window').create();
const _publicationQueue = eventPublication.create(({ BrowserWindow, handle, uiSnapshot }, events, snapshot) =>
  _publishNow(BrowserWindow, handle, events.length === 1 ? events[0] : { ...events.at(-1), batch: events }, snapshot, uiSnapshot), {
  // Capture the first event's visible state before the handle can advance to
  // another snapshot in the same JS turn. Only delivery is deferred.
  capture: (context, snapshot) => ({ ...context, uiSnapshot:
    !context.handle.detached && context.handle.attachedWindow && typeof context.handle.uiSnapshot === 'function'
      ? _uiWindow.snapshot(context.handle) : snapshot }),
});
const OPEN_TIMEOUT_MS = 45000;
// Native snapshots already have 50 ms batching. Share the one-frame transport
// scheduler with the real Electron stream benchmark, including cancellation.
const _streamTransport = eventPublication.createStreamScheduler((context, touched, snapshot) =>
  _publish(context.BrowserWindow, context.handle, touched, snapshot));
const _releaseTimers = new Map();
const _wired = new WeakMap();
const RELEASE_GRACE_MS = 5 * 60 * 1000;
const { entryContextPrompts: _entryContextPrompts, awaitOpen: _awaitBounded,
  createConfiguration } = require('./environment-ipc');
let _app = null;
let _usage = null;
let _cloudHandoff = null;
let _accountSync = null;
let _sharedHistory = null;
let _deliverySync = null;
let _sessionOwners = null;
const { _conf, _saveConf, workDir, _defaultCwd, _newSessionCwd } = createConfiguration(() => _app);
/*
 * Rescan local skill directories on capability probes so newly installed skills do not
 * require a client restart.
 */
function _skillDirs(app) {
  return skillRoots.discoverAsync(app);
}

/*
 * Load only policy-approved skills selected for this device. Fail closed when skill policy
 * is unavailable instead of enabling bundled capabilities implicitly.
 */
function _contextSnapshot(handle, snapshot) {
  const { usageReceipts, ...display } = snapshot || {};
  return { ...display, ...(handle.requirementContext ? { requirementContext: handle.requirementContext } : {}),
    ...(handle.deliverySync ? { deliverySync: handle.deliverySync } : {}) };
}
function _send(win, handle, touched, snapshot, includeSnapshot, presenceSnapshot) {
  if (!win || win.isDestroyed()) return;
  if (typeof _sessionOwners !== 'undefined' && _sessionOwners && !_sessionOwners.canAccess(handle)) return;
  const safePluginAuthorization = includeSnapshot && typeof eventPublication.pluginAuthorization === 'function'
    ? eventPublication.pluginAuthorization(touched?.pluginAuthorization) : undefined;
  try {
    win.webContents.send('pi-session-event', {
      ref: handle.ref, sessionId: handle.sessionId,
      kind: touched && touched.kind,
      reason: touched && touched.reason,
      failureKind: includeSnapshot && touched && touched.failureKind || '',
      retrySafe: Boolean(includeSnapshot && touched && touched.retrySafe),
      submissionId: includeSnapshot && touched && touched.submissionId || '',
      ...(includeSnapshot ? require('../../core/token-quota').fields(touched) : {}),
      ...(safePluginAuthorization ? { pluginAuthorization: safePluginAuthorization } : {}),
      snapshot: includeSnapshot ? _contextSnapshot(handle, snapshot) : null,
      presence: conversationTitles.decorate(_app, typeof handle.historyRow === 'function'
        ? { ...handle.historyRow(presenceSnapshot || snapshot), ...(handle.requirementContext ? { requirementContext: handle.requirementContext } : {}) } : null),
      ...(handle.requirementContext ? { requirementContext: handle.requirementContext } : {}),
      taskId: String(touched && touched.taskId || snapshot && snapshot.execution && snapshot.execution.turnQueue && snapshot.execution.turnQueue.activeTaskId || ''),
      taskTitle: String(handle.taskTitle || ''),
      taskIds: Array.isArray(handle.taskIds) ? handle.taskIds.slice() : (handle.taskRef ? [String(handle.taskRef)] : []),
      taskBindings: Array.isArray(handle.taskBindings) ? handle.taskBindings.slice() : [],
      activeTaskId: String(handle.activeTaskId || handle.taskRef || ''),
      collaboration: Boolean((handle.taskIds || []).length || handle.taskRef),
      ...(Array.isArray(touched?.batch) ? { events: touched.batch.map(event => eventPublication.fields(event, includeSnapshot, snapshot)) } : {}),
    });
  }
  catch (e) { /* Drop the frame if its destination window is closing. */ }
}

/*
 * Send content only to the window hosting the conversation; other windows receive
 * lightweight presence to avoid multiplying history serialization by window count.
 */
function _publish(BrowserWindow, handle, touched, snapshot) {
  _publicationQueue.push(handle.ref, touched, snapshot, { BrowserWindow, handle });
}
function _publishNow(BrowserWindow, handle, touched, snapshot, uiSnapshot) {
  if (typeof _sessionOwners !== 'undefined' && _sessionOwners && !_sessionOwners.canAccess(handle)) {
    _discardRenderer(handle);
    return;
  }
  const owner = handle.attachedWindow;
  require('../conversation/app-surfaces.cjs').all(BrowserWindow.getAllWindows()).forEach((win) => {
    const full = !handle.detached && owner === win;
    const raw = full ? uiSnapshot : snapshot;
    const visible = _cloudHandoff ? _cloudHandoff.view(handle, raw) : raw;
    // Legacy contract marker: _send(win, handle, touched, snapshot, full)
    _send(win, handle, touched, visible, full, snapshot);
  });
}
function _isActive(handle) {
  const status = handle && handle.status();
  return Boolean(handle && typeof handle.inFlight === 'function' && handle.inFlight()) ||
    status === 'streaming' || status === 'compacting' || status === 'waiting-user';
}

function _clearRelease(ref) {
  const timer = _releaseTimers.get(ref);
  if (timer) clearTimeout(timer);
  _releaseTimers.delete(ref);
}

function _scheduleRelease(handle) {
  if (!handle || !handle.detached || _isActive(handle) || _releaseTimers.has(handle.ref)) return;
  const timer = setTimeout(() => {
    _releaseTimers.delete(handle.ref);
    if (handle.detached && !_isActive(handle) && runtimeSession.get(handle.ref) === handle) {
      artifactRuntime.closeRef(handle.ref);
      handle.close();
    }
  }, RELEASE_GRACE_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
  _releaseTimers.set(handle.ref, timer);
}

function _wire(BrowserWindow, handle) {
  if (!handle || _wired.has(handle)) return;
  _sharedHistory?.observe(handle, require('../conversation/requirement-context').cachedIdentity(_app));
  const dispose = handle.on((touched, snapshot) => {
    _push(BrowserWindow, handle, touched, snapshot);
    if (handle.detached) _scheduleRelease(handle);
  });
  _wired.set(handle, dispose);
}

function _discardRenderer(handle) {
  if (!handle) return;
  _publicationQueue.cancel(handle.ref);
  _streamTransport.cancel(handle.ref);
  const dispose = _wired.get(handle);
  _wired.delete(handle);
  try { if (typeof dispose === 'function') dispose(); } catch (_) { /* Continue closing renderer ownership. */ }
  _unwatchOwner(handle);
  _uiWindow.reset(handle);
  handle.detached = true;
  handle.attachedWindow = null;
  _clearRelease(handle.ref);
  require('./app-mcp-grant.cjs').unbind(handle);
  artifactRuntime.closeRef(handle.ref);
}

function _bindUsage(handle, identity, adapterId) {
  if (!handle || !identity) return;
  _deliverySync?.bind(handle, identity);
  _accountSync?.bind(handle, identity);
  handle.usageIdentity = {
    hub: String(identity.hub || ''),
    clientId: String(identity.clientId || ''),
    accountScope: (() => { try { return require('../conversation/runtime-segments').scope(identity); } catch (_) { return ''; } })(),
  };
  handle.usageAgentKey = String(adapterId || handle.adapterId || 'pi');
}

function _unwatchOwner(handle) {
  if (handle && handle.attachedWindow && handle.ownerClosed) {
    try { handle.attachedWindow.removeListener('closed', handle.ownerClosed); } catch (e) { /* The destination is already closed. */ }
  }
  if (handle) handle.ownerClosed = null;
}

function _detach(handle) {
  if (!handle) return;
  _publicationQueue.flush(handle.ref);
  _unwatchOwner(handle);
  _uiWindow.reset(handle);
  handle.detached = true;
  handle.attachedWindow = null;
  _scheduleRelease(handle);
}

function _attach(handle, win) {
  if (!handle) return;
  _publicationQueue.flush(handle.ref);
  _unwatchOwner(handle);
  if (handle.detached || handle.attachedWindow !== win) _uiWindow.reset(handle);
  handle.detached = false;
  handle.attachedWindow = win || null;
  if (win && !win.isDestroyed()) {
    handle.ownerClosed = () => { if (handle.attachedWindow === win) _detach(handle); };
    win.once('closed', handle.ownerClosed);
  }
  _clearRelease(handle.ref);
}

function _openReply(handle, extra) {
  const reply = require('./open-reply').openReply(_app, handle, extra);
  if (handle.localReplica === true) return reply;
  const context = require('../conversation/requirement-context').publicContext(_app, handle.sessionId);
  if (context) {
    reply.requirementContext = context;
    reply.snapshot = { ...reply.snapshot, requirementContext: context };
  }
  if (!_cloudHandoff) return reply;
  const snapshot = _cloudHandoff.view(handle, reply.snapshot);
  return { ...reply, snapshot, ...(snapshot.cloudHandoff?.phase === 'committed' ? {
    cloud: true, intent: '', goal: null, model: snapshot.modelSelection.model,
    adapterId: snapshot.adapterId, displayName: snapshot.displayName, accessControl: snapshot.accessControl,
  } : {}) };
}

/* Batch text-only deltas and publish other changes immediately. */
function _push(BrowserWindow, handle, touched, snapshot) {
  const ref = handle.ref;
  const structural = !touched || touched.kind !== 'block';
  if (structural) {
    _deliverySync?.observe(handle, touched, snapshot);
    if (_usage) _usage.observe(handle, snapshot);
    _streamTransport.push(ref, touched, snapshot, { BrowserWindow, handle });
    return;
  }
  _streamTransport.push(ref, touched, snapshot, { BrowserWindow, handle });
}
function install({ app, ipcMain, BrowserWindow, identityOf, sendIdentityOf, capabilityGrantsOf,
  onQuotaExceeded, authorizeAI, confirmFullAccess = require('../access-control/full-access-consent').confirm }) {
  /* Check runtime availability before presenting a usable composer. */
  _app = app;
  _sessionOwners = require('./session-owner.cjs').create({ app });
  const session = new Proxy({ ...runtimeSession }, {
    get(target, property) {
      if (property === 'get' || property === 'findBySessionId') return (...args) => {
        const handle = target[property](...args);
        if (!handle || _sessionOwners.canAccess(handle)) return handle;
        _discardRenderer(handle);
        return null;
      };
      if (property === 'list') return () => target.list().filter(handle => _sessionOwners.canAccess(handle));
      if (property === 'open') return async options => {
        const captured = _sessionOwners.assertOpen(options);
        const opened = await target.open(options);
        if (opened?.ok && opened.session) _sessionOwners.bind(opened.session, options.identity, { captured });
        return opened;
      };
      return Reflect.get(target, property);
    },
  });
  _deliverySync = require('../conversation/local-delivery-sync').create({
    notify: handle => _push(BrowserWindow, handle, { kind: 'delivery-sync' }, handle.snapshot()) });
  _cloudHandoff = require('../conversation/cloud-handoff-ipc').install({ app, ipcMain, session,
    identityOf: sendIdentityOf || identityOf,
    assertOwner: (identity, handle) => memories.assertOwner(identity, handle.sessionId),
    notify: (handle, touched) => _push(BrowserWindow, handle, touched, handle.snapshot()) });
  _cloudHandoff.onSynchronized(presence => {
    for (const win of BrowserWindow.getAllWindows()) {
      try { if (!win.isDestroyed()) win.webContents.send('pi-session-event', {
        kind: 'settled', sessionId: presence.id, ref: '', presence, cloudSynchronized: true,
      }); } catch (_) { /* A closing renderer does not own cloud execution. */ }
    }
  });
  if (app.isReady?.()) _cloudHandoff.synchronization.start();
  else app.on('ready', () => _cloudHandoff.synchronization.start());
  const accountSyncStore = require('../conversation/account-sync-store').createWorker(
    path.join(app.getPath('userData'), 'account-conversations-sync', 'outbox.json'));
  _sharedHistory = require('../conversation/shared-history.cjs').create({ app, session });
  session.setReplicaHistory?.(_sharedHistory);
  _accountSync = require('../conversation/account-sync').create({
    app, store: accountSyncStore, identityOf: sendIdentityOf || identityOf,
    localIdentityOf: async () => (sendIdentityOf || identityOf)(app),
    resolveNativeSource: (item, identity) => require('../conversation/account-native-source.cjs').resolve({ app, session, item, identity }),
    realtime: true, metadataOnly: true,
    preserveLegacyOutbox: (job, identity) => _sharedHistory.preserveLegacyOutbox(job, identity),
  });
  // Account-conversation WebSocket messages are invalidation hints, but they
  // still need to reach the renderer.  Without this bridge the sync service
  // refreshed its private cache while an already-open desktop projection and
  // the sidebar stayed stale until the user navigated away and back.
  _accountSync.onChange?.(async (conversationId, raw, projection) => {
    try {
      const id = String(conversationId || '');
      const runtime = require('../platform-connections/runtime.cjs');
      const currentOwner = async () => runtime.connectionScope(await (sendIdentityOf || identityOf)(app));
      if (!id || !projection?.owner || projection.owner !== await currentOwner()) return;
      const handle = session.findBySessionId(id);
      if (handle?.refresh) {
        const current = await handle.refresh();
        if (projection.owner !== await currentOwner()) return;
        if (current) _publish(BrowserWindow, handle, { kind: 'account-conversation-sync' }, handle.snapshot());
      }
      const presence = conversationTitles.decorate(_app, projection);
      require('../conversation/app-surfaces.cjs').all(BrowserWindow.getAllWindows()).forEach(win => {
        if (win.isDestroyed()) return;
        win.webContents.send('pi-session-event', {
          kind: Number(presence.lifecycleRevision || 0) > 0 ? 'history-lifecycle' : 'account-conversation-sync',
          ref: handle?.ref || '', sessionId: id, presence,
        });
      });
    } catch (_) {
      // The next normal history read remains authoritative if a window closes
      // while the best-effort realtime repaint is in flight.
    }
  });
  // The bridge historically accepted one external history provider. Keep the
  // cloud handoff provider and add the account projection without changing the
  // cloud authority or exposing account sync as a Runner.
  session.setExternalHistory?.({
    historyEntry(id) { return _cloudHandoff.historyEntry?.(id) || null; },
    async history(options) {
      const [cloud, account] = await Promise.allSettled([_cloudHandoff.history(options), _accountSync.history(options)]);
      const rows = [];
      if (cloud.status === 'fulfilled') rows.push(...(cloud.value.chats || []));
      if (account.status === 'fulfilled') rows.push(...(account.value.chats || []));
      const seen = new Set();
      return { ok: true, chats: rows.filter(row => row && row.id && !seen.has(row.id) && seen.add(row.id)),
        lifecycle: account.status === 'fulfilled' ? account.value.lifecycle || [] : [] };
    },
    isRemote(id) { return typeof _cloudHandoff.isRemote === 'function' && _cloudHandoff.isRemote(id); },
    forget(id) {
      if (typeof _accountSync.isAccountConversation === 'function' && _accountSync.isAccountConversation(id)) {
        return Promise.resolve({ ok: false, reason: '跨设备会话请在来源设备归档' });
      }
      return _cloudHandoff.forget(id);
    },
  });
  require('../access-control/preferences').install({ app, ipcMain, BrowserWindow, confirmFullAccess });
  require('../workspace/recent-workspace').install({ app, ipcMain });
  const newChatAccess = require('../access-control/new-chat-consent').create({ BrowserWindow, confirmFullAccess });
  newChatAccess.install(ipcMain);
  const memories = require('../conversation/session-memory').install({ app, ipcMain, dialog, BrowserWindow, identityOf });
  const startReceipts = require('./start-receipts.cjs').create({
    app, identityOf: sendIdentityOf || identityOf, request: taskInput.request,
  });
  _usage = usageReporter.createUsageReporter({ app, identityOf, onQuotaExceeded });
  _usage.flush().catch(() => {});
  const pluginDebug = require('../personal-plugin-debug-ipc').install({
    app, ipcMain, session, identityOf: sendIdentityOf || identityOf, skillDirs: () => skillRoots.discover(app),
    assertOwner: (identity, handle) => memories.assertOwner(identity, handle.sessionId),
    deviceGrants: () => capabilityGrantsOf ? capabilityGrantsOf(app) : [],
    managedInputsRoot: () => path.join(workDir(app), 'temp'),
  });
  require('./environment-ipc').install({
    app, ipcMain, session, identityOf, capabilityGrantsOf, _skillDirs, workDir, _saveConf, _conf,
  });
  const historyActions = require('./history-ipc').install({ app, ipcMain, session, BrowserWindow, dialog, shell,
    cloudHistory: _cloudHandoff, accountHistory: _accountSync, sharedHistory: _sharedHistory });
  require('../conversation/work-conversation-cards').install({ app, ipcMain, session, BrowserWindow,
    identityOf: sendIdentityOf || identityOf,
    newCwd: options => _newSessionCwd(app, 'chat-' + require('node:crypto').randomUUID(), options) });
  /*
   * Read fixed-name plugin drafts only from outputs of active registered sessions; never
   * accept renderer-supplied file paths.
   */
  pluginDraft.installIpc(ipcMain, session, app);
  async function openConversation(event, raw, expectedIdentity, automationContext) {
    const preview = require('../work-preview');
    const appRequest = raw?.appRequestId ? preview.appRequestContext(event, raw.appRequestId) : null;
    const appPluginId = appRequest?.pluginId || preview.appContextFor(event?.sender)?.pluginId || '';
    const preferences = require('../access-control/preferences');
    const automationAccess = require('../access-control/automation-access');
    if (event && !preferences.isTrusted(event)) return { ok: false, reason: '请在 SoduWork 工作区中打开对话' };
    const opts = automationAccess.apply(require('./task-access').withTaskAccessDefault(
      preferences.forNewChat(app, { ...(raw || {}) }, preferences.isTrusted(event))), automationContext);
    // Automation model selection is explicit in the schedule envelope. An
    // empty value deliberately follows the selected runtime's normal model
    // resolution; never inherit the last model from the ordinary composer.
    delete opts.appRequestId;
    let accessConsent = null;
    try {
      const historyAccess = require('../conversation/history-access');
      const requestActor = historyAccess.actor(app);
      const connectionOf = value => {
        try { return require('../platform-connections/runtime.cjs').connectionScope(value); }
        catch (_) { return ''; }
      };
      const failedClosures = new WeakMap();
      const closeFailedOpen = async (handle) => {
        if (!handle) return true;
        if (failedClosures.has(handle)) return failedClosures.get(handle);
        try { _discardRenderer(handle); } catch (_) { /* Continue with authoritative runtime cleanup. */ }
        _sessionOwners?.quarantine(handle);
        const closing = Promise.resolve().then(async () => {
          let confirmed = false;
          try { confirmed = typeof handle.close === 'function' && await handle.close() !== false; }
          catch (_) { /* Keep unconfirmed runtimes quarantined. */ }
          _sessionOwners?.closed(handle, confirmed);
          return confirmed;
        });
        failedClosures.set(handle, closing);
        return closing;
      };
      if (!opts.chatId && (Object.hasOwn(opts, 'accessDraftId') || Object.hasOwn(opts, 'accessConsentId'))) {
        accessConsent = newChatAccess.reserve(event, opts, expectedIdentity);
        delete opts.accessDraftId;
        delete opts.accessConsentId;
      }
      if (!opts.chatId && String(opts.adapterId || 'pi') === 'pi' &&
          typeof session.loadSdk === 'function') {
        Promise.resolve(session.loadSdk(app)).catch(() => {});
      }
      appRequest?.assertActive();
      // Local history can be read without reconnecting the Hub or resuming an
      // old account's execution process. Remote originals follow the usual path.
      // A downloaded source locator is not a native identity. Account and cloud
      // originals retain their authenticated opening and continuation paths.
      const resolvedLocal = opts.chatId && !_cloudHandoff.isRemote?.(opts.chatId) && _sharedHistory
        ? await _sharedHistory.resolve(opts.chatId) : null;
      const local = resolvedLocal && require('../conversation/shared-history.cjs').isLocalIdentity(resolvedLocal, opts.chatId)
        ? resolvedLocal : null;
      const openLocalHistory = async () => {
        const captured = historyAccess.actor(app);
        if (local) {
          if (local.deleted) return { ok: false, notFound: true, reason: '这条会话已经不存在了' };
          const old = session.findBySessionId(local.id);
          if (old?.inFlight?.()) return { ok: false, reason: '这条会话还在执行，完成或停止后再操作' };
          if (old && await old.close() === false) return { ok: false, reason: '会话仍在关闭，请稍后重试' };
          const projection = await _sharedHistory.open(local.id);
          if (projection) {
            const handle = session.attachView(projection);
            if (captured.identity && captured.owner) _sessionOwners?.bind(handle, captured.identity);
            if (event) _attach(handle, require('../conversation/app-surfaces.cjs').forSender(BrowserWindow, event.sender));
            else _detach(handle);
            _wire(BrowserWindow, handle);
            return _openReply(handle, { resumed: true, attached: true, localReplica: true });
          }
        }
        return { ok: false, notFound: true, reason: '这条会话已经不存在了' };
      };
      let nativeLocal = false;
      if (local) {
        let executable = true;
        try { historyAccess.assertOwner(app, opts.chatId, historyAccess.actor(app), local); }
        catch (_) { executable = false; }
        if (local.deleted || local.cached || !executable) return await openLocalHistory();
        // Canonical local identity wins over stale renderer projection flags.
        nativeLocal = true;
        Object.assign(opts, { adapterId: local.adapterId || 'pi',
          accountConversation: false, accountProjection: false });
      }
      let identity;
      try { identity = await identityOf(app); }
      catch (error) {
        if (local && !automationContext && !expectedIdentity) return await openLocalHistory();
        throw error;
      }
      if (!identity && local && !automationContext && !expectedIdentity) return await openLocalHistory();
      appRequest?.assertActive();
      if (!identity) return { ok: false, reason: '这台电脑还没连上 SoduWork 后台（先打开桌宠登录一次）' };
      historyAccess.assertCurrent(app, requestActor, identity);
      const historyActor = historyAccess.actor(app, identity);
      const openingConnection = connectionOf(identity);
      const assertHistoryCurrent = async () => {
        const current = await identityOf(app);
        historyAccess.assertCurrent(app, historyActor, current);
        if (expectedIdentity && (!openingConnection || connectionOf(current) !== openingConnection))
          throw Error('连接环境已切换，本次自动化未启动');
        return current;
      };
      if (automationContext) automationAccess.assertCurrent(automationContext, identity);
      if (expectedIdentity && (!openingConnection || openingConnection !== connectionOf(expectedIdentity))) {
        return { ok: false, reason: '连接环境已切换，本次自动化未启动' };
      }
      const selectNativeSource = async native => {
        await assertHistoryCurrent();
        // A previously attached account projection may have hidden an archive
        // while local history was unavailable. Retire only that passive view;
        // an existing execution runtime must be reattached below, never closed.
        const views = new Set([opts.chatId, native.id].map(id => session.findBySessionId(id)));
        for (const view of views) {
          if (view?.adapterId !== 'account-sync') continue;
          if (view.inFlight?.()) throw Error('这条会话还在执行，完成或停止后再操作');
          if (!await closeFailedOpen(view)) throw Error('会话仍在关闭，请稍后重试');
          await assertHistoryCurrent();
        }
        nativeLocal = true;
        Object.assign(opts, { chatId: native.id, adapterId: native.adapterId || 'pi',
          accountConversation: false, accountProjection: false });
      };
      const selectedLive = opts.chatId && session.findBySessionId(opts.chatId);
      if (opts.chatId && (!selectedLive || selectedLive.adapterId === 'account-sync') &&
          typeof _accountSync !== 'undefined' && _accountSync?.isAccountConversation?.(opts.chatId)) {
        const item = await _accountSync.row(opts.chatId);
        await assertHistoryCurrent();
        if (item?.deleted) return { ok: false, notFound: true, reason: '这条会话已经不存在了' };
        const native = await require('../conversation/account-native-source.cjs').resolve({ app, session, item, identity });
        await assertHistoryCurrent();
        if (native) await selectNativeSource(native);
      }
      // Resolve account aliases before choosing a live handle or native archive.
      // A source alias may already equal the native ID after an earlier lookup;
      // equality is not evidence that this conversation must stay read-only.
      if (opts.chatId && !nativeLocal && (!selectedLive || selectedLive.adapterId === 'account-sync') &&
          typeof _accountSync !== 'undefined' && typeof _accountSync?.openProjection === 'function') {
        const projection = await _accountSync.openProjection(opts.chatId).catch(() => null);
        if (projection) {
          await assertHistoryCurrent();
          const item = projection.historyRow?.();
          if (item?.deleted) return { ok: false, notFound: true, reason: '这条会话已经不存在了' };
          const native = await require('../conversation/account-native-source.cjs').resolve({
            app, session, item, identity });
          await assertHistoryCurrent();
          if (native) await selectNativeSource(native);
          else if (!session.findBySessionId(opts.chatId)) {
            const handle = session.attachView(projection);
            _sessionOwners?.bind(handle, identity, { connection: true });
            if (event) _attach(handle, require('../conversation/app-surfaces.cjs').forSender(BrowserWindow, event.sender));
            else _detach(handle);
            _wire(BrowserWindow, handle);
            return _openReply(handle, { resumed: true, attached: true, accountConversation: true });
          }
        }
      }
      // Start the SDK/model work while local capability policy and Skill
      // discovery are being resolved. `prewarm` shares model-config's pending
      // request, so session.open will await the same result instead of
      // issuing a second request. A failure is intentionally left to
      // session.open, which can return the user-facing reason.
      if (!opts.chatId && String(opts.adapterId || 'pi') === 'pi' && typeof session.prewarm === 'function') {
        Promise.resolve(session.prewarm(app, identity, String(opts.modelName || '')))
          .catch(() => {});
      }
      /* Reconnect to the existing in-memory session when opening active history; never start a duplicate runtime. */
      if (opts.chatId) {
        const live = session.findBySessionId(opts.chatId);
        if (live) {
          try {
          // Reattaching a requirement projection must recheck Hub ownership;
          // an existing local view is not authority for remote access.
          await _cloudHandoff.refreshTaskExecution?.(opts.chatId, true);
          // A live handle is already attached to this device and must keep the
          // strict memory binding check. Archived history is different: the
          // device session can be in the middle of renewal, so checking its
          // optional memory binding before locating the transcript would make
          // an otherwise valid conversation impossible to open.
          memories.assertOwner(identity, opts.chatId);
          require('../conversation/requirement-context').assertOwner(app, live, identity);
          await require('../conversation/acceptance-session').attach(app, live, { resumed: true }, identity);
          await assertHistoryCurrent();
          require('../conversation/acceptance-session').assertTask(live, opts.taskRef);

          const requestedTaskId = String(opts.taskRef || '').trim();
          const liveTaskIds = new Set([
            ...(Array.isArray(live.taskIds) ? live.taskIds : []),
            ...(Array.isArray(live.taskBindings) ? live.taskBindings.map((item) => item && (item.taskId || item.id)) : []),
            String(live.taskRef || ''),
          ].map((item) => String(item || '').trim()).filter(Boolean));
          if (requestedTaskId && !liveTaskIds.has(requestedTaskId) && typeof live.bindTask === 'function') {
            await require('../conversation/requirement-context').checkBinding({ app, handle: live, identity,
              identityOf: () => (sendIdentityOf || identityOf)(app) },
              requestedTaskId, route => taskInput.request(identity, route));
            await assertHistoryCurrent();
            const bound = await live.bindTask(requestedTaskId, opts.taskTitle);
            await assertHistoryCurrent();
            if (!bound || bound.ok === false) return bound || { ok: false, reason: "需求会话绑定失败" };
          }
          const boundTaskIds = new Set([
            ...liveTaskIds,
            ...(Array.isArray(live.taskIds) ? live.taskIds : []),
            ...(Array.isArray(live.taskBindings) ? live.taskBindings.map((item) => item && (item.taskId || item.id)) : []),
            String(live.taskRef || ''),
          ].map((item) => String(item || '').trim()).filter(Boolean));
          if (!opts.requireTaskBinding || !requestedTaskId || boundTaskIds.has(requestedTaskId)) {
            await assertHistoryCurrent();
            require('./app-mcp-grant.cjs').bind(live, event?.sender, appPluginId, app, { identityOf: sendIdentityOf || identityOf });
            _bindUsage(live, identity, live.usageAgentKey || opts.adapterId || 'pi');
            if (event) _attach(live, require('../conversation/app-surfaces.cjs').forSender(BrowserWindow, event.sender));
            else _detach(live);
            _wire(BrowserWindow, live);
            _cloudHandoff.observe(live);
            return _openReply(live, { resumed: true, attached: true, seeded: 0 });
          }
          } catch (error) {
            // Reattaching must never destroy a runtime that was already live.
            _discardRenderer(live);
            throw error;
          }
        }
      }
      // Account projections are read-only views and are not registered Agent
      // adapters. Never pass a stale projection row to session.open: that
      // would turn a recoverable history miss into an adapter-not-registered
      // error page. The sidebar can refresh the authenticated directory and
      // retry the projection without creating a duplicate local session.
      if (opts.chatId && (String(opts.adapterId || '').toLowerCase() === 'account-sync' ||
          opts.accountConversation === true || opts.accountProjection === true)) {
        return { ok: false, notFound: true,
          reason: '账号会话暂时无法读取，请刷新历史后重试' };
      }
      if (opts.chatId && typeof _cloudHandoff.reopen === 'function') {
        const remote = await _cloudHandoff.reopen(opts.chatId,
          'cloud-' + require('node:crypto').randomUUID());
        if (remote) {
          try {
            const current = await assertHistoryCurrent();
            if (!openingConnection || connectionOf(current) !== openingConnection)
              throw Error('账号或服务已切换，请在当前连接重新打开会话');
          }
          catch (error) {
            await closeFailedOpen(remote);
            throw error;
          }
          let handle;
          try {
            handle = session.attachView(remote);
            _sessionOwners?.bind(handle, identity, { connection: true });
            if (event) _attach(handle, require('../conversation/app-surfaces.cjs').forSender(BrowserWindow, event.sender)); else _detach(handle);
            _wire(BrowserWindow, handle);
            return _openReply(handle, { resumed: true, attached: true, cloud: true });
          } catch (error) {
            if (handle) await closeFailedOpen(handle);
            else await closeFailedOpen(remote);
            throw error;
          }
        }
      }
      /* Resume the archive identified by the selected history entry. */
      // Existing sessions stay attachable during maintenance; new runtimes remain blocked.
      const maintenance = updateWorkloads.guard();
      if (!maintenance.ok) return maintenance;
      // Start policy, Skill discovery and local capability checks before the
      // archive/attachment work below. The same promise is awaited after
      // those local steps, so a new chat does not serialize policy latency
      // ahead of every other preparation task.
      const skillDirs = _skillDirs(app);
      const capabilityPromise = capabilities.resolve({
        app,
        identity,
        skillDirs,
        requested: Array.isArray(opts.capabilities) ? opts.capabilities : undefined,
        deviceGrants: capabilityGrantsOf ? capabilityGrantsOf(app) : [],
        selectedSkills: Array.isArray(opts.skills) ? opts.skills : [],
      });
      // The native consent dialog can outlive capability discovery. Observe a
      // rejection now; the awaited original promise still reports it below.
      capabilityPromise.catch(() => {});
      let resume = null;
      if (opts.chatId) {
        // Opening one identity must not refresh every adapter's sidebar first.
        if (typeof session.archivedConversation === 'function') {
          resume = await session.archivedConversation(app, opts.chatId);
        } else {
          const got = await session.history(app, Number.MAX_SAFE_INTEGER);
          resume = ((got && got.chats) || []).find((c) => c.id === opts.chatId) || null;
        }
        await assertHistoryCurrent();
        if (!resume) {
          await capabilityPromise.catch(() => {});
          return { ok: false, notFound: true, reason: '这条对话找不到了（存档可能已被清理）' };
        }
        const ownerOptions = historyAccess.isOwnerlessNativeArchive(resume) ? { allowLegacy: true } : {};
        historyAccess.assertOwner(app, opts.chatId, historyAccess.actor(app, identity), resume, ownerOptions);
      }
      const workOpening = require('../conversation/work-conversation-opening');
      const work = workOpening.prepare(app, opts, resume, identity, preferences.isTrusted(event), session);
      if (work.first) opts.accessMode = work.accessOptions.accessMode;
      if (opts.chatId && (Object.hasOwn(opts, 'accessDraftId') || Object.hasOwn(opts, 'accessConsentId'))) {
        accessConsent = newChatAccess.reserve(event, work.accessOptions, expectedIdentity);
        delete opts.accessDraftId; delete opts.accessConsentId;
      }
      if (resume?.adapterId && !work.first) opts.adapterId = resume.adapterId;
      if (resume && (String(opts.adapterId || '').toLowerCase() === 'account-sync' ||
          resume.accountConversation === true || resume.accountProjection === true)) {
        return { ok: false, notFound: true,
          reason: '账号会话暂时无法读取，请刷新历史后重试' };
      }
      // History links can omit the Agent or carry a stale composer choice.
      // Resolve the archived identity first, then warm only its actual runtime.
      if (resume && String(opts.adapterId || 'pi') === 'pi' && typeof session.prewarm === 'function') {
        Promise.resolve(session.prewarm(app, identity, String(opts.modelName || ''))).catch(() => {});
      }
      const ref = 'chat-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
      // Remote continuation must not silently move a native session into the
      // default workspace when its original directory is unavailable.
      if (opts.nativeRelay === true && resume) {
        require('./resume-cwd')(app, resume, () => {
          throw Error('原会话工作目录不可用，请在来源电脑恢复目录后重试');
        });
      }
      // Existing conversations keep their persisted directory. A missing local
      // directory retains the established recovery fallback; new drafts choose.
      const cwd = resume
        ? require('./resume-cwd')(app, resume, _defaultCwd)
        : _newSessionCwd(app, ref, opts);
      const permitted = await workOpening.applyPolicy({ app, event, options: opts, resume, work, cwd,
        automationContext, accessConsent, BrowserWindow, confirmFullAccess });
      if (!permitted.ok) { await capabilityPromise.catch(() => {}); return permitted; }
      // A per-chat scratch directory is not a reusable engineering workspace.
      const scratchRoot = path.resolve(workDir(app), 'temp');
      const memoryRelativeCwd = path.relative(scratchRoot, path.resolve(cwd));
      const scratchCwd = !memoryRelativeCwd || (!memoryRelativeCwd.startsWith('..' + path.sep) && memoryRelativeCwd !== '..' && !path.isAbsolute(memoryRelativeCwd));
      const memoryOptions = { ...opts, cwd, workspaceExplicit: !scratchCwd, resumed: Boolean(resume) };
      const memoryContextPromise = memories.context(identity, memoryOptions);
      // Start optional memory lookup alongside attachment/capability preparation.
      memoryContextPromise.catch(() => {});
      const inputDir = opts.cwd ? path.join(workDir(app), 'temp', ref, '.soduwork-inputs') : '';
      const staged = resume ? { files: [], warnings: [] }
        : await attachments.stage(cwd, opts.attachments, { stagingDir: inputDir });
      const resolved = await capabilityPromise;
      const explicitMissing = (resolved.catalog.businessSkills || []).filter((item) =>
        resolved.selectedSkills.includes(item.name) && !item.installed);
      if (explicitMissing.length) {
        return {
          ok: false,
          reason: '本次选择的 Skill 没有在当前电脑完成安装：' +
            explicitMissing.map((item) => item.name).join('、') +
            '。请检查后台连接后重试。',
        };
      }
      const memoryContext = await memoryContextPromise;
      const spec = sessionSpec.build({ ...opts, cwd }, resolved, {
        cwd,
        readOnly: (_conf().mode || 'full') === 'readonly',
      });
      if (automationContext) automationAccess.assertCurrent(automationContext, await identityOf(app));
      if (event && !preferences.isTrusted(event)) return { ok: false, reason: '请在 SoduWork 工作区中打开对话' };
      accessConsent?.assertValid();
      let automationPluginLock = expectedIdentity ? opts.pluginLock : null;
      const editSource = opts.pluginEditId && !opts.chatId ? await require('../jiyong-edit-source.cjs').prepare({
        app,identityOf,pluginId:opts.pluginEditId,cwd:spec.cwd,readOnly:spec.readOnly,
      }) : null;
      let openingTimedOut = false;
      const openingPromise = Promise.resolve().then(async () => {
        await assertHistoryCurrent();
        if (opts.chatId) {
          const ownerOptions = historyAccess.isOwnerlessNativeArchive(resume) ? { allowLegacy: true } : {};
          historyAccess.assertOwner(app, opts.chatId, historyActor, resume, ownerOptions);
        }
        accessConsent?.assertValid();
        return session.open({
        app, identity, cwd: spec.cwd, ref, runtimeConversationId: resume?.runtimeConversationId,
        workConversation: work.bootstrap,
        workConversationId: work.first ? resume.id : undefined,
        validateWorkConversation: work.first ? () => work.validate({ event, identityOf: sendIdentityOf || identityOf,
          request: route => taskInput.request(identity, route) }) : undefined,
        adapterId: String(opts.adapterId || 'pi'),
        readOnly: spec.readOnly,
        accessPolicy: spec.accessPolicy,
        skillDirs: spec.skillDirs, optionalSkillDirs: spec.optionalSkillDirs,
        resolveSkills: skillTurn.resolver({ app, identity, identityOf: sendIdentityOf || identityOf,
          skillDirs: () => _skillDirs(app) }),
        resolveConnectors: require('../conversation-connectors.cjs').resolver({ app, identity, identityOf: sendIdentityOf || identityOf,
          ref, allowed: (resolved.skills || []).some(row => row.name === 'mcp-tools'), explicitlySelected: spec.selectedSkills.includes('mcp-tools') }),
        taskRef: spec.taskRef, taskTitle: spec.taskTitle,
        ...(resume?.title || opts.sessionTitle ? { sessionTitle: String(resume?.title || opts.sessionTitle).replace(/\s+/g, ' ').trim().slice(0, 240) } : {}),
        ...(opts.projectId ? { projectId: String(opts.projectId).trim().slice(0, 36) } : {}),
        ...(opts.repoId ? { repoId: String(opts.repoId).trim().slice(0, 36) } : {}),
        // A never-bound Pi draft can create its first binding only after its
        // saved creation receipt and current Hub ownership/state are verified.
        // Established archives still require their persisted task binding.
        requireTaskBinding: Boolean(opts.requireTaskBinding) && !work.bindCreatedTask,
        thinkingLevel: spec.thinkingLevel,
        ...(typeof opts.modelName === 'string' ? { modelName: spec.modelName } : {}),
        reasoningEffort: spec.reasoningEffort,
        intent: spec.intent,
        goal: spec.goal,
        acceptance: spec.acceptance,
        budgetMinutes: spec.budgetMinutes,
        maxSteps: spec.maxSteps,
        capabilityIds: spec.capabilityIds,
        resolvePlugins: async (pluginIds, projectId, turnContext) => {
          if (automationPluginLock && pluginIds.includes(automationPluginLock.pluginId)) {
            const installed = automationPluginLock.pluginId.startsWith('local:')
              ? require('../personal-plugins').get(app, automationPluginLock.pluginId)
              : await require('../app-installed-remote.cjs').get({app,identityOf},automationPluginLock.pluginId);
            if (!installed.enabled || installed.version !== automationPluginLock.version || installed.checksum !== automationPluginLock.checksum) {
              throw new Error('自动化所选插件已变化，请重新确认插件版本后执行');
            }
          }
          const appContext = await require('./app-mcp-grant.cjs').forSession(session.get(ref));
          const grants = await pluginGrant.resolve({ app, identityOf, appContext,
            allowUnavailableApp: turnContext?.allowUnavailableApp === true && !automationPluginLock,
            ref: session.get(ref)?.sessionId || ref, pluginIds, projectId, cwd: spec.cwd });
          automationPluginLock = null;
          return grants;
        },
        inputAttachments: staged.files,
        contextPrompts: [
          ...(resolved.capabilityIds.includes('browser') ? [
            '【Browser Use 会话】本次隔离浏览器会话 ID：' + ref +
            '。调用 browser.mjs 时每条命令末尾都追加 --session ' + ref +
            '；后续操作当前页面时 URL 写 current。任务完成后执行 close。' +
            '不要连接或接管用户自己已打开的浏览器。',
          ] : []),
          ...(resolved.selectedSkills && resolved.selectedSkills.length ? [
            '【本次明确选用的 Skill】' + resolved.selectedSkills.join('、') +
            '。若任务匹配，请优先遵循这些 Skill；仍须以已加载的 SKILL.md 为准。',
          ] : []),
          ..._entryContextPrompts(opts.contextPrompts),
          ...(editSource ? [editSource.guide] : []),
          ...(memoryContext.prompt ? [memoryContext.prompt] : []),
          ...(staged.files.length ? [attachments.prompt(staged.files)] : []),
        ],
        resumePath: resume && !work.bootstrap ? resume.path : '',
        /*
         * Track whether opening resumes a conversation even without a native archive path; output
         * and draft discovery then use conversation time boundaries.
         */
        resumedConversation: Boolean(resume && !work.bootstrap),
        /* SDK uses the validated directory; the archive path remains separate. */
        resumeCwd: resume ? cwd : '',
        resumeAt: resume ? resume.at : 0,
        // Historical archives must paint immediately. Third-party extensions
        // are loaded serially by the SDK and one stalled extension used to
        // leave this IPC call pending forever. The first actual send restores
        // deferred tools at an idle boundary when the access policy permits it.
        noExtensions: Boolean(resume && opts.loadExtensions !== true),
        resourceLoadTimeoutMs: opts.resourceLoadTimeoutMs,
        });
      });
      // The reservation and immediate rollback share one cleanup promise so
      // finalization failures cannot close a runtime twice or leak late views.
      accessConsent?.track(openingPromise.then(result => result?.ok && result.session
        ? { ...result, session: { close: () => closeFailedOpen(result.session) } } : result));
      // The SDK has no cancellation token. If it returns after the watchdog,
      // close the late session immediately so a retry cannot create a hidden
      // duplicate runtime.
      openingPromise.then((late) => {
        if (accessConsent || !openingTimedOut || !late || !late.ok || !late.session) return;
        return closeFailedOpen(late.session);
      }).catch(() => {});
      let opened;
      try {
        opened = await _awaitBounded(openingPromise, OPEN_TIMEOUT_MS, '执行底座初始化超时');
      } catch (error) {
        openingTimedOut = error && error.code === 'SODUWORK_OPEN_TIMEOUT';
        if (openingTimedOut) return { ok: false, reason: '执行底座初始化超过 45 秒没有响应，请重试' };
        throw error;
      }
      if (!opened.ok) return opened;
      try {
        await assertHistoryCurrent();
        if (opts.chatId) {
          const ownerOptions = historyAccess.isOwnerlessNativeArchive(resume) ? { allowLegacy: true } : {};
          historyAccess.assertOwner(app, opts.chatId, historyActor, resume, ownerOptions);
        }
        await require('../conversation/acceptance-session').attach(app, opened.session,
          resume ? { resumed: true } : { ...opts, resumed: false }, identity);
        accessConsent?.assertValid();
        opened.session.ui = {
          mode: spec.readOnly ? 'readonly' : 'full',
          capabilities: resolved.capabilities,
          skills: (resolved.skills || []).filter(item => !Array.isArray(opened.session.skills) || opened.session.skills.includes(item.name)),
          selectedSkills: resolved.selectedSkills,
          inputAttachments: staged.files,
          attachmentWarnings: staged.warnings,
        };
        await memories.attach(opened.session, identity, memoryContext, [...spec.warnings, ...(opened.session.skillWarnings || [])], memoryOptions);
        require('../conversation/requirement-context').assertOwner(app, opened.session, identity);
        accessConsent?.assertValid();
        await assertHistoryCurrent();
        require('./app-mcp-grant.cjs').bind(opened.session, event?.sender, appPluginId, app, { identityOf: sendIdentityOf || identityOf });
        _bindUsage(opened.session, identity, opts.adapterId || 'pi');
        if (event) _attach(opened.session, require('../conversation/app-surfaces.cjs').forSender(BrowserWindow, event.sender));
        else _detach(opened.session);
        _wire(BrowserWindow, opened.session);
        _cloudHandoff.observe(opened.session);
        appRequest?.assertActive();
        const reply = _openReply(opened.session, { resumed: !!resume, seeded: opened.seeded || 0 });
        accessConsent?.commit();
        return reply;
      } catch (error) {
        await closeFailedOpen(opened.session);
        throw error;
      }
    } catch (e) {
      return { ok: false, reason: '起会话失败：' + String((e && e.message) || e) };
    } finally {
      accessConsent?.finish();
    }
  }
  ipcMain.handle('pi-session-open', (event, raw) => openConversation(event, raw));
  /*
   * Immediate automation runs are opened by the schedule renderer after the Hub
   * has durably claimed the occurrence.  Keep the renderer's trusted event (so
   * access consent can still be shown), but bind the opening request to the
   * current device identity.  The identity is what makes a personal-plugin
   * lock authoritative in `openConversation`; a plain pi-session-open call has
   * no expected identity and consequently drops pluginLock before the first
   * turn.
   */
  ipcMain.handle('pi-session-automation-open', async (event, raw) => {
    const identity = await identityOf(app);
    if (!identity) return { ok: false, reason: '请先连接 SoduWork 服务并登录' };
    return openConversation(event, raw, identity);
  });
  /*
   * Acknowledge prompt acceptance immediately; publish long-running progress and results
   * through pi-session-event.
   */

  ipcMain.handle('pi-session-bind-task', async (event, ref, rawTaskId, rawTitle) => {
    const s = session.get(ref);
    if (!s) return { ok: false, reason: "这条会话已经不在了（可能已关闭）" };
    if (typeof s.bindTask !== 'function') {
      return { ok: false, reason: "当前客户端不支持需求会话绑定" };
    }
    try {
      const identity = await (sendIdentityOf || identityOf)(app);
      if (!identity) return { ok: false, reason: '请先连接 SoduWork 服务并登录' };
      const owner = s.usageIdentity;
      if (owner && (owner.hub !== identity.hub || owner.clientId !== identity.clientId))
        return { ok: false, reason: '账号或服务已变化，请重新打开这条对话' };
      memories.assertOwner(identity, s.sessionId);
      await require('../conversation/acceptance-session').attach(app, s, { resumed: true }, identity);
      require('../conversation/acceptance-session').assertTask(s, rawTaskId);
      await require('../conversation/requirement-context').checkBinding({ app, handle: s, identity,
        identityOf: () => (sendIdentityOf || identityOf)(app) },
        rawTaskId, route => taskInput.request(identity, route));
      if (session.get(ref) !== s) throw Error('账号已切换，请重新打开会话');
      return await Promise.resolve(s.bindTask(rawTaskId, rawTitle));
    } catch (error) {
      return { ok: false, reason: "需求会话绑定失败：" + String((error && error.message) || error) };
    }
  });

  async function sendConversation(ref, text, rawAttachments, rawOptions, observe, appRequest) {
    appRequest?.assertActive();
    const skillTurn = require('./skill-turn');
    const maintenance = updateWorkloads.guard();
    if (!maintenance.ok) return maintenance;
    const s = session.get(ref);
    if (!s) return { ok: false, code: 'SESSION_NOT_FOUND', notSent: true, reason: '这条对话已经不在了（可能已关闭）' };
    let selectedSkills;
    try { selectedSkills = skillTurn.names(rawOptions?.skills); }
    catch (error) { return skillTurn.failure(error); }
    let pluginInputs = [];
    try {
      const rows = Array.isArray(rawOptions?.plugins) ? rawOptions.plugins : [];
      if (rows.some(row => row?.inputValues && typeof row.inputValues === 'object')) {
        pluginInputs = require('./plugin-context').inputSelections(rows, rows.map(row => row?.pluginId));
      }
    } catch (error) { return { ok: false, reason: error.message }; }
    let currentIdentity;
    try {
      // Memory ownership requires the current account's signed session. Device
      // credentials alone omit that account and incorrectly reject logged-in users.
      // The strict resolver reuses valid tokens; only renewal needs the network.
      const current = await (sendIdentityOf || identityOf)(app);
      appRequest?.assertActive();
      if (!current) return { ok: false, reason: '请先连接 SoduWork 服务并登录' };
      // Same-account environment changes do not invalidate access solely through usageIdentity's Hub and client fields.
      // Enforce account isolation through assertOwner fingerprints from memory and requirement bindings.
      memories.assertOwner(current, s.sessionId);
      require('../conversation/requirement-context').assertOwner(app, s, current);
      await require('../conversation/acceptance-session').attach(app, s, { resumed: true }, current);
      const acceptance = require('../conversation/acceptance-session').assertTask(s, rawOptions?.taskId);
      if (acceptance) rawOptions = { ...(rawOptions || {}), taskId: acceptance.taskRef,
        taskExecution: { acceptanceOnly: true, acceptanceMode: acceptance.acceptanceMode, approvalId: acceptance.approvalId,
          ...(acceptance.acceptanceAttachmentIds ? { acceptanceAttachmentIds: acceptance.acceptanceAttachmentIds } : {}) } };
      else if (rawOptions?.taskExecution?.acceptanceOnly) {
        if (rawOptions?.taskExecution?.acceptanceExecutionSession !== true)
          throw Error('请从需求验收入口新建验收会话');
        /*
         * Reused execution conversations may review only their already-bound requirement; renderer
         * acceptanceOnly markers cannot authorize unrelated artifact reads.
         */
        const requestedTask = String(rawOptions?.taskId || '').trim();
        const boundIds = new Set([
          s.taskRef, s.taskId, s.activeTaskId, ...(s.taskIds || []),
          ...(s.taskBindings || []).map(row => row && (row.taskId || row.id)),
        ].map(value => String(value || '').trim()).filter(Boolean));
        if (!requestedTask || !boundIds.has(requestedTask))
          throw Error('原执行会话尚未绑定这项需求，请从需求验收入口重新打开');
      }
      currentIdentity = current;
    } catch (error) { return { ok: false, reason: String(error.message || error) }; }
    try {
      if (session.get(ref) !== s) throw Error('账号已切换，请重新打开会话');
      if (_cloudHandoff.guard(s)) return await _cloudHandoff.send(s, text, rawAttachments, rawOptions || {});
    } catch (error) { return { ok: false, reason: String(error.message || error) }; }
    // Scheduled automation is an ordinary one-turn conversation even when the
    // selected personal plugin happens to be a workflow package.  The debug
    // bridge owns an interactive plugin-debug run and would otherwise hijack
    // the automation prompt into the AI execution/workflow path.  Keep that
    // bridge for user initiated plugin conversations only.
    const automationTurn = rawOptions?.source === 'automation';
    const debugBlocked = automationTurn ? '' : pluginDebug.guard(s);
    if (debugBlocked) return { ok: false, reason: debugBlocked };
    let taskTurn = null;
    const taskId = String(rawOptions && rawOptions.taskId || '').trim().slice(0, 120);
    const followUpTurn = !!(rawOptions && rawOptions.taskExecution && rawOptions.taskExecution.followUp === true);
    if (taskId) {
      try {
        taskTurn = await taskInput.prepare(currentIdentity, taskId, s.sessionId,
          String(rawOptions.submissionId || '').slice(0, 120), text, rawOptions.taskExecution,
          { app, handle: s, workRoot: workDir(app), startReceipts, identityOf: async () => {
            const fresh = await (sendIdentityOf || identityOf)(app);
            await require('../conversation/acceptance-session').attach(app, s, { resumed: true }, fresh);
            return fresh;
          } });
        text = taskTurn.displayText ?? taskTurn.text;
        // Stage requirement materials and current attachments together, preserving distinct files even when names match.
        rawAttachments = (taskTurn.attachments || []).concat(Array.isArray(rawAttachments) ? rawAttachments : []);
      } catch (error) {
        // Only an explicitly finished task permits an ordinary follow-up without a receipt.
        // Active receipts, permission failures and network errors must not lose task delivery silently.
        if (!followUpTurn || error.code !== 'TASK_FINISHED' || rawOptions.taskExecution?.executionChoice === 'native') return { ok: false, reason: String(error.message || error) };
        console.warn('[task-input] 续轮收据未挂上，按普通会话发送：' + String((error && error.message) || error));
        taskTurn = null;
      }
    }
    // Review analysis may read requirement context and attachments without creating execution receipts or changing task state.
    // taskTurn supplies context without classifying ordinary analysis as execution.
    // Enable taskLifecycle callbacks only for actual requirement-execution turns.
    const taskLifecycle = Boolean(taskTurn && taskTurn.acceptanceOnly !== true);
    const inputDir = path.join(workDir(app), 'temp', ref, '.soduwork-inputs');
    const staged = await attachments.stage(s.cwd, rawAttachments, { stagingDir: inputDir });
    if (staged.warnings.length && (taskId || !staged.files.length)) {
      if (taskTurn?.afterTurn) await taskTurn.afterTurn('stopped').catch(() => {});
      return { ok: false, reason: staged.warnings[0] };
    }
    /* Renderer may select plugin ids, but it never supplies executable guidance
       or authorization context. The main process resolves every id again when
       the turn actually starts (including queued turns). */
    // Own-app identity comes from the verified native composer, never page text.
    // Renderer plugin objects/ids remain selection keys, not executable guidance.
    const rawPluginObjects = Array.isArray(rawOptions && rawOptions.plugins)
      ? rawOptions.plugins : [];
    const rawPluginIds = Array.isArray(rawOptions && rawOptions.pluginIds)
      ? rawOptions.pluginIds : [];
    const ownAppId = require('./app-mcp-grant.cjs').nativePluginId(s);
    const selectedPluginIds = (rawPluginObjects.length ? rawPluginObjects : rawPluginIds)
      .map(item => String(item?.pluginId || item || '').trim()).filter(Boolean);
    let selectedAppId;
    try {
      selectedAppId = ownAppId ? await require('../app-conversation-connection.cjs').association(app, selectedPluginIds, { identityOf: sendIdentityOf || identityOf }) : '';
      if (session.get(ref) !== s) throw Error('账号已切换，请重新打开会话');
    } catch (error) { return { ok: false, reason: error.message }; }
    const rawPluginSource = [...(ownAppId && !selectedAppId ? [ownAppId] : []), ...(rawPluginObjects.length ? rawPluginObjects : rawPluginIds)];
    const pluginIds = [...new Set(rawPluginSource.map((item) => {
      if (item && typeof item === 'object') return String(item.pluginId || '').trim();
      return String(item || '').trim();
    }).filter(Boolean))].slice(0, 3);
    const clearPluginSelection = Boolean(rawOptions &&
      (rawOptions.clearPluginSelection === true || rawOptions.pluginSelection === 'clear'));
    const sendOptions = {
      ...(taskTurn?.acceptanceOnly ? { beforeTurn: taskTurn.beforeTurn, afterTurn: taskTurn.afterTurn,
        promptText: taskTurn.text } : {}),
      ...(taskLifecycle ? { taskId, taskTitle: taskTurn.task.title || '',
        beforeTurn: taskTurn.beforeTurn, afterTurn: taskTurn.afterTurn, beforeRetry: taskTurn.beforeRetry,
        ...(taskTurn.onStarted ? { onStarted: taskTurn.onStarted } : {}), retry: rawOptions.retry === true,
        executor: taskTurn.executor, controlled: taskTurn.controlled,
        ...(typeof taskTurn.modelName === 'string' ? { modelName: taskTurn.modelName } : {}) } : {}),
      pluginIds,
      pluginInputs,
      ...(clearPluginSelection ? { clearPluginSelection: true } : {}),
      skills: selectedSkills,
      sentAt: Number.isFinite(rawOptions?.sentAt) && rawOptions.sentAt > 0 ? Math.min(rawOptions.sentAt, Date.now()) : Date.now(),
      projectId: String(taskTurn ? taskTurn.task.projectId || '' : rawOptions && rawOptions.projectId || '').slice(0, 36),
      repoId: String(taskTurn ? taskTurn.task.repoId || '' : rawOptions && rawOptions.repoId || '').slice(0, 36),
      submissionId: String(rawOptions && rawOptions.submissionId || '')
        .replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64),
    };
    if (typeof authorizeAI === 'function') {
      // Pi can attribute personal funding per call. Other runtimes retain the
      // strict account gate until they provide equally reliable usage receipts.
      const agent = s.adapterId || 'pi';
      const modelMode = require('../agent-runtime/runtime-catalog').runtime(agent)?.modelMode;
      sendOptions.beforeTurn = require('../conversation/quota-admission.cjs').beforeTurn(
        authorizeAI, currentIdentity, sendOptions.beforeTurn, { agent, modelMode, controlled: Boolean(sendOptions.controlled) });
    }
    let workflowTurn;
    try {
      if (session.get(ref) !== s) throw Error('账号已切换，请重新打开会话');
      await require('./app-mcp-grant.cjs').guardSend(s, sendOptions);
      if (session.get(ref) !== s) throw Error('账号已切换，请重新打开会话');
    }
    catch (error) { return { ok: false, reason: error.message }; }
    try {
      if (typeof rawOptions?.nativeRelayGuard === 'function') await rawOptions.nativeRelayGuard();
      workflowTurn = automationTurn ? null :
        await pluginDebug.submitConversation?.(s, text, staged.files, sendOptions, rawPluginObjects);
    }
    catch (error) {
      if (taskTurn) await taskTurn.afterTurn('stopped').catch(() => {});
      return { ok: false, reason: String(error.message || error) };
    }
    if (session.get(ref) !== s) {
      if (taskTurn?.afterTurn) await taskTurn.afterTurn('stopped').catch(() => {});
      return { ok: false, reason: '账号已切换，请重新打开会话' };
    }
    if (!workflowTurn && typeof rawOptions?.nativeRelayGuard === 'function') {
      try { await rawOptions.nativeRelayGuard(); }
      catch (error) { return { ok: false, accepted: false, reason: String(error.message || error) }; }
    }
    const submitted = workflowTurn || (typeof s.submit === 'function'
      ? await s.submit(text, staged.files, sendOptions)
      : { accepted: true, queued: false, completion: s.send(text, staged.files, sendOptions) });
    if (!submitted.accepted) {
      if (taskTurn?.afterTurn) await taskTurn.afterTurn('stopped').catch(() => {});
      return submitted.result || { ok: false, reason: '这条消息没有被接收' };
    }
    if (observe) observe(Promise.resolve(submitted.completion));
    Promise.resolve(submitted.completion).then((r) => {
      if (!r || !r.ok) _publish(BrowserWindow, s, {
        kind: 'error', reason: r && r.reason,
        failureKind: r && r.failureKind, retrySafe: Boolean(r && r.retrySafe),
        submissionId: sendOptions.submissionId,
        taskId: sendOptions.taskId || '',
      }, _uiWindow.snapshot(s));
      else _publish(BrowserWindow, s, {
        kind: r.cancelled ? 'turn-queue-cancelled' : 'settled',
        submissionId: sendOptions.submissionId,
        taskId: sendOptions.taskId || '',
      }, _uiWindow.snapshot(s));
      if (s.detached) _scheduleRelease(s);
    }).catch((error) => {
      _publish(BrowserWindow, s, {
        kind: 'error', reason: String((error && error.message) || error),
        submissionId: sendOptions.submissionId,
      }, _uiWindow.snapshot(s));
    });
    return { ok: true, accepted: true, ...(workflowTurn ? { workflowRun: workflowTurn.workflowRun } : {}), queued: Boolean(submitted.queued),
      queueId: submitted.queueId || '', position: Number(submitted.position || 0), snapshot: _contextSnapshot(s, _uiWindow.snapshot(s)),
      inputAttachments: staged.files,
      attachmentWarnings: staged.warnings };
  }
  ipcMain.handle('pi-session-send', (event, ref, text, files, options) => {
    const request = options?.appRequestId ? require('../work-preview').appRequestContext(event, options.appRequestId) : null;
    if (request && require('./app-mcp-grant.cjs').nativePluginId(session.get(ref)) !== request.pluginId)
      throw Error('Application conversation does not belong to this page');
    return sendConversation(ref, text, files, options, undefined, request);
  });

  ipcMain.handle('pi-session-queue-cancel', (event, ref, queueId) => {
    const s = session.get(ref);
    if (!s) return { ok: false, reason: '这条对话已经不在了（可能已关闭）' };
    if (_cloudHandoff.guard(s)) return { ok: false, reason: '请先处理云端交接，再操作本地队列' };
    if (typeof s.cancelQueued !== 'function') return { ok: false, reason: '当前版本还不能取消排队消息' };
    return s.cancelQueued(queueId);
  });

  ipcMain.handle('pi-session-queue-update', (event, ref, id, action, value) => {
    const s = session.get(ref);
    if (!s || typeof s.updateQueue !== 'function') return { ok: false, reason: '会话暂不可用' };
    if (_cloudHandoff.guard(s)) return { ok: false, reason: '请先处理云端交接，再操作本地队列' };
    if (!['resume', 'edit', 'up', 'down', 'before', 'retry-model', 'send-now'].includes(action)) return { ok: false, reason: '不支持的队列操作' };
    return s.updateQueue(String(id || ''), action, String(value || '').slice(0, 50000));
  });

  require('./runtime-selection-ipc').install({ app, ipcMain, session,
    identityOf: sendIdentityOf || identityOf, memories, cloud: _cloudHandoff,
    publish: (handle, event, snap) => _publish(BrowserWindow, handle, event, snap) });
  ipcMain.handle('pi-session-snapshot', (event, ref, options) => {
    const s = session.get(ref);
    if (!s) return { ok: false, reason: '\u4f1a\u8bdd\u4e0d\u5728\u4e86' };
    const win = BrowserWindow.fromWebContents(event.sender);
    const attached = _uiWindow.request(s, win, options);
    if (s.localReplica) {
      return Promise.resolve(s.loadHistory?.(options || {})).then(() => ({ ok: true, snapshot: _contextSnapshot(s, s.snapshot()) }));
    }
    const raw = attached ? _uiWindow.snapshot(s) :
      (typeof s.uiSnapshot === 'function' ? s.uiSnapshot(options || {}) : s.snapshot());
    const snapshot = _contextSnapshot(s, raw);
    return { ok: true, snapshot: _cloudHandoff ? _cloudHandoff.view(s, snapshot) : snapshot };
  });
  const cancelSession = async (ref) => {
    const s = session.get(ref);
    if (!s) return { ok: false, accepted: false, reason: '这条对话已经不在了（可能已关闭）' };
    if (_cloudHandoff.guard(s)) return { ok: false, accepted: false, reason: '请先处理云端交接，再操作本地队列' };
    try {
      const result = await Promise.resolve(s.cancel());
      const snapshot = typeof s.uiSnapshot === 'function' ? s.uiSnapshot() : s.snapshot();
      return { ...(result || { ok: true, accepted: true }),
        snapshot: _contextSnapshot(s, snapshot) };
    } catch (error) {
      return { ok: false, accepted: false, reason: String(error && error.message || error) };
    }
  };
  // New renderer path: await a receipt so the UI can lock the stop control
  // after the first click. Keep the legacy one-way channel for older windows
  // and test fixtures that still use ipcRenderer.send().
  ipcMain.handle('pi-session-cancel-request', (_event, ref) => cancelSession(ref));
  ipcMain.on('pi-session-cancel', (event, ref) => { const s = session.get(ref); if (s) s.cancel(); });
  require('./artifact-ipc').install({ app, ipcMain, BrowserWindow, session, workDir,
    resolveSession: handle => _cloudHandoff.artifactSession(handle) });
  require('../conversation/local-delivery-action').install({ app, ipcMain, session, shell,
    isRemote: handle => Boolean(_cloudHandoff.guard(handle)),
    resolveSession: handle => _cloudHandoff.artifactSession(handle) });

  ipcMain.handle('pi-session-answer-ui', require('../access-control/ipc').answerHandler(session));
  ipcMain.handle('pi-session-set-access-mode', require('../access-control/ipc').changeHandler({ session, BrowserWindow, confirmFullAccess }));
  const goalAction = require('./goal-actions').create({
    session, publish: (s, touched, snapshot) => _publish(BrowserWindow, s, touched, snapshot),
    scheduleRelease: _scheduleRelease,
  });
  ipcMain.handle('pi-session-goal-action', (event, ref, action) => {
    const handle = session.get(ref);
    if (handle && _cloudHandoff.guard(handle)) return { ok: false, reason: '这条会话已交给云端，请在当前会话查看云端进展' };
    return goalAction(event, ref, action);
  });

  ipcMain.on('pi-session-close', (event, ref) => {
    const s = session.get(ref);
    if (!s) return;
    _publicationQueue.cancel(ref);
    _clearRelease(ref);
    _streamTransport.cancel(ref);
    artifactRuntime.closeRef(ref);
    if (s) { _unwatchOwner(s); s.close(); }
  });

  /*
   * Navigation releases foreground ownership without stopping execution. Retain completed
   * sessions briefly for reconnection; only Stop or explicit close terminates them.
   */
  ipcMain.handle('pi-session-release', (event, ref) => {
    const s = session.get(ref);
    if (!s) return { ok: true, kept: false };
    _detach(s);
    return { ok: true, kept: true, active: _isActive(s), sessionId: s.sessionId };
  });

  /* Close in-process sessions on application shutdown so they cannot keep the process alive. */
  const personalRelay = require('../conversation/personal-relay').create({
    app, identityOf: () => (sendIdentityOf || identityOf)(app),
    find: id => session.findBySessionId(id),
    open: (options, identity) => openConversation(null, options, identity),
    send: sendConversation,
    sync: () => _accountSync.flush(),
  });
  let accountingQuitReady = false;
  const contentMigration = require('../conversation/content-migration.cjs').create({
    app, identityOf: sendIdentityOf || identityOf });
  contentMigration.start();
  let persistenceClose = null;
  const disposePersistence = () => {
    if (!persistenceClose) persistenceClose = Promise.allSettled([
      contentMigration.close(), _accountSync.close(), _sharedHistory?.close(), _usage?.persist?.(),
    ]).then(results => {
      if (results.some(result => result.status === 'rejected'))
        console.warn('[conversation] Pending local data could not be saved before exit');
    });
    return persistenceClose;
  };
  app.on('before-quit', event => {
    const persisted = disposePersistence();
    void _cloudHandoff?.synchronization.close();
    personalRelay.close();
    _publicationQueue.clear();
    _streamTransport.clear();
    _releaseTimers.forEach((t) => clearTimeout(t));
    _releaseTimers.clear();
    session.list().forEach(_unwatchOwner);
    artifactRuntime.closeAll();
    startReceipts.dispose();
    try { session.closeAll(); } catch (e) { /* Do not throw during shutdown cleanup. */ }
    // Disk writes run asynchronously during conversations. Complete their
    // durability boundary before Electron tears down the main process.
    if (!accountingQuitReady && event?.preventDefault) {
      event.preventDefault();
      persisted.finally(() => { accountingQuitReady = true; app.quit(); });
    }
    return persisted;
  });
  return {
    dispose: disposePersistence,
    history: require('./local-history-remote.cjs').create({ app, session, history: _sharedHistory,
      accountHistory: _accountSync,
      identityOf: sendIdentityOf || identityOf,
      action: historyActions.localAction }),
    open: (options, identity) => openConversation(null, options, identity),
    ...require('../access-control/automation-access').service(app, openConversation),
    async send(ref, text, files, options) {
      let completion;
      const result = await sendConversation(ref, text, files, options, value => { completion = value; });
      return { ...result, completion };
    },
    find: id => session.findBySessionId(id),
    sync: () => _accountSync.flush(),
  };
}
module.exports = { install, _skillDirs, _defaultCwd };
