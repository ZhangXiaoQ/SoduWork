/*
 * AI-team execution state, task workspace, and notifications. Office cards use
 * panels-aidesk-office.js; details reuse shared traces.
 */
let _deskData = { desks: [] };
let _deskFocusTid = '';    /* Task passed from another view, possibly already delivered and absent from active stations. */
let _deskTaskId = '';      /* Current task-workspace ID. */
let _deskTimer = null;
let _deskPushTimer = null;
let _deskRequest = null;
let _deskRefreshQueued = false;
let _deskQueuedFocus = '';
function _deskPanelVisible() {
  const panel = document.getElementById('aiDeskPanel');
  return !!(panel && panel.classList.contains('show') &&
    document.visibilityState !== 'hidden');
}

function _queueDeskRefresh(focusTaskId, delay) {
  if (focusTaskId) _deskQueuedFocus = String(focusTaskId);
  _deskRefreshQueued = true;
  clearTimeout(_deskPushTimer);
  _deskPushTimer = setTimeout(() => {
    _deskPushTimer = null;
    if (!_deskPanelVisible()) {
      _deskRefreshQueued = false;
      _deskQueuedFocus = '';
      return;
    }
    const focus = _deskQueuedFocus;
    _deskRefreshQueued = false;
    _deskQueuedFocus = '';
    _loadDesks(focus);
  }, Math.max(0, Number(delay) || 0));
}

/*
 * Coalesce Runner session events into a 180 ms refresh instead of waiting for
 * twenty-second polling or repainting every command.
 */
window.addEventListener('soduwork-work-execution', (ev) => {
  if (!_deskPanelVisible()) return;
  const tid = String(((ev || {}).detail || {}).taskId || '');
  if (tid && !_dkFindTask(tid) && _deskFocusTid && tid !== _deskFocusTid) return;
  _queueDeskRefresh('', 180);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && _deskPanelVisible()) {
    _queueDeskRefresh('', 0);
  }
});

/* Route workspace actions into an independent, non-topmost native window from the overlay.
   Open in place within the workspace or when no Electron bridge is available. */
function openAIDeskEntry(focusTaskId) {
  if (focusTaskId && typeof openTaskConversation === 'function') {
    return openTaskConversation(focusTaskId, '', {source: 'task-live', navigation: true});
  }
  /*
   * Use core/win-bridge.js routeToWorkWindow; a true result means navigation was handled and
   * must not be repeated locally.
   */
  if (typeof WinSync !== 'undefined' &&
      WinSync.routeToWorkWindow('aidesk', { taskId: focusTaskId || '' })) return;
  openAIDesk(focusTaskId || '');
}

function openAIDesk(focusTaskId) {
  if (focusTaskId && typeof openTaskConversation === 'function') {
    return openTaskConversation(focusTaskId, '', {source: 'task-live', navigation: true});
  }
  let p = document.getElementById('aiDeskPanel');
  if (!p) {
    p = document.createElement('div');
    p.id = 'aiDeskPanel'; p.className = 'desk-panel';
    /* Default to the agent workbench; task cards open the shared conversation. */
    p.innerHTML =
      '<div class="dk-head ws-page-head"><div class="dk-title"><span class="dk-title-kicker" data-i18n="eyebrow.ai_team">AI TEAM</span>' +
        '<span class="dk-title-name">AI 团队</span><span class="dk-sub" id="dkSub"></span></div>' +
      '<div class="dk-acts">' +
        '<span class="dk-live-badge" id="dkLiveStatus"><i></i><b data-i18n="eyebrow.ready">READY</b></span>' +
        '<button class="dk-agent-manage" id="dkAgentManage" type="button">Agent 管理</button>' +
        '<button class="dk-refresh" id="dkRefresh" title="刷新执行状态">' +
          '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/></svg>刷新</button>' +
        '<button class="dk-close" id="dkClose">✕</button></div></div>' +
      '<div class="dk-main dk-office-layout">' +
        '<section class="dk-roster dk-office-stage" id="dkRoster" aria-label="AI 数字办公室"></section>' +
        '<aside class="dk-body dk-office-inspector" id="dkBody" aria-label="办公室观察窗"></aside>' +
      '</div>' ;

    document.body.appendChild(p);
    document.getElementById('dkClose').addEventListener('click', closeAIDesk);
    const _agentManage = document.getElementById('dkAgentManage');
    if (_agentManage) _agentManage.addEventListener('click', () => {
      if (typeof openAgentsEntry === 'function') openAgentsEntry();
      else if (window.WorkspaceHost) WorkspaceHost.open('agents', {});
    });
    const _rb = document.getElementById('dkRefresh');
    if (_rb) _rb.addEventListener('click', async () => {
      _rb.disabled = true; _rb.classList.add('is-loading');
      await _loadDesks('');
      _rb.disabled = false; _rb.classList.remove('is-loading');
    });
    /*
     * Let CSS position near-full-window panels; makeDraggable/placeDockPopup would conflict
     * with fixed edge offsets.
     */
  }
  p.classList.add('show');
  if (typeof expandForOverlay === 'function') expandForOverlay();
  /*
   * Leave always-on-top state to electron.js _TOP_DROPPERS so closing one panel cannot
   * override another open panel.
   */
  _loadDesks(focusTaskId || '');
  /* Poll every twenty seconds only while work is active. */
  if (_deskTimer) clearInterval(_deskTimer);
  _deskTimer = setInterval(() => {
    if (!_deskPanelVisible()) return;
    if ((_deskData.desks || []).some(d => d.busy)) _queueDeskRefresh('', 0);
  }, 20000);
}

