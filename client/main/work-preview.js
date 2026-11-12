'use strict';

/*
 * Host web and local HTML previews in isolated WebContentsViews. Renderers supply layout
 * and navigation intent; the main process owns path validation, permissions, and external
 * links.
 */
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');
const sessions = require('./agent-runtime/pi-session-bridge');
const outputs = require('./pi-session/outputs');
const artifactRuntime = require('./conversation/artifact-runtime');
const appBridgeContract = require('./soduwork-app-bridge-contract.cjs');
// The main process always exposes __dirname. Parser/lifecycle fixtures load
// this module in a VM, where it is intentionally absent, so keep the bridge
// path deterministic without making those isolated tests depend on a global.
const APP_PRELOAD = path.join(
  typeof __dirname === 'string'
    ? __dirname
    : (typeof process === 'object' && process && typeof process.cwd === 'function' ? process.cwd() : '.'),
  'work-preview-app-preload.cjs',
);
const OWNERS = new Map();
// Occlusion belongs to the renderer document, even when its current chat/views
// are disposed. A new view must not escape an already-open dialog.
const OCCLUSION = new WeakMap();
const WATCHED_DOCUMENTS = new WeakSet();
let DEPS = null;
let SESSION_POOL = null;
const { composerActivity, showDetached, showEmbedded, embeddedBounds, windowDisplay, appContextFor, appContextForPlugin, isAppComposer, composerTurnSettled, composerControl, composerSend, composerHello, composerWidth, composerModeSet, chromeAction, composerDock, composerStep, composerState, composerSent } = require('./work-preview-app-window.cjs').create({
  owners: OWNERS, getDeps: () => DEPS, ownerFor, ownerSession, safeWebUrl,
  normalizeAppBridge, cleanTabId, createView, destroyTab, liveContents, loadTarget, syncVisibility, clampBounds,
});

function normalizeAddress(raw) {
  let value = String(raw || '').trim();
  if (!value) return '';
  if (/^about:blank$/i.test(value)) return 'about:blank';
  if (/^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:\/|$)/i.test(value)) {
    value = 'http://' + value;
  } else if (!/^[a-z][a-z\d+.-]*:/i.test(value)) {
    value = 'https://' + value;
  }
  try {
    const parsed = new URL(value);
    if (!/^(https?:)$/.test(parsed.protocol) || isTimestampLikeHost(parsed.hostname)) return '';
    return parsed.href;
  } catch (_) {
    return '';
  }
}

function isTimestampLikeHost(host) {
  const value = String(host || '').trim().replace(/^\[|\]$/g, '');
  return /^(?:\d{4}[-/]\d{1,2}[-/]\d{1,2})(?:[tT _-]\d{1,2})(?::\d{1,2}(?::\d{1,2})?)?$/.test(value);
}

function safeWebUrl(raw) {
  const value = normalizeAddress(raw);
  return value === 'about:blank' || /^https?:\/\//i.test(value) ? value : '';
}

function clampBounds(raw, size) {
  const maxW = Math.max(0, Math.floor(Number(size && size.width) || 0));
  const maxH = Math.max(0, Math.floor(Number(size && size.height) || 0));
  const x = Math.max(0, Math.min(maxW, Math.floor(Number(raw && raw.x) || 0)));
  const y = Math.max(0, Math.min(maxH, Math.floor(Number(raw && raw.y) || 0)));
  const width = Math.max(0, Math.min(maxW - x, Math.floor(Number(raw && raw.width) || 0)));
  const height = Math.max(0, Math.min(maxH - y, Math.floor(Number(raw && raw.height) || 0)));
  return { x, y, width, height };
}

function cleanTabId(raw) {
  const value = String(raw || '').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 120);
  return value || '';
}

function fileTarget(ref, target, projected) {
  const active = projected || sessions.get(String(ref || ''));
  if (!active) return { ok: false, reason: '这条会话已经结束，无法继续预览文件' };
  const resolved = path.resolve(String(target || ''));
  if (!outputs.inside(active.cwd, resolved)) {
    return { ok: false, reason: '只能预览当前会话工作区里的文件' };
  }
  return { ok: true, url: pathToFileURL(resolved).href, path: resolved };
}

