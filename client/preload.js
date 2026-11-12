const { contextBridge, ipcRenderer, webUtils } = require('electron');

const pageIpcEvents = [];
let pageIpcEpoch = 0;
const pageIpcClock = () => typeof performance === 'undefined' ? Date.now() : performance.now();
function trimPageIpcEvents() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (let i = pageIpcEvents.length - 1; i >= 0; i--) if (pageIpcEvents[i].at < cutoff) pageIpcEvents.splice(i, 1);
  if (pageIpcEvents.length > 200) pageIpcEvents.splice(0, pageIpcEvents.length - 200);
}
function timedPageInvoke(channel, ...args) {
  const start = pageIpcClock(), at = Date.now(), epoch = pageIpcEpoch;
  const finish = ok => {
    if (epoch !== pageIpcEpoch) return;
    pageIpcEvents.push({ name: channel, at, durationMs: Math.max(0, Math.round((pageIpcClock() - start) * 10) / 10), ok });
    trimPageIpcEvents();
  };
  try {
    return Promise.resolve(ipcRenderer.invoke(channel, ...args)).then(
      value => { finish(true); return value; }, error => { finish(false); throw error; });
  } catch (error) { finish(false); throw error; }
}

/*
 * Expose a runtime-neutral conversation facade; retain piSession as a compatibility alias.
 */