function closeAIDesk() {
  const p = document.getElementById('aiDeskPanel');

  if (p && p.classList.contains('show')) {
    p.classList.remove('show');
    if (typeof shrinkFromOverlay === 'function') shrinkFromOverlay();
  }
  if (_deskTimer) { clearInterval(_deskTimer); _deskTimer = null; }
  if (_deskPushTimer) { clearTimeout(_deskPushTimer); _deskPushTimer = null; }
  _deskRefreshQueued = false;
  _deskQueuedFocus = '';
  if (typeof closeConsole === 'function') closeConsole();
}

async function _loadDesks(focusTaskId) {
  const body = document.getElementById('dkBody');
  if (!body || !window.SoduWorkAPI || !SoduWorkAPI.aiDesks) return;
  const focus = typeof focusTaskId === 'string' ? focusTaskId : '';
  if (_deskRequest) {
    _deskRefreshQueued = true;
    if (focus) _deskQueuedFocus = focus;
    return _deskRequest;
  }
  if (!_deskPanelVisible()) return null;
  const request = _fetchDesks(body, focus);
  _deskRequest = request;
  try {
    return await request;
  } finally {
    if (_deskRequest === request) _deskRequest = null;
    if (_deskRefreshQueued && _deskPanelVisible()) _queueDeskRefresh('', 180);
  }
}

async function _fetchDesks(body, focusTaskId) {
  if (!(_deskData.desks || []).length) {
    body.innerHTML = '<div class="dk-blank">正在看谁在干活…</div>';
    body.dataset.sig = '';        /* Invalidate the render signature after manual DOM changes. */
  }
  const r = await SoduWorkAPI.aiDesks();
  if (document.getElementById('dkBody') !== body) return;
  _deskData = r || { desks: [] };
  const desks = _deskData.desks || [];
  if (focusTaskId) { void window.openTaskConversation?.(focusTaskId, '', {navigation:true}); return _deskData; }
  /* Default to the global execution overview; executor selection remains a sidebar filter. */
  if (!_dkPick || (_dkPick !== '__all__' &&
      !desks.some(d => (d.key || d.name) === _dkPick))) _dkPick = '__all__';
  _renderDesks();
  return _deskData;
}

function _renderDesks() {
  const roster = document.getElementById('dkRoster');
  const body = document.getElementById('dkBody');
  const sub = document.getElementById('dkSub');
  if (!roster || !body) return;
  const desks = _deskData.desks || [];
  const main = body.parentElement;
  const isTaskView = false;
  if (main) {
    main.classList.toggle('is-task-view', isTaskView);
  }
  if (sub) {
    const s = _deskData.summary || {};
    const text = (s.running || 0) + ' 条运行中 · ' +
      ((s.waiting || 0) + (s.failed || 0)) + ' 条需要处理';
    if (sub.textContent !== text) sub.textContent = text;
  }
  const live = document.getElementById('dkLiveStatus');
  if (live) {
    const running = Number(((_deskData.summary || {}).running) || 0);
    live.classList.toggle('is-live', running > 0);
    const label = live.querySelector('b');
    const text = running > 0 ? 'LIVE' : 'READY';
    if (label && label.textContent !== text) label.textContent = text;
  }
  // Compare only visible content and preserve live card nodes during refresh.
  const sig = _dkOfficeSceneHtml(desks);
  if (roster._officeMarkup !== sig) {
    _dkOfficePatchScene(roster, sig);
    roster._officeMarkup = sig;
  }
  const d = _dkPick === '__all__' ? null
    : (desks.find(x => (x.key || x.name) === _dkPick) || null);
  if (body.firstChild) body.replaceChildren();

}