function allowedNavigation(raw, item) {
  const value = String(raw || '');
  if (value === 'about:blank' || /^https?:\/\//i.test(value)) return true;
  if (!/^file:/i.test(value) || !item.ref) return false;
  try {
    const active = sessions.get(item.ref);
    return Boolean(active && outputs.inside(item.previewCwd || active.cwd, fileURLToPath(value)));
  } catch (_) {
    return false;
  }
}

function liveContents(owner, item) {
  const root = item?.appWindowRoot || item;
  if (!owner || !item || owner.views.get(root.id) !== root ||
      (item.appWindowRoot && root.appTabs?.pages.get(item.id) !== item) ||
      !owner.sender || owner.sender.isDestroyed() || owner.host.isDestroyed()) return null;
  const wc = item.view && item.view.webContents;
  return wc && !wc.isDestroyed() ? wc : null;
}

const closedResult = () => ({ ok: false, reason: '这个页签已经关闭' });

function normalizeAppBridge(raw, targetUrl) {
  if (raw == null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('应用桥接声明无效');
  const origin = appBridgeContract.normalizeOrigin(raw.origin);
  if (!origin) throw new Error('应用桥接声明缺少有效来源');
  let targetOrigin = '';
  try { targetOrigin = appBridgeContract.normalizeOrigin(new URL(targetUrl).origin); } catch (_) {}
  if (!targetOrigin || origin !== targetOrigin) throw new Error('应用桥接来源与页面地址不一致');
  const declaration = appBridgeContract.normalizeManifestBridge({
    version: raw.version, capabilities: raw.capabilities,
  });
  return {
    appId: String(raw.appId || '').trim().slice(0, 160),
    contributionId: String(raw.contributionId || '').trim().slice(0, 100),
    origin, version: declaration.version, capabilities: declaration.capabilities,
  };
}

function childFor(event) {
  const sender = event && event.sender;
  if (!sender || sender.isDestroyed()) return null;
  for (const owner of OWNERS.values()) {
    for (const item of owner.views.values()) {
      for (const page of item.appTabs?.pages.values() || [item]) {
        if (page.view?.webContents === sender && liveContents(owner, page)) return { owner, item: page };
      }
    }
  }
  return null;
}

function appRequestContext(event, id) {
  const sender = event?.sender, owner = sender && OWNERS.get(sender.id);
  const pending = owner?.pendingAppRequests?.get(String(id || ''));
  if (!owner || owner.sender !== sender || !pending || pending.parentId !== sender.id ||
      !pending.assertActive || !pending.item) throw Error('Application request is unavailable');
  pending.assertActive();
  return { pluginId: String(pending.item.appBridge.appId || '').replace(/^plugin:/, ''),
    assertActive: pending.assertActive };
}

function resolveAppResponse(event, payload) {
  const sender = event && event.sender;
  const owner = sender && OWNERS.get(sender.id);
  if (!owner || !payload || typeof payload !== 'object') return false;
  const pending = owner.pendingAppRequests && owner.pendingAppRequests.get(String(payload.id || ''));
  if (!pending || pending.parentId !== event.sender.id) return false;
  owner.pendingAppRequests.delete(pending.id);
  clearTimeout(pending.timer);
  try { pending.assertActive?.(); }
  catch (error) { pending.resolve({ ok: false, code: error.code, reason: error.message }); return true; }
  pending.resolve(payload.result && typeof payload.result === 'object'
    ? payload.result : { ok: false, reason: '应用宿主返回了无效结果' });
  return true;
}

async function appRequest(event, raw) {
  const found = childFor(event);
  if (!found || !found.item.appBridge) return { ok: false, code: 'APP_BRIDGE_UNAVAILABLE', reason: '该页面未获准使用 SoduWork 能力' };
  const { owner, item } = found;
  appOwner.assertCurrent(item);
  let request;
  try { request = appBridgeContract.normalizeRequest(raw); }
  catch (error) { return { ok: false, code: 'APP_REQUEST_INVALID', reason: error.message }; }
  const capability = appBridgeContract.METHOD_CAPABILITY[request.method];
  if (!appBridgeContract.hasCapability(item.appBridge.capabilities, capability)) {
    return { ok: false, code: 'APP_CAPABILITY_DENIED', reason: '应用未获准使用此能力' };
  }
  let currentOrigin = '';
  try { currentOrigin = new URL(item.view.webContents.getURL()).origin; } catch (_) {}
  if (!appBridgeContract.validateOrigin(currentOrigin, item.appBridge.origin)) {
    return { ok: false, code: 'APP_ORIGIN_DENIED', reason: '页面来源已变化，能力已关闭' };
  }
  if (['ai.generate','directory.list','composer.mention','user.getCurrent','notifications.list','library.list','library.read','conversations.list','conversations.messages'].includes(request.method)) {
    try { request.assertCurrent=(await require('./work-preview-app-connection.cjs').authorize(item,DEPS,capability)).assertCurrent; }
    catch(error) {return {ok:false,reason:error.message};}
  }
  if (request.method === 'ai.generate') return DEPS.appAI(item, request.params, request.assertCurrent);
  if (request.method.startsWith('conversations.')) {
    try{return await require('./app-readonly-history.cjs').handle(DEPS.app,request.method,request.params,request.assertCurrent);}
    catch(error){return {ok:false,code:'APP_HISTORY_READ_FAILED',reason:error.message};}
  }
  if (request.method === 'automation.create') return require('./work-preview-app-automation.cjs').submit({ owner, item, request, deps: {...DEPS,expandComposer:(owner,root)=>composerControl(owner,root,{method:'composer.expand',params:{}})} });
  if (request.method.startsWith('attachments.')) return require('./work-preview-app-attachments.cjs').handle(item, request.method, request.params, DEPS);
  if (request.method.startsWith('composer.')) return composerControl(owner, item.appWindowRoot || item, request, item);
  if (request.method === 'mcp.connect') return require('./work-preview-app-connection.cjs').connect(found, request.params, DEPS);
  if (request.method.startsWith('settings.')) return require('./work-preview-app-connection.cjs').settings(found, request, DEPS);
  if (request.method.startsWith('files.')) return require('./app-files.cjs').handle(found,request,DEPS);
  if (request.method.startsWith('data.')) return require('./jiyong-runtime.cjs').data(found, request, DEPS);
  if (!owner.sender || owner.sender.isDestroyed()) return closedResult();
  const id = request.id;
  owner.pendingAppRequests = owner.pendingAppRequests || new Map();
  if (owner.pendingAppRequests.has(id)) {
    return { ok: false, code: 'APP_DUPLICATE_REQUEST', reason: '应用请求 id 已在处理中' };
  }
  if (owner.pendingAppRequests.size >= 32) return { ok: false, code: 'APP_BUSY', reason: '应用请求过多，请稍后重试' };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      owner.pendingAppRequests.delete(id);
      resolve({ ok: false, code: 'APP_TIMEOUT', reason: 'SoduWork 响应超时，请稍后重试' });
    }, 15000);
    owner.pendingAppRequests.set(id, { id, parentId: owner.sender.id, resolve, timer, item,
      assertActive: () => appOwner.assertCurrent(item) });
    owner.sender.send('work-preview-app-request', {
      version: 1, id, tabId: (item.appWindowRoot || item).id, appId: item.appBridge.appId,
      contributionId: item.appBridge.contributionId, method: request.method,
      params: request.params,
    });
  }).then(result=>{try{request.assertCurrent?.();return result;}catch(error){return {ok:false,reason:error.message};}});
}

