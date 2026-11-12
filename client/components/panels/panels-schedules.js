/*
 * Personal schedules are scoped by the backend to this client. Every occurrence creates a
 * new ordinary conversation whose prompt, model output, and result stay together in chat.
 */

const SCH_EVERY = [['daily', '每天'], ['hourly', '每小时'], ['weekly', '每周'], ['once', '仅一次']];
const SCH_WD = [[1, '周一'], [2, '周二'], [3, '周三'], [4, '周四'], [5, '周五'], [6, '周六'], [7, '周日']];
const SCH_CAPS = [
  ['browser', '浏览网页', '优先读取页面结构，适合查询、巡检和网页填报'],
  ['computer', '操作电脑', '网页无法结构化操作时，模拟鼠标键盘完成'],
  ['office', '办公文档', '读取或生成 Word、Excel、PowerPoint'],
];
let _schRows = null;
let _schScope = 0;
let _schAgents = [];
let _schAgentReason = '';
let _schAgentLoading = null;
let _schModelOptions = [];
let _schDefaultModel = '';
let _schNativeModelOptions = Object.create(null);
let _schRepos = [];
let _schTemplates = [];
/*
 * Plugin catalog caching and enterprise/personal method rendering live in
 * panels-schedules-methods.js and share script globals.
 */
let _schEditing = null;      /* Edited schedule, 'new', or null. */
let _schLoading = null;      /* Allow only one initial load to avoid duplicate requests during rapid navigation. */
let _schLoadRequest = 0;
let _schLoadError = '';
let _schRunOpen = '';
let _schRunRows = Object.create(null);
let _schRunLoading = Object.create(null);
let _schRunErrors = Object.create(null);
let _schRunReturnFocus = null;

const _sp2 = (n) => String(n).padStart(2, '0');
function _schBrowserTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'; }
  catch (_) { return 'Asia/Shanghai'; }
}

/* Persist IANA timezones unchanged while presenting understandable local time. */
/* Translate timezone, next-run, and preflight fragments before assembling localized sentences. */
const _schTx = value => (window.SoduWorkI18n && window.SoduWorkI18n.translateText)
  ? window.SoduWorkI18n.translateText(value) : value;
function _schTimeZoneLabel(value) {
  const zone = String(value || _schBrowserTimeZone()).trim();
  const labels = {
    'Asia/Shanghai': '北京时间',
    'Asia/Chongqing': '北京时间',
    'Asia/Hong_Kong': '香港时间',
    'Asia/Taipei': '台北时间',
    'Asia/Tokyo': '东京时间',
    'Asia/Singapore': '新加坡时间',
    'Europe/London': '伦敦时间',
    'America/New_York': '纽约时间',
    'America/Los_Angeles': '洛杉矶时间',
  };
  return _schTx(labels[zone] || (zone === _schBrowserTimeZone() ? '设备当地时间' : '当地时间'));
}
/*
 * Convert UTC timestamps to local time rather than slicing the server string.
 */
function _schLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return _sp2(d.getMonth() + 1) + '-' + _sp2(d.getDate()) + ' ' + _sp2(d.getHours()) + ':' + _sp2(d.getMinutes());
}
function _schRhythm(s) {
  if (s.every === 'once') return _schTx(window.ScheduleTiming?.summary(s) || '指定日期时间 · 待设置');
  if (s.every === 'hourly') return '每小时 ' + _sp2(s.atMinute) + ' 分';
  if (s.every === 'weekly') {
    const w = (SCH_WD.find(([k]) => k === Number(s.weekday)) || [, ''])[1];
    return '每' + w + ' ' + _sp2(s.atHour) + ':' + _sp2(s.atMinute);
  }
  return '每天 ' + _sp2(s.atHour) + ':' + _sp2(s.atMinute);
}

const SCH_RUN_STATE = {
  starting: ['待执行', 'starting'], running: ['执行中', 'running'],
  waiting: ['执行中', 'running'], succeeded: ['完成', 'succeeded'],
  failed: ['失败', 'failed'], cancelled: ['失败', 'failed'],
};
const SCH_RUN_TRIGGER = { timer: '按时触发', manual: '手动运行', retry: '自动重试' };

function _schRunDuration(seconds) {
  if (seconds === null || seconds === undefined) return '';
  const value = Math.max(0, Number(seconds) || 0);
  if (value < 60) return value + ' 秒';
  if (value < 3600) return Math.floor(value / 60) + ' 分 ' + (value % 60) + ' 秒';
  return Math.floor(value / 3600) + ' 小时 ' + Math.floor((value % 3600) / 60) + ' 分';
}

function _schProjectId(repoId) {
  const repo = _schRepos.find(item => item.id === repoId);
  return (repo && repo.projectId) || '';
}

function _schLoadingHtml() {
  return '<div class="sch-loading" role="status" aria-live="polite" aria-label="正在加载定时任务">' +
    '<div class="sch-load-row"><i></i><span><b></b><em></em></span></div>' +
    '<div class="sch-load-row"><i></i><span><b></b><em></em></span></div>' +
    '<small>正在同步你的自动化安排…</small></div>';
}

function _schErrorText(error) {
  if (typeof _humanErr === 'function') return _humanErr(error, '暂时没拿到定时任务');
  return String((error && (error.detail || error.message)) || '请检查连接后重试');
}