/* Compute elapsed time from the dispatch ISO timestamp; use an unspecified label when unavailable. */
function _sinceTxt(at) {
  const t = at ? Date.parse(at) : NaN;
  if (!t) return '一会儿了';
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return '不到 1 分钟';
  if (m < 60) return m + ' 分钟';
  const h = Math.round(m / 6) / 10;
  return (h < 24 ? h + ' 小时' : Math.round(h / 24) + ' 天');
}

let _noticeFolder = 'received';
let _noticeLoad = { received: {}, sent: {} };
let _noticeScope = '';
let _noticeLimits = { received: 100, sent: 100 };
function _syncNoticeScope() {
  const scope = globalThis.SoduWorkAPI?.taskStorageKey?.('notices') || '';
  if (scope !== _noticeScope) {
    _noticeScope = scope;
    _noticeLoad = { received: {}, sent: {} };
    _noticeLimits = { received: 100, sent: 100 };
    _noticeExpanded.clear();
    _noticeVisibleRows.clear();
  }
  return scope;
}
const _noticeExpanded = new Set();
const _noticeVisibleRows = new Map();
/* Show conversation-entry icons beside metadata only for colleague notifications with attachments. */
function _noticeClipIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z');
  svg.appendChild(path);
  return svg;
}
function _noticeRows(folder) {
  if (globalThis.MateNoticeSync) return MateNoticeSync.rows(folder);
  return folder === 'sent' ? [] : (typeof notices !== 'undefined' && Array.isArray(notices) ? notices : []);
}
async function _loadMateNoticeFolder(folder) {
  const target = folder === 'sent' ? 'sent' : 'received';
  const scope = _syncNoticeScope();
  const load = { pending: true, error: '' };
  _noticeLoad[target] = load;
  _noticeFolder = target;
  _renderNoticePanel();
  try {
    if (!globalThis.MateNoticeSync) throw Error('通知暂时无法加载，请重试');
    const result = await MateNoticeSync.refresh(target);
    if (_syncNoticeScope() !== scope || _noticeLoad[target] !== load) return;
    if (!result || result.ok === false) throw Error('通知暂时无法加载，请重试');
  } catch (error) {
    if (_syncNoticeScope() !== scope || _noticeLoad[target] !== load) return;
    load.error = error?.message || '通知暂时无法加载，请重试';
  } finally { load.pending = false; }
  if (_noticeFolder === target) _renderNoticePanel();
}
function _readReceivedNotice(serverId, scope) {
  return Promise.resolve().then(() => {
    if (_syncNoticeScope() !== scope) return;
    if (!globalThis.MateNoticeSync) throw Error('已读状态未同步，请重试');
    return MateNoticeSync.markRead(serverId);
  }).then(() => {
    if (_syncNoticeScope() !== scope) return;
    _noticeLoad.received.error = '';
    _renderNoticePanel();
  }).catch(error => {
    if (_syncNoticeScope() !== scope) return;
    _noticeLoad.received.error = error?.message || '已读状态未同步，请重试';
    _renderNoticePanel();
  });
}

async function _readLocalNotice(read) {
  const scope = _syncNoticeScope();
  try {
    if (typeof markNoticeRead === 'function') await read();
  } catch (error) {
    if (_syncNoticeScope() === scope) _noticeLoad.received.error = error?.message || '通知暂时无法加载，请重试';
  } finally { if (_syncNoticeScope() === scope) _renderNoticePanel(); }
}

