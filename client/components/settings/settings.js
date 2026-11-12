/* Settings UI shared by the workspace and desktop overlay.
   Only the workspace contains the settings form; overlay bindings safely do nothing without its DOM.
   Scale, font, visibility, and work-root helpers remain available in both windows.
   Store.saveCfg() broadcasts changes through WinSync so each window reapplies its own effects.
   Do not load app/app.js here: its startup and polling side effects must run only once. */

/* ---------- Panel visibility ---------- */
function openSettings() {
  const panel = document.getElementById('settingsPanel');
  if (!panel) return;
  void globalThis.AccessPreferences?.refresh?.();
  _syncSeg('shapeSeg', 'shape', cfg.shape);
  _syncSeg('genderSeg', 'gender', cfg.gender);
  _syncSeg('remindSeg', 'remind', cfg.remind);
  _syncSeg('scaleSeg', 'scale', cfg.uiScale);
  _syncSeg('fontSeg', 'font', cfg.fontScale || 'medium');
  _syncLocaleSelect((cfg && cfg.locale) || (globalThis.SoduWorkI18n && SoduWorkI18n.getLocale && SoduWorkI18n.getLocale()) || 'zh-CN');
  _applyLocaleUI();
  /* Refresh the current skin name and binding state when opening settings. */
  if (typeof refreshSkinCurName === 'function') refreshSkinCurName();
  _refreshBindNote();
  _refreshClientUpdateStatus();
  panel.classList.add('show');
  /*
   * Reset scroll after showing the panel and again on the next frame; asynchronous binding
   * text can otherwise shift the initial view through scroll anchoring.
   */
  panel.scrollTop = 0;
  requestAnimationFrame(() => { panel.scrollTop = 0; });
  if (typeof placeDockPopup === 'function') placeDockPopup(panel);
  if (typeof expandForOverlay === 'function') expandForOverlay();
}
function closeSettings() {
  const panel = document.getElementById('settingsPanel');
  // Dispose the body-level menu before this page is hidden; reopening creates one fresh control.
  if (panel) globalThis.ForwardSelect?.destroy?.(panel);
  if (panel) panel.classList.remove('show');
  if (typeof shrinkFromOverlay === 'function') shrinkFromOverlay();
}
function _syncSeg(segId, key, val) {
  const seg = document.getElementById(segId);
  if (!seg) return;
  seg.querySelectorAll('button').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-' + key) === val);
  });
}
function _applyLocaleUI() {
  if (!globalThis.SoduWorkI18n || typeof SoduWorkI18n.t !== 'function') return;
  document.documentElement.lang = SoduWorkI18n.getLocale();
  SoduWorkI18n.translateNode(document.getElementById('settingsPanel'));
  _syncLocaleSelect(SoduWorkI18n.getLocale());
}
function _syncLocaleSelect(value) {
  const select = document.getElementById('localeSelect');
  if (!select) return;
  select.value = value;
  if (select.dataset) select.dataset.searchPlaceholder = globalThis.SoduWorkI18n?.translateText?.('搜索') || '搜索';
  // Use the existing in-page picker instead of an OS popup with a separate focus lifecycle.
  // Keep the select as the value owner so persistence and cross-window locale changes agree.
  const root = select.closest?.('#settingsPanel');
  if (root) globalThis.ForwardSelect?.enhance?.(root);
}

/* Window scale (--ui-scale) and font scale (--font-scale) are independent preferences.
   Apply font tokens in both windows without changing the window's footprint. */