function openSchedulePanel(options) {
  let p = document.getElementById('schPanel');
  if (!p) {
    p = document.createElement('div');
    p.id = 'schPanel'; p.className = 'sch-panel';
    p.innerHTML =
      '<div class="sch-head ws-page-head">' +
      '<span class="sch-h-ico"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/>' +
      '<path d="M12 7v5l3.2 2"/></svg></span>' +
      '<div class="sch-h-txt"><span class="sch-h-kicker" data-i18n="eyebrow.automation">AUTOMATION</span><b class="sch-h-title" data-i18n="nav.schedules">自动化</b>' +
      '<i class="sch-h-sub">让重复工作按时执行，过程与结果留在对话中</i></div>' +
      '<div class="sch-h-acts">' + _schCreateMenuHtml() +
      '<button class="np-close" id="schClose">✕</button></div></div>' +
      '<div class="sch-body" id="schBody"></div>' +
      '<div class="sch-run-layer" id="schRunLayer" aria-hidden="true">' +
      '<button type="button" class="sch-run-backdrop" data-run-close tabindex="-1" aria-label="关闭执行记录"></button>' +
      '<aside class="sch-run-drawer" role="dialog" aria-modal="true" aria-labelledby="schRunTitle" tabindex="-1">' +
      '<div id="schRunContent"></div></aside></div>' +
      '<div class="sch-editor-layer" id="schEditorLayer" aria-hidden="true">' +
      '<button type="button" class="sch-editor-backdrop" data-editor-close tabindex="-1" aria-label="关闭自动化配置"></button>' +
      '<aside class="sch-editor-drawer" role="dialog" aria-modal="true" aria-labelledby="schEditorTitle" tabindex="-1">' +
      '<div id="schEditorContent"></div></aside></div>';
    document.body.appendChild(p);
    document.getElementById('schClose').addEventListener('click', closeSchedulePanel);
    _schBindCreateMenu();
    p.querySelector('.sch-run-backdrop').addEventListener('click', () => _schCloseRuns(true));
    p.querySelector('.sch-editor-backdrop').addEventListener('click', () => _schCloseEditor(true));
    p.addEventListener('keydown', event => {
      if (!_schRunOpen) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); _schCloseRuns(true); return;
      }
      if (event.key !== 'Tab') return;
      const drawer = p.querySelector('.sch-run-drawer');
      const focusable = Array.from(drawer.querySelectorAll('button:not([disabled])'));
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === drawer)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    });
    p.addEventListener('keydown', event => {
      if (!_schEditing) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); _schCloseEditor(true); return;
      }
      if (event.key !== 'Tab') return;
      const drawer = p.querySelector('.sch-editor-drawer');
      const focusable = Array.from(drawer.querySelectorAll(
        'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])'));
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === drawer)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    });
    if (typeof makeDraggable === 'function') makeDraggable(p, p.querySelector('.sch-head'));
  }
  p.classList.add('show');
  if (typeof expandForOverlay === 'function') expandForOverlay();
  const wanted = String(options?.scheduleId || '');
  // Bind navigation targets to the current request generation; after leaving or switching schedules,
  // stale responses must not consume newer targets or open an editor from old cached data.
  p.dataset.scheduleFocus = wanted;
  const load = _loadSch(), request = _schLoadRequest;
  return load.then(() => {
    if (request !== _schLoadRequest || !wanted || !p.classList.contains('show') || p.dataset.scheduleFocus !== wanted) return;
    p.dataset.scheduleFocus = '';
    const row = (_schRows || []).find(item => String(item.id) === wanted);
    if (row) _schOpenEditor(row);
    else if (typeof petSay === 'function') petSay(_schLoadError || '关联的自动化已移除或当前账号无权访问');
  });
}
function closeSchedulePanel() {
  _schCloseCreateMenu(false);
  _schCloseRuns(false);
  _schCloseEditor(false);
  const p = document.getElementById('schPanel');
  _schLoadRequest++; _schLoading = null;
  if (p) p.dataset.scheduleFocus = '';
  if (p && p.classList.contains('show')) {
    p.classList.remove('show');
    if (typeof shrinkFromOverlay === 'function') shrinkFromOverlay();
  }
}

async function _loadSch() {
  if (_schLoading) return _schLoading;
  const scope = _schScope, request = ++_schLoadRequest;
  const body = document.getElementById('schBody');
  const firstLoad = _schRows === null;
  if (body && firstLoad) body.innerHTML = _schLoadingHtml();
  const newBtn = document.getElementById('schNew');
  if (newBtn && firstLoad) newBtn.disabled = true;
  const previousRows = _schRows;

  /*
   * Fetch the three independent catalogs concurrently to avoid sequential network delays on
   * first open.
   */
  _schLoading = (async () => {
    const scheduleReq = SoduWorkAPI.listSchedules()
      .then(rows => ({ rows: Array.isArray(rows) ? rows : [] }))
      .catch(error => ({ error }));
    const agentReq = _schLoadExecutionAgents({});
    const repoReq = (!_schRepos.length && SoduWorkAPI.listRepos)
      ? SoduWorkAPI.listRepos().then(rows => Array.isArray(rows) ? rows : []).catch(() => [])
      : Promise.resolve(_schRepos);
    const pluginReq = _schLoadPlugins('');
    const personalReq = _schmLoad();      /* Local personal plugins for the work-method picker. */
    const templateReq = SoduWorkAPI.listScheduleTemplates
      ? SoduWorkAPI.listScheduleTemplates().catch(() => []) : Promise.resolve([]);
    const [schedule, agents, repos, templates] = await Promise.all(
      [scheduleReq, agentReq, repoReq, templateReq, pluginReq, personalReq]);
    if (scope !== _schScope || request !== _schLoadRequest) return;
    _schAgents = agents;
    _schRepos = repos;
    _schTemplates = Array.isArray(templates) ? templates : [];
    if (schedule.error) {
      _schLoadError = _schErrorText(schedule.error);
      _schRows = Array.isArray(previousRows) ? previousRows : [];
    } else {
      _schLoadError = '';
      _schRows = schedule.rows;
    }
    /* Refresh the list while preserving the edited drawer and its draft. */
    _renderSchPanel();
    if (_schEditing) _schRefreshAgentField((_schEditing !== 'new' && _schEditing.assigneeId) || '');
  })().finally(() => {
    if (scope !== _schScope || request !== _schLoadRequest) return;
    _schLoading = null;
    const button = document.getElementById('schNew');
    if (button) button.disabled = false;
  });
  return _schLoading;
}

