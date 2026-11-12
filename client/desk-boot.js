



















(function () {
  'use strict';

  /*
   * desk.html initializes __deskPanel before first paint. Retain __isDeskWindow for legacy
   * routing checks.
   */
  window.__isDeskWindow = true;
  const PANEL = window.__deskPanel || 'workspace';

  /* Provide shared renderer helpers. */
  /*
   * Provide _humanErr because workspace windows do not load pet-ui.js. Keep its error
   * normalization consistent with the desktop implementation.
   */
  window._humanErr = function (e, fallback) {
    try { console.error('[SoduWork]', e); } catch (_e) { /* Ignore an optional failure. */ }
    const m = String((e && e.message) || e || '');
    const detail = String((e && e.detail) || '').trim();
    if (/failed to fetch|networkerror|econn|network|fetch/i.test(m)) return fallback || '网络不太顺，稍后再试';
    if (/\b(401|403)\b|unauthor|forbid/i.test(m)) return '没权限或登录过期了';
    if (/\b404\b|not.?found/i.test(m)) return fallback || '没找到，可能已被改动';
    if (/\b413\b|too large/i.test(m)) return '文件太大了';
    if (detail) return detail.slice(0, 240);
    if ((e && e.status) && m && !/^HTTP\s+\d+$/i.test(m)) return m.slice(0, 240);
    return fallback || '操作没成功，稍后再试';
  };
  /*
   * Implement petSay as a toast so workspace operations always provide feedback without a
   * pet element.
   */
  let _toastT = null;
  window.petSay = function (msg, dur) {
    let el = document.getElementById('deskToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'deskToast';
      el.className = 'desk-toast';
      document.body.appendChild(el);
    }
    el.textContent = String(msg || '');
    el.classList.add('show');
    clearTimeout(_toastT);
    _toastT = setTimeout(() => el.classList.remove('show'), Math.max(1800, dur || 2800));
  };
  /*
   * Fall back to a normal toast for undo bubbles when no clickable pet bubble exists.
   */
  window.petSayUndo = function (msg) { window.petSay(msg); };
  /* Transparent-overlay passthrough helpers are no-ops in native workspace windows. */
  window.expandForOverlay = function () {};
  window.shrinkFromOverlay = function () {};
  /* Desktop task-view redraws and pet reactions do not apply here. */
  window.render = function () {};
  window.petReact = function () {};
  /*
   * Disable dock-relative placement because workspace windows have no task overlay or dock;
   * preserve centered dialogs.
   */
  window.placeDockPopup = function () {};

  /*
   * core/drag.js suppresses custom dragging on native main pages, including its internal
   * bindings; do not duplicate that logic here.
   */

  /* Initialize data and theme. */
  /*
   * Apply locally stored theme, skin, and font preferences before awaiting backend data to
   * avoid a default-theme flash.
   */
  function applyLook() {
    try {
      if (typeof SkinRegistry !== 'undefined' && cfg._lastSkinId) {
        const s = SkinRegistry.getSkin(cfg._lastSkinId);
        if (s) SkinRegistry.applySkinCSSVars(s);     /* Apply remote skin CSS variables. */
      }
      if (typeof applyTheme === 'function') applyTheme();
      if (typeof applyFontScale === 'function') applyFontScale(cfg.fontScale);
    } catch (e) { /* Fall back to factory colors if the skin registry is unavailable. */ }
  }

  /* Open pages that do not depend on the task table immediately. Settings use configuration, skins use the registry, notices use local storage, and team views fetch their own data. The history board waits for tasks; requirement creation and AI desks render first and refresh data after boot. */
  const EARLY = { memory: 1, account: 1, settings: 1, shortcuts: 1, skin: 1, notices: 1, team: 1, inbox: 1, daily: 1, briefs: 1, workitems: 1,
                  schedules: 1, skills: 1, library: 1, models: 1, 'model-editor': 1, agents: 1, cloud: 1, codeacct: 1, usage: 1, archive: 1, approvals: 1, apps: 1,



                  add: 1,
                  /* Show the shared composer immediately; task data is needed only when creating a task. */
                  create: 1,



                  aidesk: 1 };

  async function boot() {
    try {
      /*
       * Use initData to refresh the shared lexical tasks binding and initialize registration,
       * heartbeats, and WebSocket handling. Assigning window.tasks cannot replace Store's global
       * let binding.
       */
      await initData();
    } catch (e) {
      console.error('[desk] 任务数据没拉起来', e);
    }
    /* Reapply appearance after initialization merges backend configuration. */
    applyLook();
    /*
     * Load team permissions after device-session startup without blocking first paint; update
     * only affected entry points when they arrive.
     */
    _loadTeamCapability();
    _watchClientUpdate();
    /*
     * initData owns the WebSocket connection. Execution-workspace polling remains independent;
     * do not create another connection here.
     */
  }

  /* Show the restart-to-update action beside the account entry once an update is ready. */
  function _watchClientUpdate() {
    const api = window.soduWorkAPI;
    if (!api || !api.clientUpdateStatus) return;
    const paint = (status) => {
      if (window.WorkspaceShell && WorkspaceShell.setUpdateState) {
        WorkspaceShell.setUpdateState(status || {});
      }
    };
    Promise.resolve(api.clientUpdateStatus()).then(paint).catch(() => {});
    if (api.onClientUpdateStatus) api.onClientUpdateStatus(paint);
  }

  function _loadTeamCapability() {
    if (!(window.SoduWorkAPI && SoduWorkAPI.getTeamCapability)) return;
    const ready = (typeof Store !== 'undefined' && Store._startupPromise) || Promise.resolve();
    Promise.resolve(ready).then(() => SoduWorkAPI.getTeamCapability()).then((cap) => {
      if (!cap) return;
      /* Use __teamCap.meId for review permissions; User.id identifies the device. */
      window.__teamCap = cap;
      if (typeof setTeamCap === 'function') setTeamCap(cap);
      /* Refresh team-navigation visibility when capabilities arrive. */
      if (window.WorkspaceShell && WorkspaceShell.refreshNav) WorkspaceShell.refreshNav();
      if (PANEL === 'add' && typeof _requestPopulateAssign === 'function') _requestPopulateAssign();
    }).catch(() => {});
  }

  /* Open the requested page. */
  const OPENERS = {
    chatbar: () => { if (window.NativeChat) NativeChat.prepare(); },
    aidesk: (p) => {
      if (typeof openAIDesk !== 'function') return;
      openAIDesk(p.taskId || '');
      /* Open a task's console directly from its details. */
      if (p.taskId && p.console && typeof openConsole === 'function') openConsole(p.taskId);
    },
    account: (p) => window.AccountCenter?.openInPanel(p?.tab || 'security'),
    settings: () => { if (typeof openSettings === 'function') openSettings(); },
    shortcuts: () => { if (typeof openShortcutSettings === 'function') openShortcutSettings(); },
    archive: () => { if (typeof openArchiveHistory === 'function') openArchiveHistory(); },
    skin:     () => { if (typeof openSkinManager === 'function') openSkinManager(); },
    notices:  () => { if (typeof openNoticePanel === 'function') openNoticePanel(); },
    history:  (p) => {
      if (typeof openTaskCenter === 'function') openTaskCenter(p);
      else if (typeof openHistoryBoard === 'function') openHistoryBoard(p);
      if (p?.createRequirement) return openRequirementDraft();
      if (p && p.approvalInbox && window.TaskApprovalInbox) return TaskApprovalInbox.open();
    },
    workitems: (p) => {
      // Saved navigation from older clients opens the single Task-based pool.
      if (typeof openTaskCenter === 'function') openTaskCenter();
    },
    team:     (p) => { if (typeof openTeamPanel === 'function') openTeamPanel({ entry: p.teamEntry || 'team' }); },
    /* 我的定时任务（个人的东西放桌宠里管）：自己去后端拉，不依赖任务表 */
    schedules: (p) => { if (typeof openSchedulePanel === 'function') return openSchedulePanel(p); },
    /* 我的技能：管理端管"开放哪些"，这一页管"我这台用哪几个" */
    skills: () => { if (typeof openSkillPanel === 'function') return openSkillPanel(); },
    /* 应用：带界面的插件，点开是工作页面而不是新建会话；本地安装免审核 */
    apps: () => { if (typeof openAppsPanel === 'function') openAppsPanel(); },
    library: (p) => { if (typeof openLibraryPanel === 'function') return openLibraryPanel(p); },
    /* 我的模型：管理端管"有哪些服务/模型"，这一页管"我自己的 key + 我自己加的模型" */
    models: () => { if (typeof openModelsPanel === 'function') openModelsPanel(); },
    'model-editor': (p) => {
      if (typeof openModelsPanel === 'function') {
        openModelsPanel({ editor: true, providerId: String((p || {}).providerId || '') });
      }
    },
    /* Install, configure, and test local CLI runtimes. */
    agents: () => { if (typeof openAgentsPanel === 'function') openAgentsPanel(); },
    cloud: () => window.openCloudEnvironmentsPanel?.(),
    /* Manage commit identity and push credentials. */
    codeacct: () => { if (typeof openCodeAcctPanel === 'function') openCodeAcctPanel(); },
    /* Show personal AI usage without administrative controls. */
    usage: () => { if (typeof openUsagePanel === 'function') openUsagePanel(); },
    memory: () => { if (window.openSessionMemoryPanel) openSessionMemoryPanel(); },
    /* Show only approvals the signed-in user may handle, with evidence beside decisions. */
    approvals: (p) => window.openApprovalsEntry(p || {}),
    briefs: (p) => { if (typeof openBriefsPanel === 'function') openBriefsPanel(p || {}); },
    /* Open the unified creation view; chatId selects an existing conversation. */
    create: (p) => typeof openComposePanel === 'function' ? openComposePanel(p || {}) : false,
  };
  /* Redirect legacy daily-report URLs to the shared work-brief page. */
  OPENERS.pichat = (p) => OPENERS.create(Object.assign({ tab: 'chat' }, p || {}));
  OPENERS.inbox = (p) => OPENERS.team(Object.assign({}, p, { teamEntry: 'inbox' }));
  OPENERS.daily = (p) => OPENERS.briefs(Object.assign({ period: 'daily', scope: 'mine' }, p || {}));

  // Legacy standalone creation windows use the shared card and close after save or cancel.
  function openRequirementDraft() {
    if (!window.WorkEntrySheet) throw new Error('需求表单暂时不可用，请重新打开窗口');
    return WorkEntrySheet.openTask({ source: '需求池', requirement: true, saveOnly: true,
      triageStage: 'intake', onClose: PANEL === 'add' ? closeWindow : undefined });
  }
  OPENERS.add = openRequirementDraft;
  OPENERS.multi = () => { if (typeof openMultiConsole === 'function') openMultiConsole(); };
  /*
   * Include the task name in standalone console titles to distinguish concurrently open
   * consoles.
   */
  OPENERS.console = (p) => {
    if (!p.taskId || typeof openConsole !== 'function') return;
    openConsole(p.taskId);
    const t = (typeof tasks !== 'undefined' && tasks.find) ? tasks.find((x) => x.id === p.taskId) : null;
    if (t && t.title) SoduWorkI18n.setWindowTitle('控制台', t.title);
  };
  OPENERS.detail = (p) => openWorkspace('history', { requirementId: p.taskId });

  /*
   * The workspace shell reuses existing page openers and closers so standalone and hosted
   * pages share business behavior.
   */
  const WORKSPACE_TARGET = {
    aidesk: 'aiDeskPanel', history: 'historyBoard', workitems: 'historyBoard', add: 'addMask',
    create: 'composePanel', briefs: 'briefPanel', memory: 'sessionMemoryPanel',
    account: 'personalAccountPanel', settings: 'settingsPanel', shortcuts: 'shortcutsPanel', archive: 'archivePanel', skin: 'skinManager', notices: 'noticePanel',
    team: 'teamPanel', inbox: 'teamPanel', daily: 'briefPanel', schedules: 'schPanel',
    skills: 'capPanel', library: 'libraryPanel', models: 'mdPanel', agents: 'agPanel', cloud: 'cloudEnvironmentPanel', codeacct: 'caPanel', usage: 'usagePanel',
    apps: 'appsPanel', sidebarapp: 'workspaceAppPanel',
  };
  let _workspaceView = '';
  function _workspacePayload(view, payload) {
    const out = Object.assign({}, payload || {});
    if (view === 'inbox' || view === 'team') out.teamEntry = view;
    return out;
  }
  function _workspaceCloseCurrent(next) {
    if (!_workspaceView || _workspaceView === next) return;
    if (_workspaceView === 'account') {
      try { window.AccountCenter?.closePanel(); } catch (e) { console.warn('[workspace] 收起个人账户失败', e); }
      return;
    }
    if (_workspaceView === 'sidebarapp') { window.WorkspaceSidebarApps?.close(); return; }
    const name = CLOSERS[_workspaceView];
    if (name && typeof window[name] === 'function') {
      try { window[name](); } catch (e) { console.warn('[workspace] 收起旧页面失败', e); }
    }
  }
  function openWorkspace(view, payload) {
    if (view === 'add') return openWorkspace('history', { createRequirement: true });
    if (view === 'detail') return openWorkspace('history', {requirementId: payload?.taskId});
    // Old deep links remain compatible, but no longer open a second approval page.
    if (view === 'approvals') {
      if (payload && payload.taskId) return window.openApprovalsEntry(payload);
      return openWorkspace('history', {approvalInbox: true});
    }
    if (view === 'history' && payload?.requirementId) {
      const id = payload.requirementId;
      openWorkspace('history', {});
      return window.RequirementsDetail?.open(id);
    }
    const key = WORKSPACE_TARGET[view] ? view : 'aidesk';
    const open = () => {
      /* Declare the target page before its opener mounts or shows the panel, using the shared workspace mounting flow. */
      document.documentElement.setAttribute('data-workspace-view', key);
      if (typeof window.closeArchiveHistory === 'function') window.closeArchiveHistory();
      _workspaceCloseCurrent(key);
      document.querySelectorAll('.workspace-hosted').forEach((x) => x.classList.remove('workspace-hosted'));
      const fn = key === 'sidebarapp' ? p => window.WorkspaceSidebarApps.open(p) : OPENERS[key] || OPENERS.aidesk;
      const opened = fn(_workspacePayload(key, payload));
      const target = document.getElementById(WORKSPACE_TARGET[key]);
      if (target) target.classList.add('workspace-hosted');
      _workspaceView = key;
      if (window.WorkspaceShell) WorkspaceShell.setActive(key);
      return opened;
    };
    return window.SoduWorkPagePerformance ? SoduWorkPagePerformance.navigate(key, open) : open();
  }

  window.WorkspaceHost = { open: (view, payload) => window.WorkspaceNavigation
    ? WorkspaceNavigation.open(view, payload, openWorkspace) : openWorkspace(view, payload),
    get view() { return _workspaceView; } };
  /* An empty workspace route opens home; restored window parameters come from the main process's current-run memory. */
  OPENERS.workspace = (p) => window.WorkspaceHost.open(String((p || {}).view || 'create'), p || {});
  function wireWorkspaceAutoReturn() {
    const mask = document.getElementById('addMask');
    if (!mask || mask._workspaceObserved) return;
    mask._workspaceObserved = true;
    new MutationObserver(() => {
      /* Creation and cancellation hide the mask; explicit navigation has already changed _workspaceView and must not redirect again. */
      if (_workspaceView === 'add' && !mask.classList.contains('show')) {
        setTimeout(() => { if (_workspaceView === 'add') openWorkspace('history', {}); }, 0);
      }
    }).observe(mask, { attributes: true, attributeFilter: ['class'] });
  }

  /*
   * Wrap the standalone page's close function to close its native window after content is
   * dismissed.
   */
  const CLOSERS = {
    aidesk: 'closeAIDesk', settings: 'closeSettings', shortcuts: 'closeShortcutSettings', archive: 'closeArchiveHistory', skin: 'closeSkinManager',
    notices: 'closeNoticePanel', history: 'closeHistoryBoard', workitems: 'closeHistoryBoard', add: 'closeAdd',
    schedules: 'closeSchedulePanel', skills: 'closeSkillPanel', library: 'closeLibraryPanel', models: 'closeModelsPanel',
    apps: 'closeAppsPanel',
    'model-editor': 'closeModelsPanel',
    agents: 'closeAgentsPanel', cloud: 'closeCloudEnvironmentsPanel', codeacct: 'closeCodeAcctPanel', usage: 'closeUsagePanel',
    create: 'closeComposePanel', briefs: 'closeBriefsPanel', memory: 'closeSessionMemoryPanel',
    team: 'closeTeamPanel', inbox: 'closeTeamPanel', daily: 'closeBriefsPanel',
    detail: 'closeDetail', multi: 'closeMultiConsole', console: 'closeConsole',
  };

  let _contentReadySent = false;
  function contentReady() {
    if (_contentReadySent) return;
    _contentReadySent = true;
    try {
      if (window.soduWorkAPI && soduWorkAPI.deskContentReady) soduWorkAPI.deskContentReady();
    } catch (e) { /* The main process also enforces a startup timeout. */ }
  }

  function openPage(payload) {
    const fn = OPENERS[PANEL] || OPENERS.aidesk;
    try {
      fn(payload || {});
    } catch (e) {
      /*
       * Keep failed pages open with an error state and console diagnostics instead of
       * automatically closing an empty window.
       */
      console.error('[desk] 开「' + PANEL + '」这一页失败', e);
      _openFailed = true;
      const hint = document.getElementById('deskBlankHint');
      if (hint) hint.textContent = '这一页没能打开：' + (e && e.message || e);
      contentReady();
      return;
    }
    _opened = true;
    /*
     * Hide the loading background after content mounts so stale loading text cannot appear or
     * pollute accessibility output.
     */
    const blank = document.getElementById('deskBlank');
    if (blank) blank.style.display = 'none';
    contentReady();
  }

  let _booted = false, _opened = false, _openFailed = false, _pending = null;
  let _hydratePaintPending = false;
  function _deskIsEditing() {
    const el = document.activeElement;
    return !!(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
  }
  function _paintHydratedDesk() {
    /* If calibration finishes within the 140ms first-paint budget, the initial open consumes it without another render. */
    if (!_booted) return;
    if (_deskIsEditing()) { _hydratePaintPending = true; return; }
    _hydratePaintPending = false;
    applyLook();
    if (PANEL === 'workspace' && window.WorkspaceShell) {
      try { WorkspaceShell.setTasks(typeof tasks !== 'undefined' ? tasks : []); } catch (e) {}
      WorkspaceShell.setConnected(!!(window.SoduWorkAPI && SoduWorkAPI.online !== false));
    }
    const view = PANEL === 'workspace' ? _workspaceView : PANEL;
    if ((view === 'history' || view === 'workitems') && typeof _renderHistoryBoard === 'function') _renderHistoryBoard();
    else if (view === 'aidesk' && typeof _loadDesks === 'function') _loadDesks('');
    else if (typeof renderSoon === 'function') renderSoon();
  }
  window.addEventListener('soduwork-store-hydrated', _paintHydratedDesk);
  window.addEventListener('soduwork-config-hydrated', _paintHydratedDesk);
  document.addEventListener('focusout', () => {
    if (_hydratePaintPending) setTimeout(_paintHydratedDesk, 0);
  });
  try {
    if (window.soduWorkAPI && soduWorkAPI.onDeskOpen) {
      soduWorkAPI.onDeskOpen((payload) => {
        if (_booted) openPage(payload); else _pending = payload || {};
      });
    }
  } catch (e) {}

  /*
   * Close standalone windows through native controls or explicit page completion. Do not
   * infer closure from DOM visibility; Escape dismisses overlays only.
   */
  function closeWindow() {
    try {
      if (window.soduWorkAPI && soduWorkAPI.closeDeskWindow) soduWorkAPI.closeDeskWindow();
      else window.close();
    } catch (e) { try { window.close(); } catch (e2) {} }
  }
  let _closesWired = false;
  function wireCloses() {
    if (_closesWired) return;
    _closesWired = true;
    const name = CLOSERS[PANEL];
    if (name && typeof window[name] === 'function') {
      const orig = window[name];
      window[name] = function () {
        const r = orig.apply(this, arguments);
        closeWindow();
        return r;
      };
    }
    // Capture handling coordinates native popovers only; other overlays own their dismissal handlers.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (e.defaultPrevented) return;
      // Let confirmation dialogs, previews, and forms handle Escape before workspace behavior.
      if (document.querySelector('dialog:modal,.catt-preview,#workEntryLayer,.pui-layer.is-visible,.rq-detail-backdrop,.rq-assignment-backdrop')) return;
      const popover = document.querySelector('[popover]:popover-open');
      if (popover) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (popover.id === 'taskApprovalInbox' && window.TaskApprovalInbox) TaskApprovalInbox.close();
        else popover.hidePopover();
        return;
      }
    }, true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  function start() {
    if (PANEL === 'workspace' && window.WorkspaceShell) {
      WorkspaceShell.mount();
      wireWorkspaceAutoReturn();
    }
    applyLook();                                   /* Apply the saved theme synchronously before backend loading. */
    /*
     * Install idempotent close wrappers before opening EARLY pages so immediate submission
     * cannot leave an empty native window.
     */
    wireCloses();
    /*
     * Read initial arguments from the URL because desk-open IPC can arrive before its listener
     * is registered.
     */
    const args = window.__deskArgs || {};
    const earlyWorkspace = PANEL === 'workspace' && EARLY[String(args.view || '')];
    if (EARLY[PANEL] || earlyWorkspace) openPage(args); /* Open configuration pages without waiting for task data. */
    boot().catch((e) => console.error('[desk] 引导失败', e)).then(() => {
      _booted = true;
      if (PANEL === 'workspace' && window.WorkspaceShell) {
        try { WorkspaceShell.setTasks(typeof tasks !== 'undefined' ? tasks : []); } catch (e) {}
        WorkspaceShell.setConnected(!!(window.SoduWorkAPI && SoduWorkAPI.online !== false));
        if (window.SoduWorkAPI && typeof SoduWorkAPI.listApprovals === 'function') {
          SoduWorkAPI.listApprovals().then((r) => WorkspaceShell.setApprovalCount(r && r.count || 0)).catch(() => {});
        }
      }
      if (_pending) openPage(_pending);           /* Explicit startup navigation takes precedence over restored early pages. */
      else if (!_opened) openPage(args);          /* Open data-dependent pages after initialization. */
      /* Populate assignment choices after team capabilities arrive for an early-opened creation form. */
      else if (PANEL === 'add' && typeof _requestPopulateAssign === 'function') { try { _requestPopulateAssign(); } catch (e) {} }
      /* Refresh the early-opened execution workspace after current-Hub tasks load. */
      else if (PANEL === 'aidesk' && typeof _loadDesks === 'function') { try { _loadDesks(''); } catch (e) {} }
      _pending = null;
      if (PANEL === 'workspace') window.dispatchEvent(new Event('soduwork-workspace-ready'));
      if (PANEL === 'chatbar') {
        window.__soduWorkChatbarReady = true;
        window.dispatchEvent(new Event('soduwork-chatbar-ready'));
      }
      if (_openFailed) console.error('[desk]「' + PANEL + '」没能开起来，窗口留着方便看现场');
      wireCloses();
    });
  }
})();