function snapshot(owner, item, patch) {
  const wc = liveContents(owner, item);
  if (!wc) return null;
  const history = wc.navigationHistory;
  const url = item.pendingNavigation || wc.getURL() || item.requested || '';
  const displayUrl = item.sourceKind === 'file' && !item.appBridge
    ? artifactRuntime.previewLocation?.(item.ref, url) ||
      (/^file:/i.test(url) && allowedNavigation(url, item) ? url : '') : '';
  return {
    tabId: item.id,
    // Chromium keeps reporting the previous document while a navigation is
    // in flight. Expose the submitted URL immediately so the address bar does
    // not snap back before did-navigate arrives.
    url, displayUrl,
    title: wc.getTitle() || item.label || '',
    loading: wc.isLoading(),
    canBack: history.canGoBack(),
    canForward: history.canGoForward(),
    error: '', failedUrl: '',
    inspectEnabled: Boolean(item.inspectEnabled),
    inspectMode: String(item.inspectMode || 'annotate'),
    annotations: Array.isArray(item.annotations) ? item.annotations.slice(0, 40) : [],
    ...(patch || {}),
  };
}

const INSPECTOR_PREFIX = '__soduwork_workbench_element__:';

const annotationPage = require('./work-preview-annotations');
const { randomBytes } = require('node:crypto');
const ANNOTATION_WORLD = 1004;
function inspectorScript(enabled, annotations, nonce) {
  return annotationPage.script({ enabled: Boolean(enabled), annotations: annotations || [],
    prefix: INSPECTOR_PREFIX, nonce: nonce || '' });
}
async function injectInspector(owner, item, enabled, options) {
  if (!liveContents(owner, item)) return;
  item.inspectEnabled = Boolean(enabled);
  item.inspectMode = String(options && options.mode || item.inspectMode || 'annotate');
  if (Array.isArray(options && options.annotations)) {
    item.annotations = options.annotations.slice(0, 40).map((note) => ({
      id: String(note.id || '').slice(0, 100), number: Number(note.number) || 1,
      url: String(note.url || '').slice(0, 2000), selector: String(note.selector || '').slice(0, 1000),
      comment: String(note.comment || '').slice(0, 2000),
      title: String(note.title || '').slice(0, 200), text: String(note.text || '').slice(0, 500),
      html: String(note.html || '').slice(0, 1600), tag: String(note.tag || '').slice(0, 40),
    }));
  }
  const wc = liveContents(owner, item);
  if (!wc || wc.isDestroyed() || !wc.getURL()) return;
  item.annotationNonce = item.annotationNonce || randomBytes(24).toString('hex');
  try {
    await wc.executeJavaScriptInIsolatedWorld(ANNOTATION_WORLD, [{
      code: inspectorScript(item.inspectEnabled, item.annotations, item.annotationNonce),
    }], true);
  } catch (error) { if (liveContents(owner, item)) throw error; }
}
function handleInspectorMessage(owner, item, message) {
  const wc = liveContents(owner, item);
  if (!wc) return;
  if (typeof message !== 'string' || !message.startsWith(INSPECTOR_PREFIX) || message.length > 16000) return;
  let payload;
  try { payload = JSON.parse(message.slice(INSPECTOR_PREFIX.length)); } catch (_) { return; }
  if (!payload || !item.annotationNonce || payload.nonce !== item.annotationNonce) return;
  if (!['upsert', 'remove', 'exit'].includes(payload.action)) return;
  if (owner.active !== item.id) return;
  if (payload.action === 'exit') { item.inspectEnabled = false; emit(owner, item); return; }
  const compact = {
    tabId: item.id, ref: item.ref, action: payload.action,
    id: String(payload.id || '').slice(0, 100),
    url: String(wc.getURL() || '').slice(0, 2000),
    title: String(payload.title || item.label || '').slice(0, 200),
    selector: String(payload.selector || '').slice(0, 1000),
    tag: String(payload.tag || '').slice(0, 40),
    text: String(payload.text || '').slice(0, 500),
    html: String(payload.html || '').slice(0, 1600),
    comment: String(payload.comment || '').trim().slice(0, 2000),
  };
  if (payload.action === 'upsert' && (!compact.comment || !compact.selector)) return;
  if (!owner.sender || owner.sender.isDestroyed()) return;
  owner.sender.send('work-preview-element-selected', compact);
}

