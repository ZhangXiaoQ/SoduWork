/*
 * Application catalog for custom interfaces and external H5 apps. Interface plugins share
 * the package/install channel; opening one launches its work surface rather than a
 * conversation. Personal/favorite sections use installed items, the market uses the remote
 * catalog, and isolated web views receive only manifest-authorized bridge capabilities.
 */

const APPS_GLYPH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.65" stroke-linejoin="round" d="M5 4.75h5.5v5.5H5zM13.5 4.75H19v5.5h-5.5zM5 13.75h5.5v5.5H5zM13.5 13.75H19v5.5h-5.5z"/></svg>';
const APPS_ICONS = {
  gift: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><g stroke="none"><rect x="5" y="12.75" width="14" height="7.5" rx="1.5" fill="#7c5cf0"/><rect x="3.75" y="9.5" width="16.5" height="3.9" rx="1.4" fill="#4f8df7"/><path d="M11.25 13.4v7.4a.75.75 0 0 0 1.5 0v-7.4Z" fill="#ffffff" opacity=".85"/><rect x="5.35" y="4.35" width="3.2" height="3.2" rx=".9" fill="#f59e0b"/><rect x="10.55" y="2.6" width="2.9" height="2.9" rx=".8" fill="#ec4899"/><circle cx="17.35" cy="5.6" r="1.6" fill="#22d3ee"/></g><path d="M12 7.25V5.9" stroke="#7c5cf0" stroke-width="1.5" stroke-linecap="round"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16.2 16.2 4.3 4.3"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.35-5.65"/><path d="M20 3.5V8h-4.5"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 5.5v13M5.5 12h13"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.25"/><path d="M3.75 12h16.5M12 3.75c2.4 2.1 3.6 4.9 3.6 8.25s-1.2 6.15-3.6 8.25c-2.4-2.1-3.6-4.9-3.6-8.25s1.2-6.15 3.6-8.25Z"/></svg>',
  monitor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.75" y="5.25" width="16.5" height="10.5" rx="1.75"/><path d="M9.25 19.5h5.5M12 15.75v3.75"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M13.25 3.75 6.5 13.5h4.25l-.75 6.75 6.75-9.75h-4.25Z"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5.5 12.5 4.2 4.2 8.8-9.4"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="m12 4 2.35 4.9 5.35.72-3.92 3.75.92 5.3L12 15.9l-4.62 2.05.92-5.3-3.92-3.75 5.35-.72Z"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/></svg>',
};
const APPS_FAV_KEY = 'soduwork-apps-favorites';
let _appsRenderSeq = 0;
let _appsCache = null; /* Cache all local and remote applications; search filters every section. */
let _appsSettingsSeq = 0;
let _appsImportSeq = 0;
const _appsUi = { query: '' };

function appKeyOf(item) {
  return String(item && (item.pluginId || item.key || item.id) || '').trim() || 'unknown';
}
function favoriteAppIds() {
  try { return JSON.parse(localStorage.getItem(APPS_FAV_KEY) || '[]') || []; }
  catch (_e) { return []; }
}
function toggleFavoriteApp(key) {
  const ids = favoriteAppIds();
  const at = ids.indexOf(key);
  if (at >= 0) ids.splice(at, 1); else ids.push(key);
  try { localStorage.setItem(APPS_FAV_KEY, JSON.stringify(ids)); } catch (_e) { /* Continue if local preference storage fails. */ }
  return at < 0;
}
function removeFavoriteApp(key) {
  const ids = favoriteAppIds();
  const at = ids.indexOf(key);
  if (at < 0) return;
  ids.splice(at, 1);
  try { localStorage.setItem(APPS_FAV_KEY, JSON.stringify(ids)); } catch (_e) { /* Continue if local preference storage fails. */ }
}

/* Creation still selects an app type; catalog cards identify only the local installation source. */
const APP_KIND_LABELS = { web: '网页即用', desktop: '桌面客户端', lite: '轻即用' };
function appSourceTagHtml(app) {
  return app.item.personal ? '<span class="appsx-source-tag">本机</span>' : '';
}
function appVersionTagHtml(app) {
  const item = app.item;
  const installed = Boolean(item.personal || item.installed);
  const version = String((installed && item.installedVersion) || item.version || '').trim();
  if (!version) return '';
  return '<span class="appsx-version-tag" title="' + (installed ? '当前版本：' : '市场版本：') +
    escapeAppsHtml(version) + '">v' + escapeAppsHtml(version) + '</span>';
}
async function appSettingsOf(key) {
  const api = window.soduWorkAPI?.appSettings;
  if (!api) throw Error('即用设置需要更新客户端后使用');
  let result = await api.get(key);
  if (!result?.ok) throw Error(result?.reason || '即用设置读取失败');
  const legacyKey = 'soduwork-app-settings:' + key;
  const legacy = localStorage.getItem(legacyKey);
  if (legacy) {
    const values = Object.fromEntries(Object.entries(JSON.parse(legacy)).filter(([key]) => !result.configuredKeys.includes(key)));
    if (Object.keys(values).length) {
      result = await api.update(key, { values, expectedRevision: result.revision });
      if (!result?.ok) throw Error(result?.reason || '旧设置迁移失败');
    }
    localStorage.removeItem(legacyKey);
  }
  return result;
}
async function saveAppSettings(key, options) {
  const result = await window.soduWorkAPI.appSettings.update(key, options);
  if (!result?.ok) throw Error(result?.reason || '即用设置保存失败');
  window.dispatchEvent(new CustomEvent('soduwork:app-settings-changed', { detail: { appKey: key } }));
}

function openAppsPanel() {
  let p = document.getElementById('appsPanel');
  if (!p) {
    p = document.createElement('div');
    p.id = 'appsPanel';
    p.className = 'sch-panel appsx';
    p.innerHTML = appsPageHtml();
    document.body.appendChild(p);
    bindAppsPage(p);
    if (typeof makeDraggable === 'function') makeDraggable(p, p.querySelector('.appsx-top'));
    /* Refresh an open catalog after installation, removal, or policy changes. */
    window.addEventListener('soduwork:plugins-changed', function () {
      _appsCache = null;
      if (p.classList.contains('show')) renderAppsCatalog(true);
    });
    window.addEventListener('soduwork-plugin-policy', function () {
      ++_appsRenderSeq; _appsCache = null;
      if (p.classList.contains('show')) renderAppsCatalog(true);
      else p.querySelector('#appsBody').textContent = '';
    });
    window.addEventListener('soduwork-locale-change', function () {
      _appsCache = null;
      if (p.classList.contains('show')) renderAppsCatalog(true);
    });
    window.addEventListener('soduwork-data-scope-changed', function () {
      closeAppSettings();
      ++_appsRenderSeq; _appsCache = null; _appsUi.query = '';
      p.querySelector('#appsSearch').value = '';
      if (p.classList.contains('show')) renderAppsCatalog(true);
    });
  }
  p.classList.add('show');
  if (typeof expandForOverlay === 'function') expandForOverlay();
  renderAppsCatalog(true);
}

function closeAppsPanel() {
  const p = document.getElementById('appsPanel');
  if (p && p.classList.contains('show')) {
    p.classList.remove('show');
    if (typeof shrinkFromOverlay === 'function') shrinkFromOverlay();
  }
}