function _schActionIcon(action) {
  const paths = {
    run: '<path d="m9 5 10 7-10 7Z"/>',
    runs: '<path d="M3.5 10a8.5 8.5 0 1 1 1.7 7M3 4v6h6M12 7v5l3 2"/>',
    edit: '<path d="m15.5 4.5 4 4M4 20l4.5-1L20 7.5a2.8 2.8 0 0 0-4-4L4.5 15Z"/>',
    del: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/>',
    busy: '<circle cx="12" cy="12" r="8" opacity=".2"/><path d="M12 4a8 8 0 0 1 8 8"/>',
  };
  return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + paths[action] + '</svg>';
}

function _schActionButton(action, label) {
  return '<button type="button" class="sch-icon-action" data-act="' + action + '" title="' + esc(label) +
    '" aria-label="' + esc(label) + '"' + (action === 'runs' || action === 'edit'
      ? ' aria-haspopup="dialog" aria-expanded="false"' : '') + '>' + _schActionIcon(action) + '</button>';
}

async function _schConfirmDisable(s) {
  const title = String(s.title || '此自动化');
  if (window.SoduWorkConfirmDialog && typeof window.SoduWorkConfirmDialog.open === 'function') {
    return window.SoduWorkConfirmDialog.open({
      title: '停用自动化？',
      message: '停用「' + title + '」后，它不会再按计划自动执行。',
      detail: '已有执行记录和会话会保留。',
      cancel: '继续运行', confirm: '停用自动化', danger: true,
    });
  }
  return typeof window.confirm === 'function' && window.confirm(
    '确定停用「' + title + '」吗？停用后不会再按计划自动执行。');
}

function _schSetRunBusy(button, busy) {
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
  button.setAttribute('aria-label', busy ? '正在提交执行' : '立刻跑一次');
  button.title = busy ? '正在提交执行…' : '立刻跑一次';
  button.innerHTML = _schActionIcon(busy ? 'busy' : 'run');
}

function _schRunButton(sid, fallback) {
  const buttons = document.querySelectorAll('.sch-item [data-act="run"]');
  for (const button of buttons) {
    if (button.closest('.sch-item')?.getAttribute('data-sid') === sid) return button;
  }
  return fallback;
}

function _renderSchPanel() {
  const body = document.getElementById('schBody');
  if (!body) return;
  const rows = _schRows || [];
  if (_schLoadError && !rows.length) {
    body.innerHTML = '<div class="sch-load-fail"><span class="sk-empty-ico">' +
      '<svg viewBox="0 0 24 24"><path d="M12 4v9M12 17.5v.5"/><circle cx="12" cy="12" r="9"/></svg></span>' +
      '<b>暂时没拿到定时任务</b><span>' + esc(_schLoadError) + '</span>' +
      '<button class="btn-mini" id="schRetry">重新加载</button></div>';
    const retry = document.getElementById('schRetry');
    if (retry) retry.addEventListener('click', () => { _schRows = null; _schLoadError = ''; _loadSch(); });
    return;
  }
  if (!rows.length) {
    /* Empty state includes an explanation, next action, and usable examples. */
    body.innerHTML =
      '<div class="sk-empty"><span class="sk-empty-ico">' +
      '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/></svg></span>' +
      '<b>还没有定时任务</b>' +
      '<span>按设定时间创建普通会话，发送提示词并在对话中查看过程与结果。<br>点击右上角「创建」，选择对话创建或手动配置。</span>' +
      '<span class="sk-empty-eg">常见的两种：<em>每天 18:00 · 汇总今天干了什么</em>' +
      '<em>每周一 09:00 · 把上周的 bug 归归类</em></span></div>';
    const recipesHtml = _schRecipeHtml(false);
    if (recipesHtml) body.insertAdjacentHTML('beforeend', recipesHtml);
    if (recipesHtml) _schBindRecipes(body);
    return;
  }
  body.innerHTML = '<div class="sch-list">' + rows.map(_schCardHtml).join('') + '</div>';
  if (_schTemplates.length) {
    body.insertAdjacentHTML('afterbegin', _schRecipeHtml(true));
    _schBindRecipes(body);
  }
  _schRenderLoadWarning(body);
  body.querySelectorAll('.sch-item').forEach(el => {
    const sid = el.getAttribute('data-sid');
    el.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => _schAct(b.getAttribute('data-act'), sid, b)));
  });
  if (!_schEditing) _schRenderEditorDrawer(false);
  _schRenderRunDrawer(false);
}