function emit(owner, item, patch) {
  const state = snapshot(owner, item, patch);
  if (state) owner.sender.send('work-preview-state', state);
}

function loadTarget(owner, item, target) {
  const wc = liveContents(owner, item);
  if (!wc) return;
  item.pendingNavigation = target;
  const generation = item.navigationGeneration = (item.navigationGeneration || 0) + 1;
  const failed = error => {
    if (!liveContents(owner, item) || generation !== item.navigationGeneration ||
        error?.code === 'ERR_ABORTED' || error?.errno === -3) return;
    emit(owner, item, { error: String(error && error.message || error) });
  };
  try { Promise.resolve(wc.loadURL(target)).catch(failed); }
  catch (error) { failed(error); }
}

function destroyTab(owner, id) {
  owner.pendingShows.delete(id);
  const item = owner.views.get(id);
  if (!item) return;
  owner.views.delete(id);
  item.disposeScheduling?.();
  if (owner.active === id) owner.active = '';
  item.appTabs?.dispose();
  if (item.composer) {
    if (item.embeddedHost) try { item.embeddedHost.contentView.removeChildView(item.composer.view); } catch (_) {}
    try { item.composer.view.webContents.close({ waitForBeforeUnload: false }); } catch (_) { /* already gone */ }
    item.composer = null;
  }
  if (item.chrome) {
    if (item.embeddedHost) try { item.embeddedHost.contentView.removeChildView(item.chrome.view); } catch (_) {}
    try { item.chrome.view.webContents.close({ waitForBeforeUnload: false }); } catch (_) { /* already gone */ }
    item.chrome = null;
  }
  const win = item.detachedWin; item.detachedWin = null;
  if (win) {
    // Dispose owned views when their standalone window closes.
    try { win.destroy(); } catch (_) { /* window may already be gone */ }
  } else {
    try { owner.host.contentView.removeChildView(item.view); } catch (_) { /* ditto */ }
  }
  try { item.view.setVisible(false); } catch (_) { /* ditto */ }
  try { item.view.webContents.close({ waitForBeforeUnload: false }); } catch (_) { /* ditto */ }
}

function releaseSession(owner) {
  if (!owner.closed || owner.liveContents.size || !owner.lease) return;
  owner.lease.release(); owner.lease = null;
}

function ownerSession(owner) {
  if (owner.lease) return owner.lease;
  if (owner.pendingLease) return owner.pendingLease;
  const assign = lease => {
    if (!lease) return null;
    if (owner.closed || OWNERS.get(owner.id) !== owner) { lease.release(); return null; }
    owner.lease = lease; owner.pendingLease = null; return lease;
  };
  const next = SESSION_POOL.acquire(() => !owner.closed && OWNERS.get(owner.id) === owner);
  if (next && typeof next.then === 'function') {
    owner.pendingLease = next.then(assign, error => { owner.pendingLease = null; throw error; });
    return owner.pendingLease;
  }
  return assign(next);
}

function destroyOwner(id) {
  const owner = OWNERS.get(id);
  if (!owner) return;
  owner.closed = true;
  owner.sender.removeListener('destroyed', owner.onDestroyed);
  [...owner.views.keys()].forEach((tabId) => destroyTab(owner, tabId));
  OWNERS.delete(id);
  owner.pendingShows.clear();
  for (const pending of owner.pendingAppRequests?.values() || []) {
    clearTimeout(pending.timer);
    pending.resolve({ ok: false, code: 'APP_CLOSED', reason: '页面已关闭' });
  }
  owner.pendingAppRequests?.clear();
  releaseSession(owner);
}

function resetEmbedded(owner) {
  // A conversation owns inline previews; the document owns application surfaces.
  owner.showOrder++;
  owner.pendingShows.clear();
  owner.active = ''; owner.resumeActive = '';
  for (const item of [...owner.views.values()]) {
    if (!item.detachedWin && !item.embeddedHost) destroyTab(owner, item.id);
  }
  syncVisibility(owner);
  if (!owner.detachedOpenings && ![...owner.views.values()].some(item => item.detachedWin || item.embeddedHost)) {
    destroyOwner(owner.id);
  }
}

function watchDocument(sender) {
  if (WATCHED_DOCUMENTS.has(sender)) return;
  WATCHED_DOCUMENTS.add(sender);
  // A reload replaces the renderer document without destroying WebContents.
  // Keep one observer across chat disposal so old modal state also expires
  // when navigation happens between chat owners. Neither hook retains views.
  const invalidate = () => {
    OCCLUSION.delete(sender);
    destroyOwner(sender.id);
  };
  sender.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) invalidate();
  });
  sender.on('render-process-gone', invalidate);
}

function ownerFor(event) {
  const sender = event.sender;
  if (!sender || sender.isDestroyed()) return null;
  const host = DEPS.BrowserWindow.fromWebContents(sender);
  if (!host || host.isDestroyed()) return null;
  watchDocument(sender);
  let owner = OWNERS.get(sender.id);
  if (!owner) {
    owner = { id: sender.id, sender, host, views: new Map(), active: '',
      pendingShows: new Map(), pendingAppRequests: new Map(), liveContents: new Set(),
      closed: false, lease: null, pendingLease: null, showOrder: 0, resumeActive: '' };
    OWNERS.set(sender.id, owner);
    owner.onDestroyed = () => destroyOwner(sender.id);
    sender.once('destroyed', owner.onDestroyed);
  }
  return owner;
}