function applyScale(v) {
  const s = { small: 0.85, medium: 1, large: 1.22 }[v || cfg.uiScale || 'medium'] || 1;
  document.documentElement.style.setProperty('--ui-scale', s);
  /* After scaling, clamp the pet and reposition task views and the sidebar when those desktop-only components exist. */
  if (typeof restorePetPos === 'function') restorePetPos();
  if (typeof _syncSidebar === 'function') _syncSidebar();
}
function applyFontScale(v) {
  /* Keep .ntext at the minimum readable body size even with the small font setting. */
  const requested = { small: 0.88, medium: 1, large: 1.15 }[v || cfg.fontScale || 'medium'] || 1;
  const s = Math.max(1, requested);
  document.documentElement.style.setProperty('--font-scale', s);
  /* Reclamp panels after font changes alter card heights. */
}
/* Hide only the pet character; keep the dock and panels available. */
function applyPetVisible() {
  const p = document.getElementById('pet');
  if (!p) return;                       /* Workspace windows have no desktop pet. */
  /* Visibility follows the persisted preference; no temporary override is applied. */
  const on = cfg.petVisible !== false;
  p.style.display = on ? '' : 'none';
  if (typeof SoduWorkPetSkin !== 'undefined') SoduWorkPetSkin.sync();
  if (typeof _syncSidebar === 'function') _syncSidebar();
}
/* Refresh dock visibility through _syncSidebar, the shared visibility decision point. */
function applyDockVisible() {
  if (typeof _syncSidebar === 'function') _syncSidebar();
}
/* Refresh form values when tray actions change the same preferences. */
function syncDeskFlagChks() {
  [['dockVisibleChk', 'dockVisible'], ['petVisibleChk', 'petVisible'],
   ['trayVisibleChk', 'trayVisible']].forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (el) el.checked = cfg[key] !== false;
  });
  const note = document.getElementById('trayOffNote');
  if (note) note.style.display = cfg.trayVisible !== false ? 'none' : '';
}

/*
 * The main process owns installers and exit permissions; the view exposes status and
 * controlled actions. Waiting means the Runner has stopped accepting work and is draining
 * active tasks.
 */
let _clientUpdateState = { state: 'idle' };
/*
 * Translate sentence fragments before composing dynamic DOM text; whole-node dictionary
 * lookup cannot translate arbitrary concatenations.
 */
const _clientUpdateText = value => (globalThis.SoduWorkI18n &&
  typeof SoduWorkI18n.translateText === 'function' ? SoduWorkI18n.translateText(value) : value) || value;
