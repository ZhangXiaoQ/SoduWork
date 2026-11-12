

















(function (global) {
  'use strict';

  const LS_CFG = 'soduwork_work_cfg_v5';
  const LS_NOTICES = 'soduwork_work_notices_v1';
  const noticeStorageKey = () => (global.SoduWorkAPI && typeof global.SoduWorkAPI.taskStorageKey === 'function')
    ? global.SoduWorkAPI.taskStorageKey('notices') : LS_NOTICES;
  function taskEventScope() {
    const api = global.SoduWorkAPI, identity = api?.clientAuthSnapshot?.();
    return identity?.state === 'active' && identity.user?.id
      ? String(api.taskStorageKey?.('ops') || '') : '';
  }

  const _read = (k, dft) => {
    try { return JSON.parse(localStorage.getItem(k) || dft); } catch (e) { return JSON.parse(dft); }
  };

  /* Send invalidations. */
  function push(kind, payload) {
    try {
      if (global.soduWorkAPI && soduWorkAPI.broadcast) soduWorkAPI.broadcast(kind, payload || null);
    } catch (e) { /* Single-window browser previews need no Electron synchronization. */ }
  }

  /* Receive invalidations. */
  /*
   * Reload and reapply configuration. Capture the prior skin ID before merging so its
   * injected variables can be removed.
   */
  function pullCfg() {
    if (typeof Store === 'undefined' || !Store._cfg) return;
    const incoming = _read(LS_CFG, '{}');
    if (!incoming || typeof incoming !== 'object') return;
    /*
     * Remove legacy server-owned fields before merging, matching Store's CFG_SERVER_OWNED
     * contract.
     */
    ['modelProviders'].forEach(k => { delete incoming[k]; });
    const prevSkinId = Store._cfg._lastSkinId;
    Object.assign(Store._cfg, incoming);
    const c = Store._cfg;
    if (c.locale) global.SoduWorkI18n?.setLocale(c.locale, { persist: false, broadcast: false });

    /* Remove old skin variables and apply new ones; built-in skins without overrides require no changes. */
    if (typeof SkinRegistry !== 'undefined' && c._lastSkinId !== prevSkinId) {
      try {
        const prev = prevSkinId && SkinRegistry.getSkin(prevSkinId);
        if (prev) SkinRegistry.clearSkinCSSVars(prev);
        const cur = c._lastSkinId && SkinRegistry.getSkin(c._lastSkinId);
        if (cur) SkinRegistry.applySkinCSSVars(cur);
      } catch (e) { /* Fall back to built-in styling if the registry is unavailable. */ }
    }
    /* Guard window-specific helpers so each renderer applies only its own effects. */
    if (typeof applyTheme === 'function') applyTheme();
    if (typeof applyScale === 'function') applyScale(c.uiScale);
    if (typeof applyFontScale === 'function') applyFontScale(c.fontScale);
    if (typeof applyPetVisible === 'function') applyPetVisible();
    if (typeof applyDockVisible === 'function') applyDockVisible();
    if (typeof syncDeskFlagChks === 'function') syncDeskFlagChks();
    if (typeof renderPetSVG === 'function') renderPetSVG(c.gender);
    if (typeof updatePet === 'function') updatePet();
    if (typeof render === 'function') render();
    if (typeof applyRemind === 'function') applyRemind();
    if (typeof applyShape === 'function') applyShape();
    if (typeof refreshSkinCurName === 'function') refreshSkinCurName();
    /* Refresh an open skin panel, including remotely initiated changes. */
    if (typeof renderSkinGrid === 'function') {
      const sm = document.getElementById('skinManager');
      if (sm && sm.classList.contains('show')) renderSkinGrid();
    }
  }

  /* Reload notifications, refresh badges, and update the open notification center. */
  function pullNotices() {
    if (typeof notices === 'undefined' || !Array.isArray(notices)) return;
    if (global.MateNoticeSync?.persistent) {
      return global.MateNoticeSync.restore().catch(() => {});
    }
    const arr = _read(noticeStorageKey(), '[]');
    if (!Array.isArray(arr)) return;
    notices.length = 0;
    Array.prototype.push.apply(notices, arr);
    if (typeof updateNoticeBadge === 'function') updateNoticeBadge();
    if (typeof _renderNoticePanel === 'function') {
      const p = document.getElementById('noticePanel');
      if (p && p.classList.contains('show')) _renderNoticePanel();
    }
  }

  /*
   * Task broadcasts invalidate state only. Each window reloads its current Hub rather than
   * another window's local mirror; throttle bursts to 120ms.
   */
  let _taskT = null;
  function pullTasks() {
    clearTimeout(_taskT);
    _taskT = setTimeout(async () => {
      if (typeof Store === 'undefined' || !Array.isArray(Store._tasks)) return;
      /* Reload tasks from the current Hub environment after invalidation. */
      if (typeof Store.refreshTasks === 'function') await Store.refreshTasks();
      try { global.dispatchEvent(new CustomEvent('soduwork-work-task-change', { detail: { type: 'tasks.synced', all: true } })); } catch (_) {}
      if (typeof render === 'function') render();
      if (typeof updatePet === 'function') updatePet();
      if (typeof _syncSidebar === 'function') _syncSidebar();
      /* Patch task details incrementally during cross-window updates to preserve trace components and active controls. */
      if (typeof detailId !== 'undefined' && detailId && typeof refreshOpenDetail === 'function') {
        refreshOpenDetail(detailId);
      }
      if (typeof _renderHistoryBoard === 'function') {
        const hb = document.getElementById('historyBoard');
        if (hb && hb.classList.contains('show')) _renderHistoryBoard();
      }
    }, 120);
  }

  /*
   * Reprobe team capability and inbox counts after changes so the desktop dock badge
   * reflects claims made in the workspace.
   */
  function pullTeamCap() {
    if (!(global.SoduWorkAPI && SoduWorkAPI.getTeamCapability)) return;
    SoduWorkAPI.getTeamCapability().then((cap) => {
      if (!cap) return;
      if (typeof setTeamCap === 'function') setTeamCap(cap);
      else global.__teamCap = cap;
    }).catch(() => {});
  }

  function pullModels() {
    const panel = document.getElementById('mdPanel');
    if (!panel || !panel.classList.contains('show') || typeof _mdLoad !== 'function') return;
    /*
     * Do not refresh another provider's unsaved credentials or custom models away; the editing
     * window reloads after saving.
     */
    const dirty = (typeof _mdDirty !== 'undefined' && _mdDirty) ||
      (typeof _mdKeyEdits !== 'undefined' && Object.keys(_mdKeyEdits || {}).length > 0);
    if (dirty) return;
    _mdData = null;
    _mdLoad();
  }

  /*
   * Hub environment changes affect the entire client process group; reload every window's
   * HTTP and WebSocket state.
   */
  function pullHubEnvironment() {
    if (typeof Store !== 'undefined' && typeof Store.beginEnvironmentSwitch === 'function') {
      Store.beginEnvironmentSwitch();
    }
    setTimeout(() => location.reload(), 80);
  }
  /*
   * Move the desktop dock aside for the Agent drawer in another native window. Style changes
   * refresh the overlay's native hit regions.
   */
  function agDrawerAvoid(on) {
    const dock = document.getElementById('edgeDock');
    if (!dock) return;
    /*
     * Use an inline transform to override inline drag cleanup that CSS classes cannot
     * supersede.
     */
    dock.style.transform = on ? 'translateX(120%)' : 'none';
    dock.classList.toggle('avoid', !!on);
  }

  /* A task-event relay carries assignment semantics to the workspace renderer. */
  function pullTaskEvent(payload) {
    // Account changes reach separate renderers asynchronously. A task from an
    // older window must never become a fact in the current account's Store.
    // Legacy broadcasts carry no provenance, so only re-read the authorized Hub.
    if (!payload?.taskScope) { pullTasks(); return; }
    if (payload.taskScope !== taskEventScope()) return;
    if (!payload || !payload.task || typeof Store === 'undefined' || !Store ||
        typeof Store.applyServerEvent !== 'function') { pullTasks(); return; }
    try { Store.applyServerEvent({ ...payload, __fromWindow: true }); }
    catch (e) { pullTasks(); }
  }
  const HANDLERS = { cfg: pullCfg, notices: pullNotices, teamcap: pullTeamCap,
                     tasks: pullTasks, 'task-event': pullTaskEvent, models: pullModels, hubenv: pullHubEnvironment,
                     'ag-drawer': agDrawerAvoid, 'agent-runtimes-changed': () => { try { global.dispatchEvent(new Event('agent-runtimes-changed')); } catch (_) {} } };

  try {
    if (global.soduWorkAPI && soduWorkAPI.onBroadcast) {
      soduWorkAPI.onBroadcast((kind, payload) => {
        const fn = HANDLERS[kind];
        if (fn) return fn(payload);
      });
    }
  } catch (e) { /* No bridge: single-window mode. */ }
  /*
   * Restore the displaced dock before the drawer-owning window closes or reloads.
   */
  window.addEventListener('beforeunload', () => {
    try { if (global.soduWorkAPI && soduWorkAPI.broadcast) soduWorkAPI.broadcast('ag-drawer', false); } catch (e) { /* Window shutdown is in progress. */ }
  });
  /*
   * Route ordinary business pages to the workspace and terminals to standalone tools,
   * retaining desktop quick views. Return true when routed; open locally only without a
   * bridge or in the target standalone page.
   */
  function routeToWorkWindow(panel, extra) {
    /* The main workspace owns business detail pages so users keep navigation context.
       Only terminal tools and task creation remain separate native windows. */
    const standalone = panel === 'console' || panel === 'multi' ||
                       panel === 'add';





    if (!standalone && global.__deskPanel === 'workspace' && global.WorkspaceHost) {
      global.WorkspaceHost.open(panel, extra || {});
      return true;
    }
    if (global.__deskPanel === panel) return false;
    if (!(global.soduWorkAPI && soduWorkAPI.openDeskWindow)) return false;
    soduWorkAPI.openDeskWindow(Object.assign(
      standalone ? { panel: panel } : { panel: 'workspace', view: panel }, extra || {}));
    return true;
  }

  /*
   * Use Entry functions for dock and remote actions so workspace pages do not open inside
   * the desktop overlay.
   */
  global.openSettingsEntry = function () {
    if (!routeToWorkWindow('settings') && typeof openSettings === 'function') openSettings();
  };
  global.openSkinEntry = function () {
    if (!routeToWorkWindow('skin') && typeof openSkinManager === 'function') openSkinManager();
  };
  // Historical task links open the same requirement, never a second detail page.
  global.openDetailEntry = function (taskId) {
    if (!taskId) return;
    if (global.__deskPanel === 'workspace' && global.RequirementsDetail) return global.RequirementsDetail.open(taskId);
    return routeToWorkWindow('history', { requirementId: taskId });
  };
  /* Route creation to the shared requirement card; the desktop overlay owns navigation only. */
  global.openAddEntry = function () {
    if (routeToWorkWindow('history', { createRequirement: true })) return;
    return global.WorkEntrySheet?.openTask({ source: '需求池', requirement: true, saveOnly: true, triageStage: 'intake' });
  };
  /* Open the multi-terminal console in a separate native window. */
  global.openMultiEntry = function () {
    if (!routeToWorkWindow('multi') && typeof openMultiConsole === 'function') openMultiConsole();
  };
  global.openNoticeEntry = function () {
    if (!routeToWorkWindow('notices') && typeof openNoticePanel === 'function') openNoticePanel();
  };
  /* Open personal schedules through their dedicated page. */
  global.openSchedulesEntry = function (options) {
    if (!routeToWorkWindow('schedules', options) && typeof openSchedulePanel === 'function') openSchedulePanel(options);
  };
  /* Administrators control available skills; the personal page selects this client's skills. */
  global.openSkillsEntry = function () {
    if (!routeToWorkWindow('skills') && typeof openSkillPanel === 'function') openSkillPanel();
  };
  /* Administrators control services and models; the personal page manages private keys and custom models. */
  global.openLibraryEntry = function () {
    if (!routeToWorkWindow('library') && typeof openLibraryPanel === 'function') openLibraryPanel();
  };
  global.openModelsEntry = function () {
    if (!routeToWorkWindow('models') && typeof openModelsPanel === 'function') openModelsPanel();
  };
  /* Manage installed CLI runtimes, configuration, and connection tests. */
  global.openAgentsEntry = function () {
    if (routeToWorkWindow('agents', { tab: 'runners' })) return true;
    if (typeof openAgentsPanel === 'function') { openAgentsPanel({ tab: 'runners' }); return true; }
    return false;
  };
  /* Manage commit identity and push credentials. */
  global.openCodeAcctEntry = function () {
    if (!routeToWorkWindow('codeacct') && typeof openCodeAcctPanel === 'function') openCodeAcctPanel();
  };
  /* Route conversations into the workspace content area; chatId resumes an existing conversation. */
  /* Create page: no parameters selects the task-creation tab. */
  global.openCreateEntry = function (extra) {
    const given = Object.assign({}, extra || {});
    const payload = given.chatId
      ? given
      : (global.WorkspaceShell && typeof global.WorkspaceShell.newSessionPayload === 'function'
        ? global.WorkspaceShell.newSessionPayload(given)
        : Object.assign({ newSession: true }, given));
    if (!routeToWorkWindow('create', payload) && typeof openComposePanel === 'function') openComposePanel(payload);
  };
  global.openPiChatEntry = function (chatId) {
    const payload = chatId
      ? { tab: 'chat', chatId: String(chatId) }
      : (global.WorkspaceShell && typeof global.WorkspaceShell.newSessionPayload === 'function'
        ? global.WorkspaceShell.newSessionPayload({ tab: 'chat' })
        : { tab: 'chat', newSession: true });
    if (!routeToWorkWindow('create', payload) && typeof openComposePanel === 'function') openComposePanel(payload);
  };
  /* Approval notifications open a task's review card or the pending-review list when no task is supplied. */
  global.openApprovalsEntry = function (focus) {
    /*
     * Preserve task context when opening review. Decisions and evidence reside in the
     * Hub-backed details card, independent of device-local execution archives.
     */
    const src = typeof focus === 'string' ? { taskId: focus } : (focus || {});
    const payload = {
      taskId: String(src.taskId || ''),
      approvalId: String(src.approvalId || ''),
    };
    if (payload.taskId) {
      if (global.__deskPanel === 'workspace' && global.RequirementsDetail) {
        return global.RequirementsDetail.open(payload.taskId);
      }
      return routeToWorkWindow('history', { requirementId: payload.taskId });
    }
    if (!routeToWorkWindow('history', {approvalInbox: true}) && global.TaskApprovalInbox) {
      if (typeof openTaskCenter === 'function') openTaskCenter();
      return global.TaskApprovalInbox.open();
    }
  };
  global.openHistoryEntry = function () {
    const routed = routeToWorkWindow('history');
    if (!routed && typeof openTaskCenter === 'function') openTaskCenter();
    else if (!routed && typeof openHistoryBoard === 'function') openHistoryBoard();
  };
  /* Employees and leaders read work briefs in the client; administration manages their rules. */
  global.openBriefsEntry = function (extra) {
    if (!routeToWorkWindow('briefs', extra || {}) && typeof openBriefsPanel === 'function') {
      openBriefsPanel(extra || {});
    }
  };
  /* Keep team and inbox entry points and redirect legacy daily reports to work briefs. */
  global.openTeamEntry = function (entry) {
    const e = entry || 'team';
    if (e === 'daily') {
      global.openBriefsEntry({ period: 'daily', scope: 'mine' });
      return;
    }
    if (!routeToWorkWindow(e, { teamEntry: e }) && typeof openTeamPanel === 'function') {
      openTeamPanel({ entry: e });
    }
  };

  /* Synchronize desktop visibility preferences with the main process. */
  /*
   * cfg owns dock, pet, and tray visibility. Report changes to the main-process startup
   * cache; tray actions update and persist cfg through the same broadcast flow.
   */
  function reportFlags() {
    try {
      if (!(global.soduWorkAPI && soduWorkAPI.reportDeskFlags)) return;
      const c = (typeof Store !== 'undefined' && Store._cfg) || {};
      soduWorkAPI.reportDeskFlags({
        dock: c.dockVisible !== false, pet: c.petVisible !== false, tray: c.trayVisible !== false,
      });
    } catch (e) { /* Browser previews have no main process or tray. */ }
  }

  /* Apply tray preference broadcasts in both windows, persist through saveCfg, and synchronize idempotently.
   Preferences are explicit and durable; no session-only visibility override is used. */
  if (global.soduWorkAPI && soduWorkAPI.onDeskFlags &&
      /index\.html|desk\.html/.test(location.pathname)) {
    soduWorkAPI.onDeskFlags((f) => {
      if (typeof Store === 'undefined' || !Store._cfg) return;
      if ('dock' in f) Store._cfg.dockVisible = !!f.dock;
      if ('pet' in f) Store._cfg.petVisible = !!f.pet;
      if ('tray' in f) Store._cfg.trayVisible = !!f.tray;
      if (typeof saveCfg === 'function') saveCfg();
      if (typeof applyPetVisible === 'function') applyPetVisible();
      if (typeof applyDockVisible === 'function') applyDockVisible();
    });
  }
  /* Report authoritative preferences on startup to refresh the main-process cache. */
  if (typeof setTimeout === 'function') setTimeout(reportFlags, 0);

  global.WinSync = {
    push: push,
    reportFlags: reportFlags,
    pushCfg: () => { push('cfg'); reportFlags(); },
    pushNotices: () => push('notices'),
    pushTeamCap: () => push('teamcap'),
    pushTasks: () => push('tasks'),
    pushTaskEvent: (event) => {
      const taskScope = taskEventScope();
      if (taskScope) push('task-event', { ...event, taskScope });
      else push('tasks');
    },
    pushHubEnvironment: () => push('hubenv'),
    routeToWorkWindow: routeToWorkWindow,
  };
})(typeof window !== 'undefined' ? window : this);
