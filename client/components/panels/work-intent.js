/* Entry intents: direct conversation, goal loop, and formal requirement creation. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WorkIntent = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const esc = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const text = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const multiline = (value, max) => String(value || '').replace(/\r\n?/g, '\n')
    .split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean).join('\n').slice(0, max);
  const wiTx = (value) => (typeof window !== 'undefined' && window.SoduWorkI18n?.translateText
    ? window.SoduWorkI18n.translateText(value) : value);
  const GOAL_PHASES = Object.freeze([
    ['understand', '理解目标'], ['plan', '形成计划'], ['execute', '完成工作'],
    ['verify', '验证结果'], ['deliver', '整理交付'],
  ]);
  const SCHEDULE_WEEKDAYS = Object.freeze(['一', '二', '三', '四', '五', '六', '日']);
  const SCHEDULE_MONTH_DAYS = Object.freeze(Array.from({ length: 31 }, (_, index) => index + 1));

  const ICONS = Object.freeze({
    goal: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M22 12h-3M12 22v-3M2 12h3"/></svg>',
    task: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="4" width="14" height="16" rx="3"/><path d="M9 9h6M9 13h6M9 17h3"/></svg>',
    schedule: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.2 2"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>',
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><g class="ncopy-default"><rect x="8.5" y="7.5" width="10.5" height="12" rx="2"/><path d="M15.5 7.5V6A2.5 2.5 0 0 0 13 3.5H6A2.5 2.5 0 0 0 3.5 6v8A2.5 2.5 0 0 0 6 16.5h2.5"/></g><path class="ncopy-check" d="m5.5 12.5 3.2 3.2 9.8-10"/></svg>',
  });

  function acceptanceItems(value) {
    return multiline(value, 1600).split(/\n|[；;]/)
      .map((item) => item.replace(/^\s*(?:[-*•·]\s*|\d+\s*[.)、]\s*)/, '').trim())
      .filter(Boolean);
  }
  function longMessage(value) {
    const body = String(value || '').replace(/\r\n?/g, '\n').trim();
    return body.length > 320 || body.split('\n').length > 6;
  }

  function preview(value) {
    const body = String(value || '').replace(/\s+/g, ' ').trim();
    return body.length > 116 ? body.slice(0, 116).trimEnd() + '…' : body;
  }

  function userMessage(value, raw, messageFooter) {
    const body = String(value || '').replace(/\r\n?/g, '\n').trim();
    const intent = normalize(raw || {});
    const items = acceptanceItems(intent.acceptance);
    const isLong = longMessage(body);
    const content = isLong
      ? '<details class="nuser-long"><summary><span>' + esc(preview(body)) +
        '</span><i class="nuser-more">展开全文</i><i class="nuser-less">收起</i></summary>' +
        '<div class="nuser-full">' + esc(body) + '</div></details>'
      : '<div class="nuser-text">' + esc(body) + '</div>';
    const className = 'nmsg user' + (isLong ? ' long' : '') +
      (intent.mode === 'goal' ? ' goal' : '');
    const copy = '<button type="button" class="nmessage-copy" data-copy-message="' + esc(body) +
      '" title="复制内容" aria-label="复制内容">' + ICONS.copy + '</button>';
    const footer = messageFooter == null ? '<div class="nmessage-footer">' + copy + '</div>' : messageFooter;
    if (intent.mode !== 'goal') {
      return '<div class="' + className + '"><div class="nbubble">' + content + '</div>' + footer + '</div>';
    }
    const criteria = items.length
      ? '<details class="nuser-criteria"><summary>查看完成标准</summary><ul>' +
        items.map((item) => '<li>' + esc(item) + '</li>').join('') + '</ul></details>'
      : '';
    return '<div class="' + className + '"><div class="nbubble">' + content +
      '<div class="nuser-goalmeta">' + ICONS.goal + '<span>目标循环</span><i>' +
      (items.length ? items.length + ' 项完成标准 · ' : '') + '已写入工作记忆</i></div>' +
      criteria + '</div>' + footer + '</div>';
  }


  function normalize(raw, fallbackGoal) {
    const value = raw || {};
    const mode = value.mode === 'task' ? 'task'
      : value.mode === 'schedule' ? 'schedule'
      : value.mode === 'goal' || value.intent === 'goal' ? 'goal' : 'chat';
    const goal = text(value.goal || (mode !== 'chat' ? fallbackGoal : ''), 1200);
    return Object.freeze({
      mode: mode === 'goal' && !goal ? 'chat' : mode,
      goal,
      acceptance: multiline(value.acceptance, 1600),
      schedule: mode === 'schedule' ? cleanSchedule(value.schedule) : null,
    });
  }

  /*
   * Match personal automation settings. One-time schedules preserve absolute time; a missing
   * date remains incomplete. Include personalPluginKey only when a local plugin method is
   * selected.
   */
  function cleanSchedule(raw) {
    const value = raw || {};
    const every = ['daily', 'weekly', 'monthly', 'hourly', 'once', 'custom'].includes(value.every) ? value.every : 'daily';
    const hasWeekdays = Array.isArray(value.weekdays);
    const weekdays = hasWeekdays ? [...new Set(value.weekdays.map(item => parseInt(item, 10)).filter(item => item >= 1 && item <= 7))].sort((a, b) => a - b) : [];
    const monthDays = Array.isArray(value.monthDays) ? [...new Set(value.monthDays.map(item => parseInt(item, 10)).filter(item => item >= 1 && item <= 31))].sort((a, b) => a - b) : [];
    const pluginKey = text(value.personalPluginKey, 64);
    const timeZone = text(value.timeZone, 64);
    return Object.freeze({
      every,
      atHour: Math.max(0, Math.min(23, parseInt(value.atHour, 10) || 0)),
      atMinute: Math.max(0, Math.min(59, parseInt(value.atMinute, 10) || 0)),
      weekday: every === 'weekly' && hasWeekdays && !weekdays.length
        ? null : weekdays[0] || Math.max(1, Math.min(7, parseInt(value.weekday, 10) || 1)),
      weekdays,
      monthDays,
      monthDayPolicy: value.monthDayPolicy === 'last_day' ? 'last_day' : 'skip',
      startDate: text(value.startDate, 10),
      endDate: text(value.endDate, 10),
      ...(every === 'once' ? { runAt: text(value.runAt, 80) } : {}),
      ...(every === 'custom' ? { customRule: String(value.customRule || '').replace(/\r\n?/g, '\n').trim() } : {}),
      ...(timeZone ? { timeZone } : {}),
      ...(pluginKey ? { personalPluginKey: pluginKey } : {}),
    });
  }

  function controls(prefix, options) {
    const p = esc(prefix || 'work');
    const goalOnly = !!(options && options.goalOnly);
    if (goalOnly) {
      return '<span class="wi-tools wi-goal-only" role="group" aria-label="工作方式">' +
        '<button class="wi-tool" id="' + p + 'IntentMenu" type="button" aria-pressed="false" ' +
          'title="设定持续目标" aria-label="设定持续目标">' + ICONS.goal +
          '<span class="wi-tool-label" id="' + p + 'IntentMenuLabel">设定目标</span></button></span>';
    }
    return '<span class="wi-tools" role="group" aria-label="工作方式">' +
      '<button class="wi-tool" id="' + p + 'IntentMenu" type="button" aria-pressed="false" ' +
        'aria-haspopup="menu" aria-expanded="false" title="设定持续目标或建立需求">' +
        ICONS.goal + '<span class="wi-tool-label" id="' + p + 'IntentMenuLabel">设定目标</span>' +
        '<span class="wi-tool-chevron" aria-hidden="true">⌄</span></button>' +
      '<div class="wi-chooser" id="' + p + 'IntentChooser" role="menu" aria-label="选择工作方式">' +
        '<button class="wi-choice" id="' + p + 'IntentGoal" type="button" role="menuitem">' +
          '<span class="wi-choice-icon">' + ICONS.goal + '</span><span><b>设定目标</b>' +
          '<i>仍是普通工作，但会按完成标准持续执行、自检和修正</i></span></button>' +
        '<button class="wi-choice" id="' + p + 'IntentTask" type="button" role="menuitem">' +
          '<span class="wi-choice-icon">' + ICONS.task + '</span><span><b>建立需求</b>' +
          '<i>连同完成标准发送，再确认执行人、底座与流程</i></span></button>' +
        '<button class="wi-choice" id="' + p + 'IntentSchedule" type="button" role="menuitem">' +
          '<span class="wi-choice-icon">' + ICONS.schedule + '</span><span><b>自动化</b>' +
          '<i>到点自动建需求并交给 AI，按下方设定的时间反复执行</i></span></button>' +
      '</div></span>';
  }

  function rail(prefix) {
    const p = esc(prefix || 'work');
    return '<div class="wi-rail" id="' + p + 'IntentRail" aria-live="polite">' +
      '<button class="wi-rail-toggle" type="button" id="' + p + 'IntentToggle" ' +
        'aria-expanded="false" aria-controls="' + p + 'IntentPanel">' +
        '<span class="wi-rail-ring" aria-hidden="true"><i></i></span>' +
        '<span class="wi-rail-copy"><b id="' + p + 'IntentLabel">目标</b>' +
          '<i id="' + p + 'IntentStage">等待开始</i></span>' +
        '<svg class="wi-rail-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 10l4 4 4-4"/></svg>' +
      '</button>' +
      '<div class="wi-rail-actions" role="group" aria-label="目标运行控制">' +
        '<button class="wi-rail-action wi-rail-stop" type="button" id="' + p + 'IntentPause" ' +
          'title="停止并保留进度" aria-label="停止并保留进度" hidden>' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg></button>' +
        '<button class="wi-rail-action wi-rail-resume" type="button" id="' + p + 'IntentResume" ' +
          'title="继续完成目标" aria-label="继续完成目标" hidden>' +
          '<svg class="is-fill" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7.2 16.5 12 9 16.8Z"/></svg></button>' +
        '<button class="wi-rail-action wi-rail-delete" type="button" id="' + p + 'IntentClear" ' +
          'title="删除目标" aria-label="删除目标">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8v9M12 8v9M16 8v9M5 5h14M9 5l1-2h4l1 2M7 5l1 16h8l1-16"/></svg></button>' +
      '</div>' +
      '<div class="wi-rail-panel" id="' + p + 'IntentPanel" hidden>' +
        '<header><span><b id="' + p + 'IntentPhase">目标已记录</b>' +
          '<i id="' + p + 'IntentSummary"></i></span></header>' +
        '<ol id="' + p + 'IntentSteps"></ol>' +
      '</div>' +
      '</div>';
  }

  function phaseView(runtime) {
    const state = runtime || {};
    const supplied = Array.isArray(state.phases) ? state.phases : [];
    const byKey = new Map(supplied.map((item) => [String(item && item.key || ''), item || {}]));
    const rows = GOAL_PHASES.map(([key, label]) => {
      const source = byKey.get(key) || {};
      const phaseState = ['completed', 'running', 'paused', 'blocked'].includes(source.state)
        ? source.state : 'pending';
      return { key, label: text(source.label || label, 48), state: phaseState };
    });
    let index = rows.findIndex((item) => item.state !== 'completed');
    if (index < 0 || state.ready) index = rows.length - 1;
    const current = rows[Math.max(0, index)] || null;
    return {
      rows, total: rows.length, current: rows.length ? Math.max(0, index) + 1 : 0,
      completed: rows.filter((item) => item.state === 'completed').length,
      phase: current,
    };
  }

  function surface(prefix, options) {
    const p = esc(prefix || 'work');
    const goalOnly = !!(options && options.goalOnly);
    return '<div class="wi-brief" id="' + p + 'IntentBrief" aria-hidden="true" aria-live="polite">' +
      '<div class="wi-brief-mode"><span class="wi-brief-icon" id="' + p + 'IntentModeIcon">' + ICONS.goal + '</span>' +
        '<span class="wi-brief-copy"><b id="' + p + 'IntentLabel">设定目标</b>' +
        '<i id="' + p + 'IntentSummary">上方描述就是本次目标</i></span></div>' +
      (goalOnly ? '' : '<div class="wi-schedule-row" id="' + p + 'IntentScheduleRow" hidden>' +
        '<span>' + esc(wiTx('执行时间')) + '</span>' +
        '<select id="' + p + 'IntentSchEvery" aria-label="' + esc(wiTx('频率')) + '">' +
          '<option value="daily">' + esc(wiTx('每天')) + '</option><option value="weekly">' + esc(wiTx('每周')) + '</option><option value="monthly">' + esc(wiTx('每月')) + '</option>' +
          '<option value="hourly">' + esc(wiTx('每小时')) + '</option><option value="once">' + esc(wiTx('指定日期时间 · 仅一次')) + '</option>' +
          '<option value="custom">' + esc(wiTx('自定义')) + '</option></select>' +
        '<select id="' + p + 'IntentSchWeekday" aria-label="星期几" hidden>' +
          SCHEDULE_WEEKDAYS.map((d, i) =>
            '<option value="' + (i + 1) + '">周' + d + '</option>').join('') + '</select>' +
        '<div class="wi-schedule-weekdays" data-wi-weekdays hidden>' +
          '<span>' + esc(wiTx('星期')) + '</span><div>' + SCHEDULE_WEEKDAYS.map((d, i) =>
            '<label><input type="checkbox" data-wi-weekday value="' + (i + 1) + '"' +
            (i === 0 ? ' checked' : '') + '><b>' + esc(wiTx('周' + d)) + '</b></label>').join('') + '</div></div>' +
        '<div class="wi-schedule-monthdays" data-wi-monthdays hidden>' +
          '<span>' + esc(wiTx('每月日期')) + '</span><div>' + SCHEDULE_MONTH_DAYS.map((day) =>
            '<label><input type="checkbox" data-wi-monthday value="' + day + '"><b>' + String(day).padStart(2, '0') + '</b></label>').join('') + '</div>' +
          '<label class="wi-schedule-lastday"><input type="checkbox" data-wi-lastday><b>' + esc(wiTx('缺少日期时使用当月最后一天')) + '</b></label></div>' +
        '<div class="wi-schedule-range" data-wi-range>' +
          '<label>' + esc(wiTx('开始日期')) + '<input id="' + p + 'IntentSchStartDate" type="date" aria-label="' + esc(wiTx('开始日期')) + '"></label>' +
          '<label>' + esc(wiTx('结束日期')) + '<input id="' + p + 'IntentSchEndDate" type="date" aria-label="' + esc(wiTx('结束日期')) + '"></label></div>' +
        '<input id="' + p + 'IntentSchRunAt" type="datetime-local" step="60" aria-label="' + esc(wiTx('执行日期时间')) + '" hidden>' +
        '<label class="wi-schedule-custom" data-wi-custom hidden><span>' + esc(wiTx('自定义规则')) + '</span>' +
          '<textarea id="' + p + 'IntentSchCustomRule" rows="4" maxlength="4096" spellcheck="false" data-user-content aria-label="' + esc(wiTx('自定义规则')) + '"></textarea>' +
          '<small>' + esc(wiTx('可使用 DTSTART 与 RRULE 精确指定开始时间、时区和重复规则')) + '</small></label>' +
        '<input id="' + p + 'IntentSchTime" type="time" value="09:00" aria-label="' + esc(wiTx('时刻')) + '">' +
        '<select id="' + p + 'IntentSchPlugin" aria-label="工作方法" hidden>' +
          '<option value="">不用插件</option></select>' +
        '<i>' + esc(wiTx('按这台电脑的时区执行')) + '</i></div>') +
      '<label class="wi-acceptance-row" for="' + p + 'IntentAcceptance">' +
        '<span>完成标准 <i>可选</i></span>' +
        '<textarea id="' + p + 'IntentAcceptance" rows="1" maxlength="1600" ' +
          'placeholder="例如：有可直接使用的成果，并附验证证据"></textarea></label>' +
      '<button class="wi-brief-clear" id="' + p + 'IntentClear" type="button" ' +
        'title="取消本次工作方式" aria-label="取消本次工作方式">' + ICONS.close + '</button>' +
      '</div>';
  }

  function mount(node, options) {
    if (!node) return null;
    const o = options || {};
    const goalOnly = !!o.goalOnly;
    const p = o.prefix || 'work';
    const byId = (name) => node.querySelector('#' + p + name);
    const menuButton = byId('IntentMenu');
    const menuLabel = byId('IntentMenuLabel');
    const goalButton = byId('IntentGoal');
    const taskButton = byId('IntentTask');
    const scheduleButton = byId('IntentSchedule');
    const scheduleRow = byId('IntentScheduleRow');
    const schEvery = byId('IntentSchEvery');
    const schWeekday = byId('IntentSchWeekday');
    const schWeekdays = [...node.querySelectorAll('[data-wi-weekday]')];
    const schMonthdays = [...node.querySelectorAll('[data-wi-monthday]')];
    const schLastday = node.querySelector('[data-wi-lastday]');
    const schWeekdayGroup = node.querySelector('[data-wi-weekdays]');
    const schMonthdayGroup = node.querySelector('[data-wi-monthdays]');
    const schRange = node.querySelector('[data-wi-range]');
    const schStartDate = byId('IntentSchStartDate');
    const schEndDate = byId('IntentSchEndDate');
    const schTime = byId('IntentSchTime');
    const schRunAt = byId('IntentSchRunAt');
    const schCustomRule = byId('IntentSchCustomRule');
    const schCustomRuleWrap = node.querySelector('[data-wi-custom]');
    if (schCustomRule && typeof window !== 'undefined' && window.ScheduleTiming) {
      schCustomRule.placeholder = window.ScheduleTiming.customExample();
    }
    const schPlugin = byId('IntentSchPlugin');
    /*
     * Load host-provided automationMethods on first entry into automation mode; hide the
     * selector when no methods are available.
     */
    let methodItems = null;
    let methodLoading = false;
    function ensureMethods() {
      if (!schPlugin || methodItems !== null || methodLoading) return;
      if (typeof o.automationMethods !== 'function') { methodItems = []; return; }
      methodLoading = true;
      Promise.resolve(o.automationMethods()).then((items) => {
        methodItems = Array.isArray(items) ? items : [];
      }).catch(() => { methodItems = []; }).then(() => {
        methodLoading = false;
        if (!methodItems.length) return;
        schPlugin.innerHTML = '<option value="">不用插件</option>' +
          methodItems.map((item) => '<option value="' + esc(item.key) + '">' +
            esc(item.name) + '</option>').join('');
        schPlugin.hidden = state.mode !== 'schedule';
      });
    }
    const chooser = byId('IntentChooser');
    const brief = byId('IntentBrief');
    const modeIcon = byId('IntentModeIcon');
    const label = byId('IntentLabel');
    const summary = byId('IntentSummary');
    const acceptanceInput = byId('IntentAcceptance');
    const clear = byId('IntentClear');
    const defaultPlaceholder = o.input ? o.input.getAttribute('placeholder') : '';
    let state = { mode: 'chat', goal: '', acceptance: '' };

    function closeChooser(focusButton) {
      if (chooser) chooser.classList.remove('show');
      if (menuButton) menuButton.setAttribute('aria-expanded', 'false');
      if (focusButton && menuButton) menuButton.focus();
    }

    function fitAcceptance() {
      if (!acceptanceInput) return;
      acceptanceInput.style.height = 'auto';
      acceptanceInput.style.height = Math.min(Math.max(32, acceptanceInput.scrollHeight), 68) + 'px';
    }

    function scheduleValue() {
      const time = String((schTime && schTime.value) || '09:00').split(':');
      const every = (schEvery && schEvery.value) || 'daily';
      const weekdays = every === 'weekly'
        ? schWeekdays.filter((input) => input.checked).map((input) => Number(input.value)) : [];
      const monthDays = every === 'monthly'
        ? schMonthdays.filter((input) => input.checked).map((input) => Number(input.value)) : [];
      return {
        every,
        weekday: weekdays[0] || (every === 'weekly' ? null :
          parseInt((schWeekday && schWeekday.value) || '1', 10)),
        weekdays,
        monthDays,
        monthDayPolicy: schLastday && schLastday.checked ? 'last_day' : 'skip',
        startDate: every === 'custom' ? '' : (schStartDate ? schStartDate.value : ''),
        endDate: every === 'custom' ? '' : (schEndDate ? schEndDate.value : ''),
        ...(schRunAt && schRunAt.value ? { runAt: schRunAt.value } : {}),
        ...(every === 'custom' && schCustomRule ? { customRule: schCustomRule.value.trim() } : {}),
        atHour: parseInt(time[0], 10) || 0,
        atMinute: parseInt(time[1], 10) || 0,
        personalPluginKey: (schPlugin && schPlugin.value) || '',
      };
    }

    function current(fallbackGoal) {
      return normalize({
        mode: state.mode,
        goal: state.mode === 'chat' ? '' : fallbackGoal,
        acceptance: acceptanceInput ? acceptanceInput.value : state.acceptance,
        schedule: scheduleValue(),
      }, fallbackGoal);
    }

    function paint() {
      const goalOn = state.mode === 'goal';
      const taskOn = state.mode === 'task';
      const scheduleOn = state.mode === 'schedule';
      const active = goalOn || taskOn || scheduleOn;
      node.dataset.workIntent = state.mode;
      if (menuButton) {
        menuButton.classList.toggle('on', active);
        menuButton.setAttribute('aria-pressed', String(active));
        menuButton.title = goalOn ? '本次工作按目标循环' : taskOn ? '建立需求'
          : scheduleOn ? '建立自动化' : '设定目标或建立需求';
      }
      if (menuLabel) menuLabel.textContent = goalOn ? '目标' : taskOn ? '建立需求'
        : scheduleOn ? '自动化' : '设定目标';
      if (goalButton) {
        goalButton.classList.toggle('on', goalOn);
        goalButton.setAttribute('aria-current', goalOn ? 'true' : 'false');
      }
      if (taskButton) {
        taskButton.classList.toggle('on', taskOn);
        taskButton.setAttribute('aria-current', taskOn ? 'true' : 'false');
      }
      if (scheduleButton) {
        scheduleButton.classList.toggle('on', scheduleOn);
        scheduleButton.setAttribute('aria-current', scheduleOn ? 'true' : 'false');
      }
      if (scheduleRow) {
        scheduleRow.hidden = !scheduleOn;
        if (schWeekday) schWeekday.hidden = true;
        if (schWeekdayGroup) schWeekdayGroup.hidden = !(schEvery && schEvery.value === 'weekly');
        if (schMonthdayGroup) schMonthdayGroup.hidden = !(schEvery && schEvery.value === 'monthly');
        if (schRange) schRange.hidden = !(schEvery && ['daily', 'weekly', 'monthly', 'hourly'].includes(schEvery.value));
        if (schRunAt) schRunAt.hidden = !(schEvery && schEvery.value === 'once');
        if (schCustomRuleWrap) schCustomRuleWrap.hidden = !(schEvery && schEvery.value === 'custom');
        if (schTime) schTime.hidden = !!(schEvery && ['hourly', 'once', 'custom'].includes(schEvery.value));
        if (schPlugin) schPlugin.hidden = !scheduleOn || !(methodItems || []).length;
        if (scheduleOn) ensureMethods();
      }
      if (brief) {
        brief.classList.toggle('show', active);
        brief.classList.toggle('task', taskOn || scheduleOn);
        brief.classList.toggle('schedule', scheduleOn);
        brief.setAttribute('aria-hidden', String(!active));
      }
      if (modeIcon) modeIcon.innerHTML = taskOn ? ICONS.task
        : scheduleOn ? ICONS.schedule : ICONS.goal;
      if (label) label.textContent = goalOn ? '目标' : taskOn ? '需求目标'
        : scheduleOn ? '自动化' : '';
      if (summary) summary.textContent = goalOn
        ? '上方描述与完成标准会随同一次发送，并写入本次工作记忆'
        : taskOn ? '上方描述与完成标准会一起进入需求确认'
        : scheduleOn ? '到点自动建需求并交给 AI；可随时在「自动化」里调整或停用' : '';
      if (o.input) {
        o.input.placeholder = goalOn ? '描述希望 SoduWork 最终完成并交付什么…'
          : taskOn ? '说明需求目标、背景和需要解决的问题…'
          : scheduleOn ? '描述每次到点要做什么，例如：汇总我今天的需求进展…' : defaultPlaceholder;
      }
      const hint = node.querySelector('.wc-hint');
      if (hint) hint.textContent = goalOn ? '回车发送目标与完成标准'
        : taskOn ? '回车整理为正式需求'
        : scheduleOn ? '回车建立自动化' : '回车开始 · Shift+回车换行';
      const send = node.querySelector('.wc-send');
      if (send) send.title = goalOn ? '按目标开始' : taskOn ? '整理为正式需求'
        : scheduleOn ? '建立自动化' : '开始';
      if (active) setTimeout(fitAcceptance, 0);
      if (typeof o.onChange === 'function') o.onChange(current(o.input && o.input.value));
    }

    function setMode(mode) {
      state = {
        mode: ['task', 'goal', 'schedule'].indexOf(mode) >= 0 ? mode : 'chat',
        goal: '',
        acceptance: multiline(acceptanceInput && acceptanceInput.value, 1600),
      };
      closeChooser();
      paint();
      if (o.input) o.input.focus();
    }

    if (menuButton) menuButton.addEventListener('click', (event) => {
      event.stopPropagation();
      if (goalOnly) {
        setMode(state.mode === 'goal' ? 'chat' : 'goal');
        return;
      }
      const show = chooser && !chooser.classList.contains('show');
      closeChooser();
      if (chooser && show) {
        chooser.classList.add('show');
        menuButton.setAttribute('aria-expanded', 'true');
        const selected = chooser.querySelector('[aria-current="true"]') || goalButton;
        setTimeout(() => selected && selected.focus(), 0);
      }
    });
    if (goalButton) goalButton.addEventListener('click', (event) => {
      event.stopPropagation(); setMode('goal');
    });
    if (taskButton) taskButton.addEventListener('click', (event) => {
      event.stopPropagation(); setMode('task');
    });
    if (scheduleButton) scheduleButton.addEventListener('click', (event) => {
      event.stopPropagation(); setMode('schedule');
    });
    if (schEvery) schEvery.addEventListener('change', () => paint());
    if (schPlugin) schPlugin.addEventListener('change', () => paint());
    if (scheduleRow) scheduleRow.addEventListener('click', (event) => event.stopPropagation());
    if (clear) clear.addEventListener('click', () => {
      if (acceptanceInput) {
        acceptanceInput.value = '';
        acceptanceInput.style.height = '';
      }
      if (schPlugin) schPlugin.value = '';
      schWeekdays.forEach((input, index) => { input.checked = index === 0; });
      schMonthdays.forEach((input) => { input.checked = false; });
      if (schLastday) schLastday.checked = false;
      if (schStartDate) schStartDate.value = '';
      if (schEndDate) schEndDate.value = '';
      if (schRunAt) schRunAt.value = '';
      if (schCustomRule) schCustomRule.value = '';
      state = { mode: 'chat', goal: '', acceptance: '' };
      closeChooser(); paint();
      if (o.input) o.input.focus();
    });
    if (acceptanceInput) acceptanceInput.addEventListener('input', () => {
      state.acceptance = multiline(acceptanceInput.value, 1600);
      fitAcceptance();
    });
    if (chooser) {
      chooser.addEventListener('click', (event) => event.stopPropagation());
      chooser.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { event.preventDefault(); closeChooser(true); }
      });
    }
    document.addEventListener('click', () => closeChooser());
    paint();
    return {
      current,
      reset() {
        if (acceptanceInput) {
          acceptanceInput.value = '';
          acceptanceInput.style.height = '';
        }
        if (schPlugin) schPlugin.value = '';
        schWeekdays.forEach((input, index) => { input.checked = index === 0; });
        schMonthdays.forEach((input) => { input.checked = false; });
        if (schLastday) schLastday.checked = false;
        if (schStartDate) schStartDate.value = '';
        if (schEndDate) schEndDate.value = '';
        if (schRunAt) schRunAt.value = '';
        if (schCustomRule) schCustomRule.value = '';
        state = { mode: 'chat', goal: '', acceptance: '' };
        closeChooser(); paint();
      },
      editGoal() { setMode('goal'); },
      setMode,
    };
  }

  function showGoal(node, raw, prefix, runtime) {
    if (!node) return;
    const p = prefix || 'nchat';
    const value = normalize(raw || {});
    const railNode = node.querySelector('#' + p + 'IntentRail');
    if (!railNode) return;
    const active = value.mode === 'goal';
    railNode.classList.toggle('show', active);
    railNode.classList.remove('task');
    const state = runtime || {};
    const key = !active ? '' : state.paused ? 'paused' : state.failed ? 'blocked'
      : state.busy ? 'running' : state.ready ? 'ready' : 'recorded';
    railNode.dataset.state = key;
    const progress = phaseView(state);
    const label = node.querySelector('#' + p + 'IntentLabel');
    const stage = node.querySelector('#' + p + 'IntentStage');
    const summary = node.querySelector('#' + p + 'IntentSummary');
    const phase = node.querySelector('#' + p + 'IntentPhase');
    const steps = node.querySelector('#' + p + 'IntentSteps');
    const toggle = node.querySelector('#' + p + 'IntentToggle');
    const panel = node.querySelector('#' + p + 'IntentPanel');
    const pause = node.querySelector('#' + p + 'IntentPause');
    const resume = node.querySelector('#' + p + 'IntentResume');
    const statusLabel = key === 'paused' ? '目标已暂停'
      : key === 'blocked' ? '目标暂时受阻' : key === 'running' ? '目标循环中'
        : key === 'ready' ? '目标已完成' : '目标已记录';
    if (label) label.textContent = !active ? '' : statusLabel;
    if (stage) stage.textContent = !active ? '' : progress.total
      ? ('第 ' + progress.current + ' / ' + progress.total + ' 步 · ' + progress.phase.label) : statusLabel;
    if (phase) phase.textContent = progress.phase ? progress.phase.label : statusLabel;
    if (summary) {
      const count = acceptanceItems(value.acceptance).length;
      const counted = count ? count + ' 项完成标准' : '目标';
      summary.textContent = !active ? '' : key === 'paused'
        ? (state.detail || '当前进度已保留，等你决定是否继续')
        : key === 'blocked' ? (state.detail || '本轮未形成可用结果，可调整后继续')
          : key === 'running' ? (state.detail || '正在按' + counted + '执行与自检')
            : key === 'ready' ? (state.detail || counted + '已完成；后续可正常对话')
              : counted + '已写入工作记忆';
    }
    if (steps) {
      const stateText = {
        completed: '已完成', running: '进行中', paused: '已暂停', blocked: '受阻', pending: '',
      };
      steps.innerHTML = progress.rows.map((item, index) => '<li class="is-' + item.state + '">' +
        '<span class="wi-step-mark" aria-hidden="true">' +
          (item.state === 'completed' ? '✓' : String(index + 1)) + '</span>' +
        "<span>" + esc(item.label) + '</span><i>' + (stateText[item.state] || '') + '</i></li>').join('');
    }
    const ratio = progress.total ? progress.completed / progress.total : 0;
    railNode.style.setProperty('--wi-progress', Math.round((state.ready ? 1 : ratio) * 360) + 'deg');
    const actionPending = Boolean(state.actionPending);
    if (pause) {
      pause.hidden = !(active && key === 'running');
      pause.disabled = actionPending;
      pause.onclick = !pause.hidden && typeof state.onPause === 'function'
        ? (event) => {
            event.preventDefault(); event.stopPropagation(); state.onPause();
          } : null;
    }
    if (resume) {
      resume.hidden = !(active && (key === 'paused' || (key === 'blocked' && state.canContinue === true)));
      resume.disabled = actionPending || state.canContinue === false;
      resume.title = state.canContinue === false ? '正在安全停止，请稍候'
        : key === 'blocked' ? '继续修复并重新验证' : '继续完成目标';
      resume.setAttribute('aria-label', resume.title);
      resume.onclick = !resume.hidden && !resume.disabled && typeof state.onResume === 'function'
        ? (event) => {
            event.preventDefault(); event.stopPropagation(); state.onResume();
          } : null;
    }
    if (!active && panel) {
      panel.hidden = true;
      railNode.classList.remove('open');
      if (toggle) toggle.setAttribute('aria-expanded', 'false');
    }
    if (toggle && panel && !railNode.dataset.progressBound) {
      railNode.dataset.progressBound = '1';
      toggle.onclick = (event) => {
        event.preventDefault(); event.stopPropagation();
        const open = !railNode.classList.contains('open');
        railNode.classList.toggle('open', open);
        toggle.setAttribute('aria-expanded', String(open));
        panel.hidden = !open;
      };
      railNode.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || panel.hidden) return;
        panel.hidden = true; railNode.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false'); toggle.focus();
      });
    }
    const clear = node.querySelector('#' + p + 'IntentClear');
    if (clear) {
      clear.hidden = !active;
      clear.disabled = actionPending;
      clear.onclick = active && !actionPending && typeof state.onClear === 'function'
        ? (event) => {
            event.preventDefault(); event.stopPropagation();
            if (panel) panel.hidden = true;
            railNode.classList.remove('open');
            if (toggle) toggle.setAttribute('aria-expanded', 'false');
            state.onClear();
          } : null;
    }
  }

  return { normalize, acceptanceItems, longMessage, userMessage,
    controls, rail, surface, mount, showGoal, phaseView, icons: ICONS };
});