async function _schAct(act, sid, btn) {
  const scope = _schScope;
  const s = (_schRows || []).find(x => x.id === sid);
  if (!s) return;
  if (act === 'runs') { await _schToggleRuns(sid, false, btn); return; }
  if (act === 'edit') {
    await _schPrepareEditor(s, btn);
    return;
  }
  if (act === 'del') {
    /*
     * Confirm deletion within the affected card so its identity and consequences remain
     * visible.
     */
    _schConfirmDel(sid, s);
    return;
  }
  if (act === 'toggle') {
    if (btn.disabled || s.every === 'once' && s.onceFired) return;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    if (s.enabled) {
      const accepted = await _schConfirmDisable(s);
      if (!accepted) {
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
        return;
      }
    }
    const next = !s.enabled;
    try {
      await SoduWorkAPI.updateSchedule(sid, {enabled: next});
      if (scope !== _schScope) return;
      if (typeof petSay === 'function') petSay(next ? '自动化已启用' : '自动化已停用');
      await _loadSch();
    } catch (error) {
      if (scope === _schScope && typeof petSay === 'function') {
        petSay((next ? '启用' : '停用') + '失败：' + _schErrorText(error));
      }
    } finally {
      if (btn.isConnected) {
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
      }
    }
    return;
  }
  if (act === 'run') {
    if (btn.disabled) return;
    _schSetRunBusy(btn, true);
    let runButton = btn;
    try {
      const instanceId = 'ui-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      const launched = await SoduWorkAPI.runSchedule(sid, { instanceId });
      if (scope !== _schScope) return;
      const automationTitle = String(s.title || '未命名自动化').trim();
      if (typeof petSay === 'function') petSay(launched.waitingForDevice
        ? '已开启自动化任务「' + automationTitle + '」，设备上线后将开始执行'
        : '已开启自动化任务「' + automationTitle + '」');
      runButton = _schRunButton(sid, btn);
      // Immediate execution is a navigation into the ordinary automation chat.
      // The run drawer is opened only by the explicit history action; showing it
      // here made a successful launch look like a task-record workflow.
      if (typeof _schLaunchRunConversation === 'function') {
        Promise.resolve(_schLaunchRunConversation(sid, { ...launched, scheduleTitle: s.title }, scope))
          .then(opened => {
            if (scope !== _schScope) return;
            _schSetRunBusy(runButton, false);
            if (!opened && typeof petSay === 'function') petSay('自动化任务已开启，会话正在准备中，请稍后在执行记录中打开');
          })
          .catch(() => { if (scope === _schScope) _schSetRunBusy(runButton, false); });
      }
      // Refresh card state in the background without taking the user away from
      // the chat navigation path.
      void _loadSch();
    } catch (e) {
      if (scope !== _schScope) return;
      _schSetRunBusy(runButton, false);
      if (typeof petSay === 'function') {
        const detail = String(typeof _humanErr === 'function' ? _humanErr(e, '派活失败') : e.message || '派活失败');
        petSay(detail.startsWith('没派出去：') ? detail : '没派出去：' + detail);
      }
      return;
    }
  }
}

/* Insert an inline consequence explanation with explicit confirm/cancel actions. */
function _schConfirmDel(sid, s) {
  const scope = _schScope;
  const card = document.querySelector('.sch-item[data-sid="' + sid + '"]');
  if (!card || card.querySelector('.sch-confirm')) return;
  const bar = document.createElement('div');
  bar.className = 'sch-confirm';
  bar.innerHTML = '<span>删掉「' + esc(s.title) + '」？<i>以前的会话记录不受影响，只是以后不再自动执行。</i></span>' +
    '<span class="sch-c-ops"><button class="btn-mini" data-c="no">再想想</button>' +
    '<button class="btn-mini danger-solid" data-c="yes">删除</button></span>';
  card.appendChild(bar);
  card.classList.add('confirming');
  bar.querySelector('[data-c="no"]').addEventListener('click', () => {
    bar.remove(); card.classList.remove('confirming');
  });
  bar.querySelector('[data-c="yes"]').addEventListener('click', async () => {
    if (scope !== _schScope) return;
    bar.innerHTML = '<span>正在删除…</span>';
    try { await SoduWorkAPI.deleteSchedule(sid); } catch (e) {
      if (scope !== _schScope) return;
      bar.remove(); card.classList.remove('confirming');
      if (typeof petSay === 'function') petSay('没删掉：' + _schErrorText(e));
      return;
    }
    if (scope !== _schScope) return;
    if (typeof petSay === 'function') petSay('删掉了定时任务「' + s.title + '」');
    _schRows = null; _loadSch();
  });
}

function _schBlueprintHtml(s) {
  const work = (s.title || '').trim() || '\u5b8c\u6210\u8bbe\u5b9a\u7684\u5de5\u4f5c';
  return '<section class="sch-blueprint">' +
    '<header><span><b>\u5b83\u4f1a\u8fd9\u6837\u8fd0\u884c</b><i>\u4fdd\u5b58\u540e\u53ef\u5148\u8dd1\u4e00\u6b21\uff0c\u786e\u8ba4\u7ed3\u679c\u518d\u653e\u5fc3\u542f\u7528</i></span>' +
    '<em>\u53ef\u8ffd\u8e2a \u00b7 \u53ef\u91cd\u8bd5 \u00b7 \u7559\u8bc1\u636e</em></header><ol>' +
    '<li><i>1</i><span><small>\u89e6\u53d1</small><b id="schBpWhen">\u6309\u8bbe\u5b9a\u65f6\u95f4</b></span></li>' +
    '<li><i>2</i><span><small>\u6267\u884c</small><b id="schBpWork">' + esc(work) + '</b></span></li>' +
    '<li><i>3</i><span><small>\u4ea4\u4ed8</small><b>\u6253\u5f00\u666e\u901a\u4f1a\u8bdd\u3001\u53d1\u9001\u63d0\u793a\u8bcd\u5e76\u4fdd\u7559\u5b8c\u6574\u8bb0\u5f55</b></span></li>' +
    '</ol></section>';
}

