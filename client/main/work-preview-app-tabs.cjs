'use strict';

// A window owns its tabs and one composer. Pages keep separate Chromium history
// and documents, but share the existing owner's isolated session and app scope.
const appOwner = require('./work-preview-app-owner.cjs');
function attach({ owner, item, createView, loadTarget, safeWebUrl, openExternal, layout }) {
  const first = { ...item, appWindowRoot: item };
  if (item.appBridge) appOwner.inherit(first, item);
  const pages = new Map([[first.id, first]]);
  let activeId = first.id, sequence = 0, disposed = false;
  const active = () => pages.get(activeId);
  // Existing window layout/refresh code addresses item.view. Keep the window
  // identity stable even after the initial page closes, while IPC resolves the
  // actual source page through pages rather than this active-view accessor.
  Object.defineProperty(item, 'view', { configurable: true, get: () => active()?.view || first.view });
  const state = () => ({ embedded: !!item.embeddedHost, activeId, startup: active()?.startup || 'loading', canRetry: !!active()?.canRetry && active()?.startup !== 'ready', appLabel: item.label, appVersion: item.appVersion || '', icon: item.icon || '', canBack: !!active()?.view.webContents.navigationHistory.canGoBack(),
    tabs: [...pages.values()].map(page => {
      const wc = page.view.webContents;
      let fallback = '新页面';
      try { fallback = new URL(wc.getURL()).hostname || fallback; } catch (_) {}
      return { id: page.id, title: String(wc.getTitle() || fallback).slice(0, 200), loading: wc.isLoading() };
    }) });
  function publish() {
    if (disposed) return;
    item.schedule?.();
    try { item.chrome?.view.webContents.send('app-window-tabs', state()); } catch (_) {}
  }
  function select(id, focus = true) {
    if (!pages.has(id) || disposed) return false;
    activeId = id;
    for (const page of pages.values()) page.view.setVisible(page.id === id && page.startup === 'ready' && item.surfaceVisible !== false);
    layout();
    if (focus) active().view.webContents.focus();
    publish(); return true;
  }
  function remove(page) {
    page.cancelStartup?.();
    pages.delete(page.id);
    try { (item.detachedWin || item.embeddedHost).contentView.removeChildView(page.view); } catch (_) {}
    try { page.view.webContents.close({ waitForBeforeUnload: false }); } catch (_) {}
  }
  function close(id) {
    const page = pages.get(id);
    if (!page || disposed) return false;
    if (pages.size === 1) { if (item.closeSurface) item.closeSurface(); else item.detachedWin.close(); return true; }
    const ids = [...pages.keys()], index = ids.indexOf(id);
    if (id === activeId) select(ids[index + 1] || ids[index - 1]);
    remove(page); publish(); return true;
  }
  function watch(page) {
    const wc = page.view.webContents;
    let generation = 0, retryTimer;
    page.cancelStartup = () => clearTimeout(retryTimer);
    const status = value => {
      if (disposed || !pages.has(page.id)) return;
      page.startup = value;
      if (value === 'ready') { page.presented = true; page.cancelStartup(); page.canRetry = false; }
      page.view.setVisible(page.id === activeId && value === 'ready' && item.surfaceVisible !== false);
      publish();
    };
    page.beginLoad = () => {
      generation++; page.cancelStartup(); page.canRetry = false;
      // The launch shell gates the first frame only. Hiding an already opened
      // document on every navigation traps usable pages behind slow resources
      // (and suspends page-owned painting) until window.onload eventually fires.
      if (page.presented) { status('ready'); return; }
      status('loading');
      retryTimer = setTimeout(() => {
        if (disposed || !pages.has(page.id) || page.startup === 'ready') return;
        page.canRetry = true; publish();
      }, 120000);
      retryTimer.unref?.();
    };
    page.beginLoad();
    wc.on('did-start-navigation', (event, _url, inPlace, mainFrame) => {
      if ((event?.isMainFrame ?? mainFrame) === false || (event?.isSameDocument ?? inPlace)) return;
      page.beginLoad();
    });
    wc.on('did-finish-load', async () => {
      const current = generation;
      if (page.startup === 'error') return;
      if (page.presented) { status('ready'); return; }
      try {
        // Wait for the document to draw before exposing its native surface.
        // Request a compositor frame even for a hidden view. Page-owned RAF
        // callbacks may be suspended here, especially after a failed navigation.
        await wc.capturePage({ x: 0, y: 0, width: 1, height: 1 }, { stayHidden: true, stayAwake: true });
        if (current === generation && !wc.isDestroyed()) status('ready');
      } catch (_) { if (current === generation) status('error'); }
    });
    wc.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (mainFrame === false || code === -3) return;
      generation++; status(page.presented ? 'ready' : 'error');
    });
    wc.on('render-process-gone', () => { page.presented = false; page.beginLoad(); status('error'); });
    for (const name of ['page-title-updated', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading']) wc.on(name, publish);
    wc.on('did-navigate', () => { page.appConnection = null; publish(); });
    wc.on('content-bounds-updated', event => event.preventDefault());
    wc.on('close', event => { event.preventDefault(); close(page.id); });
    wc.on('render-process-gone', publish);
    wc.setWindowOpenHandler(details => {
      try { if (item.appBridge) appOwner.assertCurrent(page); } catch (_) { return { action: 'deny' }; }
      if (/^(?:mailto|tel):/i.test(details.url)) { void openExternal(details.url).catch(() => {}); return { action:'deny' }; }
      if (!safeWebUrl(details.url) || disposed || pages.size >= 32) return { action: 'deny' };
      return { action: 'allow', outlivesOpener: true, overrideBrowserWindowOptions: { webPreferences: {
        contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      } }, createWindow(options) {
        if (item.appBridge) appOwner.assertCurrent(page);
        if (disposed) throw Error('应用窗口已关闭');
        const id = item.id + ':page-' + (++sequence);
        const page = createView(owner, id, item.appBridge, true, options.webContents);
        owner.views.delete(id); // The app window, not inline-preview cleanup, owns this page.
        page.appWindowRoot = item;
        page.requested = details.url;
        pages.set(id, page);
        (item.detachedWin || item.embeddedHost).contentView.addChildView(page.view);
        page.view.setBorderRadius(12);
        watch(page);
        // Re-add the composer last: a popup must never cover its native surface.
        if (item.composer) (item.detachedWin || item.embeddedHost).contentView.addChildView(item.composer.view);
        if (details.disposition !== 'background-tab') select(id);
        else { nextPage.view.setBounds(item.view.getBounds()); publish(); }
        // Foreground popups retain Chromium's opener, POST body and referrer.
        if (!options.webContents) loadTarget(owner, nextPage, details.url);
        return nextPage.view.webContents;
      } };
    });
  }
  const controller = { pages, active, state, publish, select, close,
    setVisible(visible) {
      item.surfaceVisible = visible;
      for (const page of pages.values()) {
        const show = visible && page.id === activeId && page.startup === 'ready';
        if (page.view.getVisible() !== show) page.view.setVisible(show);
      }
      for (const part of [item.chrome, item.composer]) {
        if (part && part.view.getVisible() !== visible) part.view.setVisible(visible);
      }
      item.schedule?.();
    },
    dispose() {
      disposed = true;
      for (const page of [...pages.values()]) remove(page);
    },
    action(action, id) {
      if (action === 'state') return { ok: true, state: state() };
      if (action === 'select') return { ok: select(id) };
      if (action === 'close') return { ok: close(id) };
      const wc = active()?.view.webContents;
      if (action === 'back' && wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      if (action === 'refresh') { active()?.beginLoad(); wc?.reload(); }
      publish(); return { ok: true };
    },
  };
  item.appTabs = controller;
  watch(first);
  item.chrome?.view.webContents.on('did-finish-load', publish);
  publish();
  return controller;
}
module.exports = { attach };
