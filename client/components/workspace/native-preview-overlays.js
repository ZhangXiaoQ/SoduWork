(function (global) {
  'use strict';
  // Native child views are above every DOM z-index. Observe actual overlay
  // visibility once per document, rather than maintaining a list in each tab.
  // Older menus predate ARIA popup roles. Keep their concrete containers here
  // until they adopt the same semantic contract as newly added overlays.
  const OVERLAYS = 'dialog,[aria-modal="true"],[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[popover],[data-native-preview-overlay],.ntool-drawer,.pui-layer,.tt-modal-mask,.wc-popover,.cp-modelpop,.ws-rail-popover,.cap-add-menu,.library-menu,.cp-skill-menu,.nchat-summary';
  const SLOTS = '[data-native-preview-tab]';
  const MODAL = 'dialog[open],[aria-modal="true"],[data-native-preview-overlay],.ntool-drawer,.pui-layer,.tt-modal-mask';
  function create(window, send) {
    const document = window.document, overlays = new Set(), slots = new Set();
    let observer, disposed = false, queued = false, last = '';
    const visible = node => {
      if (!node?.isConnected || node.closest('[hidden],[aria-hidden="true"]') || !node.getClientRects().length) return false;
      const style = window.getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse';
    };
    // Fractional layout arithmetic can put adjacent edges a few millionths of
    // a pixel apart. Such rounding noise must not hide a neighboring native view.
    const overlaps = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.01 &&
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.01;
    function sync() {
      queued = false;
      if (disposed) return;
      let blocked = document.documentElement.hasAttribute('data-window-menu-overlay') ||
        document.documentElement.hasAttribute('data-modal-overlay');
      let allowed = blocked ? [] : null;
      const hosts = [...slots].filter(node => {
        if (!node.isConnected || !node.matches(SLOTS)) { slots.delete(node); return false; }
        return visible(node);
      });
      for (const node of overlays) {
        if (!node.isConnected || !node.matches(OVERLAYS)) { overlays.delete(node); continue; }
        if (!visible(node)) continue;
        // An inline group is not a modal. Non-modal menus/popovers only hide
        // the native surface when they actually overlap its host rectangle.
        const modal = node.matches(MODAL) && !node.closest('.wes-layer.is-inline');
        if (!modal && !hosts.some(host => !node.contains(host) && overlaps(node.getBoundingClientRect(), host.getBoundingClientRect()))) continue;
        blocked = true;
        // A plugin dialog may own its own browser. Permit that browser only
        // when every active overlay contains it; nested confirmations hide it.
        const contained = hosts.filter(host => node.contains(host)).map(host => host.getAttribute('data-native-preview-tab'));
        allowed = allowed === null ? contained : allowed.filter(id => contained.includes(id));
      }
      const state = { blocked, allowedTabs: [...new Set(allowed || [])].filter(Boolean).sort() };
      const signature = JSON.stringify(state);
      if (signature === last) return;
      last = signature;
      try { Promise.resolve(send(state)).catch(() => {}); } catch (_) { /* Window is closing. */ }
    }
    function schedule() {
      if (disposed || queued) return;
      queued = true;
      window.queueMicrotask(sync);
    }
    function collect(node) {
      if (node?.nodeType !== 1) return false;
      let changed = false;
      for (const [selector, set] of [[OVERLAYS, overlays], [SLOTS, slots]]) {
        if (node.matches(selector)) { set.add(node); changed = true; }
        for (const match of node.querySelectorAll(selector)) { set.add(match); changed = true; }
      }
      return changed;
    }
    collect(document.documentElement);
    observer = new window.MutationObserver(records => {
      let relevant = false;
      for (const record of records) {
        if (record.type === 'childList') {
          for (const node of [...record.addedNodes, ...record.removedNodes]) relevant = collect(node) || relevant;
        } else {
          const node = record.target;
          if (node === document.documentElement || overlays.has(node) || slots.has(node) ||
              node.matches(OVERLAYS + ',' + SLOTS) || [...overlays, ...slots].some(item => node.contains(item))) {
            collect(node); relevant = true;
          }
        }
      }
      if (relevant) schedule();
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['hidden', 'open', 'class', 'style', 'role', 'aria-modal', 'aria-hidden', 'data-native-preview-tab',
        'data-native-preview-overlay', 'data-window-menu-overlay', 'data-modal-overlay'] });
    const events = ['resize', 'soduwork-window-menu-visibility', 'transitionend', 'animationend', 'toggle'];
    events.forEach(name => window.addEventListener(name, schedule, true));
    sync();
    return { sync, dispose() { disposed = true; observer.disconnect(); events.forEach(name => window.removeEventListener(name, schedule, true)); overlays.clear(); slots.clear(); } };
  }
  const api = { create };
  global.NativePreviewOverlays = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global.document?.documentElement && global.soduWorkAPI?.workPreview?.setOcclusion) {
    const monitor = create(global, state => global.soduWorkAPI.workPreview.setOcclusion(state));
    global.addEventListener('pagehide', () => monitor.dispose(), { once: true });
  }
})(typeof window !== 'undefined' ? window : globalThis);