function appsPageHtml() {
  return '<div class="appsx-top">' +
    '<div class="appsx-title-wrap"><h1 class="appsx-title"><span class="appsx-title-gift" aria-hidden="true">' + APPS_ICONS.gift + '</span>即用</h1>' +
    '<p class="appsx-sub">AI有界面，做事更清晰！即开即用，你的AI场景工作台</p></div>' +
    '<div class="appsx-tools">' +
    '<label class="appsx-search">' + APPS_ICONS.search +
    '<input id="appsSearch" type="text" placeholder="搜索即用" spellcheck="false" autocomplete="off"></label>' +
    '<button class="appsx-icon-btn" id="appsRefresh" title="刷新" type="button">' + APPS_ICONS.refresh + '</button>' +
    '<button class="appsx-pill" id="appsAdd" type="button">快速创建即用 ' + APPS_ICONS.plus + '</button>' +
    '<button class="appsx-icon-btn" id="appsClose" title="关闭" type="button">' + APPS_ICONS.close + '</button>' +
    '</div></div>' +
    '<div class="appsx-scroll" id="appsBody"></div>';
}

function bindAppsPage(p) {
  p.querySelector('#appsSearch').addEventListener('input', function () {
    _appsUi.query = this.value || '';
    renderAppsCatalog(false); /* Filter and render cached entries without refetching the catalog. */
  });
  p.querySelector('#appsRefresh').addEventListener('click', function () {
    this.classList.remove('is-spinning'); void this.offsetWidth; this.classList.add('is-spinning');
    renderAppsCatalog(true);
  });
  p.querySelector('#appsAdd').addEventListener('click', function () {
    openAppsCreateDialog();
  });
  p.querySelector('#appsClose').addEventListener('click', closeAppsPanel);
}

/*
 * Use the shared plugin catalog, including authorized uninstalled remote applications.
 * Group installed and market entries together; the sidebar's three-item limit does not apply here.
 */
async function loadAppsCatalog() {
  const plugins = await Promise.allSettled([(window.SoduWorkAPI && typeof window.SoduWorkAPI.pluginCatalog === 'function')
    ? window.SoduWorkAPI.pluginCatalog() : Promise.resolve({ items:[] })]).then(results => results[0]);
  const result = plugins.status === 'fulfilled' ? plugins.value : { items:[],remoteError:'插件即用暂时无法加载：' + plugins.reason.message };
  if (plugins.status === 'rejected') throw plugins.reason;
  const items = Array.isArray(result && result.items) ? result.items : [];
  const apps = [];
  items.forEach(function (item) {
    if (!item || item.enabled === false) return;
    if (!item.personal && item.permissions && item.permissions.canUse === false) return;
    const rows = item.ui && Array.isArray(item.ui.contributions) ? item.ui.contributions : [];
    let row = null;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i].slot === 'workspace.navigation') { row = rows[i]; break; }
    }
    if (!row) return;
    apps.push({
      item,
      row,
      title: String(item.name || row.title || '即用'),
      desc: String(item.description || row.description || ''),
    });
  });
  /* Sort built-ins first, then names; favorites retain their own order. */
  apps.sort(function (a, b) {
    const ab = a.item.builtIn ? 0 : 1, bb = b.item.builtIn ? 0 : 1;
    if (ab !== bb) return ab - bb;
    return a.title.localeCompare(b.title, 'zh-Hans-CN');
  });
  apps.remoteError = String(result && result.remoteError || '');
  return apps;
}

function appsMatchingQuery(all) {
  let list = all;
  const query = _appsUi.query.trim().toLowerCase();
  if (query) {
    list = list.filter(function (app) {
      return (app.title + ' ' + app.desc).toLowerCase().includes(query);
    });
  }
  return list;
}

async function renderAppsCatalog(force) {
  const body = document.getElementById('appsBody');
  if (!body) return;
  if (_appsCache && !force) {
    ++_appsRenderSeq; /* Invalidate pending requests and render the cache immediately. */
    renderAppsInto(body, _appsCache);
    return;
  }
  const ticket = ++_appsRenderSeq;
  if (!_appsCache) body.innerHTML = '<div class="appsx-loading">正在载入即用…</div>';
  let apps;
  try { apps = await loadAppsCatalog(); }
  catch (error) {
    if (ticket !== _appsRenderSeq) return;
    if ([401, 403].includes(Number(error && error.status))) _appsCache = null;
    if (_appsCache) appsRefreshNotice(body, error);
    else renderAppsError(body, error);
    return;
  }
  if (ticket !== _appsRenderSeq) return; /* Discard stale catalog refresh results. */
  if (_appsCache && apps.remoteError) {
    appsRefreshNotice(body, new Error(apps.remoteError));
    return;
  }
  appsRefreshNotice(body);
  const unchanged = _appsCache && JSON.stringify([_appsCache, _appsCache.remoteError]) === JSON.stringify([apps, apps.remoteError]);
  _appsCache = apps;
  if (!unchanged) renderAppsInto(body, apps);
}

function appsRefreshNotice(body, error) {
  body.querySelector('#appsRefreshNotice')?.remove();
  if (!error) return;
  if (_appsCache) _appsCache.remoteError = String(error.message || error);
  // A failed refresh is not evidence that the market is empty. Keep cached
  // cards, but remove a previous empty-state claim until a real fetch succeeds.
  body.querySelector('[data-apps-section="market"] .appsx-empty')?.remove();
  const notice = document.createElement('p');
  notice.id = 'appsRefreshNotice'; notice.className = 'appsx-market-error';
  notice.setAttribute('role', 'status');
  notice.textContent = '刷新失败，正在显示上次内容。';
  const retry = document.createElement('button');
  retry.className = 'btn-mini'; retry.type = 'button'; retry.textContent = '重试';
  retry.setAttribute('data-apps-retry', '');
  retry.addEventListener('click', () => renderAppsCatalog(true)); notice.appendChild(retry);
  body.prepend(notice);
}

function appsSectionsFor(list) {
  const installed = list.filter(app => app.item.personal || app.item.installed);
  const market = list.filter(app => !app.item.personal && app.item.listed !== false);
  const query = _appsUi.query.trim().toLowerCase();
  const recommendations = (_appsCache || []).filter(app => !app.item.personal && app.item.marketPolicy?.featured && app.item.listed !== false)
    .map(app => {
      const local = installed.find(candidate => candidate.item.personal && (
        candidate.item.sourcePluginId === app.item.pluginId ||
        (candidate.item.key && candidate.item.key === app.item.key && /^https?:/.test(candidate.row.source?.url || '') && candidate.row.source.url === app.row.source?.url)));
      return local ? { ...local, item: { ...local.item, coverUrl: app.item.coverUrl || local.item.coverUrl } } : app;
    }).filter(app => !query || (app.title + ' ' + app.desc).toLowerCase().includes(query));
  // Recommendations are independent exposure groups and may include a favorited installed application.
  // Favorites and the remaining personal list are mutually exclusive to avoid duplicates.
  const ids = favoriteAppIds();
  const favorites = installed.filter(app => ids.indexOf(appKeyOf(app.item)) >= 0)
    .sort((a, b) => ids.indexOf(appKeyOf(b.item)) - ids.indexOf(appKeyOf(a.item)));
  const remaining = installed.filter(app => ids.indexOf(appKeyOf(app.item)) < 0);
  return [
    ...(recommendations.length ? [{ key: 'recommended', label: '推荐', items: recommendations }] : []),
    ...(favorites.length ? [{ key: 'favorites', label: '常用', items: favorites }] : []),
    { key: 'mine', label: '我的', items: remaining },
    { key: 'market', label: '市场', items: market },
  ];
}