function openNoticePanel() {
  let p = document.getElementById('noticePanel');
  if (!p) {
    p = document.createElement('div');
    p.id = 'noticePanel'; p.className = 'notice-panel';
    p.innerHTML =
      '<div class="np-head ws-page-head"><div class="np-title"><span data-i18n="nav.notices">通知</span> <span class="np-sub" id="npSub"></span></div>' +
      '<div class="np-acts"><button type="button" class="np-clear" id="npClear" title="清空本机通知">清空</button><button type="button" class="np-close" id="npClose" aria-label="关闭通知">✕</button></div></div>' +
      '<div class="np-toolbar"><nav class="np-tabs" aria-label="通知分类"><button type="button" data-notice-folder="received">收到的消息</button><button type="button" data-notice-folder="sent">发送的通知</button></nav></div>' +
      '<div class="np-body" id="npBody"></div>';
    document.body.appendChild(p);
    document.getElementById('npClose').addEventListener('click', closeNoticePanel);
    p.querySelector('.np-tabs').addEventListener('click', (event) => {
      const tab = event.target.closest('[data-notice-folder]'); if (!tab) return;
      void _loadMateNoticeFolder(tab.getAttribute('data-notice-folder'));
    });
    document.getElementById('npClear').addEventListener('click', async () => {
      const scope = _syncNoticeScope();
      try { if (typeof clearNotices === 'function') await clearNotices(); }
      catch (error) { if (_syncNoticeScope() === scope) _noticeLoad.received.error = error?.message || '通知暂时无法加载，请重试'; }
      if (_syncNoticeScope() !== scope) return;
      _renderNoticePanel();
    });
    document.getElementById('npBody').addEventListener('keydown', e => {
      if (!['Enter', ' '].includes(e.key) || !e.target.matches('.np-row')) return;
      e.preventDefault(); e.target.click();
    });
    document.getElementById('npBody').addEventListener('click', (e) => {
      if (e.target.closest('[data-notice-more]')) {
        _noticeLimits[_noticeFolder] += 100;
        const top = document.getElementById('npBody').scrollTop;
        _renderNoticePanel(); document.getElementById('npBody').scrollTop = top;
        document.querySelector('[data-notice-more]')?.focus({ preventScroll: true });
        return;
      }
      if (e.target.closest('[data-notice-retry]')) { void _loadMateNoticeFolder(_noticeFolder); return; }
      const followUp = e.target.closest('[data-notice-follow-up]');
      if (followUp) {
        e.preventDefault(); e.stopPropagation();
        const key = followUp.getAttribute('data-notice-follow-up') || '';
        const sourceScope = _syncNoticeScope();
        const message = _noticeVisibleRows.get(key);
        if (!message || followUp.disabled) return;
        const sourceFolder = _noticeFolder;
        followUp.disabled = true;
        followUp.setAttribute('aria-busy', 'true');
        const open = payload => {
          if (_syncNoticeScope() !== sourceScope) throw Error('\u8d26\u53f7\u6216\u670d\u52a1\u5df2\u5207\u6362\uff0c\u8bf7\u91cd\u65b0\u6253\u5f00\u6d88\u606f');
          if (globalThis.WorkspaceHost && typeof globalThis.WorkspaceHost.open === 'function') {
            return globalThis.WorkspaceHost.open('create', payload);
          }
          if (typeof openComposePanel === 'function') return openComposePanel(payload);
          throw Error('\u65b0\u4f1a\u8bdd\u5165\u53e3\u6682\u65f6\u4e0d\u53ef\u7528');
        };
        const notify = text => { if (typeof petSay === 'function') petSay(text); };
        Promise.resolve().then(() => globalThis.MessageFollowUp?.openInNewSession(message, {
          api: globalThis.SoduWorkAPI,
          bridge: globalThis.soduWorkAPI,
          isCurrent: () => _syncNoticeScope() === sourceScope,
          open,
          notify,
        })).then(ok => {
          if (!ok || _syncNoticeScope() !== sourceScope) return;
          const serverId = String(message.serverMessageId || '');
          if (sourceFolder === 'received') {
            if (serverId) return _readReceivedNotice(serverId, sourceScope);
            return _readLocalNotice(() => markNoticeRead(key));
          }
        }).finally(() => {
          if (followUp.isConnected) { followUp.disabled = false; followUp.removeAttribute('aria-busy'); }
        }).catch(() => {});
        return;
      }
      const expand = e.target.closest('[data-notice-expand]');
      if (expand) {
        e.preventDefault(); e.stopPropagation();
        const key = expand.getAttribute('data-notice-expand');
        const open = expand.getAttribute('aria-expanded') !== 'true';
        if (open) _noticeExpanded.add(key); else _noticeExpanded.delete(key);
        expand.setAttribute('aria-expanded', String(open));
        expand.closest('.np-copy').classList.toggle('is-expanded', open);
        expand.textContent = open ? '收起全文' : '展开全文';
        return;
      }
      const preview = e.target.closest('[data-notice-preview]');
      if (preview) {
        e.preventDefault(); e.stopPropagation();
        const url = preview.getAttribute('data-notice-preview') || '';
        try { const parsed = new URL(url);
          if (!['http:', 'https:'].includes(parsed.protocol) || /^(localhost|127\.|0\.0\.0\.0|::1)$/i.test(parsed.hostname)) throw Error('unsafe');
          if (typeof window.soduWorkAPI?.openExternal === 'function') void window.soduWorkAPI.openExternal(url);
        } catch (_) { if (typeof petSay === 'function') petSay('网页预览地址无效，已保留完整 ZIP 附件'); }
        return;
      }
      const file = e.target.closest('[data-notice-file]');
      if (file) { e.preventDefault(); e.stopPropagation(); void _downloadNoticeFile(file); return; }
      const row = e.target.closest('.np-row');
      if (!row) return;
      const notice = _noticeVisibleRows.get(row.getAttribute('data-nnotice'));
      if (notice?.kind === 'legal_update') {
        const noticeScope = _syncNoticeScope();
        Promise.resolve().then(() => {
          if (_syncNoticeScope() !== noticeScope) return false;
          if (!globalThis.LegalUpdates?.openNotice) throw Error('协议内容暂未加载，请稍后重试。');
          return globalThis.LegalUpdates.openNotice(notice);
        }).then(opened => {
          if (opened && _syncNoticeScope() === noticeScope) {
            _noticeLoad.received.error = '';
            return _readLocalNotice(() => markNoticeRead(notice.id));
          }
        }).catch(error => {
          if (_syncNoticeScope() !== noticeScope) return;
          _noticeLoad.received.error = error?.message || '协议内容暂未加载，请稍后重试。';
          _renderNoticePanel();
        });
        return;
      }
      const serverId = row.getAttribute('data-server-message');
      if (serverId && _noticeFolder === 'received') {
        void _readReceivedNotice(serverId, _syncNoticeScope());
      } else if (_noticeFolder === 'received') void _readLocalNotice(() => markNoticeRead(row.getAttribute('data-nnotice')));
      _renderNoticePanel();
      const tid = row.getAttribute('data-ntask');
      if (tid && typeof openDetailEntry === 'function') openDetailEntry(tid);
    });
    if (typeof makeDraggable === 'function') makeDraggable(p, p.querySelector('.np-head'));
  }
  _renderNoticePanel();
  void _loadMateNoticeFolder(_noticeFolder);
  void globalThis.LegalUpdates?.refresh();
  p.classList.add('show');
  if (typeof placeDockPopup === 'function') placeDockPopup(p);
  if (typeof expandForOverlay === 'function') expandForOverlay();
}
function closeNoticePanel() {
  const p = document.getElementById('noticePanel');
  if (p && p.classList.contains('show')) {
    p.classList.remove('show');
    if (typeof shrinkFromOverlay === 'function') shrinkFromOverlay();
  }
}
function _noticePresentation(n) {
  const legal = n.kind === 'legal_update';
  const mate = n.kind === 'mate_message' || n.kind === 'task_assignment';
  const descriptor = n.textMessage;
  const fallback = String(n.bodyText ?? n.text ?? '');
  const translated = descriptor && typeof descriptor === 'object'
    ? (globalThis.SoduWorkI18n?.t?.(String(descriptor.key || ''),
        String(descriptor.fallback || fallback), descriptor.params || {}) || fallback)
    : fallback;
  let text = String(legal && globalThis.LegalUpdates ? LegalUpdates.noticeText(n.legalUpdate) : translated).replace(/^[\s\u23f0\u21bb\u2705\ud83d\udce5]+/u, '').trim();
  if (mate && n.bodyText == null && n.senderName && text.startsWith(n.senderName + '：')) text = text.slice(n.senderName.length + 1).trim();
  const report = !mate && text.match(/^(日报已生成|周报已生成)[：:]\s*([\s\S]*)$/);
  const labels = { task: '任务动态', remind: '提醒', recur: '循环任务', system: '系统通知', notice: '工作通知', mate_receipt: '消息回执' };
  let title = esc(legal ? (globalThis.SoduWorkI18n?.translateText?.('系统消息') || '系统消息') : report ? report[1] : labels[n.kind] || '工作通知');
  if (n.kind === 'mate_receipt') {
    const status = { accepted: '已发送', delivered: '已送达', read: '已读' }[n.receiptStatus] || '消息回执';
    title = esc(status + ' · ' + (n.recipientName || n.senderName || '对方'));
  }
  if (mate) {
    const person = _noticeFolder === 'sent' ? n.recipientName : n.senderName;
    title = person ? '<span>' + (_noticeFolder === 'sent' ? '发送给' : '来自') + '</span> <span data-user-content>' + esc(person) + '</span>' : '同事消息';
  }
  const icon = mate ? '<svg class="np-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a8 8 0 0 1-8 8H4l1.6-4A8 8 0 1 1 20 11.5Z"/><path d="M8 10h8M8 14h5"/></svg>' : report ? '<svg class="np-svg" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="3"/><path d="M9 7h6M9 11h6M9 15h3"/></svg>' : _nkIcon(legal ? 'system' : n.kind);
  return { text: report ? report[2] : text, title, icon, mate, report: !!report };
}