function bindView(owner, item) {
  const wc = item.view.webContents;
  const notify = () => emit(owner, item);
  wc.on('did-start-loading', notify);
  wc.on('did-stop-loading', () => {
    item.pendingNavigation = '';
    notify();
    if (item.inspectEnabled || (item.annotations || []).length) {
      injectInspector(owner, item, item.inspectEnabled).catch(error => emit(owner, item, { error: error.message }));
    }
  });
  wc.on('did-navigate', () => { item.appConnection = null; item.pendingNavigation = ''; notify(); });
  wc.on('did-navigate-in-page', () => { item.pendingNavigation = ''; notify(); });
  wc.on('page-title-updated', notify);
  wc.on('console-message', (event, _level, message) => handleInspectorMessage(owner, item,
    typeof message === 'string' ? message : event.message));
  wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame === false || code === -3) return;
    emit(owner, item, { error: description || '页面没有加载成功', failedUrl: url || '' });
  });
  wc.on('render-process-gone', (_event, detail) => {
    emit(owner, item, { error: '预览页面已停止：' + String(detail && detail.reason || '未知原因') });
  });
  wc.on('will-navigate', (event, url) => {
    if (allowedNavigation(url, item)) return;
    event.preventDefault();
    emit(owner, item, { error: '这个地址不在允许的预览范围内' });
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (allowedNavigation(url, item)) {
      setImmediate(() => loadTarget(owner, item, url));
    } else if (/^(?:mailto|tel):/i.test(url)) {
      DEPS.shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });
}

// Session outlives each view; handlers must not close over its owner or contents.
function denyPermissionRequest(_wc, _permission, callback) { callback(false); }
function denyPermissionCheck() { return false; }

function createView(owner, id, appBridge, detached, webContents, partition) {
  const view = new DEPS.WebContentsView({
    ...(webContents ? { webContents } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      partition: partition || owner.lease.partition,
      ...(appBridge ? { preload: APP_PRELOAD } : {}),
    },
  });
  view.setBackgroundColor('#ffffff');
  view.setVisible(false);
  if (!detached) owner.host.contentView.addChildView(view);
  const item = { id, view, ref: '', label: '', requested: '', inspectEnabled: false,
    inspectMode: 'annotate', annotations: [], appBridge: appBridge || null };
  if (appBridge) {
    try { appOwner.capture(item, DEPS); }
    catch (error) { view.webContents.close(); throw error; }
  }
  owner.views.set(id, item);
  const contents = view.webContents;
  owner.liveContents.add(contents);
  contents.once('destroyed', () => {
    owner.liveContents.delete(contents);
    releaseSession(owner);
  });
  const isolated = view.webContents.session;
  isolated.setPermissionRequestHandler(denyPermissionRequest);
  isolated.setPermissionCheckHandler(denyPermissionCheck);
  bindView(owner, item);
  return item;
}

function permitted(owner, id) {
  const state = OCCLUSION.get(owner.sender);
  return !state?.suppressed && (!state?.blocked || state.allowed.has(id));
}
function syncVisibility(owner) {
  for (const item of owner.views.values()) {
    if (item.detachedWin) continue; // Standalone windows manage visibility independently of workspace overlays.
    if (!liveContents(owner, item)) continue;
    if (item.embeddedHost) {
      const b = item.embeddedBounds;
      item.appTabs?.setVisible(owner.active === item.id && permitted(owner, item.id) && b.width >= 32 && b.height >= 32);
      continue;
    }
    const bounds = item.view.getBounds();
    const visible = owner.active === item.id && permitted(owner, item.id) && bounds.width >= 32 && bounds.height >= 32;
    if (item.view.getVisible() !== visible) item.view.setVisible(visible);
  }
}
function setOcclusion(event, payload) {
  const owner = ownerFor(event);
  if (!owner) return { ok: false };
  const before = OCCLUSION.get(owner.sender);
  const blocked = payload?.blocked === true;
  const allowed = new Set((Array.isArray(payload?.allowedTabs) ? payload.allowedTabs : []).slice(0, 100).map(cleanTabId).filter(Boolean));
  if (blocked && !before?.blocked) owner.resumeActive = owner.active;
  OCCLUSION.set(owner.sender, { ...before, blocked, allowed });
  if (!blocked && before?.blocked) {
    if (owner.views.has(owner.resumeActive)) owner.active = owner.resumeActive;
    owner.resumeActive = '';
  }
  syncVisibility(owner);
  return { ok: true };
}
/* Modal dialogs (plugin installer confirmation etc.) are DOM layers and can
   never cover the native WebContentsView. The synchronous bridge parks views
   before the modal paints; the document observer tracks every other overlay.
   Each signal must clear independently before a view may reappear. Keep both
   across owner disposal so changing chats cannot escape an open modal. */
function setSuppressed(event, hidden) {
  const owner = ownerFor(event);
  if (!owner) return { ok: false };
  const next = !!hidden;
  const before = OCCLUSION.get(owner.sender);
  if (!!before?.suppressed === next) return { ok: true };
  OCCLUSION.set(owner.sender, { ...before, suppressed: next });
  try {
    syncVisibility(owner);
  } catch (_) { return { ok: false }; }
  return { ok: true };
}