function appsEmptyHtml(query, section, allInFavorites) {
  if (!query && (section === 'recommended' || section === 'favorites')) return '';
  if (section === 'recommended') return '<p class="appsx-section-empty">' + (query ? '推荐即用中没有匹配结果。' : '暂无推荐即用。') + '</p>';
  if (section === 'mine' && allInFavorites && !query) {
    return '<p class="appsx-section-empty">已安装的即用可在上方分组中打开。</p>';
  }
  if (section === 'favorites') {
    return '<p class="appsx-section-empty">' + (query ? '常用即用中没有匹配结果。' : '点击即用卡片上的 ★，将常用即用固定在这里。') + '</p>';
  }
  if (query) {
    return '<div class="appsx-empty"><span class="appsx-empty-ico">' + APPS_ICONS.search + '</span>' +
      '<b>没有找到「' + escapeAppsHtml(query) + '」</b>' +
      '<span>换个关键词，或浏览下方的市场即用。</span></div>';
  }
  if (section === 'mine') {
    return '<div class="appsx-empty"><span class="appsx-empty-ico">' + APPS_GLYPH + '</span>' +
      '<b>还没有我的即用</b>' +
      '<span>从市场添加远端即用，或导入本机的 .soduwork-plugin 即用包。</span>' +
      '<button class="appsx-pill small" id="appsEmptyInstall" type="button">安装即用包</button></div>';
  }
  return '<div class="appsx-empty"><span class="appsx-empty-ico">' + APPS_GLYPH + '</span>' +
    '<b>市场暂无即用</b>' +
    '<span>这里展示远端发布并向你开放的即用。</span></div>';
}

function renderAppsError(body, error) {
  body.innerHTML = '<div class="appsx-empty" role="status"><b>即用目录暂时无法加载</b><span>' +
    escapeAppsHtml(String(error && error.message || error)) + '</span><button class="appsx-pill small" data-apps-retry>重试</button></div>';
  body.querySelector('[data-apps-retry]').addEventListener('click', () => renderAppsCatalog(true));
}

function appsCardHtml(app, index, recommended, conversation) {
  const customIcon = (window.SoduWorkPluginIcon && SoduWorkPluginIcon.imageFor(app.item)) || '';
  const key = appKeyOf(app.item);
  const faved = favoriteAppIds().indexOf(key) >= 0;
  const favorite = '<button class="appsx-act appsx-fav' + (faved ? ' is-fav' : '') + '" type="button" aria-pressed="' + faved + '" title="' +
    (faved ? '取消常用' : '收藏为常用') + '" aria-label="' + (faved ? '取消常用' : '收藏为常用') + '">' + APPS_ICONS.star + '</button>';
  const needsSync = !app.item.personal && (!app.item.installed || app.item.updateAvailable);
  let cover = '';
  try { const url = new URL(app.item.coverUrl || app.item.marketPolicy?.coverUrl || ''); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) cover = url.href; } catch (_) {}
  if (recommended) return '<div class="appsx-card appsx-cover-card" data-app-index="' + index + '" role="button" tabindex="0" aria-label="' + escapeAppsHtml(app.title) + '">' +
    '<div class="appsx-cover">' + (cover ? '<img src="' + escapeAppsHtml(cover) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '<span>' + APPS_GLYPH + '</span>') +
    '</div><div class="appsx-cover-info"><div class="appsx-cover-copy"><div class="appsx-cover-meta"><span class="appsx-app-ico' + (customIcon ? ' has-img' : '') + '">' + (customIcon || APPS_GLYPH) + '</span>' +
    '<span class="appsx-card-txt"><span class="appsx-card-headline"><b data-user-content>' + escapeAppsHtml(app.title) + '</b>' + appVersionTagHtml(app) + '</span></span></div>' +
    '<p class="appsx-cover-desc"' + (app.desc ? ' data-user-content' : '') + '>' + escapeAppsHtml(app.desc || '打开即用工作界面') + '</p></div>' +
    '<div class="appsx-cover-actions"><div class="appsx-cover-tools">' + favorite +
    (!needsSync ? '<button class="appsx-act appsx-set" type="button" title="即用设置" aria-label="即用设置">' + APPS_ICONS.gear + '</button>' : '') + '</div>' +
    '<button class="appsx-card-open" type="button" aria-label="打开即用">打开即用</button></div></div></div>';
  return '<div class="appsx-card' + (conversation ? ' nmessage-app-card' : '') + '" ' +
    (conversation ? 'data-chat-app="' + escapeAppsHtml(key) + '"' : 'data-app-index="' + index + '"') + ' role="button" tabindex="0" title="' + (needsSync ? (app.item.updateAvailable ? '升级并打开即用' : '添加并打开即用') : '打开即用') + '">' +
    '<span class="appsx-app-ico' + (customIcon ? ' has-img' : '') + '">' + (customIcon || APPS_GLYPH) + '</span>' +
    '<span class="appsx-card-txt"><span class="appsx-card-headline"><b data-user-content>' + escapeAppsHtml(app.title) + '</b>' + appVersionTagHtml(app) + '</span>' +
    '<small class="appsx-card-description">' + appSourceTagHtml(app) + '<span class="appsx-description-text"' + (app.desc ? ' data-user-content' : '') + '>' + (app.desc ? escapeAppsHtml(app.desc) : '打开即用工作界面') + '</span></small></span>' +
    (needsSync ? '<span class="appsx-card-add" aria-hidden="true">' + APPS_ICONS.plus + '</span>' : '') +
    '<span class="appsx-card-acts">' +
    (!needsSync ? '<button class="appsx-act appsx-set" type="button" title="即用设置" aria-label="即用设置">' + APPS_ICONS.gear + '</button>' : '') +
    favorite + (conversation ? '<button type="button" class="appsx-card-open" data-chat-open-app="' + escapeAppsHtml(key) + '">打开即用</button>' : '') + '</span></div>';
}

function renderAppsInto(body, all) {
  const list = [], visible = appsMatchingQuery(all);
  let html = '';
  if (all.remoteError) {
    html += '<p class="appsx-market-error" role="status">远端市场暂时无法加载：' + escapeAppsHtml(all.remoteError) + '<button class="btn-mini" type="button" data-apps-retry>重试</button></p>';
  }
  html += appsSectionsFor(visible).map(function (section) {
    const cards = section.items.map(app => appsCardHtml(app, list.push(app) - 1, section.key === 'recommended')).join('');
    return '<section class="appsx-section" data-apps-section="' + section.key + '">' +
      '<header class="appsx-sec-head"><h2>' + escapeAppsHtml(section.label) + '</h2></header>' +
      (cards ? '<div class="appsx-grid">' + cards + '</div>' :
        (section.key === 'market' && all.remoteError ? '' : appsEmptyHtml(_appsUi.query.trim(), section.key,
          visible.some(app => app.item.personal || app.item.installed)))) + '</section>';
  }).join('');
  body.innerHTML = html;
  body.querySelector('[data-apps-retry]')?.addEventListener('click', () => renderAppsCatalog(true));
  body.querySelectorAll('.appsx-cover img').forEach(img => img.addEventListener('error', () => { img.hidden = true; img.parentElement.classList.add('is-fallback'); }));

  /* Click a card to open the application; favorite/settings controls handle their own events. */
  body.querySelectorAll('.appsx-card').forEach(function (card) {
    const app = list[Number(card.dataset.appIndex)];
    if (!app) return;
    const key = appKeyOf(app.item);
    card.addEventListener('click', function (event) {
      if (event.target.closest('.appsx-act')) return; /* Badge actions must not also open the application. */
      openAppsCard(app, card);
    });
    card.addEventListener('keydown', function (event) {
      if (event.target !== card) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openAppsCard(app, card); }
    });
    const fav = card.querySelector('.appsx-fav');
    if (fav) fav.addEventListener('click', function () {
      toggleFavoriteApp(key);
      renderAppsCatalog(false); /* Update matching favorite indicators across both sections. */
    });
    const set = card.querySelector('.appsx-set');
    if (set) set.addEventListener('click', function () { openAppSettings(app); });
  });
  const emptyInstall = body.querySelector('#appsEmptyInstall');
  if (emptyInstall) emptyInstall.addEventListener('click', installAppPackage);
}