function _schFormHtml(s) {
  s = s || { title: '', note: '', every: 'daily', atHour: 18, atMinute: 0, weekday: 1,
             assigneeId: _schDefaultAgentId(), modelName: '', repoId: '', flow: false,
             pluginBindingId: '', personalPluginKey: '', pluginInputs: {},
             requiredCapabilities: [], retryLimit: 2, retryDelayMinutes: 5,
             timeZone: _schBrowserTimeZone(), enabled: true };
  const mode = 'direct';
  const opt = (list, cur) => list.map(([k, l]) =>
    '<option value="' + k + '"' + (String(k) === String(cur) ? ' selected' : '') + '>' + l + '</option>').join('');
  /* Group fields by work, schedule, and executor. */
  const sec = (t, d) => '<div class="sch-sec"><b>' + t + '</b>' + (d ? '<i>' + d + '</i>' : '') + '</div>';
  const activeCaps = new Set(s.requiredCapabilities || []);
  const capChips = SCH_CAPS.map(([key, label, hint]) =>
    '<label class="sch-cap' + (activeCaps.has(key) ? ' on' : '') + '" title="' + esc(hint) + '">' +
    '<input type="checkbox" value="' + key + '"' + (activeCaps.has(key) ? ' checked' : '') + '>' +
    '<span class="sch-cap-dot"></span><b>' + label + '</b><i>' + hint + '</i></label>').join('');
  const retryOn = Number(s.retryLimit == null ? 2 : s.retryLimit) > 0;

  return '<div class="sch-form">' + _schBlueprintHtml(s) +
    sec('要它干什么') +
    '<label class="sch-f-lbl">标题</label>' +
    '<input class="sch-in" id="schTitle" maxlength="60" placeholder="如：汇总今天干了什么，写一份小结" value="' + esc(s.title) + '">' +
    '<label class="sch-f-lbl">交代给 AI 的话<em>每次都会原样发过去，写清楚点</em></label>' +
    '<textarea class="sch-in" id="schNote" rows="4" placeholder="要做什么、产出成什么样、放哪儿。">' + esc(s.note) + '</textarea>' +

    sec('什么时候跑', '按' + esc(_schTimeZoneLabel(s.timeZone)) + '执行 · 触发精度约两分钟') +
    '<div class="sch-when-row">' +
    '<select class="sch-in sch-w-every" id="schEvery">' + opt(SCH_EVERY, s.every) + '</select>' +
    '<select class="sch-in sch-w-wd" id="schWd">' + opt(SCH_WD, s.weekday) + '</select>' +
    '<span class="sch-clock" id="schHWrap">' +
    '<select class="sch-in" id="schH" aria-label="小时" aria-describedby="schClockHint">' +
    window.ScheduleTiming.clockOptions(24, s.atHour) + '</select><em id="schClockSep" aria-hidden="true">:</em>' +
    '<select class="sch-in" id="schM" aria-label="分钟" aria-describedby="schClockHint">' +
    window.ScheduleTiming.clockOptions(60, s.atMinute) + '</select>' +
    '<small id="schClockHint">滚动选择时间</small></span>' +
    _schOnceFieldsHtml(s) + '<span class="sch-when-pv" id="schPv" role="status" aria-live="polite"></span></div>' +
    _schDateRangeHtml(s) +

    sec('在哪儿运行', '不依赖工程的办公自动化可以留空') +
    '<label class="sch-f-lbl">工程</label><select class="sch-in" id="schRepo">' +
    '<option value="">不指定工程（文档、汇总、巡检等）</option>' +
    (s.repoId && !_schRepos.some(r => r.id === s.repoId) ? '<option value="' + esc(s.repoId) +
      '" selected disabled>原工程已不可用或无权访问，请重新选择</option>' : '') +
    _schRepos.map(r => '<option value="' + esc(r.id) + '"' + (r.id === s.repoId ? ' selected' : '') + '>' + esc(r.name) + '</option>').join('') +
    '</select>' +

    sec('怎么执行', '自动创建普通会话，发送提示词并使用所选底座和模型') +
    '<div class="sch-mode-tabs" role="tablist" hidden style="display:none">' +
    '<button class="sch-mode-btn' + (mode === 'direct' ? ' on' : '') + '" data-mode="direct" role="tab">直接执行' +
    '<i>适合单步、结果明确的工作</i></button>' +
    '<button class="sch-mode-btn' + (mode === 'plugin' ? ' on' : '') + '" data-mode="plugin" role="tab">插件自动化' +
    '<i>多节点、可审批、可追踪</i></button></div>' +
    '<div class="sch-exec-block" id="schDirectBlock">' +
    _schAgentFieldHtml(s.assigneeId) +
    /* New personal-plugin schedules pin versions; preserve legacy follow-latest semantics. */
    '<div id="schMethodWrap">' +
    _schmConfigHtml(s.personalPluginKey || '', s.pluginBindingId ? {} : (s.pluginInputs || {}), {
      versionPolicy: s.personalPluginVersionPolicy || (s.id ? 'latest' : 'pinned'),
      version: s.personalPluginVersion || '',
      checksum: s.personalPluginChecksum || '',
    }) +
    '</div>' +
    /*
     * Hide manual Browser/Computer/Office capability checkboxes and leave them unselected by
     * default. applyMethodCaps still applies declared personal-plugin capabilities to the
     * execution contract.
     */
    '<label class="sch-f-lbl" hidden style="display:none">这项工作需要什么能力<em>只派给真实具备且已授权的执行机</em></label>' +
    '<div class="sch-cap-grid" id="schCaps" hidden style="display:none">' + capChips + '</div>' +
    '<div class="sch-ready checking" id="schReady"><span></span><b>正在检查执行条件…</b><small></small></div>' +
    '<div class="sch-retry-row">' +
    '<label class="sch-chk compact"><input type="checkbox" id="schRetry"' + (retryOn ? ' checked' : '') + '>失败自动重试</label>' +
    '<span id="schRetryOptions"><select class="sch-in" id="schRetryLimit"><option value="1"' +
    (Number(s.retryLimit || 0) === 1 ? ' selected' : '') + '>1 次</option><option value="2"' +
    (Number(s.retryLimit || 2) === 2 ? ' selected' : '') + '>2 次</option><option value="3"' +
    (Number(s.retryLimit || 0) === 3 ? ' selected' : '') + '>3 次</option></select>' +
    '<select class="sch-in" id="schRetryDelay"><option value="2"' +
    (Number(s.retryDelayMinutes || 0) === 2 ? ' selected' : '') + '>间隔 2 分钟</option><option value="5"' +
    (Number(s.retryDelayMinutes || 5) === 5 ? ' selected' : '') + '>间隔 5 分钟</option><option value="10"' +
    (Number(s.retryDelayMinutes || 0) === 10 ? ' selected' : '') + '>间隔 10 分钟</option></select></span></div>' +
    '<label class="sch-chk" id="schFlowWrap" hidden style="display:none"><input type="checkbox" id="schFlow">按基础研发流程走</label></div>' +
    '<div class="sch-exec-block" id="schPluginBlock" hidden style="display:none"><div id="schPluginConfig">' +
    _schPluginConfigHtml(s.repoId, s.pluginBindingId, s.pluginInputs || {}) + '</div></div>' +
    '<div class="sch-chk-row">' +
    '<label class="sch-chk"><input type="checkbox" id="schEnabled"' + (s.enabled ? ' checked' : '') + '>' +
    '启用<em>关掉就只是存着，不会自动跑</em></label></div>' +

    '<div class="sch-f-acts"><button class="btn-mini" id="schCancel">取消</button>' +
    '<button class="btn-mini primary" id="schSave">' + (s.id ? '保存修改' : '启用自动化') + '</button></div></div>';
}