const conversationSession = {
  localHistorySupported: true,
  probe: (adapterId) => ipcRenderer.invoke('pi-session-probe', adapterId || 'pi'),
  runtimes: options => timedPageInvoke('pi-session-runtimes', options || {}),
  customAgents: Object.fromEntries(['list', 'add', 'activate', 'pick'].map(action =>
    [action, input => ipcRenderer.invoke('custom-agents-' + action, input)])),
  onRuntimesChanged: fn => {
    const handler = () => { try { fn(); } catch (_) {} };
    ipcRenderer.on('agent-runtimes-changed', handler);
    return () => ipcRenderer.removeListener('agent-runtimes-changed', handler);
  },
  onModelsChanged: fn => {
    const handler = () => { try { fn(); } catch {} };
    ipcRenderer.on('models-changed', handler);
    return () => ipcRenderer.removeListener('models-changed', handler);
  },
  runtimeModels: (adapterId) => ipcRenderer.invoke('pi-session-runtime-models', String(adapterId || '')),
  capabilities: (options) => timedPageInvoke('conversation-capabilities', options || {}),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch (error) { return ''; }
  },
  history: options => timedPageInvoke('pi-session-history', options),
  search: query => ipcRenderer.invoke('conversation-search', String(query || '').slice(0, 200)),
  searchHistory: () => timedPageInvoke('conversation-search-history'),
  cancelSearch: (clearCache = false) => ipcRenderer.send('conversation-search-cancel', clearCache === true),
  archivedHistory: () => ipcRenderer.invoke('pi-session-history-archived'),
  renameHistory: (id, title) => ipcRenderer.invoke('pi-session-history-rename', id, title),
  archiveHistory: (id) => ipcRenderer.invoke('pi-session-history-archive', String(id || '')),
  restoreHistory: (id) => ipcRenderer.invoke('pi-session-history-restore', String(id || '')),
  deleteHistory: (id, options) => ipcRenderer.invoke('pi-session-history-delete', String(id || ''), options || null),
  permanentDeleteHistory: (id) => ipcRenderer.invoke('pi-session-history-permanent-delete', String(id || '')),
  memory: Object.assign(
    Object.fromEntries(['preview', 'cancel', 'confirm', 'list', 'get', 'options', 'update', 'archive', 'restore', 'delete']
      .map(name => [name, (...args) => ipcRenderer.invoke('session-memory-' + name, ...args)])),
    { dimensions: Object.fromEntries(['list', 'get', 'create', 'update', 'archive', 'restore', 'delete', 'context']
      .map(name => [name, (...args) => ipcRenderer.invoke('memory-dimension-' + name, ...args)])) }
  ),
  recentPluginDraft: () => ipcRenderer.invoke('pi-session-recent-plugin-draft'),
  pluginDraft: (ref, target) => ipcRenderer.invoke('pi-session-plugin-draft', ref, target),
  open: (opts) => ipcRenderer.invoke('pi-session-open', opts || {}),
  // Automation openings retain the current main-process identity so a local
  // personal-plugin lock is verified before the first ordinary-chat turn.
  openAutomation: (opts) => ipcRenderer.invoke('pi-session-automation-open', opts || {}),
  reserveWorkConversation: options => ipcRenderer.invoke('pi-session-reserve-work', options || {}),
  workCards: sessionId => ipcRenderer.invoke('pi-session-work-cards', sessionId),
  findTaskCreation: taskId => ipcRenderer.invoke('pi-session-find-task-creation', taskId),
  saveWorkCard: (sessionId, card) => ipcRenderer.invoke('pi-session-save-work-card', sessionId, card),
  saveWorkDraftSelection: (sessionId, value) => ipcRenderer.invoke('pi-session-save-work-draft-selection', sessionId, value),
  cloud: { ...Object.fromEntries(['preview', 'confirm', 'recover', 'abort', 'materialize'].map(action =>
    [action, (ref, input) => ipcRenderer.invoke('conversation-cloud-' + action, ref, input || {})])),
    start: input => ipcRenderer.invoke('conversation-cloud-start', input),
    targets: agentId => ipcRenderer.invoke('conversation-cloud-targets', agentId) },
  confirmNewChatAccess: (opts) => ipcRenderer.invoke('pi-session-confirm-new-chat-access', opts || {}),
  revokeNewChatAccess: (opts) => ipcRenderer.invoke('pi-session-revoke-new-chat-access', opts || {}),
  bindTask: (ref, taskId, title) => ipcRenderer.invoke('pi-session-bind-task', ref, taskId, title),
  send: (ref, text, attachments, options) => ipcRenderer.invoke('pi-session-send', ref, text, attachments || [], options || {}),
  cancelQueued: (ref, id) => ipcRenderer.invoke('pi-session-queue-cancel', ref, id),
  updateQueue: (ref, id, action, value) => ipcRenderer.invoke('pi-session-queue-update', ref, id, action, value),
  selectAgent: (ref, agentId) => ipcRenderer.invoke('pi-session-select-agent', ref, agentId),
  conversationRuntimes: (ref, options) => ipcRenderer.invoke('pi-session-conversation-runtimes', ref, options || {}),
  selectModel: (ref, name) => ipcRenderer.invoke('pi-session-select-model', ref, name),
  setThinking: (ref, value) => ipcRenderer.invoke('pi-session-set-thinking', ref,
    typeof value === 'string' ? value : Boolean(value)),
  setAccessMode: (ref, mode, expectedRevision, options) => ipcRenderer.invoke('pi-session-set-access-mode', ref, mode, expectedRevision, options || {}),
  snapshot: (ref, options) => ipcRenderer.invoke('pi-session-snapshot', ref, options || {}),
  outputs: (ref) => ipcRenderer.invoke('pi-session-outputs', ref),
  artifactAction: (ref, artifactId, action) =>
    ipcRenderer.invoke('pi-session-artifact-action', ref, artifactId, action),
  pickShareFolder: () => ipcRenderer.invoke('mate-message-pick-folder'),
  attachmentImage: (ref, token, mode) =>
    ipcRenderer.invoke('pi-session-attachment-image', ref, token || '', mode || 'full'),
  copyImage: (pngData) => ipcRenderer.invoke('conversation-copy-image', pngData),
  copyAttachmentImage: (ref, token, pngData) =>
    ipcRenderer.invoke('pi-session-copy-attachment-image', ref, token || '', pngData),
  openOutput: (ref, p) => ipcRenderer.invoke('pi-session-open-output', ref, p),
  revealOutput: (ref, p) => ipcRenderer.invoke('pi-session-reveal-output', ref, p),
  openOutputFolder: (ref) => ipcRenderer.invoke('pi-session-open-output-folder', ref),
  readOutput: (ref, p) => ipcRenderer.invoke('pi-session-read-output', ref, p),
  toolDetail: (ref, id) => ipcRenderer.invoke('pi-session-tool-detail', ref, id),
  writeOutput: (ref, p, text) => ipcRenderer.invoke('pi-session-write-output', ref, p, text),
  readOutputBinary: (ref, p) => ipcRenderer.invoke('pi-session-read-output-binary', ref, p),
  inspectDelivery: (ref, ids) => ipcRenderer.invoke('conversation-delivery-inspect', ref, ids),
  prepareDelivery: (ref, ids) => ipcRenderer.invoke('conversation-delivery-prepare', ref, ids),
  openDeliveryArchive: (ref, ids, options) => ipcRenderer.invoke('conversation-delivery-open-archive', ref, ids, options)
    .catch(() => ({ ok: false, reason: '无法打开本地压缩包，请重新打开客户端后重试' })),
  saveDelivery: (ref, ids, expectedRevision) => ipcRenderer.invoke('conversation-delivery-save', ref, ids, expectedRevision),
  openLocalDelivery: (ref, ids, options) => ipcRenderer.invoke('conversation-delivery-open-local', ref, ids, options)
    .catch(error => ({ ok: false, code: 'DELIVERY_OPEN_FAILED', reason: /No handler registered/i.test(error?.message || '')
      ? '请重启 SoduWork 后打开成果位置，文件仍保留在本机' : '无法打开成果位置，请重试' })),
  continueLocalDelivery: (ref, ids) => ipcRenderer.invoke('conversation-delivery-continue-local', ref, ids)
    .catch(error => ({ ok: false, code: 'DELIVERY_OPEN_FAILED', reason: /No handler registered/i.test(error?.message || '')
      ? '请重启 SoduWork 后在本地继续，成果仍保留在本机' : '无法准备本地会话，请重试' })),
  openInApp: (ref, p) => ipcRenderer.invoke('pi-session-open-in-app', ref, p),
  workdir: () => ipcRenderer.invoke('pi-session-workdir'),
  pickWorkdir: (options) => ipcRenderer.invoke('pi-session-pick-workdir', options || {}),
  saveWorkdir: (dir) => ipcRenderer.invoke('pi-session-save-workdir', dir),
  pickCwd: (options) => ipcRenderer.invoke('pi-session-pick-cwd', options || {}),
  openWorkdir: () => ipcRenderer.invoke('pi-session-open-workdir'),
  openSessionWorkdir: (ref) => ipcRenderer.invoke('pi-session-open-session-workdir', ref),
  setMode: (m) => ipcRenderer.invoke('pi-session-mode', m),
  // Return a stop receipt so the renderer can enter a pending state once and
  // wait for the main process to acknowledge the request.  The main process
  // still publishes the normal session events; this receipt only closes the
  // fire-and-forget gap that made repeated clicks look necessary.
  cancel: (ref) => ipcRenderer.invoke('pi-session-cancel-request', ref).catch(() => {
    // Older fixture windows and pre-upgrade renderers only expose the
    // fire-and-forget channel. Keep that path usable while the new channel
    // is deployed; production handlers return the awaited receipt above.
    ipcRenderer.send('pi-session-cancel', ref);
    return { ok: true, accepted: true, stopped: false, legacy: true };
  }),
  answerUi: (ref, res) => ipcRenderer.invoke('pi-session-answer-ui', ref, res),
  goalAction: (ref, action) => ipcRenderer.invoke('pi-session-goal-action', ref, action),
  release: (ref) => ipcRenderer.invoke('pi-session-release', ref),
  close: (ref) => ipcRenderer.send('pi-session-close', ref),
  onEvent: (fn) => {
    const h = (_e, payload) => {
      const events = Array.isArray(payload?.events) ? payload.events : [null];
      for (const event of events) {
        try { fn(event ? { ...payload, ...event, events: undefined } : payload); }
        catch (error) { /* One subscriber/event cannot stop the remaining batch. */ }
      }
    };
    ipcRenderer.on('pi-session-event', h);
    return () => ipcRenderer.removeListener('pi-session-event', h);
  },
  // Opt-in transports a heavy snapshot through contextBridge only once. The
  // renderer expands lightweight ordered events against that shared snapshot.
  onEventBatch: (fn, options) => {
    const h = (_e, payload) => {
      try { fn(options?.presenceOnly ? { ...payload, snapshot: null } : payload); } catch (_) {}
    };
    ipcRenderer.on('pi-session-event', h);
    return () => ipcRenderer.removeListener('pi-session-event', h);
  },
};