/* Application settings and H5 settings.get/update share main-process secure storage. */
function jiyongSettingsFields(item, record) {
  const declaration = item.conversationJiyong || item.jiyong;
  const fields = declaration?.parameters?.filter(p => p.display !== 'hidden') || [];
  const esc = escapeAppsHtml;
  return {fields, html:fields.map(p => {
    const value = record.values[p.key] ?? p.default;
    const attr = ' data-jiyong-parameter="' + esc(p.key) + '"';
    let input;
    if (p.display === 'switch') input = '<input type="checkbox"' + attr + (value === true ? ' checked' : '') + '>';
    else if (p.display === 'select' || p.display === 'multiselect') input = '<select' + attr + (p.display === 'multiselect' ? ' multiple' : '') + '>' + (p.options || []).map(v => '<option value="' + esc(v) + '"' + ((Array.isArray(value) ? value : [value]).includes(v) ? ' selected' : '') + '>' + esc(v) + '</option>').join('') + '</select>';
    else if (p.display === 'textarea') input = '<textarea' + attr + '>' + esc(value ?? '') + '</textarea>';
    else input = '<input' + attr + ' type="' + (p.secret || p.display === 'password' ? 'password' : p.display === 'number' ? 'number' : 'text') + '" autocomplete="off" value="' + esc(p.secret ? '' : value ?? '') + '" placeholder="' + (record.configuredKeys.includes(p.key) && p.secret ? '已配置；留空保留原值' : '') + '">';
    return '<label class="appsx-parameter"><span>' + esc(p.label || p.key) + '</span>' + input + '</label>';
  }).join('')};
}
async function openAppSettings(app) {
  if (!app) return;
  const ticket = ++_appsSettingsSeq;
  const key = appKeyOf(app.item);
  let record;
  try { record = await appSettingsOf(key); } catch (error) { sayAppsMessage(error.message); return; }
  if (ticket !== _appsSettingsSeq) return;
  const fields = window.SoduWorkPluginInstallSetup?.preferences;
  const setup = fields ? fields.schema(app.item) : { preferences: [] };
  setup.preferences = setup.preferences.filter(field => field.key !== 'ukey' && !record.secretKeys.includes(field.key));
  const declared = jiyongSettingsFields(app.item,record);
  let mask = document.getElementById('appsSettingsMask');
  if (!mask) {
    mask = document.createElement('div');
    mask.id = 'appsSettingsMask';
    mask.className = 'appsx-mask';
    mask.innerHTML = '<div class="appsx-modal" role="dialog" aria-label="即用设置"></div>';
    document.body.appendChild(mask);
    mask.addEventListener('pointerdown', function (event) { if (event.target === mask) closeAppSettings(); });
    document.addEventListener('keydown', function onKey(event) {
      if (event.key === 'Escape' && mask.classList.contains('show')) { closeAppSettings(); event.stopPropagation(); }
    });
  }
  const modal = mask.querySelector('.appsx-modal');
  const icon = window.SoduWorkPluginIcon?.imageFor(app.item) || APPS_GLYPH;
  const version = String(app.item.installedVersion || app.item.version || '').trim();
  modal.innerHTML =
    '<header class="appsx-modal-head"><b>即用设置</b>' +
    '<button class="appsx-icon-btn" id="appsSetClose" type="button">' + APPS_ICONS.close + '</button></header>' +
    '<div class="appsx-modal-body">' +
    '<section class="appsx-settings-info" aria-label="即用信息"><span class="appsx-settings-icon" role="img" aria-label="即用图标">' + icon + '</span>' +
    '<div class="appsx-settings-copy"><b class="appsx-settings-name" data-user-content>' + escapeAppsHtml(app.title) + '</b>' +
    '<span class="appsx-settings-version">' + escapeAppsHtml(version ? '版本 v' + version : '版本未知') + '</span>' +
    '<p class="appsx-settings-description"' + (app.desc || app.item.description ? ' data-user-content' : '') + '>' + escapeAppsHtml(app.desc || app.item.description || '暂无描述') + '</p></div></section>' +
    '<label class="appsx-developer-field"><span>开发者</span>' +
    (app.item.personal && !app.item.builtIn ? '<input id="appsSetDeveloper" type="text" maxlength="120" value="' + escapeAppsHtml(app.item.authorName || '') + '" placeholder="填写开发者或工作室名称">' : '<b' + (app.item.authorName ? ' data-user-content' : '') + '>' + escapeAppsHtml(app.item.authorName || '未填写') + '</b>') + '</label>' +
    '<label class="appsx-developer-field"><span>即用分类</span>' +
    (app.item.personal && !app.item.builtIn ? '<select id="appsSetCategory">' + APPS_CREATE_CATEGORIES.map(row => '<option value="' + row.id + '"' + (row.id === (app.item.appCategory || 'other') ? ' selected' : '') + '>' + row.title + '</option>').join('') + '</select>' : '<b>' + (APPS_CREATE_CATEGORIES.find(row => row.id === app.item.appCategory)?.title || '其他') + '</b>') + '</label>' +
    (setup.preferences.length ? fields.render(setup, app.item.setupConfig || {}, escapeAppsHtml) : '') +
    declared.html +
    (window.soduWorkAPI?.workPreview?.appCache ? '<section class="appsx-cache"><div><b>临时缓存</b><small id="appsCacheSize" role="status">正在计算缓存大小…</small><small>保留登录信息、业务数据和文件</small></div><button class="btn-mini" id="appsCacheClear" type="button">清理缓存</button></section>' : '') +
    '<p class="appsx-settings-error" id="appsSetError" role="alert" hidden></p>' +
    '</div>' +
    '<footer class="appsx-modal-foot"><button class="appsx-remove" id="appsSetRemove" type="button">移除即用</button><span class="push"></span>' +
    (app.item.personal && !app.item.builtIn ? '<button class="appsx-publish" id="appsSetPublish" type="button">申请上架</button>' : '') +
    (app.item.personal && !app.item.builtIn ? '<button class="appsx-pill small" id="appsSetEdit" type="button">修改即用</button>' : '') +
    (setup.preferences.length || declared.fields.length || (app.item.personal && !app.item.builtIn) ? '<button class="appsx-pill small" id="appsSetSave" type="button">保存</button>' : '') + '</footer>';
  mask.classList.add('show');
  function showError(message) {
    const target = modal.querySelector('#appsSetError'); target.hidden = false; target.textContent = message;
    target.scrollIntoView({ block: 'nearest' });
  }
  const cacheButton = modal.querySelector('#appsCacheClear');
  if (cacheButton) {
    const scope = window.SoduWorkAPI?.taskStorageKey?.('ops');
    const current = () => ticket === _appsSettingsSeq && scope === window.SoduWorkAPI?.taskStorageKey?.('ops');
    const cacheStatus = modal.querySelector('#appsCacheSize');
    let cacheRequest = 0;
    const updateCache = async action => {
      const request = ++cacheRequest;
      cacheButton.disabled = true;
      if (action === 'clear') cacheStatus.textContent = '正在清理缓存…';
      try {
        const result = await window.soduWorkAPI.workPreview.appCache({ pluginId: key, action });
        if (!current() || request !== cacheRequest) return;
        if (!result?.ok) throw Error(result?.reason || '缓存操作失败，请重试');
        cacheStatus.textContent = (action === 'clear' ? '已清理，当前缓存：' : '当前缓存：') + (result.bytes / 1048576).toFixed(2) + ' MB';
        if (result.shared) {
          const note = document.createElement('small'); note.textContent = '网页资源缓存由当前工作区的应用共用';
          if (!cacheStatus.parentElement.querySelector('[data-cache-shared]')) { note.setAttribute('data-cache-shared', ''); cacheStatus.parentElement.append(note); }
        }
      } catch (error) {
        if (current() && request === cacheRequest) cacheStatus.textContent = error.message;
      } finally { if (current() && request === cacheRequest) cacheButton.disabled = false; }
    };
    cacheButton.addEventListener('click', () => { void updateCache('clear'); });
    void updateCache('stats');
  }
  modal.querySelector('#appsSetClose').addEventListener('click', closeAppSettings);
  modal.querySelector('#appsSetEdit')?.addEventListener('click',async function() {
    this.disabled = true;
    try { await window.PluginBuilderEntry.editApp(app.item.pluginId); closeAppSettings(); }
    catch (error) { this.disabled=false;showError(error.message); }
  });
  async function saveAppMetadata() {
    const developer = modal.querySelector('#appsSetDeveloper'), category = modal.querySelector('#appsSetCategory');
    if (!developer || !category) return;
    if (developer.value.trim() === String(app.item.authorName || '') && category.value === (app.item.appCategory || 'other')) return;
    const saved = await window.soduWorkAPI.personalPlugins.updateMetadata(app.item.pluginId,{author:developer.value.trim(),appCategory:category.value,expectedChecksum:app.item.checksum});
    if (!saved?.ok) throw Error(saved?.reason || '即用信息保存失败');
    Object.assign(app.item,saved.plugin);_appsCache=null;void renderAppsCatalog(true);
  }
  const refreshPublication = () => window.SoduWorkPluginPublication?.refreshPersonalSubmission(
    modal.querySelector('#appsSetPublish'), app.item, { isCurrent: () => ticket === _appsSettingsSeq });
  refreshPublication();
  modal.querySelector('#appsSetPublish')?.addEventListener('click', async function () {
    if (ticket !== _appsSettingsSeq) return;
    this.disabled = true;
    this.textContent = '正在准备…';
    const restore = () => {
      if (ticket !== _appsSettingsSeq) return;
      mask.classList.add('show');
      this.focus();
      refreshPublication();
    };
    try {
      if (!window.openCapabilityPluginPublication) throw Error('上架组件未加载，请重启客户端后重试');
      await saveAppMetadata();
      await window.openCapabilityPluginPublication(app.item, {
        isCurrent: () => ticket === _appsSettingsSeq,
        onReady: () => mask.classList.remove('show'),
        onClose: restore,
      });
    } catch (error) {
      if (ticket !== _appsSettingsSeq) return;
      restore(); showError(error.message || '申请上架准备失败');
    }
  });
  modal.querySelector('#appsSetRemove').addEventListener('click', async function () {
    if (ticket !== _appsSettingsSeq) return;
    this.disabled = true;
    this.textContent = '正在移除…';
    modal.querySelectorAll('input,textarea,select,button').forEach(control => { control.disabled = true; });
    try {
      const result = app.item.personal
        ? await SoduWorkAPI.deletePersonalPlugin(key)
        : await SoduWorkAPI.setEnterprisePluginInstalled(app.item.pluginId, false);
      if (result && result.ok === false) throw Error(result.reason || result.error || '即用没有移除成功');
      removeFavoriteApp(key);
      closeAppSettings();
      _appsCache = null;
      await renderAppsCatalog(true);
      sayAppsMessage('即用已移除并卸载');
    } catch (error) {
      this.disabled = false;
      modal.querySelectorAll('input,textarea,select,button').forEach(control => { control.disabled = false; });
      this.textContent = '移除即用';
      refreshPublication();
      showError(String(error && error.message || error));
    }
  });
  modal.querySelector('#appsSetSave')?.addEventListener('click', async function () {
    if (ticket !== _appsSettingsSeq) return;
    let params;
    try {
      const submitted = setup.preferences.length ? fields.collect(modal, setup) : {};
      // Only the declared, visible fields are edited; preserve any hidden legacy preferences.
      const visible = new Set(setup.preferences.map(field => field.key));
      params = { ...Object.fromEntries(Object.entries(app.item.setupConfig || {}).filter(([key]) => !visible.has(key))), ...submitted };
    }
    catch (error) { showError(error.message); return; }
    this.disabled = true;
    modal.querySelectorAll('input,textarea,select,button').forEach(control => { control.disabled = true; });
    try {
      await saveAppMetadata();
      const values = {};
      for (const p of declared.fields) {
        const control = modal.querySelector('[data-jiyong-parameter="' + p.key + '"]');
        if (p.secret && !control.value) continue;
        const value = p.display === 'switch' ? control.checked : p.display === 'multiselect' ? [...control.selectedOptions].map(o => o.value) : p.type === 'number' ? Number(control.value) : control.value;
        if (p.type === 'number' && (!control.value.trim() || !Number.isFinite(value))) throw Error('请填写有效数字：' + p.label);
        values[p.key] = value;
      }
      if (Object.keys(values).length) {
        await saveAppSettings(key,{values,secretKeys:declared.fields.filter(p => p.secret).map(p => p.key),expectedRevision:record.revision});
        record = await appSettingsOf(key);
      }
      if (!setup.preferences.length) { closeAppSettings(); sayAppsMessage('即用设置已保存'); return; }
      const result = app.item.personal
        ? await SoduWorkAPI.configurePersonalPlugin(app.item.pluginId, app.item.checksum, params)
        : await SoduWorkAPI.setEnterprisePluginInstalled(app.item.pluginId, true, app.item.versionId, params);
      if (result?.ok === false) throw Error(result.reason || result.error || '即用设置保存失败');
      if (result?.plugin) Object.assign(app.item, result.plugin);
      else app.item.setupConfig = params;
    }
    catch (error) { showError(error.message); modal.querySelectorAll('input,textarea,select,button').forEach(control => { control.disabled = false; }); refreshPublication(); return; }
    if (ticket === _appsSettingsSeq) closeAppSettings();
  });
}
function closeAppSettings() {
  ++_appsSettingsSeq;
  const box = document.getElementById('appsSettingsMask');
  if (box) { box.classList.remove('show'); const input = box.querySelector('#appsSetUkey'); if (input) input.value = ''; }
}