const _clientUpdateLabels = {
  idle: '尚未检查', checking: '正在检查', current: '已是最新',
  available: '发现新版本', downloading: '正在下载', downloaded: '等待安装',
  waiting: '安全等待中', installing: '正在安装', installed: '更新完成',
  deferred: '已安全延后', failed: '更新失败', manual: '需要手动更新',
  development: '开发模式',
};
function _clientUpdateDetail(status) {
  const state = String(status.state || 'idle');
  const current = status.currentVersion ? ('当前 SoduWork ' + status.currentVersion) : '';
  const target = status.targetVersion ? (' SoduWork ' + status.targetVersion) : '';
  if (state === 'waiting') {
    const count = Array.isArray(status.blockers) ? status.blockers.filter(item => item?.kind !== 'drain-barrier').length : 0;
    return count ? '已停止接收新的本机工作，正在等待 ' + count + ' 项工作结束；现有任务不会中断。'
      : '正在确认当前工作已结束。';
  }
  if (state === 'downloading') return '正在安全下载' + target + ' · ' + Number(status.progress || 0) + '%';
  if (state === 'downloaded') return current + ' →' + target + '；新版本已下载并通过校验，但尚未安装。';
  if (state === 'installing') return '任务已排空，正在安装' + target + '。';
  if (state === 'deferred') return status.error || '当前工作继续运行；稍后可重新发起安全安装。';
  if (state === 'failed' || state === 'manual') return status.error || '请检查更新配置后重试。';
  if (state === 'current') return '当前 SoduWork ' + (status.currentVersion || '') + ' 已是最新版本。';
  if (state === 'installed') return target + ' 已安装完成。';
  if (state === 'development') return '开发运行不执行完整客户端在线安装。';
  if (state === 'checking') return '正在向当前后台环境确认可用版本…';
  return '任务执行中不会被升级打断；安装前会自动等待 Runner 排空。';
}
function _paintClientUpdateStatus(status) {
  _clientUpdateState = status && typeof status === 'object' ? status : { state: 'idle' };
  const state = String(_clientUpdateState.state || 'idle');
  const progressView = window.ClientUpdateView?.describe(_clientUpdateState);
  const badge = document.getElementById('clientUpdateBadge');
  const dot = document.getElementById('clientUpdateDot');
  const title = document.getElementById('clientUpdateTitle');
  const detail = document.getElementById('clientUpdateDetail');
  const action = document.getElementById('clientUpdateAction');
  const blockers = document.getElementById('clientUpdateBlockers');
  if (!badge || !dot || !title || !detail || !action || !blockers) return;
  badge.textContent = progressView?.title || _clientUpdateLabels[state] || state;
  badge.className = 'client-update-badge is-' + state;
  dot.className = 'client-update-dot is-' + state;
  const current = String(_clientUpdateState.currentVersion || '').trim();
  const baseTitle = progressView?.title || (state === 'waiting' ? '正在保护当前工作' :
    state === 'failed' ? '客户端更新没有完成' :
    state === 'current' ? '当前版本已就绪' :
    state === 'installed' ? '客户端已更新' :
    (_clientUpdateLabels[state] || '客户端更新'));
  title.textContent = _clientUpdateText(baseTitle) +
    (current ? ' · ' + _clientUpdateText('当前版本') + ' ' + current : '');
  detail.textContent = (progressView?.detail || _clientUpdateDetail(_clientUpdateState)) +
    (!progressView && _clientUpdateState.actionMessage ? ' ' + _clientUpdateState.actionMessage : '');
  window.ClientUpdateView?.renderProgress(document.getElementById('clientUpdateProgress'), _clientUpdateState);
  const busy = progressView?.active || ['checking', 'downloading', 'waiting', 'installing'].includes(state);
  const installable = ['downloaded', 'deferred'].includes(state) &&
    Boolean(_clientUpdateState.targetVersion);
  action.disabled = busy && state !== 'waiting';
  action.textContent = state === 'waiting' ? '取消本次等待' :
    progressView?.active ? (progressView.percent == null ? '更新进行中' : progressView.percent + '%') :
    state === 'downloading' ? (Number(_clientUpdateState.progress || 0) + '%') :
    state === 'installing' ? '正在安装' :
    installable ? '安全安装' : '检查更新';
  blockers.replaceChildren();
  const rows = Array.isArray(_clientUpdateState.blockers) ?
    _clientUpdateState.blockers : [];
  blockers.hidden = !['waiting', 'deferred'].includes(state) || !rows.length;
  rows.forEach((item) => {
    const row = document.createElement('div');
    const mark = document.createElement('i');
    const text = document.createElement('span');
    text.textContent = String(item && item.title || '正在执行的工作');
    text.title = text.textContent;
    row.append(mark, text);
    const local = item.kind === 'conversation' && item.ref;
    const task = item.kind === 'runner-session' && item.taskId;
    if (state === 'waiting' && local && soduWorkAPI.resolveClientUpdate) {
      const stop = document.createElement('button');
      stop.type = 'button'; stop.textContent = '停止工作';
      stop.addEventListener('click', async () => {
        stop.disabled = true;
        try { _paintClientUpdateStatus(await soduWorkAPI.resolveClientUpdate({
          kind: item.kind, id: item.ref || item.id,
        })); } catch (error) {
          _paintClientUpdateStatus({ ..._clientUpdateState, actionMessage: String(error.message || error) });
        }
      });
      row.appendChild(stop);
    }
    if (local || task) {
      const view = document.createElement('button');
      view.type = 'button'; view.textContent = local ? '打开会话' : '查看任务';
      view.addEventListener('click', () => {
        closeSettings();
        if (local && window.WorkspaceHost) WorkspaceHost.open('create', { tab: 'chat', chatId: item.id });
        else if (task && typeof openDetailEntry === 'function') openDetailEntry(item.taskId);
        else if (task && typeof openDetail === 'function') openDetail(item.taskId);
      });
      row.appendChild(view);
    }
    blockers.appendChild(row);
  });
  if (rows.length) {
    const help = document.createElement('p');
    help.textContent = '工作结束后会自动继续安装。无需继续的工作可点「停止工作」；停止失败或找不到任务时，可先取消本次等待，再到任务中心处理或联系管理员检查执行机。';
    blockers.appendChild(help);
  }
}
async function _refreshClientUpdateStatus() {
  if (!(window.soduWorkAPI && soduWorkAPI.clientUpdateStatus)) return;
  try { _paintClientUpdateStatus(await soduWorkAPI.clientUpdateStatus()); }
  catch (error) {
    _paintClientUpdateStatus({ state: 'failed',
      error: '更新状态暂时不可用：' + String(error.message || error) });
  }
}
function _bindClientUpdateStatus() {
  const action = document.getElementById('clientUpdateAction');
  if (!action || !(window.soduWorkAPI && soduWorkAPI.clientUpdateStatus)) return;
  if (soduWorkAPI.onClientUpdateStatus) {
    soduWorkAPI.onClientUpdateStatus((status) => _paintClientUpdateStatus(status));
  }
  action.addEventListener('click', async () => {
    action.disabled = true;
    try {
      const state = String(_clientUpdateState.state || '');
      if (state === 'waiting' && soduWorkAPI.resolveClientUpdate) {
        _paintClientUpdateStatus(await soduWorkAPI.resolveClientUpdate({ action: 'cancel-wait' }));
        return;
      }
      const installable = ['downloaded', 'deferred'].includes(state) &&
        Boolean(_clientUpdateState.targetVersion);
      const next = installable && soduWorkAPI.installClientUpdate
        ? await soduWorkAPI.installClientUpdate()
        : await soduWorkAPI.checkClientUpdate({ interactive: true });
      _paintClientUpdateStatus(next || {});
    } catch (error) {
      _paintClientUpdateStatus({ ..._clientUpdateState, state: 'failed',
        error: String(error.message || error) });
    }
  });
  void _refreshClientUpdateStatus();
}

