'use strict';
// Keep foreground drawing responsive. Background throttling applies only to
// idle/minimized/hidden application surfaces; Agent execution stays in Node.
function attach(item) {
  const applied = new WeakMap();
  const update = () => {
    const host = item.detachedWin || item.embeddedHost;
    if (!host || host.isDestroyed()) return;
    const foreground = !host.isMinimized?.() && (item.embeddedHost ? item.surfaceVisible !== false : host.isVisible());
    const pages = item.appTabs ? [...item.appTabs.pages.values()] : [item];
    const loading = pages.some(page => page.startup === 'loading');
    const throttle = !(foreground || loading || item.composer?.busy);
    const views = [...pages.map(page => page.view), item.chrome?.view, item.composer?.view].filter(Boolean);
    for (const view of views) {
      const wc = view.webContents;
      if (!wc || wc.isDestroyed() || applied.get(wc) === throttle) continue;
      try { wc.setBackgroundThrottling?.(throttle); applied.set(wc, throttle); } catch (_) {}
    }
  };
  item.schedule = update;
  const host = item.detachedWin || item.embeddedHost;
  for (const event of ['minimize', 'restore', 'show', 'hide']) host.on(event, update);
  item.disposeScheduling = () => { for (const event of ['minimize', 'restore', 'show', 'hide']) host.removeListener(event, update); };
  update();
}
module.exports = { attach };