/*
 * Expose page-level preview actions without exposing webContents or ipcRenderer to the
 * renderer.
 */
const workPreview = {
  appCache: payload => ipcRenderer.invoke('work-preview-app-cache', payload || {}),
  show: (payload) => ipcRenderer.invoke('work-preview-show', payload || {}),
  /* Open independent native application windows. */
  showDetached: (payload) => ipcRenderer.invoke('work-preview-show-detached', payload || {}),
  showEmbedded: payload => ipcRenderer.invoke('work-preview-show-embedded', payload || {}),
  windowDisplay: () => ipcRenderer.invoke('work-preview-window-display'),
  /*
   * Bridge real desk.html composer components to main-process conversation following,
   * content insertion, expansion, and send receipts.
   */
  composerHello: () => ipcRenderer.invoke('work-preview-composer-hello'),
  composerActivity: busy => ipcRenderer.invoke('work-preview-composer-activity', { busy }),
  composerDock: (opts) => ipcRenderer.invoke('work-preview-composer-dock', opts || {}),
  composerStep: (payload) => ipcRenderer.invoke('work-preview-composer-step', payload || {}),
  composerSent: () => ipcRenderer.invoke('work-preview-composer-sent'),
  onComposerSession: (cb) => ipcRenderer.on('app-composer-session', (_e, msg) => { try { cb(msg || {}); } catch (_) {} }),
  onComposerPut: (cb) => ipcRenderer.on('app-composer-put', (_e, msg) => { try { cb(msg || {}); } catch (_) {} }),
  onComposerMode: (cb) => ipcRenderer.on('app-composer-mode', (_e, msg) => { try { cb(msg || {}); } catch (_) {} }),
  onComposerInbox: (cb) => ipcRenderer.on('work-preview-composer-inbox', (_e, msg) => { try { cb(msg || {}); } catch (_) {} }),
  onComposerHello: (cb) => ipcRenderer.on('work-preview-composer-hello', (_e, msg) => { try { cb(msg || {}); } catch (_) {} }),
  onComposerRefresh: (cb) => ipcRenderer.on('work-preview-composer-refresh', (_e, msg) => { try { cb(msg || {}); } catch (_) {} }),
  composerState: (payload) => ipcRenderer.invoke('work-preview-composer-state', payload || {}),
  composerTurnSettled: () => ipcRenderer.invoke('work-preview-composer-turn-settled'),
  composerSubmitResult: payload => ipcRenderer.invoke('work-preview-composer-submit-result', payload),
  authorizeComposerAutomation: id => ipcRenderer.invoke('work-preview-composer-automation-authorize',id),
  composerAutomationResult: payload => ipcRenderer.invoke('work-preview-composer-automation-result',payload),
  onComposerAutomation: cb => ipcRenderer.on('app-composer-automation',(_e,payload)=>{try{cb(payload || {});}catch(_) {}}),
  onComposerSubmit: cb => ipcRenderer.on('app-composer-submit', (_e, payload) => { try { cb(payload || {}); } catch (_) {} }),
  /* Report sidebar width changes for synchronized native-view layout. */
  composerSetWidth: (width) => ipcRenderer.invoke('work-preview-composer-width', { width: Number(width) }),
  /* Control floating preview and pinned expansion states. */
  composerSetMode: (m) => ipcRenderer.invoke('work-preview-composer-mode-set', m || {}),
  /* Open application management from the application title bar. */
  onAppsManage: (cb) => ipcRenderer.on('work-preview-apps-manage', (_e, msg) => { try { cb(msg || {}); } catch (_) {} }),
  updateBounds: (tabId, bounds) => ipcRenderer.invoke('work-preview-bounds', { tabId, bounds }),
  command: (tabId, action, payload) =>
    ipcRenderer.invoke('work-preview-command', { tabId, action, ...(payload || {}) }),
  inspect: (tabId, enabled, options) =>
    ipcRenderer.invoke('work-preview-command', { tabId, action: 'inspect', enabled: Boolean(enabled), ...(options || {}) }),
  setAnnotations: (tabId, annotations) =>
    ipcRenderer.invoke('work-preview-command', { tabId, action: 'annotations', annotations }),
  hide: () => ipcRenderer.invoke('work-preview-hide'),
  setOcclusion: (payload) => ipcRenderer.invoke('work-preview-occlusion', payload || {}),
  /*
   * Synchronously hide native preview views before DOM modals paint, then restore the active
   * page; DOM z-index cannot cover a WebContentsView.
   */
  suppressWorkPreview: (hidden) => { try { ipcRenderer.sendSync('work-preview-suppress', !!hidden); } catch (e) { /* fail open */ } },
  destroy: (tabId) => ipcRenderer.invoke('work-preview-destroy', tabId || ''),
  resetEmbedded: () => ipcRenderer.invoke('work-preview-reset-embedded'),
  onState: (fn) => {
    const handler = (_event, state) => { try { fn(state || {}); } catch (_) { /* Contain subscriber exceptions. */ } };
    ipcRenderer.on('work-preview-state', handler);
    return () => ipcRenderer.removeListener('work-preview-state', handler);
  },
  onElementSelected: (fn) => {
    const handler = (_event, payload) => { try { fn(payload || {}); } catch (_) { /* listener isolation */ } };
    ipcRenderer.on('work-preview-element-selected', handler);
    return () => ipcRenderer.removeListener('work-preview-element-selected', handler);
  },
};