/* 切换「需求视图大小 / 字体大小」时气泡文案：模板（任务视图：{size} / 字体：{size}）
   和尺寸词（小/中/大）都走语言包再拼，否则英文界面会出现「Font size: 大」
   这类前缀已翻、参数残留中文的混排。SoduWorkI18n 缺席时按中文原样兜底。 */
function _saySegSize(template, value) {
  const label = ({ small: '小', medium: '中', large: '大' }[value] || '中');
  const i18n = globalThis.SoduWorkI18n;
  if (!i18n || typeof i18n.t !== 'function') { petSay(template.replace('{size}', label)); return; }
  petSay(i18n.t(template, template, { size: i18n.t(label) }));
}

/* ---------- 表单绑定 ---------- */
function _bindSettingsEvents() {
  /* 任务形状/SoduWork 形象设置已移除：形状由皮肤决定(玻璃圆珠/SoduWork 方块)，当前 SoduWork/球宠物无性别之分 */
  _bindAppSeg('remindSeg', 'remind', v => {
    cfg.remind = v; saveCfg();
    if (typeof applyRemind === 'function') applyRemind();
    if (typeof render === 'function') render();
  });
  _bindAppSeg('scaleSeg', 'scale', v => {
    cfg.uiScale = v; saveCfg();
    applyScale(v);
    _saySegSize('任务视图：{size}', v);
  });
  _bindAppSeg('fontSeg', 'font', v => {
    cfg.fontScale = v; saveCfg();
    applyFontScale(v);
    _saySegSize('字体：{size}', v);
  });
  const localeSelect = document.getElementById('localeSelect');
  if (localeSelect) localeSelect.addEventListener('change', () => {
    const value = localeSelect.value;
    if (globalThis.SoduWorkI18n && typeof SoduWorkI18n.setLocale === 'function') SoduWorkI18n.setLocale(value);
    _applyLocaleUI();
    if (typeof render === 'function') render();
  });
  _bindWorkRoot();
  _bindAccount();
  _bindSkinEntry();
  /* Persist desktop-pet visibility and broadcast it to the overlay window. */
  const pv = document.getElementById('petVisibleChk');
  if (pv) {
    pv.checked = cfg.petVisible !== false;
    pv.addEventListener('change', () => {
      cfg.petVisible = pv.checked; saveCfg();
      applyPetVisible();
      petSay && petSay(pv.checked ? '我回来啦~' :
        (cfg.dockVisible === false ? '藏起来了，从托盘图标能把我叫回来' : '藏起来了，竖条还在'));
    });
  }
  const dv = document.getElementById('dockVisibleChk');
  if (dv) {
    dv.checked = cfg.dockVisible !== false;
    dv.addEventListener('change', () => {
      cfg.dockVisible = dv.checked; saveCfg();
      applyDockVisible();
      petSay && petSay(dv.checked ? '竖条回来了' : '竖条收起来了，主窗口里样样都在');
    });
  }
  /*
   * Explain how to restore the tray icon before hiding it also removes its context menu.
   */
  const tv = document.getElementById('trayVisibleChk');
  if (tv) {
    const note = document.getElementById('trayOffNote');
    const syncNote = () => { if (note) note.style.display = tv.checked ? 'none' : ''; };
    tv.checked = cfg.trayVisible !== false;
    syncNote();
    tv.addEventListener('change', () => {
      cfg.trayVisible = tv.checked; saveCfg();
      syncNote();
      petSay && petSay(tv.checked ? '托盘图标回来了' : '托盘图标收起来了，这一页能再打开');
    });
  }
}
/* Show the current skin and open the dedicated skin manager from appearance settings. */
function _bindSkinEntry() {
  const btn = document.getElementById('skinOpenBtn');
  refreshSkinCurName();
  if (btn) btn.addEventListener('click', () => {
    /*
     * Keep settings open when skin management opens in another native window. Close it only in
     * browser previews where both share a page.
     */
    if (!(window.soduWorkAPI && soduWorkAPI.openDeskWindow)) {
      const sp = document.getElementById('settingsPanel');
      if (sp && sp.classList.contains('show')) {
        closeSettings();
      }
    }
    if (typeof openSkinEntry === 'function') openSkinEntry();
    else if (typeof openSkinManager === 'function') openSkinManager();
  });
}
/* Refresh the displayed skin name after applySkin. */
window.refreshSkinCurName = function () {
  const cur = document.getElementById('skinCurName');
  if (!cur) return;
  const s = (typeof SkinRegistry !== 'undefined' && typeof currentSkinId === 'function')
    ? SkinRegistry.getSkin(currentSkinId()) : null;
  cur.textContent = (s && s.name) || '默认';
};