function setBounds(owner, item, raw) {
  if (!liveContents(owner, item)) return null;
  if (item.embeddedHost) return embeddedBounds(owner, item, raw);
  if (item.detachedWin) {
    try {
      const size = item.detachedWin.getContentBounds();
      return { x: 0, y: 0, width: size.width, height: size.height };
    } catch (_) { return null; }
  }
  const content = owner.host.getContentBounds();
  const bounds = clampBounds(raw, content);
  const visible = owner.active === item.id && permitted(owner, item.id) && bounds.width >= 32 && bounds.height >= 32;
  const current = item.view.getBounds();
  const unchanged = current.x === bounds.x && current.y === bounds.y &&
    current.width === bounds.width && current.height === bounds.height;
  // Re-showing an already visible view is a no-op: on Windows, hiding and
  // re-showing the view (or even re-asserting visibility) drops its native
  // keyboard focus, which blanked the annotation editor's textarea while the
  // workbench kept repainting and re-calling show().
  if (unchanged && item.view.getVisible() === visible) return bounds;
  item.view.setBounds(bounds);
  if (item.view.getVisible() !== visible) item.view.setVisible(visible);
  return bounds;
}

async function show(event, raw) {
  const payload = raw || {};
  const owner = ownerFor(event);
  const id = cleanTabId(payload.tabId);
  if (!owner || !id) return { ok: false, reason: '工作画布没有准备好' };
  const opening = {};
  const order = ++owner.showOrder;
  owner.pendingShows.set(id, opening);
  const pendingLease = ownerSession(owner);
  const lease = pendingLease && typeof pendingLease.then === 'function' ? await pendingLease : pendingLease;
  if (!lease || owner.closed || owner.pendingShows.get(id) !== opening) return closedResult();
  const nextRef = String(payload.ref || '');
  let item = owner.views.get(id);
  const requestedTarget = payload.url ? safeWebUrl(payload.url) : '';
  if (payload.url && !requestedTarget) return { ok: false, reason: '请提供 http 或 https 地址' };
  const requestedBridge = Object.prototype.hasOwnProperty.call(payload, 'appBridge')
    ? (payload.appBridge ? normalizeAppBridge(payload.appBridge, requestedTarget) : null)
    : null;
  if (item && (!liveContents(owner, item) || nextRef && item.ref && item.ref !== nextRef)) {
    destroyTab(owner, id);
    owner.pendingShows.set(id, opening);
    item = null;
  }
  let sameAccount = true;
  try { if (item?.appBridge) appOwner.assertCurrent(item); } catch (_) { sameAccount = false; }
  if (item && (!sameAccount || Boolean(item.appBridge) !== Boolean(requestedBridge) ||
      requestedBridge && (requestedBridge.appId !== item.appBridge?.appId || requestedBridge.origin !== item.appBridge?.origin))) {
    destroyTab(owner, id);
    owner.pendingShows.set(id, opening);
    item = null;
  }
  item = item || createView(owner, id, requestedBridge);
  if (requestedBridge) item.appBridge = requestedBridge;
  const generation = item.showGeneration = (item.showGeneration || 0) + 1;
  item.ref = String(nextRef || item.ref || '');
  item.label = String(payload.label || item.label || '').slice(0, 160);
  item.artifactId = String(payload.artifactId || item.artifactId || '');

  let target = '';
  if (payload.kind === 'artifact' && item.artifactId) {
    const active = await require('./conversation/cloud-output-cache').project(sessions.get(item.ref));
    const started = await artifactRuntime.preview(active, item.ref, item.artifactId);
    if (!liveContents(owner, item)) return closedResult();
    if (generation !== item.showGeneration) return { ok: false, reason: '预览内容已切换' };
    if (!started.ok) return started;
    target = started.url;
  } else if (payload.kind === 'file' && payload.target) {
    const source = sessions.get(item.ref);
    const project = require('./conversation/cloud-output-cache').project;
    const active = await project(source);
    const resolved = fileTarget(item.ref, payload.target, active);
    if (!resolved.ok) return resolved;
    const previewCwd = item.previewCwd = active.cwd;
    if (/\.(?:html?|mp4|m4v|webm|mov|ogv)$/i.test(resolved.path)) {
      const started = await artifactRuntime.previewInput(active, item.ref, resolved.path);
      if (!started.ok) return started;
      if (sessions.get(item.ref) !== source || !liveContents(owner, item) || generation !== item.showGeneration) return closedResult();
      const currentSession = await project(source);
      if (sessions.get(item.ref) !== source || currentSession?.cwd !== previewCwd) return closedResult();
      target = started.url;
    } else target = resolved.url;
  } else if (payload.url) {
    target = requestedTarget;
    if (!target) return { ok: false, reason: '请输入 http 或 https 地址' };
  }
  if (!target && !item.requested) return { ok: false, reason: '没有可以打开的内容' };
  // Closing/hiding or selecting another tab while preparation awaited cannot
  // resurrect the old native surface, even across different tab IDs.
  if (!liveContents(owner, item) || owner.pendingShows.get(id) !== opening || order !== owner.showOrder) return closedResult();
  const occlusion = OCCLUSION.get(owner.sender);
  if (occlusion?.blocked && !occlusion.allowed.has(id)) {
    owner.resumeActive = id;
    // Background layout paints must not replace a plugin's selected browser
    // while a nested confirmation temporarily hides all native views.
    if (!owner.active) owner.active = id;
  } else owner.active = id;
  const bounds = setBounds(owner, item, payload.bounds || {});
  syncVisibility(owner);
  if (target) item.sourceKind = payload.kind === 'artifact' || payload.kind === 'file' ? 'file' : 'url';
  if (target && (target !== item.requested || payload.reload === true)) {
    item.requested = target;
    loadTarget(owner, item, target);
  }
  return { ok: true, bounds, state: snapshot(owner, item) };
}

