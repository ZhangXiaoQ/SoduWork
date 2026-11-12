/* Administrator-managed rail placements. Catalog authorization and app opening
   share the existing marketplace/installer and native app runtime. */
(function (global) {
  'use strict';
  let picks = [], activeId = '', tabId = '', generation = 0, request = 0, loaded = false, panel, observer, retryTimer;
  const handles = new Map();
  const preview = () => global.soduWorkAPI?.workPreview;
  const scope = () => global.SoduWorkAPI?.taskStorageKey?.('ops');
  const tr = value => global.SoduWorkI18n?.translateText?.(value) || value;
  function renderRail() {
    const slot = document.getElementById('wsSidebarApps');
    if (!slot) return;
    slot.replaceChildren();
    for (const item of picks) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'ws-rail-button ws-sidebar-app';
      button.setAttribute('data-user-content', '');
      button.dataset.sidebarApp = item.pluginId;
      button.title = item.name; button.setAttribute('aria-label', item.name);
      button.classList.toggle('active', activeId === item.pluginId);
      if (activeId === item.pluginId) button.setAttribute('aria-current', 'page');
      const source = global.SoduWorkPluginIcon?.source(item);
      if (source) {
        const img = document.createElement('img'); img.src = source; img.alt = ''; img.draggable = false;
        img.onerror = () => { img.remove(); button.textContent = String(item.name || 'A').slice(0, 1); };
        button.append(img);
      } else button.textContent = String(item.name || 'A').slice(0, 1);
      button.onclick = () => global.WorkspaceHost?.open('sidebarapp', { pluginId: item.pluginId });
      slot.append(button);
    }
  }
  async function refresh() {
    const api = global.SoduWorkAPI;
    if (!api?.sidebarRecommendations || !api.pluginCatalog) return;
    const ticket = ++request, owner = scope();
    try {
      const [placements, catalog] = await Promise.all([api.sidebarRecommendations(), api.pluginCatalog()]);
      if (ticket !== request || owner !== scope()) return;
      const byId = new Map((catalog?.items || []).filter(item => !item.personal && item.enabled !== false &&
        item.listed !== false && item.permissions?.canUse !== false &&
        item.ui?.contributions?.some(row => row.slot === 'workspace.navigation' &&
          ['external', 'package'].includes(row.source?.type || row.source?.kind) && row.source?.openMode !== 'external'))
        .map(item => [item.pluginId, item]));
      const seen = new Set();
      picks = (placements?.items || []).flatMap(row => {
        const item = row.surface === 'sidebar' && row.kind === 'app' && byId.get(row.targetId);
        if (!item || seen.has(item.pluginId)) return [];
        seen.add(item.pluginId); return [item];
      });
      loaded = true;
      for (const [id, tab] of handles) if (!picks.some(item => item.pluginId === id)) {
        void preview()?.destroy(tab); handles.delete(id);
      }
      if (activeId && !picks.some(item => item.pluginId === activeId)) {
        close();
        if (global.WorkspaceHost?.view === 'sidebarapp') global.WorkspaceHost.open('apps');
      }
      renderRail();
    } catch (_) {
      if (ticket !== request || owner !== scope()) return;
      picks = []; renderRail();
    }
  }
  function mount() {
    renderRail();
    if (!loaded) { loaded = true; void refresh(); }
  }
  function bounds() {
    const b = panel.getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }
  function close() {
    generation++; activeId = ''; tabId = '';
    clearTimeout(retryTimer);
    observer?.disconnect(); observer = null;
    panel?.classList.remove('show');
    void preview()?.hide(); renderRail();
  }
  async function open(payload) {
    close();
    const ticket = generation, owner = scope();
    const current = () => ticket === generation && owner === scope();
    if (!panel) {
      panel = document.createElement('section'); panel.id = 'workspaceAppPanel';
      panel.className = 'workspace-app-panel'; document.body.append(panel);
    }
    panel.classList.add('show'); panel.replaceChildren();
    const startup = document.createElement('div'); startup.className = 'workspace-app-status';
    const candidate = picks.find(item => item.pluginId === payload?.pluginId);
    const mark = document.createElement('div'); mark.className = 'workspace-app-mark';
    const source = global.SoduWorkPluginIcon?.source(candidate);
    if (source) { const image = document.createElement('img'); image.src = source; image.alt = ''; mark.append(image); }
    else mark.textContent = String(candidate?.name || 'A').slice(0, 1);
    const name = document.createElement('b'); name.textContent = candidate?.name || ''; name.setAttribute('data-user-content', '');
    const label = document.createElement('p'); label.textContent = tr('正在打开…');
    startup.append(mark, name, label); panel.append(startup);
    retryTimer = setTimeout(() => {
      if (!current()) return;
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn-mini'; retry.textContent = tr('重新加载');
      retry.onclick = () => global.WorkspaceHost.open('sidebarapp', payload); startup.append(retry);
    }, 120000);
    await refresh();
    if (!current()) return false;
    const item = picks.find(row => row.pluginId === payload?.pluginId);
    if (!item) return false;
    activeId = item.pluginId; renderRail();
    try {
      const result = await global.SoduWorkApps.openAppFromItem(item, { embedded: true, bounds: bounds(), isCurrent: current });
      if (!current() || !result) return false;
      clearTimeout(retryTimer);
      tabId = result.tabId;
      handles.set(item.pluginId, tabId);
      observer = new ResizeObserver(() => { if (tabId) void preview().updateBounds(tabId, bounds()); });
      observer.observe(panel);
      return true;
    } catch (error) {
      if (current()) console.warn('[workspace-app] open failed', error);
      return false;
    }
  }
  function invalidate(event) {
    ++request; picks = []; loaded = false; renderRail();
    if (event.type === 'soduwork-data-scope-changed') { handles.clear(); close(); }
    else void refresh();
  }
  global.WorkspaceSidebarApps = { mount, refresh, renderRail, open, close };
  for (const event of ['soduwork-data-scope-changed', 'soduwork:plugins-changed', 'soduwork-plugin-policy', 'soduwork-device-auth']) global.addEventListener(event, invalidate);
  global.addEventListener('focus', () => { if (loaded) void refresh(); });
  global.addEventListener('soduwork-locale-change', renderRail);
  const timer = setInterval(() => { if (loaded && !document.hidden) void refresh(); }, 60000);
  global.addEventListener('beforeunload', () => clearInterval(timer));
})(window);