function _bindAccount() {
  const input = document.getElementById('boxNameInput');
  const btn = document.getElementById('boxNameSave');
  if (!input || !btn) return;
  input.value = (typeof User !== 'undefined' && User.name) || '';
  btn.addEventListener('click', async () => {
    const v = String(input.value || '').trim();
    if (!v) { petSay('名字不能为空哦'); return; }
    if (typeof User !== 'undefined') await User.setName(v);
    /* Reregister immediately so the management service receives the new name without waiting for a heartbeat. */
    try { if (typeof SoduWorkAPI !== 'undefined' && SoduWorkAPI.registerClient) await SoduWorkAPI.registerClient(); } catch (e) {}
    petSay('叫我「' + v + '」就行~');
    _refreshBindNote();
  });
  _refreshBindNote();
}
/* Read device binding from capability data, including meName and orgName. */
async function _refreshBindNote() {
  const note = document.getElementById('boxBindNote');
  if (!note) return;
  const scope = () => {
    const api = window.SoduWorkAPI;
    return [api?.hubBase?.(), api?.clientAuthSnapshot?.()?.user?.id].join('|');
  };
  const owner = scope();
  const idShort = (typeof User !== 'undefined') ? User.id : '';
  let bindTxt = '后台绑定：未连接';
  try {
    const cap = (typeof SoduWorkAPI !== 'undefined' && SoduWorkAPI.getTeamCapability) ? await SoduWorkAPI.getTeamCapability() : null;
    /* Translate the default meName before interpolating it into the binding template. */
    if (cap && cap.assigned) bindTxt = '后台绑定：' + (cap.meName || _clientUpdateText('已绑定用户')) + (cap.orgName ? '（' + cap.orgName + '）' : '') +
      (cap.canManage ? ' · 管理者身份' : ' · 成员身份');
    else if (cap) bindTxt = '后台绑定：未绑定 · 管理员可在 SoduWork 管理端分配归属';
  } catch (e) {}
  /* Translate the binding template and device-label segment separately, then append the dynamic account, organization, and device values. */
  if (owner === scope()) note.textContent = _clientUpdateText(bindTxt) + ' ' + _clientUpdateText('· 设备标识') + ' ' + idShort;
}
window.refreshPersonalAccountBinding = function () {
  const input = document.getElementById('boxNameInput');
  if (input && input !== document.activeElement) input.value = (typeof User !== 'undefined' && User.name) || '';
  return _refreshBindNote();
};

/* Share the selected local folder with the library, project dispatch and new
   conversations. Keep the existing local and native preference stores aligned. */
const _WORK_ROOT_KEY = 'soduwork_work_root';