/* Parent renderer side of the registered web-app bridge. Only the parent
   desk renderer receives requests; the child WebContentsView never receives
   the full SoduWork preload surface. */
const workPreviewAppHost = {
  authorize: id => ipcRenderer.invoke('work-preview-app-authorize', String(id || '')),
  notifyDataChanged: topic => ipcRenderer.invoke('work-preview-app-data-changed',String(topic||'')),
  onRequest: (fn) => {
    const handler = (_event, payload) => { try { fn(payload || {}); } catch (_) {} };
    ipcRenderer.on('work-preview-app-request', handler);
    return () => ipcRenderer.removeListener('work-preview-app-request', handler);
  },
  respond: (id, result) => ipcRenderer.send('work-preview-app-response', {
    id: String(id || ''), result: result || { ok: false, reason: '应用宿主未返回结果' },
  }),
};

/*
 * Keep overlay-shape acknowledgements ordered across blur IPC and asynchronous state
 * queries. The listener is installed during preload evaluation so a blur that arrives
 * before the renderer binds its DOM consumer can still be replayed once.
 */
let overlayShapeRevision = 0;
let lastOverlayShapeRects = null;
let pendingOverlayBlur = false;
let deliveredOverlayBlurRevision = -1;
const overlayBlurConsumers = new Set();

function validOverlayShapeRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function invokeOverlayBlurConsumer(callback) {
  try { callback(); } catch (_error) { /* One dismissal failure must not interrupt the bridge. */ }
}

function receiveOverlayBlurRevision(revision) {
  if (!validOverlayShapeRevision(revision) || revision < overlayShapeRevision ||
      revision <= deliveredOverlayBlurRevision) return;
  overlayShapeRevision = revision;
  deliveredOverlayBlurRevision = revision;
  if (!overlayBlurConsumers.size) {
    pendingOverlayBlur = true;
    return;
  }
  pendingOverlayBlur = false;
  for (const callback of [...overlayBlurConsumers]) invokeOverlayBlurConsumer(callback);
}

function observeOverlayShapeState(info) {
  const revision = info && info.revision;
  if (!validOverlayShapeRevision(revision) || revision < overlayShapeRevision) return info;
  const previousRevision = overlayShapeRevision;
  overlayShapeRevision = revision;
  if (info.awaitingShape === true) receiveOverlayBlurRevision(revision);
  else if (revision > previousRevision && lastOverlayShapeRects !== null) {
    /*
     * A reloaded renderer can publish its first geometry before the asynchronous
     * revision query returns. Main correctly rejects that revision-zero packet;
     * replay the cached geometry once the current main-process revision is known.
     */
    ipcRenderer.send('window-set-overlay-shape', lastOverlayShapeRects, overlayShapeRevision);
  }
  return info;
}

function sendOverlayShape(rects) {
  lastOverlayShapeRects = Array.isArray(rects)
    ? rects.map(rect => rect && typeof rect === 'object' ? { ...rect } : rect)
    : rects;
  ipcRenderer.send('window-set-overlay-shape', lastOverlayShapeRects, overlayShapeRevision);
}

ipcRenderer.on('overlay-window-blur', (_event, revision) => {
  receiveOverlayBlurRevision(revision);
});