function current(event, raw) {
  const owner = ownerFor(event);
  const id = cleanTabId(raw && raw.tabId);
  return owner && id ? { owner, item: owner.views.get(id) } : { owner, item: null };
}

async function command(event, raw) {
  const payload = raw || {};
  const found = current(event, payload);
  if (!found.owner || !found.item) return { ok: false, reason: '这个页签已经关闭' };
  const { owner, item } = found;
  const wc = liveContents(owner, item);
  if (!wc) return closedResult();
  const history = wc.navigationHistory;
  const action = String(payload.action || '');
  if (action === 'back' && history.canGoBack()) history.goBack();
  else if (action === 'forward' && history.canGoForward()) history.goForward();
  else if (action === 'reload') wc.reload();
  else if (action === 'stop') { item.navigationGeneration = (item.navigationGeneration || 0) + 1; wc.stop(); }
  else if (action === 'load') {
    const target = safeWebUrl(payload.url);
    if (!target) return { ok: false, reason: '请输入有效的网址' };
    item.requested = target;
    item.showGeneration = (item.showGeneration || 0) + 1;
    item.sourceKind = 'url';
    loadTarget(owner, item, target);
  } else if (action === 'external') {
    const target = /^https?:\/\//i.test(wc.getURL()) ? wc.getURL() : '';
    if (!target) return { ok: false, reason: '本地成果无需跳到外部浏览器' };
    DEPS.shell.openExternal(target).catch(() => {});
  } else if (action === 'inspect') {
    await injectInspector(owner, item, Boolean(payload.enabled), payload);
  } else if (action === 'annotations') {
    await injectInspector(owner, item, item.inspectEnabled, {
      annotations: Array.isArray(payload.annotations) ? payload.annotations : [] });
  }
  const state = snapshot(owner, item);
  return state ? { ok: true, state } : closedResult();
}