/* Shared app-open chain: synchronize installation/updates, then use the existing
   native runtime in a standalone window or the administrator's sidebar slot. */
async function openAppFromItem(item, options = {}) {
  const current = () => !options.isCurrent || options.isCurrent();
  if (!current()) return null;
  if (!item || !window.PluginUIHost || typeof window.PluginUIHost.openContribution !== 'function') {
    throw Error('即用页面暂时不可用，请刷新即用目录后重试');
  }
  const key = appKeyOf(item);
  const navRow = (item.ui && Array.isArray(item.ui.contributions) ? item.ui.contributions : [])
    .find(row => row && row.slot === 'workspace.navigation') || null;
  if (!navRow) throw Error('即用页面不存在，请刷新后重试');
  if (!item.personal && (!item.installed || item.updateAvailable)) {
    if (!window.SoduWorkAPI || typeof window.SoduWorkAPI.setEnterprisePluginInstalled !== 'function') {
      throw Error('即用同步入口暂不可用，请更新客户端');
    }
    const result = await window.SoduWorkAPI.setEnterprisePluginInstalled(item.pluginId, true, item.versionId);
    if (result && result.ok === false) throw Error(result.reason || result.error || '即用同步失败');
    if (!current()) return null;
    _appsCache = await loadAppsCatalog();
    if (!current()) return null;
    const body = document.getElementById('appsBody');
    if (body && _appsCache) renderAppsInto(body, _appsCache);
    const latest = (_appsCache || []).find(candidate => appKeyOf(candidate.item) === key && candidate.item.installed);
    return window.PluginUIHost.openContribution(latest ? latest.row : navRow, { ...options, item: latest ? latest.item : item, detached: !options.embedded });
  }
  return window.PluginUIHost.openContribution(navRow, { ...options, item, detached: !options.embedded });
}