const soduWorkBridge = {
  pagePerformance: {
    snapshot: () => { trimPageIpcEvents(); return { available: true, events: pageIpcEvents.map(row => ({ ...row })) }; },
    clear: () => { pageIpcEpoch++; pageIpcEvents.length = 0; },
  },
  automationPreflight: payload => ipcRenderer.invoke('automation-preflight', payload || {}),
  automationConversationsWake: payload => ipcRenderer.invoke('automation-conversations-wake', payload || {}),
  platformConnections: Object.fromEntries(['status','refresh','prepare','connect','cancel','disconnect','openAuth'].map(action => [action, (provider, payload) => ipcRenderer.invoke('platform-connection-' + action, provider, payload || {})])),
  closeWindow: () => ipcRenderer.send('window-close'),
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  setAlwaysOnTop: (flag) => ipcRenderer.send('window-set-always-on-top', flag),
  moveWindow: (x, y) => ipcRenderer.send('window-move', x, y),
  setIgnoreMouseEvents: (ignore, opts) => ipcRenderer.send('window-set-ignore-mouse-events', ignore, opts),
  setOverlayShape: sendOverlayShape,
  getOverlayShape: () => Promise.resolve(ipcRenderer.invoke('window-get-overlay-shape')).then(observeOverlayShapeState),
  getWindowBounds: () => ipcRenderer.invoke('window-get-bounds'),
  getScreenSize: () => ipcRenderer.invoke('screen-get-size'),

  /* Overlay recovery channels. */
  // Send periodic heartbeats for main-process health checks.
  sendHeartbeat: () => ipcRenderer.send('renderer-heartbeat'),
  // Report renderer readiness after initialization.
  notifyReady: () => ipcRenderer.send('renderer-ready'),
  // Query emergency-mode state.
  isEmergency: () => ipcRenderer.invoke('safety-is-emergency'),

  /*
   * Read registration metadata through main-process IPC because sandboxed preload cannot
   * require the OS module.
   */
  getSysInfo: () => ipcRenderer.invoke('sys-info'),
  /* Request the main-process-created default workspace when no local preference exists. */
  getDefaultWorkRoot: () => timedPageInvoke('work-root-default'),
  getHubConnection: () => timedPageInvoke('hub-connection-info'),
  distributionInfo: () => ipcRenderer.sendSync('client-distribution-info'),
  selectHubEnvironment: (hub) => ipcRenderer.invoke('hub-environment-select', hub || ''),
  runtimeForm: () => { try { return ipcRenderer.sendSync('runtime-form'); } catch (e) { return 'packaged'; } },
  deviceAuthBootstrap: (payload) => timedPageInvoke('device-auth-bootstrap', payload || {}),
  clientDomainRead: (domain, scope) => timedPageInvoke('client-domain-read', domain, scope),
  clientDomainInvalidate: (domain, scope) => ipcRenderer.invoke('client-domain-invalidate', domain, scope),
  onClientDomainChanged: callback => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('client-domain-changed', handler);
    return () => ipcRenderer.removeListener('client-domain-changed', handler);
  },
  deviceAuthLogin: (payload) => ipcRenderer.invoke('device-auth-login', payload || {}),
  deviceAuthLogout: (payload) => ipcRenderer.invoke('device-auth-logout', payload || {}),
  deviceAuthClearSession: (payload) => ipcRenderer.invoke('device-auth-clear-session', payload || {}),
  deviceAuthStatus: (hub, clientId) => ipcRenderer.invoke('device-auth-status', hub || '', clientId || ''),
  // Account profile/session actions stay in the main process so account state is
  // shared by every renderer window without exposing credentials to the page.
  deviceAccountAction: (payload) => ipcRenderer.invoke('device-account-action', payload || {}),
  refreshAccountProfile: () => ipcRenderer.invoke('account-profile-refresh'),
  onAccountSessionChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('account-session-changed', handler);
    return () => ipcRenderer.removeListener('account-session-changed', handler);
  },
  onAccountProfileChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('account-profile-changed', handler);
    return () => ipcRenderer.removeListener('account-profile-changed', handler);
  },
  /* Keep cloud-computer credentials in the main process; expose sanitized connection state only. */
  cloudComputer: {
    get: (scope) => ipcRenderer.invoke('cloud-computer-get', scope || {}),
    status: (scope) => ipcRenderer.invoke('cloud-computer-status', scope || {}),
    save: (input) => ipcRenderer.invoke('cloud-computer-save', input || {}),
    test: (input) => ipcRenderer.invoke('cloud-computer-test', input || {}),
    install: (input) => ipcRenderer.invoke('cloud-computer-install', input || {}),
    clear: (scope) => ipcRenderer.invoke('cloud-computer-clear', scope || {}),
  },
  onDeviceAuthQuotaExceeded: (cb) => {
    const handler = (_event, detail) => { try { cb(detail || {}); } catch (e) {} };
    ipcRenderer.on('device-auth-quota-exceeded', handler);
    return () => ipcRenderer.removeListener('device-auth-quota-exceeded', handler);
  },

  /* The main process controls update source, signature checks, download, and installation. */
  getAppVersion: () => ipcRenderer.invoke('app-version'),
  getAppInfo: () => ipcRenderer.invoke('app-info'),
  requestAppQuit: () => ipcRenderer.invoke('app-request-quit'),
  getWindowTitlebar: () => ipcRenderer.invoke('window-titlebar-info'),
  setWindowTitlebarTheme: (theme) => ipcRenderer.invoke('window-titlebar-theme', theme || {}),
  setWindowMenuState: (state) => ipcRenderer.invoke('window-menu-state', state || {}),
  setWindowShortcuts: (state) => ipcRenderer.invoke('window-shortcuts-state', state || {}),
  openWindowMenu: (name) => ipcRenderer.invoke('window-menu-open', name),
  onWindowMenuCommand: (callback) => {
    const allowed = new Set(['new', 'sidebar', 'history', 'website', 'about', 'quit']);
    const handler = (_event, command) => { if (allowed.has(command)) callback(command); };
    ipcRenderer.on('window-menu-command', handler);
    ipcRenderer.send('window-menu-ready');
    return () => ipcRenderer.removeListener('window-menu-command', handler);
  },
  checkClientUpdate: (options) => ipcRenderer.invoke('client-update-check', options || {}),
  clientUpdateStatus: () => timedPageInvoke('client-update-status'),
  releaseNotes: {
    list: locale => ipcRenderer.invoke('release-notes-list', locale),
    version: () => ipcRenderer.invoke('release-notes-version'),
    claim: locale => ipcRenderer.invoke('release-notes-claim', locale),
    acknowledge: () => ipcRenderer.invoke('release-notes-ack'),
    release: () => ipcRenderer.invoke('release-notes-release'),
  },
  readAloud: {
    claim: () => ipcRenderer.invoke('read-aloud-claim'),
    onStop: callback => {
      const handler = () => callback();
      ipcRenderer.on('read-aloud-stop', handler);
      return () => ipcRenderer.removeListener('read-aloud-stop', handler);
    },
  },
  installClientUpdate: () => ipcRenderer.invoke('client-update-install'),
  resolveClientUpdate: (action) => ipcRenderer.invoke('client-update-resolve', action || {}),
  onClientUpdateStatus: (cb) => ipcRenderer.on('client-update-status', (_e, status) => {
    try { cb(status || {}); } catch (e) {}
  }),

  /* The main process owns bundled Runner credentials and command construction. */
  configureRunner: (cfg) => ipcRenderer.invoke('runner-configure', cfg || {}),
  setRunnerCapability: (key, enabled) =>
    ipcRenderer.invoke('runner-capability-set', key || '', Boolean(enabled)),
  confirmRunnerComponentInstall: (key) =>
    ipcRenderer.invoke('runner-component-confirm', key || ''),
  runnerStatus: () => ipcRenderer.invoke('runner-status'),
  /* Store personal plugins under main-process user data without granting arbitrary renderer filesystem access. */
  appSettings: {
    get: (id) => ipcRenderer.invoke('app-settings-get', id || '', {}),
    update: (id, options) => ipcRenderer.invoke('app-settings-update', id || '', options || {}),
  },
  personalPlugins: {
    debug: (ref, options) => ipcRenderer.invoke('personal-plugin-debug', ref || '', options || {}),
    choosePackage: () => ipcRenderer.invoke('personal-plugin-choose-package'),
    list: (options) => timedPageInvoke('personal-plugin-list', options || {}),
    get: (pluginId) => ipcRenderer.invoke('personal-plugin-get', pluginId || ''),
    preflight: (body) => ipcRenderer.invoke('personal-plugin-preflight', body || {}),
    preflightArchive: (name, content) =>
      ipcRenderer.invoke('personal-plugin-preflight-archive', name || '', content || ''),
    create: (body) => ipcRenderer.invoke('personal-plugin-create', body || {}),
    configure: (id, checksum, config) => ipcRenderer.invoke('personal-plugin-configure', id, checksum, config),
    initialize: pluginId => ipcRenderer.invoke('personal-plugin-initialize',pluginId),
    updateMetadata: (id, options) => ipcRenderer.invoke('personal-plugin-metadata-update', id, options || {}),
    setEnabled: (pluginId, enabled) => ipcRenderer.invoke('personal-plugin-enable', pluginId || '', Boolean(enabled)),
    setVersion: (pluginId, version) => ipcRenderer.invoke(
      'personal-plugin-version', pluginId || '', version || ''),
    remove: (pluginId) => ipcRenderer.invoke('personal-plugin-delete', pluginId || ''),
    resolve: (pluginIds) => ipcRenderer.invoke('personal-plugin-resolve', pluginIds || []),
    // Native export writes a portable ZIP package. Keep exportDraft as a
    // compatibility alias for older renderer bundles.
    exportToFile: (pluginId) => ipcRenderer.invoke('personal-plugin-export', pluginId || ''),
    exportDraft: (pluginId) => ipcRenderer.invoke('personal-plugin-export', pluginId || ''),
    publisherIdentity: () => ipcRenderer.invoke('personal-plugin-publisher-identity'),
    signPayload: (payload) => ipcRenderer.invoke('personal-plugin-sign', payload || {}),
  },

  /* Open external task links through main-process shell handling. */
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  fileOpen: {
    list: () => ipcRenderer.invoke('file-open-list'),
    claim: id => ipcRenderer.invoke('file-open-claim', String(id || '')),
    ack: id => ipcRenderer.invoke('file-open-ack', String(id || '')),
    onPending: fn => {
      const listener = () => fn();
      ipcRenderer.on('file-open-pending', listener);
      return () => ipcRenderer.removeListener('file-open-pending', listener);
    },
  },
  previewAttachment: (payload) => ipcRenderer.invoke('attachment-preview', payload || {}),
  downloadAttachment: (payload) => ipcRenderer.invoke('attachment-download', payload || {}),
  readAttachmentBinary: (payload) => ipcRenderer.invoke('attachment-read-binary', payload || {}),
  /* Open library bytes retrieved by the renderer through authenticated requests. */
  openLibraryExternally: (payload) => ipcRenderer.invoke('library-open-external', payload || {}),
  revealLibraryItem: (payload) => ipcRenderer.invoke('library-reveal', payload || {}),
  localLibrary: {
    context: (payload) => ipcRenderer.invoke('library-local-context', payload || {}),
    call: (action, payload) => ipcRenderer.invoke('library-local-call', action, payload || {}),
  },
  attachmentMaterialize: (payload) => ipcRenderer.invoke('attachment-materialize', payload || {}),

  /* Capture window content with DIP coordinates and return a PNG data URL. */
  capturePage: (rect) => ipcRenderer.invoke('window-capture', rect),
  /* Forward capture options so the main-process service can hide only this
     requesting workspace window before acquiring display pixels. */
  startScreenshot: (options) => ipcRenderer.invoke('screenshot-start', options || {}),

  /*
   * Open or update native workspace and tool windows through openDeskWindow and onDeskOpen;
   * desktop overlay stacking remains separate.
   */
  openDeskWindow: (payload) => ipcRenderer.send('open-desk-window', payload || {}),
  reportWorkspaceView: (view) => ipcRenderer.send('workspace-view', view || ''),
  workspaceContext: () => ipcRenderer.invoke('workspace-state-context'),
  resetWorkspaceState: () => ipcRenderer.invoke('workspace-state-reset'),
  setLocale: (locale) => ipcRenderer.send('client-locale', String(locale || 'zh-CN')),
  reportTheme: (snapshot) => ipcRenderer.send('client-theme', snapshot),
  accessPreferences: {
    get: () => timedPageInvoke('access-preferences-get'),
    set: (mode, revision) => ipcRenderer.invoke('access-preferences-set', { mode, revision }),
    remember: mode => ipcRenderer.invoke('access-preferences-remember', { mode }),
    onChange: callback => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('access-preferences-changed', listener);
      return () => ipcRenderer.removeListener('access-preferences-changed', listener);
    },
  },
  recentWorkspace: {
    get: () => ipcRenderer.invoke('recent-workspace-get'),
    set: (dir, name) => ipcRenderer.invoke('recent-workspace-set', { dir, name }),
    clear: () => ipcRenderer.invoke('recent-workspace-clear'),
  },
  onLocaleChange: (callback) => {
    const listener = (_event, locale) => callback(locale);
    ipcRenderer.on('client-locale-changed', listener);
    return () => ipcRenderer.removeListener('client-locale-changed', listener);
  },

  /*
   * Conversation bridge: probe, open, subscribe, send, and close. Main-process services own
   * runtime access and credentials and batch event publication.
   */
  conversationSession,
  workPreviewAppHost,
  fileTypeIcon: (type) => ipcRenderer.invoke('file-type-icon', type),
  piSession: conversationSession,
  workPreview,
  onDeskOpen: (cb) => ipcRenderer.on('desk-open', (_e, payload) => {
    try { cb(payload || {}); } catch (e) { /* Contain callback exceptions so the bridge remains usable. */ }
  }),
  /* Show work windows after their first page layout is ready to avoid overlay-style flashes. */
  deskContentReady: () => ipcRenderer.send('desk-content-ready'),
  /* Close the requesting work window after explicit page completion. */
  closeDeskWindow: () => ipcRenderer.send('close-desk-window'),

  /*
   * Forward shared-state invalidations through the main process to other renderer windows,
   * excluding the sender to avoid echoes.
   */
  broadcast: (kind, payload) => ipcRenderer.send('soduwork-work-broadcast', String(kind || ''), payload || null),
  onBroadcast: (cb) => ipcRenderer.on('soduwork-work-broadcast', (_e, kind, payload) => {
    try { cb(kind, payload); } catch (e) { /* Contain callback exceptions. */ }
  }),
  /* Expose overlay-blur dismissal as an event without exposing ipcRenderer. */
  onOverlayWindowBlur: (cb) => {
    if (typeof cb !== 'function') return () => {};
    overlayBlurConsumers.add(cb);
    if (pendingOverlayBlur) {
      pendingOverlayBlur = false;
      invokeOverlayBlurConsumer(cb);
    }
    return () => overlayBlurConsumers.delete(cb);
  },

  /*
   * Renderer cfg owns dock, pet, and tray visibility; the main process caches startup
   * values. Report changes for tray updates and receive explicit tray actions for
   * persistence in the renderer.
   */
  reportDeskFlags: (flags) => ipcRenderer.send('desk-flags', flags || {}),
  onDeskFlags: (cb) => ipcRenderer.on('desk-flags-set', (_e, flags) => {
    try { cb(flags || {}); } catch (e) { /* Contain callback exceptions. */ }
  })
};

// Expose the single canonical SoduWork bridge.
contextBridge.exposeInMainWorld('soduWorkAPI', soduWorkBridge);