function guardWorkbenchDownload(slot, item) {
  // Intercept only passive downloads of current-Hub attachment URLs accidentally routed into the canvas.
  // Allow user-initiated webpage downloads; normal attachment routing bypasses the canvas.
  // Report accidental attachment downloads without opening Save As.
  let url = '';
  try { url = String(item.getURL() || ''); } catch (_) { return false; }
  if (!/^https?:\/\//i.test(url)) return false;
  let hub = '';
  try { hub = String(DEPS?.identityOf?.(DEPS?.app)?.hub || ''); } catch (_) { return false; }
  let origin = '';
  try { origin = hub ? new URL(hub).origin : ''; } catch (_) { return false; }
  if (!origin || !url.startsWith(origin + '/api/v1/attachments/')) return false;
  const owner = [...OWNERS.values()].find(entry => entry.lease?.partition === slot.partition);
  const message = '网页成果不走服务器直链，已为你准备本地成果，请从对话里的成果卡片重新打开';
  if (owner && owner.sender && !owner.sender.isDestroyed()) {
    try { owner.sender.send('work-preview-state', { tabId: String(owner.active || ''), downloadBlocked: message }); } catch (_) {}
  }
  return true;
}

function install(deps) {
  deps.appAI = require('./app-ai-generate.cjs').create(deps);
  DEPS = deps;
  const appCaches = require('./app-cache-management.cjs').create({ getDeps: () => DEPS, ownerFor });
  deps.ipcMain.handle('work-preview-app-cache', async (event, payload) => {
    try { return await appCaches.manage(event, payload); }
    catch (error) { return { ok: false, reason: error.message }; }
  });
  require('./jiyong-hosted-connection.cjs').configure(deps);
  SESSION_POOL = require('./work-preview-sessions.cjs').create({
    session: deps.session || require('electron').session,
    onError: error => console.error('[work-preview] session cleanup failed; partition quarantined:', error.message),
    onDownload: (slot, item) => guardWorkbenchDownload(slot, item),
  });
  deps.ipcMain.handle('work-preview-app-authorize', (event, id) => {
    try { appRequestContext(event, id); return { ok: true }; }
    catch (error) { return { ok: false, reason: error.message }; }
  });
  deps.ipcMain.handle('work-preview-app-request', async (event, payload) => {
    try { return await appRequest(event, payload); }
    catch (error) { return { ok: false, code: 'APP_BRIDGE_ERROR', reason: String(error && error.message || error) }; }
  });
  if (typeof deps.ipcMain.on === 'function') {
    deps.ipcMain.on('work-preview-app-response', (event, payload) => {
      try { resolveAppResponse(event, payload); } catch (_) { /* fail closed */ }
    });
    // Renderer uses sendSync so the native view is parked before the modal paints.
    deps.ipcMain.on('work-preview-suppress', (event, hidden) => {
      event.returnValue = setSuppressed(event, hidden);
    });
  }
  deps.ipcMain.handle('work-preview-show', async (event, payload) => {
    try { return await show(event, payload); }
    catch (error) { return { ok: false, reason: String(error && error.message || error) }; }
  });
  deps.ipcMain.handle('work-preview-occlusion', (event, payload) => {
    try { return setOcclusion(event, payload); }
    catch (_) { return { ok: false }; }
  });
  deps.ipcMain.handle('work-preview-bounds', (event, payload) => {
    try {
      const found = current(event, payload || {});
      if (!found.owner || !found.item) return { ok: false };
      const bounds = setBounds(found.owner, found.item, payload.bounds || {});
      return bounds ? { ok: true, bounds } : closedResult();
    } catch (_) { return { ok: false }; }
  });
  deps.ipcMain.handle('work-preview-command', async (event, payload) => {
    try { return await command(event, payload); }
    catch (error) { return { ok: false, reason: String(error && error.message || error) }; }
  });
  deps.ipcMain.handle('work-preview-show-detached', async (event, payload) => {
    try { return await showDetached(event, payload); }
    catch (error) { return { ok: false, reason: String(error && error.message || error) }; }
  });
  deps.ipcMain.handle('work-preview-show-embedded', async (event, payload) => {
    try { return await showEmbedded(event, payload); }
    catch (error) { return { ok: false, reason: String(error && error.message || error) }; }
  });
  deps.ipcMain.handle('work-preview-window-display', (event) => {
    try { return windowDisplay(event); } catch (_) { return { ok: false }; }
  });
  deps.ipcMain.handle('work-preview-composer-send', async (event, payload) => {
    try { return composerSend(event, payload); }
    catch (error) { return { ok: false, reason: String(error && error.message || error) }; }
  });
  deps.ipcMain.handle('work-preview-composer-activity', (event, payload) => composerActivity(event, payload));
  deps.ipcMain.handle('work-preview-composer-hello', (event) => {
    try { return composerHello(event); } catch (_) { return { ok: false }; }
  });
  deps.ipcMain.handle('work-preview-composer-width', (event, payload) => {
    try { return composerWidth(event, payload); } catch (_) { return { ok: false }; }
  });
  deps.ipcMain.handle('work-preview-composer-mode-set', (event, payload) => {
    try { return composerModeSet(event, payload); } catch (_) { return { ok: false }; }
  });
  deps.ipcMain.handle('work-preview-chrome-action', (event, payload) => {
    try { return chromeAction(event, payload); } catch (_) { return { ok: false }; }
  });
  deps.ipcMain.handle('work-preview-composer-dock', (event, payload) => {
    try { return composerDock(event, payload); } catch (_) { return { ok: false }; }
  });
  deps.ipcMain.handle('work-preview-composer-step', (event, payload) => {
    try { return composerStep(event, payload); } catch (_) { return { ok: false }; }
  });
  deps.ipcMain.handle('work-preview-composer-state', (event, payload) => {
    try { return composerState(payload); } catch (_) { return { ok: false }; }
  });
  deps.ipcMain.handle('work-preview-composer-sent', (event) => {
    try { return composerSent(event); } catch (_) { return { ok: false }; }
  });
  deps.ipcMain.handle('work-preview-app-data-changed',(event,topic)=>require('./app-data-events.cjs').publish(OWNERS,event,topic));
  deps.ipcMain.handle('work-preview-composer-turn-settled', (event) => composerTurnSettled(event));
  deps.ipcMain.handle('work-preview-composer-automation-authorize',(event,id)=>require('./work-preview-app-automation.cjs').authorize(event.sender,id));
  deps.ipcMain.handle('work-preview-composer-automation-result', (event,payload)=>require('./work-preview-app-automation.cjs').finish(event.sender,payload));
  deps.ipcMain.handle('work-preview-composer-submit-result', (event, payload) => require('./work-preview-app-chat.cjs').finish(event.sender, payload));
  deps.ipcMain.handle('work-preview-hide', (event) => {
    const owner = ownerFor(event);
    if (!owner) return { ok: false };
    owner.showOrder++;
    owner.pendingShows.clear();
    owner.active = ''; owner.resumeActive = '';
    syncVisibility(owner);
    return { ok: true };
  });
  deps.ipcMain.handle('work-preview-destroy', (event, tabId) => {
    const owner = ownerFor(event);
    if (!owner) return { ok: false };
    const id = cleanTabId(tabId);
    if (id) destroyTab(owner, id); else destroyOwner(owner.id);
    return { ok: true };
  });
  deps.ipcMain.handle('work-preview-reset-embedded', (event) => {
    const owner = ownerFor(event);
    if (!owner) return { ok: false };
    resetEmbedded(owner);
    return { ok: true };
  });
}

module.exports = {
  appContextFor,
  appRequestContext,
  appContextForPlugin,
  isAppComposer,
  install,
  _setSuppressed: setSuppressed,
  _normalizeAddress: normalizeAddress,
  _safeWebUrl: safeWebUrl,
  _clampBounds: clampBounds,
  _inspectorScript: inspectorScript,
  _inspectorPrefix: INSPECTOR_PREFIX,
};