async function openAppsCard(app, card) {
  if (!app || !card || card.classList.contains('is-opening')) return;
  card.classList.add('is-opening');
  card.setAttribute('aria-busy', 'true');
  const action = card.querySelector('.appsx-card-open');
  const needsSync = !app.item.personal && (!app.item.installed || app.item.updateAvailable);
  if (action && needsSync) action.textContent = '加载中…';
  try { await openAppFromItem(app.item); }
  catch (error) { sayAppsMessage('即用没能打开：' + String(error && error.message || error)); }
  finally {
    card.classList.remove('is-opening'); card.removeAttribute('aria-busy');
    if (action) action.textContent = '打开即用';
  }
}

async function conversationApplication(pluginId) {
  const scope = window.SoduWorkAPI?.taskStorageKey?.('plugins');
  const apps = await loadAppsCatalog();
  if (scope !== window.SoduWorkAPI?.taskStorageKey?.('plugins')) throw Error('账号已变化，请重新打开即用');
  const app = apps.find(row => row.item.pluginId === pluginId);
  if (!app) throw Error('即用已停用或不可用，请检查即用列表');
  return app;
}
async function openConversationApplication(pluginId) { return openAppFromItem((await conversationApplication(pluginId)).item); }
async function settingsConversationApplication(pluginId) { return openAppSettings(await conversationApplication(pluginId)); }
function conversationCardHtml(item) {
  return appsCardHtml({ item, title: String(item.name || '即用'), desc: String(item.description || '') }, 0, false, true);
}

/*
 * Route plugin management through workspace navigation to update sidebar selection;
 * standalone windows fall back to the plugin panel.
 */
function openAppsPluginsPage() {
  if (document.documentElement.getAttribute('data-desk-panel') === 'workspace' &&
      window.WorkspaceHost && typeof window.WorkspaceHost.open === 'function') {
    window.WorkspaceHost.open('skills');
    return;
  }
  if (typeof openSkillPanel !== 'function') { sayAppsMessage('插件页暂时不可用，请更新客户端'); return; }
  closeAppsPanel();
  openSkillPanel();
}

/* Local installation uses the personal-plugin package selection, preflight, and save flow. */
async function installAppPackage() {
  if (!window.SoduWorkPluginMakerUtils || typeof window.SoduWorkPluginMakerUtils.choosePackage !== 'function') {
    sayAppsMessage('安装器暂不可用，请更新客户端后重试');
    return;
  }
  const ticket = ++_appsImportSeq;
  const layer = appsInstallModal();
  const current = () => ticket === _appsImportSeq && !layer.hidden;
  layer.hidden = false;
  layer.setAttribute('aria-busy', 'true');
  layer.querySelector('#appsModalTitle').textContent = '安装即用';
  layer.querySelector('#appsModalSub').textContent = '正在准备应用包…';
  const loading = document.createElement('div');
  loading.setAttribute('role', 'status'); loading.setAttribute('aria-live', 'polite');
  const note = document.createElement('p'); note.className = 'apps-modal-note'; note.textContent = '正在读取并检查应用包…';
  const progress = document.createElement('progress'); progress.setAttribute('aria-label', '正在读取应用包');
  loading.append(note, progress);
  layer.querySelector('#appsModalBody').replaceChildren(loading);
  const cancel = document.createElement('button'); cancel.className = 'btn-mini'; cancel.id = 'appsModalCancel'; cancel.textContent = '取消';
  layer.querySelector('#appsModalFoot').replaceChildren(cancel);
  layer.querySelector('#appsModalCancel').onclick = closeAppsModal;
  layer.querySelector('#appsModalCancel').focus();
  // Let the pending state paint before opening the picker or reading bytes.
  await new Promise(resolve => setTimeout(resolve, 0));
  if (!current()) return;
  const complete = (body, preview, reason) => {
    if (!current()) return;
    if (preview?.ok === false) reason = (preview.checks || []).filter(row => row.ok === false).map(row => row.label).join('；') || '应用包检查未通过';
    confirmAppInstall(body, preview, reason);
  };
  const failed = error => {
    if (!current()) return;
    layer.removeAttribute('aria-busy');
    layer.querySelector('#appsModalSub').textContent = '应用包未能读取';
    const message = document.createElement('p'); message.className = 'apps-modal-error'; message.setAttribute('role', 'alert');
    message.textContent = String(error?.message || error);
    layer.querySelector('#appsModalBody').replaceChildren(message);
    const cancel = document.createElement('button'); cancel.className = 'btn-mini'; cancel.id = 'appsModalCancel'; cancel.textContent = '取消';
    const space = document.createElement('span'); space.className = 'push';
    const retry = document.createElement('button'); retry.className = 'btn-mini'; retry.id = 'appsModalRetry'; retry.textContent = '重新选择';
    layer.querySelector('#appsModalFoot').replaceChildren(cancel, space, retry);
    layer.querySelector('#appsModalCancel').onclick = closeAppsModal;
    layer.querySelector('#appsModalRetry').onclick = installAppPackage;
  };
  try { await window.SoduWorkPluginMakerUtils.choosePackage(SoduWorkAPI, {
    local: function (body, preview) { complete(body, preview); },
    archive: function (file, preview) {
      const draft = preview && preview.personalDraft;
      if (preview && preview.sourceKind === 'personal' && draft && !(preview.capabilities?.adapterBlockers || []).length) {
        complete(draft, preview);
      } else complete(null, preview, '这个包不是本地即用格式，请从「插件」页安装');
    },
    error: failed,
    cancel: function () { if (current()) closeAppsModal(); },
  }); } catch (error) { failed(error); }
}