globalThis.addEventListener?.('soduwork-locale-change', () => {
  if (document.getElementById('noticePanel')?.classList.contains('show')) _renderNoticePanel();
});
function _noticeFileIsZip(file) {
  return /\.zip$/i.test(String(file?.name || file?.filename || ''));
}
function _renderNoticePanel() {
  _syncNoticeScope();
  _noticeVisibleRows.clear();
  const body = document.getElementById('npBody');
  const sub = document.getElementById('npSub');
  if (!body) return;
  const list = _noticeRows(_noticeFolder).slice();
  list.sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
  const unread = _noticeFolder === 'sent' ? 0 : list.filter(n => !n.read).length;
  const tabs = document.querySelectorAll('#noticePanel .np-tabs [data-notice-folder]');
  tabs.forEach(tab => {
    const active = tab.getAttribute('data-notice-folder') === _noticeFolder;
    tab.classList.toggle('is-active', active); tab.setAttribute('aria-pressed', String(active));
  });
  if (sub) sub.innerHTML = '<span>' + list.length + ' 条</span>' + (unread ? ' <b class="np-unread-pill">' + unread + ' 未读</b>' : '');
  const clear = document.getElementById('npClear');
  if (clear) clear.hidden = _noticeFolder === 'sent';
  const loading = _noticeLoad[_noticeFolder] || {};
  const status = loading.error ? '<div class="np-load-status" role="status"><span>' + esc(loading.error) + '</span><button type="button" data-notice-retry>重试</button></div>' :
    loading.pending ? '<div class="np-load-status" role="status">正在加载通知…</div>' : '';
  if (!list.length) {
    if (status) { body.innerHTML = status; return; }
    body.innerHTML = '<div class="np-empty"><span class="np-empty-ico"><svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg></span><b>' + (_noticeFolder === 'sent' ? '还没有发送通知' : '还没有通知') + '</b><p>' + (_noticeFolder === 'sent' ? '在对话中 @ 同事，发送的消息和成果会保留在这里。' : '同事消息、任务进展和工作提醒会保留在这里。') + '</p></div>';
    return;
  }
  const pad = x => String(x).padStart(2, '0');
  const dayKey = ts => { const d = new Date(ts); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const today = dayKey(Date.now()), yesterday = dayKey(Date.now() - 86400000);
  const dayLabel = k => k === today ? '今天' : k === yesterday ? '昨天' : (parseInt(k.slice(5, 7), 10) + '月' + parseInt(k.slice(8), 10) + '日');
  const groups = new Map();
  list.slice(0, _noticeLimits[_noticeFolder]).forEach((n, index) => { const key = dayKey(n.at); if (!groups.has(key)) groups.set(key, []); groups.get(key).push({ n, index }); });
  let h = (loading.error ? status : '') + '<div class="np-stream">';
  groups.forEach((entries, day) => {
    h += '<section class="np-day-group"><div class="np-day"><span>' + dayLabel(day) + '</span><span class="np-day-count">' + entries.length + ' 条</span></div><div class="np-day-items">';
    entries.forEach(({ n, index }) => {
      const d = new Date(n.at), key = String(n.id || n.at || index);
      _noticeVisibleRows.set(key, n);
      const tm = pad(d.getHours()) + ':' + pad(d.getMinutes());
      const view = _noticePresentation(n), expanded = _noticeExpanded.has(key);
      const long = view.text.length > 240 || view.text.split('\n').length > 4;
      const isUnread = _noticeFolder !== 'sent' && !n.read;
      const files = Array.isArray(n.attachments) ? n.attachments : [];
      h += '<article class="np-row nk-' + esc(n.kind || 'notice') + (isUnread ? ' unread' : '') + (view.report ? ' is-report' : '') + '" tabindex="0"' +
        ' data-nnotice="' + esc(key) + '"' + (n.serverMessageId && n.kind !== 'mate_receipt' && _noticeFolder === 'received' ? ' data-server-message="' + esc(n.serverMessageId) + '"' : '') + (n.taskId ? ' data-ntask="' + esc(n.taskId) + '"' : '') + '>' +
        '<span class="np-ico" aria-hidden="true">' + view.icon + '</span><div class="np-copy' + (expanded ? ' is-expanded' : '') + '"><div class="np-message-head"><h3 class="np-subject">' + view.title + '</h3>' +
        '<div class="np-message-meta">' + (isUnread ? '<span class="np-unread-dot" title="未读" aria-label="未读"></span>' : '') + '<time class="np-time">' + tm + '</time>' +
        (n.sentStatus && _noticeFolder === 'sent' ? '<span class="np-delivery np-' + esc(n.sentStatus) + '">' + (n.sentStatus === 'read' ? '已读' : n.sentStatus === 'delivered' ? '已送达' : '已发送') + '</span>' : '') + '</div></div>' +
        '<div class="np-txt' + (long ? ' is-long' : '') + '"' + (view.mate ? ' data-user-content' : '') + '>' + esc(view.text) + '</div>' +
        (n.kind === 'legal_update' ? '<button type="button" class="np-preview" data-legal-update>' + esc(globalThis.SoduWorkI18n?.translateText?.('查看更新') || '查看更新') + '</button>' : '') +
        (long ? '<button type="button" class="np-expand" data-notice-expand="' + esc(key) + '" aria-expanded="' + expanded + '">' + (expanded ? '收起全文' : '展开全文') + '</button>' : '') +
        (files.length ? '<div class="np-files" data-notice-file-scope="' + esc(_syncNoticeScope()) + '">' + files.map(file => {
          const name = String(file.name || file.filename || '附件'), zip = _noticeFileIsZip(file);
          const size = Math.max(1, Math.ceil(Number(file.size || 0) / 1024)) + ' KB';
          const fileCard = zip
            ? '<div class="np-file np-file-static" aria-label="' + esc(name) + '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 14h8M8 17h5"/></svg><span><span data-user-content>' + esc(name) + '</span><em>' + size + '</em></span></div>'
            : '<button type="button" class="np-file" data-notice-action="open" data-notice-file="' + esc(file.id) + '" title="打开附件：' + esc(name) + '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 14h8M8 17h5"/></svg><span><span data-user-content>' + esc(name) + '</span><em>' + size + '</em></span><small>打开</small></button>';
          return '<div class="np-attachment">' + fileCard + '<button type="button" class="np-file-download" data-notice-action="download" data-notice-file="' + esc(file.id) + '" aria-label="下载附件：' + esc(name) + '">下载</button><button type="button" class="np-file-download" data-notice-action="save" data-notice-file="' + esc(file.id) + '" title="保存到本机资料库">保存到资料库</button></div>';
        }).join('') + '</div>' : '') +
        (n.website && n.website.previewUrl ? '<button type="button" class="np-preview" data-notice-preview="' + esc(n.website.previewUrl) + '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/></svg><span>查看网页预览</span></button>' : '') + '</div>' +
        (n.taskId ? '<span class="np-task-link" aria-label="查看任务" title="查看任务"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></span>' : '') + '</article>';
    });
    h += '</div></section>';
  });
  const markup = h + '</div>' + (list.length > _noticeLimits[_noticeFolder]
    ? '<div class="np-load-status"><button type="button" data-notice-more>加载更多</button></div>' : '');
  // An unchanged background refresh must not replace a row between pointer
  // down and click, or disturb keyboard focus and expanded message content.
  if (body._noticeMarkup === markup && body.querySelector('.np-stream')) return;
  body._noticeMarkup = markup;
  body.innerHTML = markup;
  /*
   * Offer follow-up conversations only for colleague messages with attachments; retain
   * delegated propagation and busy-state handling.
   */
  body.querySelectorAll('.np-row.nk-mate_message').forEach(row => {
    const key = row.getAttribute('data-nnotice') || '';
    const message = _noticeVisibleRows.get(key);
    const files = Array.isArray(message?.attachments) ? message.attachments : [];
    if (_noticeFolder !== 'received' || !message || !files.length) return;
    const meta = row.querySelector('.np-message-meta');
    if (!meta) return;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'np-chat-clip';
    button.dataset.noticeFollowUp = key; button.appendChild(_noticeClipIcon());
    button.title = '基于此继续：将消息内容和成果带入新的私有会话';
    button.setAttribute('aria-label', '基于此继续');
    meta.insertBefore(button, meta.firstChild);
  });
}
async function _downloadNoticeFile(button) {
  if (button.disabled) return;
  const scope = SoduWorkAPI.taskStorageKey?.('notices') || '';
  const capturedScope = button.closest?.('[data-notice-file-scope]')?.getAttribute('data-notice-file-scope');
  if (capturedScope != null && capturedScope !== scope) return;
  const current = () => (SoduWorkAPI.taskStorageKey?.('notices') || '') === scope;
  const action = button.getAttribute('data-notice-action');
  button.disabled = true;
  try {
    if (action === 'save') {
      if (typeof SoduWorkAPI.saveMateMessageFileToLibrary !== 'function') throw Error('请更新客户端后保存附件');
      await SoduWorkAPI.saveMateMessageFileToLibrary(button.getAttribute('data-notice-file'));
      try {
        const detail = { itemId: '' };
        window.dispatchEvent(new CustomEvent('soduwork-library-changed', { detail }));
        window.soduWorkAPI?.broadcast?.('library', { type: 'changed', detail, at: Date.now() });
      } catch (_) { /* Library refresh is best effort after a successful save. */ }
      if (current() && typeof petSay === 'function') petSay('已保存到本机资料库');
      return;
    }
    const file = await SoduWorkAPI.mateMessageFile(button.getAttribute('data-notice-file'));
    if (!current()) return;
    if (action === 'open' && /\.zip$/i.test(String(file.filename || file.name || ''))) {
      throw Error('ZIP 附件只支持下载或保存到资料库');
    }
    const url = SoduWorkAPI.attachmentUrl(file);
    const preview = action === 'open';
    const method = preview ? 'previewAttachment' : 'downloadAttachment';
    if (typeof window.soduWorkAPI?.[method] !== 'function') throw Error('请更新客户端后打开或下载附件');
    const result = await window.soduWorkAPI[method]({url, filename:file.filename});
    if (result && result.ok === false && !result.canceled && !result.cancelled) throw Error(result.reason || '附件未能打开或下载');
  } catch (error) {
    if (!current() || error?.code === 'STALE_TASK_SCOPE') return;
    if ((error?.code === 'LIBRARY_NAME_CONFLICT' || /同名/.test(error.message || '')) && window.SoduWorkLibraryDialogs?.create) {
      const dialogs = window.SoduWorkLibraryDialogs.create({ state: {}, esc, icon: () => '',
        notify: message => { if (typeof petSay === 'function') petSay(message); },
        errorText: failure => failure.message, load: () => {}, getEpoch: () => scope });
      const close = () => dialogs.close();
      window.addEventListener('soduwork-data-scope-changed', close);
      try { await dialogs.showError(error, '附件保存失败，请重试'); }
      finally { window.removeEventListener('soduwork-data-scope-changed', close); }
    } else if (typeof petSay === 'function') petSay(error.message || (action === 'save' ? '附件保存失败，请重试' : '附件暂时无法打开，请稍后重试'));
  }
  finally { button.disabled = false; }
}
window.openNoticePanel = openNoticePanel;
window.closeNoticePanel = closeNoticePanel;