function _wireSchForm() {
  const ev = document.getElementById('schEvery');
  const repo = document.getElementById('schRepo');
  const saveButton = document.getElementById('schSave');
  const scope = _schScope;
  const isCurrent = () => scope === _schScope && saveButton === document.getElementById('schSave');
  let saving = false;
  let repoSeq = 0;
  let methodRequired = new Set();
  let mode = document.querySelector('.sch-mode-btn.on').getAttribute('data-mode');
  let inputValues = Object.assign({}, (_schEditing && _schEditing !== 'new' && _schEditing.pluginInputs) || {});

  const readPluginInputs = () => {
    const values = {};
    document.querySelectorAll('#schPluginConfig [data-plugin-input]').forEach(el => {
      const type = el.getAttribute('data-input-type');
      values[el.getAttribute('data-plugin-input')] = type === 'boolean' ? el.checked :
        type === 'number' && el.value !== '' ? Number(el.value) : el.value;
    });
    return values;
  };
  /* Read personal-plugin inputs from #schMethodWrap, separately from enterprise-plugin inputs. */
  const readMethodInputs = () => {
    const values = {};
    document.querySelectorAll('#schMethodWrap [data-method-input]').forEach(el => {
      const type = el.getAttribute('data-input-type');
      values[el.getAttribute('data-method-input')] = type === 'boolean' ? el.checked :
        type === 'number' && el.value !== '' ? Number(el.value) : el.value;
    });
    return values;
  };
  const readBody = () => {
    const plugin = document.getElementById('schPlugin');
    const methodSelect = document.getElementById('schMethod');
    const personalKey = mode === 'direct' && methodSelect ? (methodSelect.value || '') : '';
    const { versionPolicy, personalVersion, personalChecksum, preserveSnapshot } =
      _schmSnapshotState(_schEditing, personalKey);
    return {
      title: (document.getElementById('schTitle').value || '').trim(),
      note: (document.getElementById('schNote').value || '').trim(),
      ..._schReadTiming(),
      atHour: window.ScheduleTiming.clockNumber(document.getElementById('schH').value),
      atMinute: window.ScheduleTiming.clockNumber(document.getElementById('schM').value),
      weekday: Number(document.getElementById('schWd').value || 1),
      startDate: document.getElementById('schStartDate')?.value || '',
      endDate: document.getElementById('schEndDate')?.value || '',
      assigneeId: document.getElementById('schWho').value,
      assigneeType: 'agent',
      modelName: mode === 'direct' && _schAgentAllowsModel(document.getElementById('schWho')?.value)
        ? (document.getElementById('schModel')?.value || '') : '',
      repoId: document.getElementById('schRepo').value,
      flow: false,
      /* Enterprise workflow bindings stay out of the ordinary-chat contract. A
       * personal plugin is still a valid conversation plugin and is handed to
       * the local worker through its immutable version snapshot. */
      pluginBindingId: '',
      personalPluginKey: personalKey,
      personalPluginVersionPolicy: personalKey ? versionPolicy : 'latest',
      personalPluginVersion: personalKey ? personalVersion : '',
      personalPluginChecksum: personalKey ? personalChecksum : '',
      pluginInputs: mode === 'plugin' ? readPluginInputs() :
        (preserveSnapshot ? Object.assign({}, inputValues) : readMethodInputs()),
      requiredCapabilities: Array.from(document.querySelectorAll('#schCaps input:checked'))
        .map(el => el.value),
      retryLimit: mode === 'direct' && document.getElementById('schRetry').checked
        ? Number(document.getElementById('schRetryLimit').value || 2) : 0,
      retryDelayMinutes: Number(document.getElementById('schRetryDelay').value || 5),
      enabled: document.getElementById('schEnabled').checked,
    };
  };
  let probeTimer = 0;
  let probeSeq = 0;
  const scheduleProbe = () => {
    if (_schEditorPending) return;
    const line = document.getElementById('schReady');
    if (!line || !SoduWorkAPI.preflightSchedule) return;
    clearTimeout(probeTimer);
    const seq = ++probeSeq;
    const timingError = _schTimingError(readBody());
    if (timingError) {
      _schRenderPreflight(line, {state:'blocked', message:timingError});
      return;
    }
    line.className = 'sch-ready checking';
    line.querySelector('b').textContent = '正在检查执行条件…';
    line.querySelector('small').textContent = '';
    probeTimer = setTimeout(async () => {
      if (!isCurrent() || line !== document.getElementById('schReady')) return;
      try {
        const result = await SoduWorkAPI.preflightSchedule(readBody());
        if (!isCurrent() || seq !== probeSeq || line !== document.getElementById('schReady')) return;
        _schRenderPreflight(line, result);
      } catch (error) {
        if (!isCurrent() || seq !== probeSeq || line !== document.getElementById('schReady')) return;
        line.className = 'sch-ready waiting';
        line.querySelector('b').textContent = _schErrorText(error);
        line.querySelector('small').textContent = '';
        line.removeAttribute('title');
      }
    }, 260);
  };
  const wirePluginSelect = () => {
    const select = document.getElementById('schPlugin');
    if (!select) return;
    select.addEventListener('change', () => {
      inputValues = {};
      document.getElementById('schPluginConfig').innerHTML =
        _schPluginConfigHtml(repo.value, select.value, inputValues);
      wirePluginSelect();
      scheduleProbe();
    }, { once: true });
  };
  /* Select and lock capabilities declared by the chosen personal plugin. */
  const applyMethodCaps = () => {
    const method = _schmFind((document.getElementById('schMethod') || {}).value || '');
    const need = method ? _schmCaps(method) : [];
    if (_schmSnapshotLocked(_schEditing)) {
      methodRequired = new Set(need);
      const saved = new Set((_schEditing && _schEditing.requiredCapabilities) || []);
      document.querySelectorAll('#schCaps input').forEach(input => {
        input.checked = saved.has(input.value);
        input.disabled = true;
        input.title = '固定旧版本时保留原能力合同';
        input.closest('label').classList.toggle('on', input.checked);
      });
      return;
    }
    document.querySelectorAll('#schCaps input').forEach(input => {
      const required = need.includes(input.value);
      if (methodRequired.has(input.value) && !required) input.checked = false;
      if (required) input.checked = true;
      input.disabled = required;
      input.title = required ? '所选个人插件需要这项能力' : '';
      input.closest('label').classList.toggle('on', input.checked);
    });
    methodRequired = new Set(need);
  };
  const wireMethodPolicy = () => {
    document.querySelectorAll('#schMethodWrap input[name="schMethodVersionPolicy"]').forEach(input => {
      input.addEventListener('change', () => {
        document.querySelectorAll('#schMethodWrap .sch-version-policy label').forEach(label =>
          label.classList.toggle('on', label.querySelector('input').checked));
        applyMethodCaps();
        scheduleProbe();
      });
    });
  };
  const wireMethodSelect = () => {
    const select = document.getElementById('schMethod');
    if (!select) return;
    select.addEventListener('change', () => {
      document.getElementById('schMethodWrap').innerHTML =
        _schmConfigHtml(select.value, {}, { versionPolicy: 'pinned' });
      wireMethodSelect();
      wireMethodPolicy();
      applyMethodCaps();
      scheduleProbe();
    }, { once: true });
  };
  const sync = () => {
    const v = ev.value;
    document.getElementById('schWd').style.display = v === 'weekly' ? '' : 'none';
    document.getElementById('schHWrap').style.display = v === 'once' ? 'none' : '';
    const dateRange = document.getElementById('schDateRange');
    if (dateRange) dateRange.style.display = v === 'once' ? 'none' : '';
    document.getElementById('schH').hidden = v === 'hourly';
    const clockSep = document.getElementById('schClockSep');
    if (clockSep) clockSep.hidden = v === 'hourly';
    const clockHint = document.getElementById('schClockHint');
    if (clockHint) clockHint.textContent = _schTx(v === 'hourly' ? '每小时第几分' : '滚动选择时间');
    _schSyncTiming(v);
    document.getElementById('schDirectBlock').style.display = mode === 'direct' ? '' : 'none';
    document.getElementById('schPluginBlock').style.display = mode === 'plugin' ? '' : 'none';
    document.getElementById('schFlowWrap').style.display = 'none';
    const pv = document.getElementById('schPv');
    if (pv) pv.textContent = _schNextPreview();
    const bpWhen = document.getElementById('schBpWhen');
    const bpWork = document.getElementById('schBpWork');
    if (bpWhen) bpWhen.textContent = _schNextPreview().replace(/^\u4e0b\u4e00\u6b21\uff1a/, '');
    if (bpWork) bpWork.textContent = (document.getElementById('schTitle').value || '').trim() ||
      '\u5b8c\u6210\u8bbe\u5b9a\u7684\u5de5\u4f5c';
    document.querySelectorAll('#schCaps label').forEach(label =>
      label.classList.toggle('on', label.querySelector('input').checked));
    document.getElementById('schRetryOptions').style.display =
      document.getElementById('schRetry').checked ? '' : 'none';
    scheduleProbe();
  };
  ev.addEventListener('change', sync);
  document.querySelectorAll('.sch-mode-btn').forEach(button => button.addEventListener('click', () => {
    mode = button.getAttribute('data-mode');
    document.querySelectorAll('.sch-mode-btn').forEach(item =>
      item.classList.toggle('on', item === button));
    sync();
  }));
  repo.addEventListener('change', async () => {
    const seq = ++repoSeq;
    inputValues = readPluginInputs();
    const current = document.getElementById('schPlugin');
    const selected = current ? current.value : '';
    const config = document.getElementById('schPluginConfig');
    if (config) config.innerHTML = '<div class="sch-plugin-empty">正在匹配当前项目可用的插件…</div>';
    await _schLoadPlugins(_schProjectId(repo.value));
    if (!isCurrent() || seq !== repoSeq) return;
    const available = _schPluginsForRepo(repo.value);
    const keep = available.some(item => item.bindingId === selected) ? selected : '';
    config.innerHTML = _schPluginConfigHtml(repo.value, keep, keep ? inputValues : {});
    wirePluginSelect();
    sync();
  });
  ['schH', 'schM', 'schWd', 'schRunAt', 'schStartDate', 'schEndDate'].forEach(id => document.getElementById(id)?.addEventListener('input', sync));
  document.getElementById('schTitle').addEventListener('input', event => {
    event.currentTarget.classList.remove('invalid');
    event.currentTarget.removeAttribute('aria-invalid');
    sync();
  });
  ['schH', 'schM', 'schWd'].forEach(id => document.getElementById(id).addEventListener('change', sync));
  document.getElementById('schWho').addEventListener('change', async event => {
    if (event.catalogRefresh) { _schRefreshModelField(); scheduleProbe(); return; }
    // A different substrate may have a different model namespace. Never carry
    // the previous substrate's explicit model into the new selection.
    _schRefreshModelField('');
    const selected = document.getElementById('schWho').value;
    await _schLoadNativeModelOptions(_schAgents.filter(item => item.id === selected));
    if (!isCurrent() || document.getElementById('schWho').value !== selected) return;
    _schRefreshModelField();
    scheduleProbe();
  });
  document.getElementById('schModel')?.addEventListener('change', scheduleProbe);
  document.querySelectorAll('#schCaps input').forEach(input => input.addEventListener('change', () => {
    input.closest('label').classList.toggle('on', input.checked);
    scheduleProbe();
  }));
  document.getElementById('schRetry').addEventListener('change', sync);
  ['schRetryLimit', 'schRetryDelay'].forEach(id => document.getElementById(id).addEventListener('change', scheduleProbe));
  wirePluginSelect();
  wireMethodSelect();
  wireMethodPolicy();
  applyMethodCaps();
  sync();
  document.getElementById('schCancel').addEventListener('click', () => _schCloseEditor(true));
  saveButton.scheduleDraft = () => {
    const body = readBody();
    // Catalog hydration must preserve input verbatim, including fields whose
    // plugin schema has not arrived yet. Save-time normalization stays in readBody.
    return { ...body, title: document.getElementById('schTitle').value,
      note: document.getElementById('schNote').value,
      pluginInputs: { ...inputValues, ...body.pluginInputs } };
  };
  document.getElementById('schSave').addEventListener('click', async () => {
    if (saving || _schEditorPending || !isCurrent()) return;
    const body = readBody();
    if (_schTimingError(body, true)) return;
    if (!body.title) {
      const titleInput = document.getElementById('schTitle');
      titleInput.classList.add('invalid'); titleInput.setAttribute('aria-invalid', 'true');
      titleInput.focus({ preventScroll: true });
      if (typeof petSay === 'function') petSay('给它起个名字吧');
      return;
    }
    if (!body.assigneeId) {
      if (typeof petSay === 'function') petSay('先选把活交给谁'); return;
    }
    const modelOptions = typeof _schModelOptionsFor === 'function'
      ? _schModelOptionsFor(body.assigneeId) : _schModelOptions;
    if (_schAgentAllowsModel(body.assigneeId) &&
        modelOptions.length && !body.modelName) {
      if (typeof petSay === 'function') petSay('\u8bf7\u9009\u62e9\u4e00\u4e2a\u6a21\u578b'); return;
    }
    if (body.personalPluginKey) {
      const method = _schmFind(body.personalPluginKey);
      if (!method) {
        if (typeof petSay === 'function') petSay('这个个人插件已不在本机，请换一个工作方法'); return;
      }
      const missing = (method.inputs || []).filter(f => f.required &&
        (body.pluginInputs[f.key] == null || body.pluginInputs[f.key] === ''))
        .map(f => f.label || f.key);
      if (missing.length) {
        if (typeof petSay === 'function') petSay('插件必填参数还没填：' + missing.join('、')); return;
      }
    }
    const idleLabel = saveButton.textContent;
    saving = true; ++probeSeq; clearTimeout(probeTimer);
    const fields = [...(document.getElementById('schEditorContent')?.querySelectorAll('input,textarea,select,.sch-mode-btn') || [])];
    const disabled = fields.map(node => node.disabled);
    fields.forEach(node => { node.disabled = true; });
    saveButton.disabled = true; saveButton.textContent = '正在预检…';
    try {
      // Revalidate before saving; editing-time plugin/account state may be stale.
      if (SoduWorkAPI.preflightSchedule) {
        const preflight = await SoduWorkAPI.preflightSchedule(body, { force: true });
        if (!isCurrent()) return;
        _schRenderPreflight(document.getElementById('schReady'), preflight);
        if (preflight?.state === 'blocked') throw new Error(preflight.message || '执行条件尚未满足');
      }
      saveButton.textContent = '正在保存…';
      /*
       * A prefilled template object is a new draft. Determine updates by persistent ID, not
       * object presence.
       */
      const editingId = _schEditing && _schEditing !== 'new'
        ? String(_schEditing.id || '') : '';
      if (editingId) await SoduWorkAPI.updateSchedule(editingId, body);
      else await SoduWorkAPI.createSchedule(body);
      if (!isCurrent()) return;
      if (typeof petSay === 'function') petSay(body.every === 'once' ? '一次性自动化已保存' : '定时任务已保存，到点创建普通会话并发送提示词');
      _schCloseEditor(false); _schRows = null; _loadSch();
    } catch (e) {
      if (!isCurrent()) return;
      if (typeof petSay === 'function') petSay('没保存上：' + (typeof _humanErr === 'function' ? _humanErr(e, '保存失败') : e.message));
    } finally {
      saving = false;
      fields.forEach((node, index) => { if (node.isConnected) node.disabled = disabled[index]; });
      if (saveButton.isConnected) {
        saveButton.disabled = false; saveButton.textContent = idleLabel;
      }
    }
  });
}

let _schRunRefreshTimer = 0;
window.addEventListener('soduwork-work-task-change', () => {
  const panel = document.getElementById('schPanel');
  if (!_schRunOpen || !panel || !panel.classList.contains('show')) return;
  const sid = _schRunOpen;
  clearTimeout(_schRunRefreshTimer);
  _schRunRefreshTimer = setTimeout(() => {
    if (_schRunOpen === sid) _schToggleRuns(sid, true);
  }, 300);
});

window.openSchedulePanel = openSchedulePanel;
window.closeSchedulePanel = closeSchedulePanel;
window.addEventListener('soduwork-data-scope-changed', () => _schResetScope());