/* Supply a default only when no folder has been saved. Recheck after IPC so a
   concurrent selection in either window cannot be replaced by the default. */
async function _ensureDefaultWorkRoot() {
  try {
    if (localStorage.getItem(_WORK_ROOT_KEY)) return;
    if (typeof soduWorkAPI === 'undefined' || !soduWorkAPI.getDefaultWorkRoot) return;
    const root = String(await soduWorkAPI.getDefaultWorkRoot() || '').trim();
    if (!root || localStorage.getItem(_WORK_ROOT_KEY)) return;
    localStorage.setItem(_WORK_ROOT_KEY, root);
    const input = document.getElementById('workRootInput');
    if (input && !input.value) input.value = root;
  } catch (e) { /* The user can retry with the native folder picker. */ }
}
_ensureDefaultWorkRoot();

function _bindWorkRoot() {
  const input = document.getElementById('workRootInput');
  const btn = document.getElementById('workRootSave');
  const note = document.getElementById('workRootNote');
  if (!input || !btn) return;
  const KEY = _WORK_ROOT_KEY;
  const get = () => { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } };
  input.value = get();
  if (!input.value) _ensureDefaultWorkRoot().then(() => { if (!input.value) input.value = get(); });
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    const bridge = typeof soduWorkAPI !== 'undefined' &&
      (soduWorkAPI.conversationSession || soduWorkAPI.piSession);
    if (!bridge?.pickWorkdir || !bridge?.saveWorkdir) {
      if (note) note.textContent = _clientUpdateText('请在桌面客户端选择文件夹');
      return;
    }
    btn.disabled = true;
    try {
      const result = await bridge.pickWorkdir({ defaultPath: get(), persist: false });
      if (result?.canceled) return;
      const dir = String(result?.dir || '').trim();
      if (!result?.ok || !dir) {
        if (note) note.textContent = _clientUpdateText(result?.reason || '未能选择文件夹，请重试');
        return;
      }
      const previous = get();
      localStorage.setItem(KEY, dir);
      try {
        const saved = await bridge.saveWorkdir(dir);
        if (!saved?.ok) throw new Error('Work directory was not saved');
      } catch (e) {
        previous ? localStorage.setItem(KEY, previous) : localStorage.removeItem(KEY);
        throw e;
      }
      input.value = dir;
      if (note) note.textContent = _clientUpdateText('工作目录已保存');
    } catch (e) {
      if (note) note.textContent = _clientUpdateText('无法保存工作目录，请重试');
    } finally {
      btn.disabled = false;
    }
  });
}
/* Expose the current workspace root in both renderer windows for execution-path construction. */
function workRoot() {
  try { return localStorage.getItem('soduwork_work_root') || ''; } catch (e) { return ''; }
}

function _bindAppSeg(segId, key, cb) {
  const seg = document.getElementById(segId);
  if (!seg) return;
  seg.querySelectorAll('button').forEach(b => {
    b.addEventListener('click', () => {
      seg.querySelectorAll('button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      cb(b.getAttribute('data-' + key));
    });
  });
}

/*
 * Initialize both windows on DOM readiness. Form binding is inert without settings DOM;
 * global scale, font, and pet-visibility effects still apply.
 */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initSettings);
} else {
  _initSettings();
}
function _initSettings() {
  _bindSettingsEvents();
  _bindClientUpdateStatus();
  applyScale();        /* 应用保存的任务视图大小 */
  applyFontScale();    /* 字体大小是独立一档（用户定） */
  applyPetVisible();   /* 桌宠显隐（设置项） */
  _syncSeg('scaleSeg', 'scale', cfg.uiScale || 'medium');
  _syncSeg('fontSeg', 'font', cfg.fontScale || 'medium');
  _syncLocaleSelect((cfg && cfg.locale) || (globalThis.SoduWorkI18n && SoduWorkI18n.getLocale && SoduWorkI18n.getLocale()) || 'zh-CN');
  _applyLocaleUI();
  window.addEventListener('soduwork-locale-change', () => {
    _applyLocaleUI();



    if (_clientUpdateState && typeof _clientUpdateState === 'object') _paintClientUpdateStatus(_clientUpdateState);
  });
  const sc = document.getElementById('settingsClose');
  if (sc) sc.addEventListener('click', closeSettings);
}