/* Creation choices only prepare a draft in the existing application development conversation. */
const APPS_CREATE_CATEGORIES = [
  { id: 'office', title: '工具办公', examples: '待办清单 · 番茄时钟 · 本地记账' },
  { id: 'game', title: '小游戏', examples: '摸鱼弹球 · 反应力挑战 · 每日脑洞谜题' },
  { id: 'robot', title: '机器人', examples: '灵感扭蛋机 · 脑洞辩论员 · 下班收尾官 · 会议行动员 · 项目哨兵' },
  { id: 'other', title: '其他', examples: '灵感便签 · 习惯打卡 · 个人收藏夹' },
];
/* Filled, multicolor artwork follows the catalog gift icon rather than action glyphs. */
const APPS_CREATE_ICONS = {
  office: '<svg viewBox="0 0 40 40" aria-hidden="true"><rect x="5" y="11" width="23" height="25" rx="5" fill="#7c5cf0"/><rect x="12" y="4" width="23" height="27" rx="5" fill="#4f8df7"/><rect x="17" y="11" width="13" height="3" rx="1.5" fill="#fff"/><rect x="17" y="17" width="9" height="3" rx="1.5" fill="#fff" opacity=".8"/><rect x="23" y="25" width="13" height="11" rx="3" fill="#fbbf24"/><path d="m27 30 2 2 4-4" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  game: '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M12 10h16c5 0 7 5 8 12l1 6c1 6-4 9-8 5l-5-5h-8l-5 5c-4 4-9 1-8-5l1-6c1-7 3-12 8-12Z" fill="#8b5cf6"/><rect x="8" y="18" width="12" height="4" rx="2" fill="#fff"/><rect x="12" y="14" width="4" height="12" rx="2" fill="#fff"/><circle cx="28" cy="17" r="3" fill="#fbbf24"/><circle cx="32" cy="24" r="3" fill="#fb7185"/><path d="m17 7 3-4 3 4" fill="none" stroke="#22d3ee" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  robot: '<svg viewBox="0 0 40 40" aria-hidden="true"><rect x="18" y="6" width="4" height="8" rx="2" fill="#8b5cf6"/><circle cx="20" cy="5" r="4" fill="#fbbf24"/><rect x="2" y="19" width="7" height="12" rx="3.5" fill="#2dd4bf"/><rect x="31" y="19" width="7" height="12" rx="3.5" fill="#2dd4bf"/><rect x="7" y="12" width="26" height="25" rx="9" fill="#4f8df7"/><rect x="11" y="17" width="18" height="11" rx="5.5" fill="#eef2ff"/><circle cx="16" cy="22" r="2" fill="#7c5cf0"/><circle cx="24" cy="22" r="2" fill="#7c5cf0"/><rect x="16" y="31" width="8" height="2.5" rx="1.25" fill="#fff"/></svg>',
  other: '<svg viewBox="0 0 40 40" aria-hidden="true"><rect x="4" y="9" width="23" height="27" rx="5" fill="#fb7185" transform="rotate(-8 15 22)"/><rect x="13" y="4" width="23" height="28" rx="5" fill="#fbbf24" transform="rotate(8 24 18)"/><rect x="9" y="12" width="23" height="25" rx="5" fill="#4f8df7"/><path d="m21 16 2.3 5 5.5.6-4.1 3.7 1.1 5.4-4.8-2.8-4.8 2.8 1.1-5.4-4.1-3.7 5.5-.6Z" fill="#fff"/></svg>',
  web: '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17" fill="#4f8df7"/><path d="M5 14h9l4 5-3 5H8l-4-5ZM23 5l9 5-2 7-6-1-4-5ZM24 23l10 2-5 9-6 2-3-7Z" fill="#2dd4bf"/><ellipse cx="20" cy="20" rx="8" ry="17" fill="none" stroke="#fff" stroke-width="1.5" opacity=".55"/><path d="M4 20h32" stroke="#fff" stroke-width="1.5" opacity=".55"/><circle cx="32" cy="8" r="6" fill="#fbbf24"/><path d="m29.5 8 1.7 1.7 3-3.4" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
function selectAppsCreateKind(mask, kind) {
  mask.classList.toggle('is-web', kind === 'web');
  mask.querySelectorAll('.appsx-create-opt').forEach(function (row) {
    const selected = row.dataset.kind === kind;
    row.classList.toggle('selected', selected);
    row.setAttribute('aria-selected', String(selected));
    row.tabIndex = selected ? 0 : -1;
  });
  mask.querySelectorAll('[data-create-panel]').forEach(function (panel) {
    panel.hidden = panel.dataset.createPanel !== kind;
  });
}
function appsCreateDialog() {
  let mask = document.getElementById('appsCreateMask');
  if (mask) return mask;
  mask = document.createElement('div');
  mask.id = 'appsCreateMask';
  mask.className = 'appsx-mask';
  mask.innerHTML = '<div class="appsx-create" role="dialog" aria-modal="true" aria-label="创建即用">' +
    '<div class="appsx-modal-body appsx-create-body">' +
    '<div class="appsx-create-options" role="tablist" aria-label="即用类型">' +
    '<svg class="appsx-create-tab-shape" viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true"><path d="M0 0H440C510 0 480 100 560 100H1000V101H0Z"/></svg>' +
    '<button class="appsx-create-opt" id="appsCreateLiteTab" type="button" role="tab" aria-controls="appsCreateLitePanel" data-kind="lite"><b>创建即用</b><span class="appsx-create-badge">轻量</span></button>' +
    '<button class="appsx-create-opt" id="appsCreateWebTab" type="button" role="tab" aria-controls="appsCreateWebPanel" data-kind="web"><b>WEB/H5接入</b></button></div>' +
    '<section class="appsx-create-content" id="appsCreateLitePanel" role="tabpanel" aria-labelledby="appsCreateLiteTab" data-create-panel="lite">' +
    '<div class="appsx-create-storage-row"><fieldset class="appsx-create-storage" aria-label="数据存储（必选）">' +
    '<label><input type="radio" name="appsCreateStorage" value="cloud" required><span>数据云端化</span></label>' +
    '<label><input type="radio" name="appsCreateStorage" value="local" required><span>数据本地化</span></label></fieldset>' +
    '<p class="appsx-create-storage-hint" id="appsCreateStorageHint" role="status">请选择数据存储方式后开始创建</p></div><div class="appsx-create-categories">' +
    APPS_CREATE_CATEGORIES.map(function (row) {
      return '<button class="appsx-create-category" type="button" disabled data-create-category="' + row.id + '">' +
        '<span class="appsx-create-ico" aria-hidden="true">' + APPS_CREATE_ICONS[row.id] + '</span><b>' + row.title + '</b>' +
        '<small>' + row.examples + '</small><span class="appsx-create-start">开始创建</span></button>';
    }).join('') + '</div></section>' +
    '<section class="appsx-create-content appsx-create-web" id="appsCreateWebPanel" role="tabpanel" aria-labelledby="appsCreateWebTab" data-create-panel="web" hidden>' +
    '<span class="appsx-create-web-icon" aria-hidden="true">' + APPS_CREATE_ICONS.web + '</span><h3>连接你的 H5 或服务</h3>' +
    '<p class="appsx-create-intro">将已有网页、H5 页面或在线服务接入 SoduWork，在即用中继续使用。</p>' +
    '<div class="appsx-create-recommendations"><div><b>已有网站 / H5</b><small>企业门户 · 在线表单 · 数据看板</small></div>' +
    '<div><b>云端服务</b><small>团队协作 · 业务系统 · 在线客服</small></div></div>' +
    '<button class="appsx-pill" id="appsCreateGo" type="button">开始创建</button><p class="appsx-create-fit">适合云端，数据上云</p></section></div>' +
    '<footer class="appsx-modal-foot appsx-create-foot"><button class="appsx-create-install" id="appsCreateInstall" type="button">导入即用包</button>' +
    '<span class="push"></span><button class="btn-mini" id="appsCreateCancel" type="button">取消并关闭</button></footer></div>';
  document.body.appendChild(mask);
  mask.addEventListener('change', function (event) {
    if (event.target.name !== 'appsCreateStorage') return;
    const cloud = event.target.value === 'cloud';
    mask.querySelectorAll('[data-create-category]').forEach(button => { button.disabled = false; });
    mask.querySelector('#appsCreateStorageHint').textContent = cloud
      ? '数据保存到云端，同一账号可跨设备使用；需要联网'
      : '数据保存在本机，可离线读写；不自动上传或同步';
  });
  mask.addEventListener('pointerdown', function (event) { if (event.target === mask) closeAppsCreateDialog(); });
  mask.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { closeAppsCreateDialog(); event.stopPropagation(); }
    if (event.target.matches('.appsx-create-opt') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const kind = event.key === 'Home' ? 'lite' : event.key === 'End' ? 'web' : event.target.dataset.kind === 'lite' ? 'web' : 'lite';
      selectAppsCreateKind(mask, kind);
      mask.querySelector('.appsx-create-opt.selected').focus();
    }
  });
  mask.addEventListener('click', function (event) {
    const opt = event.target.closest('.appsx-create-opt');
    if (opt) { selectAppsCreateKind(mask, opt.dataset.kind); return; }
    if (event.target.closest('#appsCreateClose') || event.target.closest('#appsCreateCancel')) closeAppsCreateDialog();
    else if (event.target.closest('#appsCreateInstall')) { closeAppsCreateDialog(); installAppPackage(); }
    else {
      const categoryButton = event.target.closest('[data-create-category]');
      const category = APPS_CREATE_CATEGORIES.find(row => row.id === categoryButton?.dataset.createCategory);
      const kind = mask.querySelector('.appsx-create-opt.selected')?.dataset.kind;
      if (!(kind === 'lite' && category) && !(kind === 'web' && event.target.closest('#appsCreateGo'))) return;
      const storageLocation = mask.querySelector('input[name="appsCreateStorage"]:checked')?.value;
      if (kind === 'lite' && !['local','cloud'].includes(storageLocation)) {
        mask.querySelector('input[name="appsCreateStorage"]').focus();
        return;
      }
      closeAppsCreateDialog();
      try { window.PluginBuilderEntry.openApp(category ? category.title + '：' : '', category ? {appCategory:category.id,storageLocation} : undefined, kind); }
      catch (error) { sayAppsMessage('即用开发助手暂时不可用：' + String(error && error.message || error)); }
    }
  });
  return mask;
}
function openAppsCreateDialog() {
  const mask = appsCreateDialog();
  selectAppsCreateKind(mask, 'lite');
  mask.querySelectorAll('input[name="appsCreateStorage"]').forEach(input => { input.checked = false; });
  mask.querySelectorAll('[data-create-category]').forEach(button => { button.disabled = true; });
  mask.querySelector('#appsCreateStorageHint').textContent = '请选择数据存储方式后开始创建';
  mask.classList.add('show');
  mask.querySelector('.appsx-create-opt.selected').focus();
}
function closeAppsCreateDialog() {
  const mask = document.getElementById('appsCreateMask');
  if (mask) mask.classList.remove('show');
}

