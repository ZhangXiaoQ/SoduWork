/* One authoritative Task collection, viewed as a board, list or timeline. */
(function (global) {
  'use strict';
  const R = global.Requirements, V = global.RequirementsView;
  const state = { ...R.defaults, limits: {}, drag: '', movingId: '', pending: false, busy: false, signature: '', year: null, month: null, onlyOverdue: false };
  let identity = '', epoch = 0, projects = new Map(), projectRequest = 0, menuAnchor = null;
  let createMenuDismiss = null;
  const panel = () => document.getElementById('historyBoard');
  const rows = () => typeof tasks === 'undefined' ? [] : tasks.filter(R.isRequirement);
  const notify = text => global.petSay?.(text);
  const storageKey = () => global.SoduWorkAPI?.taskStorageKey?.('tasks');
  function syncIdentity() {
    const key = storageKey() || ''; if (identity === key) return;
    identity = key; epoch++; projectRequest++; projects = new Map();
    let saved = null;
    try {
      if (key && !key.endsWith('@unbound')) {
        saved = JSON.parse(localStorage.getItem(key + ':requirement-view') || 'null');
        /*
         * Migrate unchanged legacy defaults to actionable tasks and recent updates. Preserve
         * explicit alternative choices; versioned preferences use the user's selections directly.
         */
        if (saved && saved.v !== 2) {
          if (saved.scope === 'related') delete saved.scope;
          if (saved.sort === 'priority') delete saved.sort;
        }
      }
    } catch (_) {}
    Object.assign(state, R.viewSettings(saved), { limits: {}, drag: '', movingId: '', pending: false, busy: false, signature: '', year: null, month: null, onlyOverdue: false }); hideMenu();
    panel()?.querySelectorAll('[popover]').forEach(menu => { if (menu.matches(':popover-open')) menu.hidePopover(); });
    const filters = panel()?.querySelector('#rqFilters'); if (filters) filters.innerHTML = '';
  }
  function persist() {
    if (!identity || identity.endsWith('@unbound') || identity !== storageKey()) return;
    try { localStorage.setItem(identity + ':requirement-view', JSON.stringify({ ...R.viewSettings(state), v: 2 })); } catch (_) {}
  }
  function context() {
    const approvals = new Map(), waiting = new Map();
    for (const item of global.TaskApprovalInbox?.snapshot?.() || []) if (!approvals.has(String(item.taskId))) approvals.set(String(item.taskId), item);
    for (const row of global.TaskApprovalInbox?.waiting?.() || []) if (!waiting.has(String(row.taskId))) waiting.set(String(row.taskId), row.waitingOn || []);
    return { approvals, waiting, projects };
  }
  function dataRows() { return rows().map(task => task.projectId && projects.has(String(task.projectId)) ? { ...task, projectName: projects.get(String(task.projectId)) } : task); }
  async function loadProjects() {
    if (!global.SoduWorkAPI?.getProjects) return;
    const request = ++projectRequest, key = storageKey();
    try {
      const result = await global.SoduWorkAPI.getProjects(); if (request !== projectRequest || key !== storageKey()) return;
      const list = Array.isArray(result) ? result : result?.projects || [];
      projects = new Map(list.map(item => [String(item.id), String(item.name || item.title || '')])); render();
    } catch (_) { /* Existing task names remain usable when project lookup fails. */ }
  }
  function create(stage) {
    if (global.WorkEntrySheet) return global.WorkEntrySheet.openTask({ source: '需求池', requirement: true,
      saveOnly: true, triageStage: stage === 'ready' ? 'ready' : 'intake',
      projectId: state.project && state.project !== '__none' ? state.project : '', kind: state.kind || 'requirement' });
    global.WorkspaceHost?.open('create', { taskMode: 'create', newSession: true });
  }
  function closeCreateMenu(restoreFocus) {
    if (createMenuDismiss) { createMenuDismiss(); createMenuDismiss = null; }
    const menu = panel()?.querySelector('#rqCreateMenu');
    const trigger = panel()?.querySelector('#hbAddMenuToggle');
    if (menu) menu.hidden = true;
    if (trigger) {
      trigger.setAttribute('aria-expanded', 'false');
      if (restoreFocus) trigger.focus({ preventScroll: true });
    }
  }
  function openCreateMenu(index) {
    const root = panel(), trigger = root?.querySelector('#hbAddMenuToggle'), menu = root?.querySelector('#rqCreateMenu');
    if (!root || !trigger || !menu) return;
    closeCreateMenu(false);
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    const focusIndex = index < 0 ? items.length - 1 : Math.min(index, items.length - 1);
    (items[focusIndex] || menu).focus({ preventScroll: true });
    const outside = event => { if (!root.querySelector('.rq-create-group')?.contains(event.target)) closeCreateMenu(false); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    createMenuDismiss = () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
    };
  }
  async function createFromChat(stage) {
    closeCreateMenu(false);
    const route = typeof global.openCreateEntry === 'function' ? global.openCreateEntry :
      (typeof global.openComposePanel === 'function' ? global.openComposePanel : null);
    const restoreCreateFocus = () => panel()?.querySelector('#hbAddMenuToggle')?.focus({ preventScroll: true });
    if (!route) restoreCreateFocus();
    if (!route) { notify('对话入口尚未就绪，请稍后重试；也可以选择手动录入。'); return false; }
    const payload = {
      tab: 'chat', newSession: true, pluginId: 'work.requirement.create', prefill: '/需求 ',
      triageStage: stage === 'ready' ? 'ready' : 'intake',
      contextPrompts: ['当前从需求池进入。请把这次对话整理成一条可协作的需求：明确目标、背景、完成标准和相关材料；信息不足时先询问，确认后再创建，不要直接开始执行。'],
    };
    try {
      if (await route(payload) === false) throw new Error('conversation entry unavailable');
      close();
      notify('请在对话中描述需求，发送后确认标题、背景和完成标准。');
      return true;
    } catch (_) {
      restoreCreateFocus();
      notify('对话暂时没有打开，请重试；也可以选择手动录入。');
      return false;
    }
  }
  function sourceHtml(status) {
    const loading = status === 'loading';
    return '<section class="rq-empty" role="status"><h2>' + (loading ? '正在加载需求' : '暂时无法连接后台') + '</h2><p>' +
      (loading ? '正在读取当前环境的需求和执行进度。' : '连接恢复后会自动同步，已保存的需求不会丢失。') + '</p>' +
      (loading ? '' : '<button type="button" data-rq-refresh>重新连接</button>') + '</section>';
  }
  function emptyHtml() {
    const filtered = state.q || Object.keys(V.labels).some(key => state[key]), hasRows = rows().length > 0, archived = state.archive === 'archived';
    return '<section class="rq-empty"><span class="rq-empty-icon">' + V.icon('board') + '</span><h2>' +
      (filtered ? '没有匹配的需求' : archived ? '暂无已归档需求' : state.scope === 'actionable' ? '暂时没有需要你处理的需求' :
       state.scope === 'created' ? '你还没有提出需求' : hasRows ? '暂时没有与你相关的需求' : '从一件想完成的事开始') + '</h2><p>' +
      (filtered ? '调整筛选条件，或清除筛选查看此视图的全部需求。' : archived ? '归档后的需求会保留在这里，随时可以查阅和恢复。' :
       hasRows ? '可以切换筛选查看其他需求，或提出一件新的工作。' : '先记录想法，准备好后再安排自己、同事或 AI 执行。') + '</p><button type="button" ' +
      (filtered ? 'data-rq-clear>清除筛选' : archived ? 'data-rq-archive="active">返回当前需求' : hasRows ? 'data-rq-scope="all">查看全部需求' : 'data-rq-create>新建需求') + '</button></section>';
  }
  function render(force) {
    const root = panel(); if (!root?.classList.contains('show')) return;
    syncIdentity(); state.scope = R.normalizeScope(state.scope, state.archive);
    if (state.drag) { state.pending = true; return; }
    const data = dataRows(), ctx = context(), source = typeof Store === 'undefined' ? 'loading' : Store.taskState;
    const available = source === 'ready' || source === 'stale';
    root.querySelector('#rqConnection').hidden = source !== 'stale';
    // Connection notices do not replace cards, focus, scroll or an open menu.
    const signature = JSON.stringify([available ? 'ready' : source, R.viewSettings(state), state.movingId, state.q, state.limits, state.year, state.month, state.onlyOverdue, [...ctx.approvals], [...projects], data]);
    if (!force && signature === state.signature) return; state.signature = signature;
    const body = root.querySelector('.hb-body'), top = body.scrollTop;
    const left = body.querySelector('.rq-kanban')?.scrollLeft || 0, tableLeft = body.querySelector('.rq-table-wrap')?.scrollLeft || 0;
    const ganttScroll = body.querySelector('.gv-body');
    const ganttPosition = { left: ganttScroll?.scrollLeft || 0, top: ganttScroll?.scrollTop || 0 };
    const scrolls = [...body.querySelectorAll('.rq-lane-cards')].map(node => [node.id, node.scrollTop]);
    const focused = document.activeElement;
    const focusAttribute = focused && body.contains(focused) ? ['data-rq-open','data-rq-actions','data-rq-assign','data-rq-more','data-gvod','id'].find(name => focused.hasAttribute(name)) : '';
    const focusId = focusAttribute ? focused.getAttribute(focusAttribute) : ''; hideMenu();
    const list = R.select(data, state, ctx);
    root.querySelector('#hbTitleText').textContent = state.archive === 'archived' ? '归档需求' : '需求池';
    const archiveEntry = root.querySelector('#rqArchiveEntry');
    archiveEntry.dataset.rqArchive = state.archive === 'archived' ? 'active' : 'archived';
    archiveEntry.textContent = state.archive === 'archived' ? '返回需求池' : '归档';
    archiveEntry.setAttribute('aria-label', state.archive === 'archived' ? '返回当前需求' : '查看归档需求');
    root.querySelector('#hbCount').textContent = available ? '· ' + (state.archive === 'archived' ? '已归档 · ' : '') + list.length + ' 条' : '';
    const scopeControls = root.querySelector('.rq-scopes');
    if (scopeControls.dataset.archive !== state.archive) {
      const choices = Object.entries(R.scopeOptions(state.archive));
      scopeControls.innerHTML = choices.map(([key,label]) => '<button type="button" data-rq-scope="' + key +
        '" aria-pressed="false">' + label + '<b>0</b></button>').join('');
      root.querySelector('#rqScope').innerHTML = V.options(choices, state.scope);
      scopeControls.dataset.archive = state.archive;
    }
    root.querySelectorAll('[data-rq-scope]').forEach(button => {
      const on = button.dataset.rqScope === state.scope; button.classList.toggle('on', on); button.setAttribute('aria-pressed', String(on));
      const badge = button.querySelector('b'); if (badge) badge.textContent = available ? R.select(data, {scope:button.dataset.rqScope,archive:state.archive}, ctx).length : '–';
    });
    for (const [id,key] of [['rqScope','scope'],['rqArchive','archive'],['rqArchiveMore','archive'],['rqSort','sort'],['rqGroup','group']]) root.querySelector('#' + id).value = state[key];
    const sortControl = root.querySelector('#rqSort');
    sortControl.disabled = state.view === 'kanban';
    if (sortControl.disabled) sortControl.value = 'updated';
    root.querySelector('#hbSearch').value = state.q;
    root.querySelectorAll('[data-rq-view]').forEach(button => { button.classList.toggle('on', button.dataset.rqView === state.view); button.setAttribute('aria-pressed', String(button.dataset.rqView === state.view)); });
    root.querySelector('#rqGroupLabel').hidden = state.view !== 'kanban';
    const chips = root.querySelector('#rqChips'); chips.innerHTML = V.chips(state, data, ctx); chips.hidden = !chips.childElementCount;
    const count = Object.keys(V.labels).filter(key => state[key]).length;
    root.querySelector('#rqFilterCount').textContent = count || ''; root.querySelector('#rqFilterToggle').classList.toggle('on', Boolean(count));
    body.classList.toggle('is-kanban', available && list.length > 0 && state.view === 'kanban');
    if (!available) body.innerHTML = sourceHtml(source);
    else if (!list.length) body.innerHTML = emptyHtml();
    else if (state.view === 'gantt' && global.GanttView) {
      const today = new Date(); if (state.year == null) { state.year = today.getFullYear(); state.month = today.getMonth(); }
      body.innerHTML = GanttView.html(list.map(task => ({label:R.content(task).title,sub:task.assigneeName || '',tasks:[{...task,...R.content(task),createdAt:task.createdAt || task.created}]})), {
        year:state.year,month:state.month,onlyOverdue:state.onlyOverdue,isOverdue:R.overdue,labelHead:'需求',clickAttr:'data-rq-open',taskRows:true});
      body.querySelectorAll('[data-rq-open]').forEach(node => { node.tabIndex = 0; node.setAttribute('role','button'); });
    } else body.innerHTML = state.view === 'list' ? V.list(list, state, ctx) : V.board(list, state, ctx);
    if (state.view === 'kanban' && state.group === 'stage') {
      /* RequirementsView predates execution-boundary drops and only marks
         triage cards draggable. Enable the two authoritative transitions as
         well; the drop handler still validates the exact current stage. */
      const byId = new Map(data.map(row => [String(row.id), row]));
      body.querySelectorAll('[data-hbid]').forEach(card => {
        const task = byId.get(card.dataset.hbid);
        const canDrag = Boolean(task && (R.canTriage(task) ||
          moveAction(task, 'reviewing') || moveAction(task, 'delivered')));
        card.draggable = canDrag && state.movingId !== card.dataset.hbid;
      });
    }
    body.scrollTop = top;
    const board = body.querySelector('.rq-kanban'); if (board) board.scrollLeft = left;
    const table = body.querySelector('.rq-table-wrap'); if (table) table.scrollLeft = tableLeft;
    const gantt = body.querySelector('.gv-body'); if (gantt) { gantt.scrollLeft = ganttPosition.left; gantt.scrollTop = ganttPosition.top; }
    scrolls.forEach(([id,position]) => { const lane = document.getElementById(id); if (lane) lane.scrollTop = position; });
    if (focusAttribute) [...body.querySelectorAll('[' + focusAttribute + ']')].find(node => node.getAttribute(focusAttribute) === focusId)?.focus({preventScroll:true});
  }
  async function refresh() {
    await Promise.allSettled([typeof Store !== 'undefined' ? Store.refreshTasks?.({ reconnect: true }) : null, global.TaskApprovalInbox?.refresh(), loadProjects()]); render();
  }
  /* Stage changes that cross execution boundaries must go through Hub facts.
     The preparation helper only handles intake/clarifying/ready; reviewing is
     a pending review ApprovalRequest and delivered is status=done. */
  function moveAction(task, next) {
    const current = R.stage(task);
    if (current === 'delivering' && next === 'reviewing' && R.canSubmitReview(task)) return 'submit-review';
    if (current === 'reviewing' && next === 'delivered' && task.canReview === true) return 'review';
    if (next === 'delivering' && V.assignable(task)) return 'assign';
    return R.stagePatch(task, next) ? 'triage' : '';
  }
  async function move(id, next) {
    if (state.busy) return;
    const task = rows().find(item => String(item.id) === String(id));
    if (!task || R.stage(task) === next) return;
    const action = moveAction(task, next);
    if (action === 'assign') { await global.RequirementAssignment?.open(id); return; }
    if (!action) { notify('执行和交付状态由实际进度更新，请在需求详情中安排或验收。'); return; }
    if (action === 'submit-review' && typeof global.SoduWorkAPI?.submitTaskReview !== 'function') {
      notify('当前客户端不支持提交验收，请更新后重试。'); return;
    }
    if (action === 'review' && typeof global.SoduWorkAPI?.reviewTask !== 'function') {
      notify('当前客户端不支持验收，请更新后重试。'); return;
    }
    const request = epoch, key = storageKey(); state.busy = true; state.movingId = String(id);
    const current = () => request === epoch && key === storageKey();
    const accept = async canonical => {
      if (!current()) return;
      if (canonical && String(canonical.id) === String(id) && typeof Store !== 'undefined' && Store.applyServerEvent) {
        const visible = rows().find(row => String(row.id) === String(id));
        if (Number(visible?.requirementVersion || 0) <= Number(canonical.requirementVersion || 0))
          Store.applyServerEvent({type:'task.updated', task:canonical});
        render();
      } else await refresh();
    };
    try {
      render();
      // Preparation moves already carry a CAS version. Let Hub validate that
      // snapshot directly; do not serialize detail/project/approval reads.
      if (action === 'triage' && Number.isInteger(task.requirementVersion) && task.requirementVersion > 0) {
        const canonical = await global.SoduWorkAPI.patchTask(id, R.stagePatch(task, next));
        await accept(canonical);
        return;
      }
      const latest = await global.SoduWorkAPI.getTask(id); if (request !== epoch || key !== storageKey()) return;
      /*
       * Use optimistic preflight to choose execution behavior; refresh stale snapshots from the
       * server. Idempotent review actions still rely on authoritative server checks.
       */
      const decision = R.resolveStageMove(task, latest, next, moveAction);
      if (decision.settled) { await refresh(); return; }
      if (decision.blocked) { notify('需求状态已变化，看板已刷新。'); await refresh(); return; }
      if (decision.action === 'assign') { await global.RequirementAssignment?.open(id); return; }
      if (decision.action === 'triage') await global.SoduWorkAPI.patchTask(id, decision.patch);
      else if (decision.action === 'submit-review') await global.SoduWorkAPI.submitTaskReview(id);
      else await global.SoduWorkAPI.reviewTask(id);
      if (request === epoch && key === storageKey()) await refresh();
    } catch (error) {
      if (request === epoch && key === storageKey()) {
        // A timed-out response does not mean the write failed. Read this exact
        // task once; never issue a second write while the outcome is unknown.
        if (action === 'triage' && !Number(error?.status) && error?.code !== 'STALE_TASK_SCOPE') {
          try {
            const confirmed = await global.SoduWorkAPI.getTask(id);
            if (!current()) return;
            if (R.stage(confirmed) === next) { await accept(confirmed); return; }
          } catch (_) { /* retain the original failure when confirmation fails */ }
          if (!current()) return;
        }
        /*
         * Preserve server detail for 409 responses so specific review blockers are not hidden by a
         * generic refresh message.
         */
        notify(String(error && error.message || '') ||
          (error && error.status === 409 ? '需求已被更新，请刷新后重试。' : '阶段没有更新，请重试'));
        await refresh();
      }
    } finally { if (request === epoch) { state.busy = false; state.movingId = ''; render(); } }
  }
  function hideMenu() {
    const menu = panel()?.querySelector('#rqCardActions'); if (menu?.matches(':popover-open')) menu.hidePopover();
    menuAnchor?.setAttribute('aria-expanded','false'); menuAnchor = null;
  }
  function showMenu(button) {
    const task = rows().find(row => String(row.id) === button.dataset.rqActions); if (!task) return;
    const menu = panel().querySelector('#rqCardActions'), same = menuAnchor === button && menu.matches(':popover-open'); hideMenu(); if (same) return;
    menuAnchor = button; menu.innerHTML = V.actions(task, context()); menu.showPopover(); button.setAttribute('aria-expanded','true');
    const rect = button.getBoundingClientRect(), width = menu.offsetWidth, height = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(rect.right - width, innerWidth - width - 8)) + 'px';
    menu.style.top = Math.max(8, rect.bottom + height + 8 > innerHeight ? rect.top - height - 5 : rect.bottom + 5) + 'px'; menu.querySelector('button')?.focus();
  }
  function mount() {
    const root = document.createElement('section'); root.id = 'historyBoard'; root.className = 'history-board requirements-board';
    root.innerHTML = '<header class="hb-head ws-page-head"><div class="hb-title"><span id="hbTitleText">需求池</span><span class="hb-count" id="hbCount"></span></div>' +
      '<div class="hb-head-actions"><button type="button" id="rqArchiveEntry" data-rq-archive="archived" aria-label="查看归档需求">归档</button><button type="button" id="hbApprovalInbox" title="查看需要你确认的需求" aria-label="待我确认" aria-expanded="false" aria-controls="taskApprovalInbox">待我确认<em data-task-approval-count></em></button>' +
      '<div class="rq-create-group"><button type="button" id="hbAdd" class="rq-primary" data-rq-create>＋ 新建需求</button>' +
      '<button type="button" id="hbAddMenuToggle" class="rq-create-toggle" aria-haspopup="menu" aria-expanded="false" aria-controls="rqCreateMenu" aria-label="选择需求创建方式" title="选择需求创建方式"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4"/></svg></button>' +
      '<div id="rqCreateMenu" class="rq-create-menu" role="menu" aria-label="需求创建方式" hidden>' +
      '<button type="button" role="menuitem" tabindex="-1" data-rq-create-chat="intake"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a8.5 8.5 0 0 1-8.5 8.5 9 9 0 0 1-3.5-.7L3 21l1.7-5a9 9 0 0 1-.7-3.5A8.5 8.5 0 1 1 20 11.5Z"/></svg><span>从对话创建</span><small>边聊边整理需求</small></button>' +
      '<button type="button" role="menuitem" tabindex="-1" data-rq-create-manual="intake"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 5.5 4 4M4 20l4.5-1 11-11a2.8 2.8 0 0 1-4-4l-11 11L4 20Z"/></svg><span>手动录入</span><small>直接填写标题和完成标准</small></button></div></div>' +
      '<button type="button" class="hb-close" aria-label="关闭需求池" data-rq-close>×</button></div></header>' +
      '<div class="rq-controls"><div class="rq-scopes" role="group" aria-label="需求视图">' + Object.entries(R.scopeOptions(state.archive)).map(([key,label]) => '<button type="button" data-rq-scope="' + key + '" aria-pressed="false">' + label + '<b>0</b></button>').join('') +
      '</div><select id="rqScope" aria-label="需求视图">' + V.options(Object.entries(R.scopeOptions(state.archive)), state.scope) + '</select>' +
      '<label class="rq-search">' + V.icon('search') + '<input id="hbSearch" placeholder="搜索需求" aria-label="搜索需求"></label>' +
      '<button type="button" class="rq-filter-toggle" id="rqFilterToggle" popovertarget="rqFilters" aria-label="筛选需求">' + V.icon('filter') + '<span>筛选</span><b id="rqFilterCount"></b></button>' +
      '<select id="rqArchive" aria-label="归档筛选" hidden><option value="active">当前需求</option><option value="archived">已归档</option></select>' +
      '<div class="rq-view-switch" role="group" aria-label="显示方式"><button type="button" data-rq-view="kanban" aria-label="看板视图" title="看板视图">' + V.icon('board') + '</button>' +
      '<button type="button" data-rq-view="list" aria-label="列表视图" title="列表视图">' + V.icon('list') + '</button></div>' +
      '<button class="rq-menu-toggle" type="button" popovertarget="rqMenu" aria-label="视图设置">' + V.icon('more') + '</button>' +
      '<div id="rqFilters" class="rq-menu rq-filters" popover></div><div id="rqMenu" class="rq-menu" popover>' +
      '<label class="rq-archive-compact">需求范围<select id="rqArchiveMore" aria-label="归档筛选"><option value="active">当前需求</option><option value="archived">已归档</option></select></label>' +
      '<label id="rqGroupLabel">看板分组<select id="rqGroup" aria-label="看板分组">' + V.options([['stage','按阶段'],['project','按项目'],['owner','按负责人']], state.group) + '</select></label>' +
      '<label>排序<select id="rqSort" aria-label="排序">' + V.options(Object.entries(R.sorts), state.sort) + '</select></label><button type="button" data-rq-view="gantt">甘特视图</button>' +
      '<button type="button" data-rq-refresh>刷新需求</button><button type="button" data-rq-clear>清除筛选</button></div></div>' +
      '<div id="rqChips" class="rq-filter-chips" aria-label="已选筛选条件" hidden></div>' +
      '<div id="rqConnection" class="rq-connection" role="status" aria-live="polite" hidden><span>连接暂时中断，正在显示上次同步的需求，恢复后自动更新。</span><button type="button" data-rq-refresh>重试</button></div><main class="hb-body"></main>' +
      '<div id="rqCardActions" class="rq-menu rq-card-actions" popover role="menu" aria-label="需求操作"></div>';
    document.body.appendChild(root); root.addEventListener('click', onClick);
    root.querySelector('#rqFilters').addEventListener('beforetoggle', event => { if (event.newState === 'open') event.target.innerHTML = V.filters(state, dataRows(), context()); });
    root.querySelector('#rqCardActions').addEventListener('toggle', event => { if (event.newState === 'closed') { menuAnchor?.setAttribute('aria-expanded','false'); menuAnchor = null; } });
    root.addEventListener('change', event => {
      const key = event.target.dataset.rqFilter || {rqScope:'scope',rqArchive:'archive',rqArchiveMore:'archive',rqSort:'sort',rqGroup:'group'}[event.target.id];
      if (key) { if (key === 'archive') switchArchive(event.target.value); else state[key] = event.target.value; state.limits = {}; persist(); render(); }
      if (event.target.hasAttribute('data-gvod')) { state.onlyOverdue = event.target.checked; render(); }
    });
    root.addEventListener('keydown', event => {
      if (event.target.closest('#rqCreateMenu,#hbAddMenuToggle')) {
        const menu = root.querySelector('#rqCreateMenu'), trigger = root.querySelector('#hbAddMenuToggle');
        const items = [...(menu?.querySelectorAll('[role="menuitem"]') || [])];
        if (event.key === 'Escape') { event.preventDefault(); closeCreateMenu(true); return; }
        if (event.key === 'Tab') { closeCreateMenu(false); return; }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          if (!items.length) return;
          const current = items.indexOf(document.activeElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
            (current < 0 ? (event.key === 'ArrowUp' ? items.length - 1 : 0) : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
          openCreateMenu(next);
          return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
          if (event.target === trigger) { event.preventDefault(); openCreateMenu(0); }
        }
        return;
      }
      if (event.target.closest('#rqCardActions') && ['ArrowDown','ArrowUp','Escape'].includes(event.key)) {
        event.preventDefault(); const buttons = [...root.querySelectorAll('#rqCardActions button:not(:disabled)')];
        if (event.key === 'Escape') { const anchor = menuAnchor; hideMenu(); anchor?.focus(); return; }
        const index = buttons.indexOf(document.activeElement); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); return;
      }
      const target = event.target.closest('[data-rq-open]:not(button)'); if (target && ['Enter',' '].includes(event.key)) { event.preventDefault(); target.click(); }
    });
    root.querySelector('#hbSearch').addEventListener('input', event => { state.q = event.target.value; state.limits = {}; render(); });
    root.querySelector('#hbApprovalInbox').addEventListener('click', event => global.TaskApprovalInbox?.open(event.currentTarget));
    root.addEventListener('dragstart', event => {
      const card = event.target.closest('[data-hbid]'); if (!card || card.draggable !== true) return;
      hideMenu(); state.drag = card.dataset.hbid; event.dataTransfer.setData('text/plain',state.drag); event.dataTransfer.effectAllowed = 'move'; card.classList.add('is-dragging');
    });
    ['dragenter','dragover'].forEach(type => root.addEventListener(type, event => {
      const lane = event.target.closest('[data-rq-lane]'), task = rows().find(row => String(row.id) === state.drag);
      if (!task || !lane || state.group !== 'stage' || !moveAction(task, lane.dataset.rqLane)) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'move'; lane.classList.add('is-drop-target');
    }));
    root.addEventListener('dragleave', event => { const lane = event.target.closest('[data-rq-lane]'); if (lane && !lane.contains(event.relatedTarget)) lane.classList.remove('is-drop-target'); });
    root.addEventListener('drop', event => {
      const lane = event.target.closest('[data-rq-lane]'); if (!lane || !state.drag || state.group !== 'stage') return;
      event.preventDefault(); const id = state.drag, task = rows().find(row => String(row.id) === id);
      state.drag = ''; clearDrag();
      if (task && R.column(task) !== lane.dataset.rqLane) void move(id,lane.dataset.rqLane);
    });
    root.addEventListener('dragend', () => { state.drag = ''; clearDrag(); if (state.pending) { state.pending = false; render(); } }); return root;
  }
  function clearDrag() { panel()?.querySelectorAll('.is-drop-target,.is-dragging').forEach(node => node.classList.remove('is-drop-target','is-dragging')); }
  function switchArchive(value) {
    state.archive = value === 'archived' ? 'archived' : 'active';
    // Archived work is never actionable. Do not carry an active-only scope or
    // stage into this entry and make the archive appear empty.
    state.scope = R.normalizeScope(state.scope, state.archive);
    state.q = ''; state.limits = {}; state.group = 'stage'; state.view = 'kanban';
    Object.keys(V.labels).forEach(key => { state[key] = ''; });
  }
  async function maintain(id, action) {
    if (state.busy) return false;
    const scope = storageKey(), currentEpoch = epoch;
    state.busy = true;
    try {
      const item = await global.SoduWorkAPI.getTask(id);
      if (scope !== storageKey() || currentEpoch !== epoch) return false;
      const permission = R.maintenance(item, action);
      if (!permission.visible || permission.disabled) throw new Error(permission.reason);
      if (action === 'delete') {
        if (!await global.RequirementConfirm?.open({title: '删除需求？', name: R.content(item).title,
          description: '需求、相关材料和执行记录将永久删除，无法恢复。', confirmLabel: '删除需求',
          valid: () => scope === storageKey() && currentEpoch === epoch,
          returnFocus: () => document.querySelector('.rq-detail-more summary') ||
            [...(panel()?.querySelectorAll('[data-rq-actions]') || [])].find(node => node.dataset.rqActions === String(id))})) return false;
        // A workflow may have started while the user was deciding.
        const latest = await global.SoduWorkAPI.getTask(id);
        if (scope !== storageKey() || currentEpoch !== epoch) return false;
        const latestPermission = R.maintenance(latest, action);
        if (!latestPermission.visible || latestPermission.disabled) throw new Error(latestPermission.reason);
        const store = typeof Store === 'undefined' ? null : Store;
        const removed = store?.removeTask(id, 0, latest);
        if (!removed) throw new Error('需求已变化，请刷新后重试。');
        render(true);
        await store._flushTaskOps();
        if (scope !== storageKey() || currentEpoch !== epoch) return false;
        const error = store.taskPersistError(id);
        if (error) throw new Error(error);
        if (store._readTaskOps().some(op => op.id === id && op.kind === 'delete')) {
          notify('删除已排队，连接恢复后会继续同步。'); return true;
        }
        notify('需求已删除');
      } else {
        const restore = action === 'restore';
        await global.SoduWorkAPI.patchTask(id, {archivedAt: restore ? null : Date.now(),
          ...(restore && item.status === 'cancel' ? {status: 'todo'} : {}), requirementVersion: item.requirementVersion});
        if (scope !== storageKey() || currentEpoch !== epoch) return false;
        notify(restore ? '需求已恢复' : '需求已归档，可在“归档”中查看');
      }
      await refresh();
      return true;
    } catch (error) {
      if (scope === storageKey() && currentEpoch === epoch) { notify(String(error.message || '操作失败，请重试')); render(true); }
      return false;
    } finally { if (currentEpoch === epoch) state.busy = false; }
  }
  function onClick(event) {
    const button = event.target.closest('button,[data-rq-open]'); if (!button) return;
    if (button.id === 'hbAddMenuToggle') {
      const expanded = button.getAttribute('aria-expanded') === 'true';
      if (expanded) closeCreateMenu(true); else openCreateMenu(0);
      return;
    }
    if (button.hasAttribute('data-rq-create-chat')) { void createFromChat(button.dataset.rqCreateChat); return; }
    if (button.hasAttribute('data-rq-create-manual')) { closeCreateMenu(false); create(button.dataset.rqCreateManual); return; }
    if (button.hasAttribute('data-rq-actions')) { showMenu(button); return; }
    if (button.hasAttribute('data-rq-open')) { hideMenu(); global.RequirementsDetail?.open(button.dataset.rqOpen); return; }
    if (button.hasAttribute('data-rq-assign')) { hideMenu(); void global.RequirementAssignment?.open(button.dataset.rqAssign); return; }
    if (button.hasAttribute('data-rq-move')) { hideMenu(); void move(button.dataset.rqMove,button.dataset.rqTarget); return; }
    if (button.hasAttribute('data-rq-chat')) { hideMenu(); const task = rows().find(row => String(row.id) === button.dataset.rqChat); if (task && R.canOpenConversation(task, global.SoduWorkAPI?.clientId)) void global.openTaskConversation?.(task.id,R.content(task).title); return; }
    if (button.hasAttribute('data-rq-maintain')) { hideMenu(); void maintain(button.dataset.rqMaintain,button.dataset.rqMaintenance); return; }
    if (button.hasAttribute('data-rq-delete')) { hideMenu(); void maintain(button.dataset.rqDelete,'delete'); return; }
    if (button.hasAttribute('data-rq-create')) { create(button.dataset.rqCreate); return; }
    if (button.hasAttribute('data-rq-close')) { close(); return; }
    if (button.hasAttribute('data-rq-scope')) { state.scope = button.dataset.rqScope; state.limits = {}; }
    if (button.hasAttribute('data-rq-archive')) switchArchive(button.dataset.rqArchive);
    if (button.hasAttribute('data-rq-more')) { const key = button.dataset.rqMore,step = key === 'list' ? 80 : 40; state.limits[key] = (state.limits[key] || step) + step; }
    if (button.hasAttribute('data-rq-view')) state.view = button.dataset.rqView;
    if (button.hasAttribute('data-rq-remove-filter')) { state[button.dataset.rqRemoveFilter] = ''; state.limits = {}; }
    if (button.hasAttribute('data-rq-clear')) { state.q = ''; Object.keys(V.labels).forEach(key => { state[key] = ''; }); state.limits = {}; state.onlyOverdue = false; }
    if (button.hasAttribute('data-gvnav')) { const date = new Date(state.year,state.month + Number(button.dataset.gvnav),1); state.year = date.getFullYear(); state.month = date.getMonth(); }
    const menu = button.closest('[popover]'); if (menu?.matches(':popover-open')) menu.hidePopover();
    if (button.hasAttribute('data-rq-refresh')) { void refresh(); return; } persist(); render();
  }
  function open(options) {
    syncIdentity();
    const root = panel() || mount(), showing = root.classList.contains('show');
    if (options?.phase === 'reviewing') {
      // A direct review entry must not inherit a previous archive/search/filter
      // that would hide the work the shortcut promised to show.
      Object.keys(V.labels).forEach(key => { state[key] = ''; });
      Object.assign(state, { phase: 'reviewing', scope: 'all', archive: 'active', q: '',
        view: 'kanban', group: 'stage', limits: {}, onlyOverdue: false, year: null, month: null });
      persist();
    } else if (!showing) {
      // Every navigation back to the pool starts with current work needing me.
      // In-place refresh/repeated open and explicit review entry retain their view.
      Object.assign(state, { scope: 'actionable', archive: 'active', limits: {} });
      persist();
    }
    root.inert = false; root.classList.add('show'); render(true);
    if (!showing) {
      // Reconcile missed task updates when returning from another view or device.
      void refresh(); global.expandForOverlay?.();
    } else {
      void loadProjects(); global.TaskApprovalInbox?.refresh().catch(() => {});
    }
  }
  function close() {
    const root = panel(); if (!root) return; hideMenu(); closeCreateMenu(false);
    root.querySelectorAll('[popover]').forEach(menu => { if (menu.matches(':popover-open')) menu.hidePopover(); });
    const finish = () => {
      root.inert = true;
      if (root.classList.contains('show')) { root.classList.remove('show'); global.shrinkFromOverlay?.(); }
    };
    const detailClose = global.RequirementsDetail?.close?.();
    if (detailClose === false) return;
    if (detailClose && typeof detailClose.then === 'function') {
      void detailClose.then(closed => { if (closed !== false) finish(); });
      return;
    }
    finish();
  }
  global.addEventListener('soduwork-approvals-changed',() => render());
  global.addEventListener('soduwork-task-source',() => render());
  global.addEventListener('soduwork-data-scope-changed',() => { identity = null; syncIdentity(); render(true); if (panel()?.classList.contains('show')) void loadProjects(); });
  global.RequirementsBoard = {open,close,refresh,render,move,maintain,context};
  global.openHistoryBoard = open; global.openTaskCenter = open; global.closeHistoryBoard = close; global._renderHistoryBoard = render;
})(window);