function appsInstallModal() {
  let layer = document.getElementById('appsModalLayer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'appsModalLayer';
    layer.className = 'apps-modal-layer';
    layer.innerHTML = '<div class="apps-modal" role="dialog" aria-modal="true">' +
      '<header><b id="appsModalTitle"></b><small id="appsModalSub"></small></header>' +
      '<div class="apps-modal-body" id="appsModalBody"></div>' +
      '<footer id="appsModalFoot"></footer></div>';
    document.body.appendChild(layer);
    layer.addEventListener('mousedown', function (event) { if (event.target === layer) closeAppsModal(); });
    layer.addEventListener('keydown', function (event) { if (event.key === 'Escape') { event.stopPropagation(); closeAppsModal(); } });
  }
  return layer;
}

function confirmAppInstall(body, preview, blockedReason) {
  const rawManifest = (preview && preview.manifest) || {};
  const manifest = window.SoduWorkPluginLocales?.present(rawManifest, window.SoduWorkI18n?.getLocale?.() || navigator.language) || rawManifest;
  const name = String(manifest.name || (body && body.name) || '未命名即用');
  const version = String(manifest.version || (body && body.version) || '0.0.0');
  const description = String(manifest.description || (body && body.description) || '');
  const layer = appsInstallModal();
  layer.removeAttribute('aria-busy');
  layer.hidden = false;
  layer.querySelector('#appsModalTitle').textContent = '安装即用';
  layer.querySelector('#appsModalSub').textContent = rawManifest.jiyong?.storage?.location === 'cloud'
    ? '检查已完成 · 应用安装到本机 · 业务数据保存到云端'
    : '检查已完成 · 仅保存到本机 · 免审核免提交';
  layer.querySelector('#appsModalBody').innerHTML =
    '<div class="apps-install-head"><span class="appsx-app-ico big">' + APPS_GLYPH + '</span>' +
    '<div><b' + (manifest.name || body?.name ? ' data-user-content' : '') + '>' + escapeAppsHtml(name) + '</b><p' + (description ? ' data-user-content' : '') + '>' + escapeAppsHtml(description || '没有说明') + '</p>' +
    '<em>v' + escapeAppsHtml(version) + (blockedReason ? '' : ' · 界面即用 · 桥接能力按声明放行') + '</em></div></div>' +
    (blockedReason ? '<p class="apps-modal-error">' + escapeAppsHtml(blockedReason) + '</p>' : '') +
    '<p class="apps-modal-note">即用界面将在隔离承载中打开；需要的对话/通知能力按即用清单声明授权。</p>';
  const foot = layer.querySelector('#appsModalFoot');
  foot.innerHTML = '<button class="btn-mini" id="appsModalCancel">取消</button>' +
    '<span class="push"></span>' +
    (blockedReason ? '' : '<button class="btn-mini primary" id="appsModalInstall">安装到本机</button>');
  foot.querySelector('#appsModalCancel').addEventListener('click', closeAppsModal);
  const installBtn = foot.querySelector('#appsModalInstall');
  if (installBtn) installBtn.addEventListener('click', async function () {
    const ticket = _appsImportSeq;
    this.disabled = true;
    this.textContent = '正在安装…';
    try {
      const result = await SoduWorkAPI.createPluginDraft(body);
      if (!result || result.ok === false || !result.plugin) throw Error(result?.reason || result?.error || '即用没有安装成功');
      if (ticket !== _appsImportSeq) { renderAppsCatalog(true); return; }
      closeAppsModal();
      sayAppsMessage('即用「' + result.plugin.name + '」已安装，侧边栏与即用页都可以打开');
      renderAppsCatalog(true);
    } catch (error) {
      if (ticket !== _appsImportSeq) return;
      this.disabled = false;
      this.textContent = '安装到本机';
      sayAppsMessage('即用没有安装成功：' + String(error && error.message || error));
    }
  });
}

function closeAppsModal() {
  ++_appsImportSeq;
  const layer = document.getElementById('appsModalLayer');
  if (layer) layer.hidden = true;
}

function escapeAppsHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}

/* Reuse the capability toast when available; otherwise show feedback above the catalog content. */
function sayAppsMessage(text) {
  if (typeof say === 'function') { say(text); return; }
  const body = document.getElementById('appsBody');
  if (body) {
    let note = body.querySelector('.apps-inline-note');
    if (!note) {
      note = document.createElement('div');
      note.className = 'apps-inline-note';
      body.prepend(note);
    }
    note.textContent = text;
    setTimeout(function () { note.remove(); }, 6000);
  }
}

/* Reused by composer-page recommendation rows: same catalog cache, same open chain, same favorites state. */
window.SoduWorkApps = {
  open: openAppsPanel, close: closeAppsPanel, render: renderAppsCatalog,
  glyph: APPS_GLYPH, icons: APPS_ICONS,
  appKeyOf, favoriteAppIds, toggleFavoriteApp,
  openAppFromItem,
  openById: openConversationApplication,
  settingsById: settingsConversationApplication, conversationCardHtml,
};
