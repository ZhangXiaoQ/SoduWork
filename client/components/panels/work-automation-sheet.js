/*
 * Conversation automation sheets share PluginUIHost with requirement forms and reuse the
 * schedules contract for timezones, Runner preflight, permissions, retries, and personal
 * plugin versions.
 */
(function (global) {
  'use strict';

  const EVERY = [
    ['daily', '每天'],
    ['weekly', '每周'],
    ['monthly', '每月'],
    ['hourly', '每小时'],
    ['once', '指定日期时间 · 仅一次'],
    ['custom', '自定义'],
  ];
  const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const MONTH_DAYS = Array.from({ length: 31 }, (_, index) => index + 1);
  const CAPABILITIES = [
    ['browser', '浏览网页', '优先读取网页结构，适合查询、巡检与填报'],
    ['computer', '操作电脑', '网页无法结构化操作时，使用鼠标键盘完成'],
    ['office', '办公文档', '读取或生成 Word、Excel、PowerPoint'],
  ];
  let state = {
    surface: null, layer: null, seed: {}, proposal: null,
    agents: [], repos: [], methods: [], modelOptions: [], defaultModel: '', agentReason: '',
    seq: 0, saved: false, saving: false, createdId: '',
  };
  let identityEpoch = 0;
  let refineTail = Promise.resolve();
  let refineScope = 0;
  let probeTimer = 0;
  let probeSeq = 0;
  let cardController, releaseCard;
  const cards = () => cardController ||= global.WorkAutomationCardState.create(() => String(global.SoduWorkAPI?.taskStorageKey?.('ops') || ''));
  const updateCard = patch => state.card && cards().update(state.card, patch, state.seed);
  function hasSurface() { return Boolean(state.layer); }
  function showLoading(body, text) {
    global.ForwardSelect?.destroy(body);
    body.innerHTML = '<div class="waz-loading"><i></i><i></i><i></i><span>' + esc(text) + '</span></div>';
  }
  function capture() {
    if (!state.card) return null;
    if (!state.card.pending && !state.saved && !state.card.snapshot.uncertain && state.layer?.querySelector('#wazForm')) {
      state.proposal = valueFromForm(); updateCard({ proposal: state.proposal });
    }
    return cards().capture(state.card);
  }
  function paintCard() {
    if (!state.layer || !state.card) return;
    const snapshot = cards().capture(state.card), body = state.layer.querySelector('#wazBody');
    state.proposal = snapshot.proposal; state.saved = snapshot.phase === 'succeeded';
    state.saving = snapshot.phase === 'submitting'; state.createdId = snapshot.createdId || '';
    if (state.saved) return renderSaved(snapshot.receipt || snapshot.proposal);
    if (snapshot.phase === 'loading') { showLoading(body, '正在整理自动化，请稍候…'); return; }
    if (!snapshot.proposal) {
      global.ForwardSelect?.destroy(body);
      body.innerHTML = '<div class="waz-error">' + esc(snapshot.error) + '</div><button class="waz-button" data-waz-reparse>重新整理</button>'; return;
    }
    render(snapshot.error);
    if (state.saving) state.layer.querySelectorAll('button,input,textarea,select').forEach(node => { node.disabled = true; });
    if (state.saving || snapshot.uncertain) {
      const button = state.layer.querySelector('[data-waz-save]'); button.disabled = true;
      button.textContent = state.saving ? '正在创建…' : '请先确认创建结果';
    }
    if (snapshot.uncertain) body.insertAdjacentHTML('beforeend', '<button class="waz-button" data-waz-open>查看自动化</button>');
  }

  const esc = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const tx = value => (global.SoduWorkI18n && typeof global.SoduWorkI18n.translateText === 'function')
    ? global.SoduWorkI18n.translateText(value) : value;
  const cut = (value, max) => String(value || '').trim().slice(0, max);
  const fullText = value => String(value == null ? '' : value);
  const checks = (value) => Array.isArray(value)
    ? value.map(item => fullText(item).trim()).filter(Boolean)
    : String(value || '').split(/\r?\n/).map(item =>
      fullText(item.replace(/^\s*(?:[-*•·]\s*|\d+\s*[.)、]\s*)/, '')).trim()).filter(Boolean);
  const errorText = (error) => {
    if (typeof global._humanErr === 'function') return global._humanErr(error, '自动化没有创建成功');
    return String((error && error.message) || error || '自动化没有创建成功');
  };

  function timeZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'; }
    catch (_) { return 'Asia/Shanghai'; }
  }

  function resetRefineQueue() {
    refineScope += 1;
    refineTail = Promise.resolve();
  }

  function methodByKey(key, catalogs = state) {
    return catalogs.methods.find(item => String(item.key || '') === String(key || '')) || null;
  }

  function methodCaps(method) {
    if (typeof _schmCaps === 'function') return _schmCaps(method);
    return ((((method || {}).capabilities || {}).runtime) || [])
      .filter(key => CAPABILITIES.some(item => item[0] === key));
  }

  function proposalOf(raw, fallback, previous, sourceText) {
    const context = arguments[4] || state;
    const parsed = raw || {};
    const prior = previous || {};
    const original = fullText(sourceText == null ? fallback : sourceText);
    // The editable instructions remain the source of truth for detailed requests.
    // A short parser summary cannot replace long or conversation-derived source.
    const preserveSource = !prior.note && (Array.from(original).length > 1500 || context.seed.conversationContext?.text);
    const rhythm = global.ScheduleTiming.infer(global.WorkAutomationBindings.directiveText(fallback), prior);
    const acceptance = checks(parsed.acceptanceCriteria || parsed.checklist || prior.acceptance);
    const next = Object.assign({}, prior, rhythm, {
      title: cut(parsed.title || prior.title || fallback, 60),
      note: preserveSource ? original : fullText(parsed.note || parsed.description || prior.note || original),
      acceptance,
      timeZone: rhythm.timeZone || prior.timeZone || timeZone(),
      assigneeId: prior.assigneeId || (((context.agents.find(item => item.available !== false)) || context.agents[0] || {}).id || ''),
      repoId: prior.repoId || '',
      flow: Boolean(prior.flow),
      personalPluginKey: prior.personalPluginKey || '',
      pluginInputs: Object.assign({}, prior.pluginInputs || {}),
      modelName: cut(parsed.modelName || prior.modelName || context.defaultModel || '', 300),
      requiredCapabilities: [...new Set(prior.requiredCapabilities || [])],
      retryLimit: Number.isFinite(Number(prior.retryLimit)) ? Number(prior.retryLimit) : 2,
      retryDelayMinutes: Number(prior.retryDelayMinutes || 5),
      enabled: prior.enabled !== false,
    });
    return global.WorkAutomationBindings.resolve(parsed, fallback, next, context);
  }

  const loadExecutionOptions = seed => global.WorkAutomationCardState.loadOptions(seed);

  function attachmentHtml() {
    const rows = (state.seed.attachmentContext || []).filter(Boolean);
    if (!rows.length) return '';
    return '<div class="waz-materials"><span>理解材料</span><b>' + rows.length +
      ' 份</b><small>用于完善本次自动化说明；周期运行时只使用已配置的系统与工作目录</small></div>';
  }

  function mount(seed) {
    const s = seed || {};
    let releaseDialog;
    const prompt = s.text ? '【自动化】：' + String(s.text).trim() : '';
    const surface = PluginUIHost.mount({
      id: 'work-automation', host: s.host, anchor: s.anchor,
      className: 'waz-plugin-surface', prompt,
      onDestroy: () => {
        global.ForwardSelect?.destroy(surface.content);
        releaseDialog?.();
      },
    });
    const node = document.createElement('div');
    node.className = 'waz-layer';
    node.innerHTML =
      '<section class="waz-sheet" role="group" aria-labelledby="wazTitle">' +
        '<header class="waz-head"><div class="waz-head-icon">' +
          '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/>' +
          '<path d="M12 7v5l3.3 2M4.5 4.5l2 2M19.5 4.5l-2 2"/></svg></div>' +
          '<div><span data-i18n="eyebrow.automation">AUTOMATION</span><h2 id="wazTitle">创建自动化</h2>' +
          '<p>设定一次，按时交给 Agent 执行，过程和结果留在对话中</p></div>' +
          '<button type="button" class="waz-close" data-waz-close aria-label="关闭">' +
          '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></header>' +
        '<main class="waz-body" id="wazBody"></main></section>';
    surface.content.appendChild(node);
    node.addEventListener('click', onClick);
    node.addEventListener('input', onChange);
    node.addEventListener('change', onChange);
    state.surface = surface;
    state.layer = node;
    releaseDialog = global.WorkAutomationView.mountDialog(surface, () => { if (!state.saving) close(); });
    requestAnimationFrame(() => node.classList.add('entered'));
    return node.querySelector('#wazBody');
  }

  async function open(seed) {
    if (!global.PluginUIHost) throw new Error('插件表单宿主没有加载好');
    if (global.WorkEntrySheet && typeof WorkEntrySheet.close === 'function') {
      WorkEntrySheet.close(false, true);
    }
    close(true);
    resetRefineQueue();
    const s = seed || {};
    const seq = ++state.seq;
    state.seed = s;
    state.saved = false;
    state.proposal = null;
    const record = cards().open(s); state.card = record;
    const ticket = s.cardState ? null : cards().begin(record, 'loading', { proposal: null });
    const body = mount(s);
    const layer = state.layer;
    let ready = false;
    const visible = () => seq === state.seq && layer === state.layer && layer.isConnected;
    releaseCard = cards().subscribe(record, () => { if (ready && visible()) paintCard(); });
    showLoading(body, '正在整理执行节奏与完成边界');
    const model = typeof s.model === 'function' ? s.model() : (s.model || '');
    const instruction = String(s.parseText || s.text || '');
    const directive = String(s.instruction ?? s.text ?? '');
    const execution = loadExecutionOptions(s);
    const methods = typeof _schmLoad === 'function'
      ? Promise.resolve(_schmLoad()).catch(() => []) : Promise.resolve([]);
    const got = await Promise.all([execution, methods]);
    if (!cards().current(record)) return false;
    const context = { seed: s, agents: got[0]?.agents || [], repos: got[0]?.repos || [], methods: got[1] || [],
      modelOptions: got[0]?.modelOptions || [], defaultModel: got[0]?.defaultModel || '' };
    if (visible()) Object.assign(state, context, { agentReason: got[0]?.reason || '' });
    ready = true;
    // Restoration refreshes candidates only; preserve the original date and manual settings without invoking the model again.
    if (s.cardState) { if (visible()) paintCard(); return visible(); }
    if (!s.cardId && !visible()) { cards().finish(ticket, { phase: 'error', error: '表单已关闭' }); return false; }
    const options = global.WorkAutomationBindings.candidates(context, directive);
    let parseError = '';
    const parsed = instruction && global.SoduWorkAPI?.parseTaskText
      ? await SoduWorkAPI.parseTaskText(instruction, model, s.attachmentContext || [], options).catch(error => { parseError = errorText(error); return {}; }) : {};
    if (!cards().valid(ticket)) return false;
    const prior = global.WorkAutomationBindings.fromContext(s.proposal || {}, s.bindingContext, context);
    const proposal = proposalOf(parsed, directive, prior, instruction, context);
    parseError ||= parsed?._parseError || '';
    cards().finish(ticket, { phase: parseError ? 'error' : 'draft', proposal, error: parseError });
    return visible();
  }

  function agentRows(current) {
    /* Translate option labels while building them because options bypass global translation; preserve names and other data. */
    const _tx = value => (global.SoduWorkI18n && global.SoduWorkI18n.translateText)
      ? global.SoduWorkI18n.translateText(value) : value;
    const selected = String(current || '');
    if (state.proposal?.bindingIssues?.some(item => item.field === 'assigneeId')) {
      return '<option value="__waz_unresolved__" selected>请确认指定的执行底座</option>' +
        state.agents.map(item => '<option value="' + esc(item.id) + '">' + esc(item.name || item.id) + '</option>').join('');
    }
    const items = state.agents.slice();
    if (selected && !items.some(item => String(item.id) === selected)) {
      items.unshift({ id: selected, name: _tx('已保存的执行底座'), available: false });
    }
    if (!items.length) return '<option value="">' + esc(_tx('当前设备没有可选执行底座')) + '</option>';
    return items.map(item => {
      const suffix = [item.locationLabel, item.onlineSeats ? _tx(item.onlineSeats + ' 个在线席位') : '',
        item.available === false ? _tx('当前未就绪') : ''].filter(Boolean);
      return '<option value="' + esc(item.id) + '"' +
        (String(item.id) === selected ? ' selected' : '') + '>' +
        esc((item.name || item.id) + (suffix.length ? ' · ' + suffix.join(' · ') : '')) + '</option>';
    }).join('');
  }

  function agentById(id) {
    return state.agents.find(item => String(item.id) === String(id || '')) || null;
  }

  function modelEntries(current, agentId) {
    const agent = agentById(agentId);
    const selected = String(current || '').trim();
    if (agent && agent.modelPick === false && agent.nativeModelPick !== true) {
      return [{ name: '', label: tx('由底座自身管理模型') }];
    }
    const source = agent?.nativeModelPick ? agent.modelOptions : state.modelOptions;
    const rows = Array.isArray(source) ? source.slice() : [];
    const normalized = rows.map(raw => ({ name: String(raw?.name || raw?.id || raw || '').trim(),
      label: String(raw?.label || raw?.displayName || raw?.name || raw?.id || raw || '').trim() }))
      .filter(item => item.name);
    if (selected && !normalized.some(item => item.name === selected)) {
      normalized.unshift({ name: selected, label: selected + tx('（已保存，当前不可用）'), stale: true });
    }
    if (!normalized.length) return [{ name: '', label: tx('当前没有可用模型') }];
    if (!selected) normalized.unshift({ name: '', label: tx('请选择模型'), placeholder: true });
    return normalized;
  }

  function modelRows(current, agentId) {
    const selected = String(current || '').trim();
    return modelEntries(current, agentId).map(item => '<option value="' + esc(item.name) + '"' +
      (item.name === selected ? ' selected' : '') + (item.stale || item.placeholder ? ' disabled' : '') + '>' +
      esc(item.label || item.name) + '</option>').join('');
  }

  function modelField(current, agentId) {
    const agent = agentById(agentId);
    const managed = agent && agent.modelPick === false && agent.nativeModelPick !== true;
    const options = agent?.nativeModelPick ? agent.modelOptions : state.modelOptions;
    const disabled = Boolean(managed || ((!Array.isArray(options) || !options.length) && !current));
    const hint = managed ? tx('当前底座自行管理模型') : tx('模型与执行底座独立保存，每次自动化运行使用这里的选择');
    return '<label class="waz-field"><span>' + esc(tx('模型')) + ' <small>' + esc(tx('可独立选择')) + '</small></span>' +
      '<select name="modelName" aria-describedby="wazModelHint"' + (disabled ? ' disabled' : '') + '>' +
      modelRows(current, agentId) + '</select><small id="wazModelHint" class="waz-field-hint">' + esc(hint) + '</small></label>';
  }

  function refreshModelField(preferred) {
    const form = state.layer?.querySelector('#wazForm');
    const select = form?.elements.modelName;
    const agent = form?.elements.assigneeId;
    if (!select || !agent) return;
    const current = preferred !== undefined ? String(preferred || '').trim() : String(select.value || '').trim();
    select.replaceChildren(...modelEntries(current, agent.value).map(item => {
      const option = document.createElement('option'); option.value = item.name;
      option.textContent = item.label || item.name; option.selected = item.name === current;
      option.disabled = Boolean(item.stale || item.placeholder); return option;
    }));
    const info = agentById(agent.value);
    const options = info?.nativeModelPick ? info.modelOptions : state.modelOptions;
    select.disabled = Boolean(info && info.modelPick === false && info.nativeModelPick !== true) ||
      ((!Array.isArray(options) || !options.length) && !current);
    select.value = current;
  }

  function selectedNumbers(value, max) {
    let source = [];
    if (Array.isArray(value)) source = value;
    else if (value != null && value !== '') source = [value];
    return [...new Set(source.map(item => Number(item)).filter(item => Number.isInteger(item) && item >= 1 && item <= max))]
      .sort((a, b) => a - b);
  }

  function timingFields(p) {
    const selectedWeekdays = selectedNumbers(p.weekdays?.length ? p.weekdays : p.weekday, 7);
    const selectedMonthDays = selectedNumbers(p.monthDays, 31);
    return '<div class="waz-timing-range" data-waz-range>' +
      '<div class="waz-field"><span>' + esc(tx('开始日期')) + ' <small>' + esc(tx('可选')) + '</small></span>' +
        '<input name="startDate" type="date" value="' + esc(p.startDate || '') + '" aria-label="' + esc(tx('开始日期')) + '"></div>' +
      '<div class="waz-field"><span>' + esc(tx('结束日期')) + ' <small>' + esc(tx('可选')) + '</small></span>' +
        '<input name="endDate" type="date" value="' + esc(p.endDate || '') + '" aria-label="' + esc(tx('结束日期')) + '"></div>' +
      '<small class="waz-range-hint">' + esc(tx('留空表示长期有效，结束日期包含当天')) + '</small></div>' +
      '<div class="waz-field waz-weekday-field" data-waz-weekday>' +
        '<span>' + esc(tx('星期')) + ' <small>' + esc(tx('可多选')) + '</small></span>' +
        '<div class="waz-choice-grid">' + WEEKDAYS.map((label, index) =>
          '<label><input type="checkbox" name="weekdays" value="' + (index + 1) + '"' +
          (selectedWeekdays.includes(index + 1) ? ' checked' : '') + '><span>' + esc(tx(label)) + '</span></label>').join('') +
        '</div><input type="hidden" name="weekday" value="' + (selectedWeekdays[0] || 1) + '"></div>' +
      '<div class="waz-field waz-monthday-field" data-waz-monthday>' +
        '<span>' + esc(tx('每月日期')) + ' <small>' + esc(tx('可多选')) + '</small></span>' +
        '<div class="waz-choice-grid waz-month-grid">' + MONTH_DAYS.map(day =>
          '<label><input type="checkbox" name="monthDays" value="' + day + '"' +
          (selectedMonthDays.includes(day) ? ' checked' : '') + '><span>' + String(day).padStart(2, '0') + '</span></label>').join('') +
        '</div><label class="waz-check waz-month-policy"><input type="checkbox" name="monthDayPolicy" value="last_day"' +
          (p.monthDayPolicy === 'last_day' ? ' checked' : '') + '><span>' + esc(tx('缺少日期时使用当月最后一天')) + '</span></label></div>' +
      '<div class="waz-field waz-custom-rule-field" data-waz-custom>' +
        '<span>' + esc(tx('自定义规则')) + ' <small>' + esc(tx('支持 iCalendar RRULE')) + '</small></span>' +
        '<textarea name="customRule" rows="4" maxlength="4096" spellcheck="false" data-user-content aria-label="' + esc(tx('自定义规则')) + '" placeholder="' +
          esc(global.ScheduleTiming.customExample(p.timeZone || timeZone())) + '">' +
          esc(p.customRule || '') + '</textarea>' +
        '<small>' + esc(tx('可使用 DTSTART 与 RRULE 精确指定开始时间、时区和重复规则')) + '</small>' +
        '<small>' + esc(tx('支持 HOURLY、DAILY、WEEKLY、MONTHLY，可设置 INTERVAL、COUNT 或 UNTIL')) + '</small>' +
        '<small>' + esc(tx('按天、周、月重复时，夏令时跳过的时刻顺延，重复时刻执行一次')) + '</small></div>';
  }

  function render(error) {
    const body = state.layer && state.layer.querySelector('#wazBody');
    if (!body) return;
    const restoreView = global.WorkAutomationView.rememberView(body);
    global.ForwardSelect?.destroy(body);
    const p = state.proposal || proposalOf({}, '');
    const method = methodByKey(p.personalPluginKey);
    const activeCaps = new Set((p.requiredCapabilities || []).concat(methodCaps(method)));
    body.innerHTML =
      '<form class="waz-form" id="wazForm"><div class="waz-fields">' +
        '<section class="waz-section"><div class="waz-section-title"><span>01</span><div>' +
          '<h3>每次要完成什么</h3><p>说明目标、输入来源、输出格式和完成标准</p></div></div>' +
          '<label class="waz-field waz-title"><span>自动化名称 <b>*</b></span>' +
            '<input name="title" maxlength="60" value="' + esc(p.title) +
            '" placeholder="例如：每天汇总团队进展"></label>' +
          '<label class="waz-field"><span>交代给 Agent 的话 <b>*</b></span>' +
            '<textarea name="note" rows="5" placeholder="每次触发时要做什么、从哪里取数据、输出到哪里">' +
            esc(p.note) + '</textarea></label>' +
          '<label class="waz-field"><span>完成标准 <small>每行一条</small></span>' +
            '<textarea name="acceptance" rows="3" placeholder="例如：生成简报并附异常证据">' +
            esc(checks(p.acceptance).join('\n')) + '</textarea></label>' + attachmentHtml() +
        '</section>' +
        '<section class="waz-section"><div class="waz-section-title"><span>02</span><div>' +
          '<h3>' + esc(tx('什么时候触发')) + '</h3><p>' + esc(tx('选择节奏，再设置日期范围、星期或日期和时间')) + '</p></div></div>' +
          '<div class="waz-grid waz-rhythm">' +
            '<label class="waz-field"><span>' + esc(tx('执行方式')) + '</span><select name="every">' +
              (!p.every ? '<option value="" selected>' + esc(tx('请选择执行方式')) + '</option>' : '') +
              EVERY.map(item => '<option value="' + item[0] + '"' +
                (item[0] === p.every ? ' selected' : '') + '>' + esc(tx(item[1])) + '</option>').join('') +
            '</select></label>' +
            '<label class="waz-field" data-waz-once><span>' + esc(tx('执行日期时间')) + ' <b>*</b></span>' +
              '<input name="runAt" type="datetime-local" step="60" value="' +
              esc(global.ScheduleTiming.localInput(p.runAt,p.timeZone || timeZone())) + '"></label>' +
            '<div class="waz-field" data-waz-clock><span>' + esc(tx('执行时刻')) + '</span><div class="waz-clock-selects" data-waz-time-selects>' +
              '<select name="clockHour" data-forward-select="compact-time" aria-label="' + esc(tx('小时')) + '">' + global.ScheduleTiming.clockOptions(24, p.atHour) + '</select>' +
              '<span aria-hidden="true">:</span><select name="clockMinute" data-forward-select="compact-time" aria-label="' + esc(tx('分钟')) + '">' +
              global.ScheduleTiming.clockOptions(60, p.atMinute) + '</select></div><small>' + esc(tx('选择小时和分钟')) + '</small></div>' +
            '<label class="waz-field" data-waz-minute><span>' + esc(tx('每小时第几分')) + '</span>' +
              '<select name="minute" data-forward-select="compact-time" aria-label="' + esc(tx('分钟')) + '">' + global.ScheduleTiming.clockOptions(60, p.atMinute) + '</select></label>' +
          '</div>' + timingFields(p) +
          '<div class="waz-timezone"><i></i><span data-waz-zone>' + esc(p.timeZone || timeZone()) +
          '</span><small id="wazNextRun">' + esc(tx('保存后由服务端计算下一次执行时间')) + '</small></div>' +
        '</section>' +
        '<section class="waz-section"><div class="waz-section-title"><span>03</span><div>' +
          '<h3>由谁、在哪里、按什么方法执行</h3><p>保存前会检查 Agent、Runner 与能力授权</p></div></div>' +
          '<div class="waz-grid">' +
            '<label class="waz-field"><span>执行底座 <b>*</b></span><select name="assigneeId"' +
              (!state.agents.length && !p.assigneeId ? ' disabled' : '') + '>' +
              agentRows(p.assigneeId) + '</select><small>' + esc(state.agentReason || (state.agents.length
                ? '运行时会在当前设备选择具备所需能力的可用席位'
                : '请打开 Agent 管理，确认 Runner 已启动并已连接当前环境')) + '</small>' +
              '<button type="button" class="waz-button" data-waz-reload-agents>刷新底座</button></label>' +
            modelField(p.modelName, p.assigneeId) +
            '<label class="waz-field"><span>关联工程 <small>可选</small></span><select name="repoId">' +
              global.WorkAutomationView.optionRows(state.repos, p.repoId, '不指定工程', p.bindingIssues?.some(item => item.field === 'repoId')) + '</select></label>' +
          '</div>' +
          '<label class="waz-field"><span>工作方法 <small>可选 · 固定当前版本</small></span>' +
            '<select name="personalPluginKey"><option value="">不用插件 · Agent 自由执行</option>' +
              (p.bindingIssues?.some(item => item.field === 'personalPluginKey') ? '<option value="__waz_unresolved__" selected>请确认指定的工作方法</option>' :
                p.personalPluginKey && !method ? '<option value="' + esc(p.personalPluginKey) + '" selected>已指定的插件不可用 · 请重新选择</option>' : '') +
              state.methods.map(item => '<option value="' + esc(item.key) + '"' +
                (String(item.key) === String(p.personalPluginKey || '') ? ' selected' : '') +
                '>' + esc(item.name) + ' · v' + esc(item.version || '') + '</option>').join('') +
            '</select></label>' + global.WorkAutomationView.methodFieldsHtml(method, p.pluginInputs || {}) +


          '<div class="waz-capabilities" hidden style="display:none"><span>本次运行需要的能力</span><div>' +
            CAPABILITIES.map(item => '<label class="' + (activeCaps.has(item[0]) ? 'on' : '') +
              '" title="' + esc(item[2]) + '"><input type="checkbox" name="capability" value="' +
              item[0] + '"' + (activeCaps.has(item[0]) ? ' checked' : '') +
              (methodCaps(method).includes(item[0]) ? ' disabled' : '') + '><i></i><b>' +
              item[1] + '</b></label>').join('') + '</div></div>' +
          '<div class="waz-grid waz-options">' +
            '<label class="waz-field"><span>失败重试</span><select name="retryLimit">' +
              [0, 1, 2, 3].map(value => '<option value="' + value + '"' +
                (Number(p.retryLimit) === value ? ' selected' : '') + '>' +
                (value ? value + ' 次' : '不重试') + '</option>').join('') + '</select></label>' +
            '<label class="waz-field"><span>重试间隔</span><select name="retryDelayMinutes">' +
              [2, 5, 10].map(value => '<option value="' + value + '"' +
                (Number(p.retryDelayMinutes) === value ? ' selected' : '') + '>间隔 ' +
                value + ' 分钟</option>').join('') + '</select></label>' +
          '</div>' +
          '<label class="waz-check waz-flow"><input type="checkbox" name="flow"' +
            (p.flow ? ' checked' : '') + (p.repoId ? '' : ' disabled') +
            '><span>工程任务按研发流程执行<small>未指定工程时不启用</small></span></label>' +
        '</section>' +
        '</div><div class="waz-actions"><div class="waz-feedback"><div class="waz-probe waiting" id="wazProbe"><i></i><div><b>正在检查执行条件…</b>' +
          '<small>Agent、Runner、权限和插件版本会在这里一次说清</small></div></div>' +
        '<div class="waz-error" id="wazError" role="alert"' + (error ? '' : ' hidden') + '>' +
          esc(error || '') + '</div></div>' +
        '<footer class="waz-foot"><label class="waz-enable"><input type="checkbox" name="enabled"' +
          (p.enabled !== false ? ' checked' : '') + '><span><b>创建后启用</b>' +
          '<small>关闭时只保存，不会自动运行</small></span></label>' +
          '<button type="button" class="waz-button primary" data-waz-save' +
          ((state.agents.length || p.assigneeId) ? '' : ' disabled') + '>创建自动化</button></footer>' +
      '</div></form>';
    paintRhythm();
    if (global.ForwardSelect) body.querySelectorAll('[data-waz-time-selects], [data-waz-minute]').forEach(root =>
      global.ForwardSelect.enhance(root));
    restoreView();
    if (!state.saving && !state.card?.snapshot.uncertain) scheduleProbe();
  }

  function methodInputs(form) {
    const values = {};
    form.querySelectorAll('[data-waz-method-input]').forEach(input => {
      const type = input.dataset.inputType;
      values[input.dataset.wazMethodInput] = type === 'boolean' ? input.checked :
        type === 'number' && input.value !== '' ? Number(input.value) : input.value;
    });
    return values;
  }

  function valueFromForm() {
    const form = state.layer && state.layer.querySelector('#wazForm');
    if (!form) return state.proposal || proposalOf({}, '');
    const data = new FormData(form);
    const clock = data.get('clockHour') != null
      ? [data.get('clockHour'), data.get('clockMinute')] : String(data.get('clock') || '').split(':');
    const every = String(data.get('every') || '');
    const zone = (state.proposal && state.proposal.timeZone) || timeZone();
    const dateInput = String(data.get('runAt') || '');
    const priorDate = state.proposal?.runAt || '';
    const selectedCaps = [...form.querySelectorAll('input[name=capability]:checked')]
      .filter(input => !input.disabled)
      .map(input => input.value);
    const selectedWeekdays = every === 'weekly' ? [...form.querySelectorAll('input[name=weekdays]:checked')]
      .map(input => Number(input.value)).filter(Number.isInteger).sort((a, b) => a - b) : [];
    const selectedMonthDays = every === 'monthly' ? [...form.querySelectorAll('input[name=monthDays]:checked')]
      .map(input => Number(input.value)).filter(Number.isInteger).sort((a, b) => a - b) : [];
    // Browser FormData intentionally omits disabled controls.  A model select
    // can be temporarily disabled while the execution catalog is refreshing;
    // keep the already selected value in the draft so a refresh/re-render does
    // not silently clear the model before the schedule is saved.
    const submittedModel = data.get('modelName');
    const modelName = submittedModel == null
      ? (state.proposal && state.proposal.modelName) : submittedModel;
    return {
      bindingIssues: (state.proposal?.bindingIssues || []).slice(),
      title: cut(data.get('title'), 60),
      note: fullText(data.get('note')),
      acceptance: checks(data.get('acceptance')),
      every,
      runAt: every !== 'once' ? null : dateInput === global.ScheduleTiming.localInput(priorDate,zone)
        ? priorDate : global.ScheduleTiming.fromLocalInput(dateInput,zone),
      atHour: every === 'hourly' ? 0 : global.ScheduleTiming.clockNumber(clock[0]),
      atMinute: global.ScheduleTiming.clockNumber(every === 'hourly' ? data.get('minute') : clock[1]),
      weekday: selectedWeekdays[0] || (every === 'weekly' ? null : Math.max(1, Math.min(7, Number(data.get('weekday')) || 1))),
      weekdays: selectedWeekdays,
      monthDays: selectedMonthDays,
      monthDayPolicy: (typeof form.querySelector === 'function' &&
        form.querySelector('input[name=monthDayPolicy]:checked')) ? 'last_day' : 'skip',
      startDate: String(data.get('startDate') || ''),
      endDate: String(data.get('endDate') || ''),
      ...(every === 'custom' ? { customRule: fullText(data.get('customRule')).trim() } : {}),
      timeZone: (state.proposal && state.proposal.timeZone) || timeZone(),
      assigneeId: cut(data.get('assigneeId'), 160),
      modelName: cut(modelName, 300),
      repoId: cut(data.get('repoId'), 80),
      flow: Boolean(data.get('flow')),
      personalPluginKey: cut(data.get('personalPluginKey'), 64),
      pluginInputs: methodInputs(form),
      // Method capabilities are derived in bodyOf, never persisted into the
      // editable extra capabilities or inherited by the next selected method.
      requiredCapabilities: selectedCaps,
      retryLimit: Math.max(0, Math.min(3, Number(data.get('retryLimit')) || 0)),
      retryDelayMinutes: Math.max(2, Math.min(10, Number(data.get('retryDelayMinutes')) || 5)),
      enabled: Boolean(data.get('enabled')),
    };
  }

  function bodyOf(value, catalogs = state) {
    const bindingError = global.WorkAutomationBindings.validate(value, catalogs);
    if (bindingError) throw new Error(bindingError);
    const method = methodByKey(value.personalPluginKey, catalogs);
    const criteria = checks(value.acceptance);
    const note = value.note + (criteria.length
      ? '\n\n完成标准：\n' + criteria.map(item => '- ' + item).join('\n') : '');
    if (note.length > 50000) throw new Error('自动化说明与完成标准合计最多 50000 个字符，请缩短后重试；内容未截断。');
    return {
      title: value.title,
      note: fullText(note),
      every: value.every,
      runAt: value.every === 'once' ? value.runAt : null,
      atHour: value.atHour,
      atMinute: value.atMinute,
      weekday: value.weekday,
      weekdays: Array.isArray(value.weekdays) ? value.weekdays :
        (value.every === 'weekly' ? global.ScheduleTiming.cleanList(value.weekday, 1, 7) : []),
      monthDays: value.monthDays || [],
      monthDayPolicy: value.monthDayPolicy || 'skip',
      startDate: value.every === 'once' || value.every === 'custom' ? null : value.startDate || null,
      endDate: value.every === 'once' || value.every === 'custom' ? null : value.endDate || null,
      ...(value.every === 'custom' ? { customRule: fullText(value.customRule).trim() } : {}),
      timeZone: value.timeZone || timeZone(),
      assigneeId: value.assigneeId,
      assigneeType: 'agent',
      modelName: value.modelName || '',
      repoId: value.repoId || '',
      flow: Boolean(value.repoId && value.flow),
      pluginBindingId: '',
      personalPluginKey: method ? String(method.key || '') : '',
      personalPluginVersionPolicy: method ? 'pinned' : 'latest',
      personalPluginVersion: method ? String(method.version || '') : '',
      personalPluginChecksum: method ? String(method.checksum || '') : '',
      pluginInputs: method ? Object.assign({}, value.pluginInputs || {}) : {},
      requiredCapabilities: [...new Set((value.requiredCapabilities || []).concat(methodCaps(method)))],
      retryLimit: value.retryLimit,
      retryDelayMinutes: value.retryDelayMinutes,
      enabled: value.enabled !== false,
    };
  }

  function paintRhythm() {
    const form = state.layer && state.layer.querySelector('#wazForm');
    if (!form) return;
    const every = form.elements.every.value;
    const weekday = form.querySelector('[data-waz-weekday]');
    const clock = form.querySelector('[data-waz-clock]');
    const minute = form.querySelector('[data-waz-minute]');
    const once = form.querySelector('[data-waz-once]');
    const range = form.querySelector('[data-waz-range]');
    const monthdays = form.querySelector('[data-waz-monthday]');
    const customRule = form.querySelector('[data-waz-custom]');
    if (range) range.hidden = every === 'once' || every === 'custom';
    if (weekday) weekday.hidden = every !== 'weekly';
    if (monthdays) monthdays.hidden = every !== 'monthly';
    if (customRule) customRule.hidden = every !== 'custom';
    if (clock) clock.hidden = every === 'hourly' || every === 'once' || every === 'custom';
    if (minute) minute.hidden = every !== 'hourly';
    if (once) once.hidden = every !== 'once';
    const hint = form.querySelector('#wazNextRun');
    const currentTiming = valueFromForm();
    const timingError = global.ScheduleTiming.validate(currentTiming);
    const zone = form.querySelector('[data-waz-zone]');
    if (zone) zone.textContent = every === 'custom'
      ? global.ScheduleTiming.customTimeZone(currentTiming.customRule, currentTiming.timeZone) : currentTiming.timeZone;
    if (hint) hint.toggleAttribute?.('data-custom-preview', every === 'custom');
    if (hint) hint.textContent = timingError ? tx(timingError) : every === 'once'
      ? tx('在指定时间触发一次，失败按下方设置重试')
      : tx('保存后由服务端计算下一次执行时间');
    const flow = form.elements.flow;
    if (flow) {
      flow.disabled = !form.elements.repoId.value;
      if (flow.disabled) flow.checked = false;
    }
  }

  function setProbe(kind, title, detail, remedy) {
    const line = state.layer && state.layer.querySelector('#wazProbe');
    if (!line) return;
    line.className = 'waz-probe ' + (kind || 'waiting');
    line.querySelector('b').textContent = title || '执行条件待确认';
    const small = line.querySelector('small');
    small.textContent = detail || '';
    if (remedy && kind !== 'ready' && kind !== 'blocked') {
      /* Link missing authorization or engine errors to Runner management. */
      const fix = document.createElement('button');
      fix.type = 'button';
      fix.className = 'btn-mini';
      fix.textContent = '去处理';
      fix.addEventListener('click', () => {
        if (typeof global.openAgentsPanel === 'function') global.openAgentsPanel({ tab: 'runners' });
        else if (typeof global.openAgentsEntry === 'function') global.openAgentsEntry();
      });
      small.appendChild(document.createTextNode(' '));
      small.appendChild(fix);
    }
  }

  function scheduleProbe() {
    clearTimeout(probeTimer);
    const seq = ++probeSeq;
    const value = valueFromForm();
    state.proposal = value;
    if (!state.card?.pending && !state.card?.snapshot.uncertain) updateCard({ proposal: value });
    const bindingError = global.WorkAutomationBindings.validate(value, state);
    if (bindingError) { setProbe('blocked', '指定内容需要确认', bindingError); return; }
    const timingError = global.ScheduleTiming.validate(value);
    if (timingError) { setProbe('blocked', '执行时间需要确认', timingError); return; }
    if (!value.assigneeId) {
      setProbe('blocked', '还没有可用的执行 Agent', '先在 Agent 管理中安装并探测一个可运行底座');
      return;
    }
    if (!global.SoduWorkAPI || !SoduWorkAPI.preflightSchedule) {
      setProbe('waiting', '保存时会检查执行条件', '当前版本不支持就地预检');
      return;
    }
    setProbe('checking', '正在检查执行条件…', 'Agent、Runner、权限和插件版本');
    probeTimer = setTimeout(async () => {
      try {
        const result = await SoduWorkAPI.preflightSchedule(bodyOf(value));
        if (seq !== probeSeq || !state.layer) return;
        const details = (result.checks || []).map(item => item.label).filter(Boolean).join(' · ');
        setProbe(result.state || 'waiting', result.message || '执行条件待确认', details, result.remedy);
        if (value.every === 'custom') {
          const nextRun = state.layer.querySelector('#wazNextRun');
          if (nextRun) nextRun.textContent = tx(global.ScheduleTiming.customPreview(result, value.timeZone));
        }
      } catch (error) {
        if (seq !== probeSeq || !state.layer) return;
        setProbe('waiting', errorText(error), '自动化仍可保存，运行前请确认服务连接');
      }
    }, 280);
  }

  function showError(message) {
    const node = state.layer && state.layer.querySelector('#wazError');
    if (!node) return;
    node.textContent = message || '';
    node.hidden = !message;
  }

  function validate(value, catalogs = state) {
    const bindingError = global.WorkAutomationBindings.validate(value, catalogs);
    if (bindingError) return bindingError;
    const timingError = global.ScheduleTiming.validate(value);
    if (timingError) return timingError;
    if (!value.title) return '先给自动化起一个能看懂的名字';
    if (!String(value.note || '').trim()) return '请写清楚每次触发后要完成什么';
    if (!value.assigneeId) return '还没有可用的执行 Agent';
    const method = methodByKey(value.personalPluginKey, catalogs);
    if (method) {
      const missing = (method.inputs || []).filter(field => field.required &&
        (value.pluginInputs[field.key] == null || value.pluginInputs[field.key] === ''))
        .map(field => field.label || field.key);
      if (missing.length) return '工作方法还缺少参数：' + missing.join('、');
    }
    return '';
  }

  async function save() {
    if (!state.layer || state.saved || state.saving || state.card?.pending || state.card?.snapshot.uncertain) return;
    const value = valueFromForm();
    const invalid = validate(value);
    if (invalid) {
      updateCard({ phase: 'error', proposal: value, error: invalid });
      showError(invalid);
      if (value.every === 'custom' && global.ScheduleTiming.validate(value) === invalid) {
        state.layer?.querySelector('[name=customRule]')?.focus?.();
      }
      return;
    }
    const button = state.layer.querySelector('[data-waz-save]');
    const layer = state.layer, seq = state.seq, epoch = identityEpoch, seed = state.seed, record = state.card;
    const current = () => state.layer === layer && state.seq === seq && identityEpoch === epoch && layer.isConnected;
    const ticket = record ? cards().begin(record, 'submitting', { proposal: value }) : null;
    const owned = () => epoch === identityEpoch && (!ticket || cards().valid(ticket));
    // Capture form values before disabling controls; FormData omits disabled fields when a conversation switch persists the sheet.
    state.proposal = value;
    state.saving = true; ++probeSeq; clearTimeout(probeTimer);
    const controls = [...layer.querySelectorAll('button,input,textarea,select')];
    const disabled = controls.map(node => node.disabled);
    controls.forEach(node => { node.disabled = true; });
    button.disabled = true;
    button.textContent = '正在预检…';
    showError('');
    let creating = false;
    try {
      const body = bodyOf(value);
      if (SoduWorkAPI.preflightSchedule) {
        const preflight = await SoduWorkAPI.preflightSchedule(body, { force: true });
        if (!owned()) return;
        if (current() && preflight) setProbe(preflight.state || 'waiting', preflight.message || '执行条件待确认',
          (preflight.checks || []).map(item => item.label).filter(Boolean).join(' · '), preflight.remedy);
        if (preflight && preflight.state === 'blocked') {
          throw new Error(preflight.message || '执行条件尚未满足');
        }
      }
      // Persist the submitting state in the original conversation before sending to prevent an in-flight request from being resent as a draft.
      await seed.onBeforeSubmit?.(record ? cards().capture(record) : null);
      if (!owned()) return;
      button.textContent = '正在创建…';
      creating = true;
      const saved = await SoduWorkAPI.createSchedule(body);
      if (!owned()) return;
      if (ticket) cards().finish(ticket, { phase: 'succeeded', proposal: value, receipt: saved || body, createdId: String(saved?.id || '') });
      // Update persistent cards through their receipt without invoking callbacks for departed views. Standalone entry retains its delivery notification.
      if ((!seed.cardId || current()) && typeof seed.onCreated === 'function') seed.onCreated(saved || body);
      if (current()) {
        state.saved = true; state.createdId = String(saved?.id || ''); state.proposal = value;
        renderSaved(saved || body); global.petSay?.('自动化已创建，到点会自己交给 AI 执行');
      }
    } catch (error) {
      if (ticket && owned()) cards().finish(ticket, { phase: 'error', proposal: value, uncertain: creating,
        error: errorText(error) + (creating ? '；创建结果尚未确认，请先到自动化管理中查询，避免重复创建。' : '') });
      if (!current()) return;
      if (!ticket) { showError(errorText(error)); button.disabled = false; button.textContent = '创建自动化'; }
    } finally {
      if (current()) {
        state.saving = false;
        controls.forEach((node, index) => { node.disabled = disabled[index]; });
      }
    }
  }

  function renderSaved(saved) {
    const body = state.layer?.querySelector('#wazBody'), value = state.proposal || saved;
    if (body) {
      global.ForwardSelect?.destroy(body);
      body.innerHTML = global.WorkAutomationCardState.savedHtml(value,
        state.agents.find(item => String(item.id) === String(value.assigneeId)), methodByKey(value.personalPluginKey), esc);
    }
  }

  function onClick(event) {
    if (state.saving) return;
    if (event.target.closest('[data-waz-reparse]')) { void open({ ...state.seed, cardState: null }); return; }
    const reload = event.target.closest('[data-waz-reload-agents]');
    if (reload) { void refreshAgents(reload); return; }
    if (event.target.closest('[data-waz-close]')) { close(); return; }
    if (event.target.closest('[data-waz-save]')) { save(); return; }
    if (event.target.closest('[data-waz-open]')) {
      const options = {scheduleId: state.createdId};
      close(true);
      if (typeof global.openSchedulesEntry === 'function') global.openSchedulesEntry(options);
      else if (typeof global.openSchedulePanel === 'function') openSchedulePanel(options);
    }
  }

  async function refreshAgents(button) {
    const layer = state.layer, seq = state.seq;
    button.disabled = true;
    try {
      const result = await loadExecutionOptions({ text: valueFromForm().note });
      if (layer !== state.layer || seq !== state.seq || state.saved || state.saving) return;
      state.proposal = valueFromForm();
      state.agents = result.agents;
      state.modelOptions = result.modelOptions || [];
      state.defaultModel = result.defaultModel || '';
      state.agentReason = result.reason;
      if (!state.proposal.assigneeId) state.proposal.assigneeId =
        (state.agents.find(item => item.available !== false) || state.agents[0] || {}).id || '';
      render();
    } finally { button.disabled = false; }
  }

  function onChange(event) {
    if (state.saving) return;
    const form = event.target.closest('#wazForm');
    if (!form) return;
    // A native select emits input before change; keep it connected until the
    // change confirms a previously unresolved method selection.
    if (event.target.name === 'personalPluginKey' && event.type !== 'change') return;
    showError('');
    if (!state.card?.snapshot.uncertain) updateCard({ phase: 'draft', error: '' });
    if (event.type === 'change' && ['personalPluginKey', 'repoId', 'assigneeId', 'every'].includes(event.target.name)) {
      state.proposal.bindingIssues = (state.proposal.bindingIssues || []).filter(item => item.field !== event.target.name);
    }
    if (event.target.name === 'personalPluginKey') {
      state.proposal = valueFromForm();
      state.proposal.personalPluginKey = event.target.value;
      state.proposal.pluginInputs = {};
      render();
      return;
    }
    if (event.target.name === 'assigneeId' && event.type === 'change') {
      const value = valueFromForm();
      refreshModelField('');
      state.proposal = { ...value, modelName: '' };
    }
    paintRhythm();
    scheduleProbe();
  }

  function active() {
    if (!state.layer || !state.layer.isConnected || state.saved || state.saving) return null;
    return { mode: 'automation', actionId: 'work.automation.create' };
  }

  async function refineNow(change, options) {
    if (!active() || !change.trim()) return false;
    const layer = state.layer, seq = state.seq;
    const before = valueFromForm();
    const seed = state.seed, record = state.card;
    const context = { seed, agents: state.agents.slice(), repos: state.repos.slice(), methods: state.methods.slice() };
    const ticket = record ? cards().begin(record, 'loading', { proposal: before }) : null;
    if (record && !ticket) return false;
    if (global.PluginUIHost && typeof PluginUIHost.checkpointCurrent === 'function') {
      PluginUIHost.checkpointCurrent({
        label: '自动化表单', title: cut(before.title || '自动化', 120), prompt: change,
      });
    }
    const body = state.layer.querySelector('#wazBody');
    showLoading(body, '正在按补充内容更新自动化');
    const source = options || {};
    const directive = fullText(source.instruction ?? change);
    const previousAttachments = state.seed.attachmentContext;
    if (Array.isArray(source.attachmentContext) && source.attachmentContext.length) {
      state.seed.attachmentContext = source.attachmentContext.slice();
    }
    const configuredModel = source.model != null ? source.model : state.seed.model;
    const model = typeof configuredModel === 'function' ? configuredModel() : (configuredModel || '');
    let parsed = {};
    if (global.SoduWorkAPI && SoduWorkAPI.parseTaskText) {
      parsed = await SoduWorkAPI.parseTaskText(
        global.WorkAutomationBindings.refinePrompt(before, change), model, state.seed.attachmentContext || [],
        global.WorkAutomationBindings.candidates(state, directive)).catch(() => ({}));
    }
    const current = () => state.layer === layer && seq === state.seq && !state.saved && !state.saving;
    if (ticket ? !cards().valid(ticket) : !current()) return false;
    if (!parsed || !Object.keys(parsed).length || parsed._parseError) {
      seed.attachmentContext = previousAttachments;
      const error = (parsed?._parseError ? errorText(parsed._parseError) + '；' : '') + '这次没有解析成功，补充内容已保留，请重试或直接修改表单。';
      if (ticket) cards().finish(ticket, { phase: 'error', proposal: before, error });
      else { state.proposal = before; render(error); }
      return false;
    }
    const merged = proposalOf(parsed, directive, before, change, context);
    if (Array.from(fullText(before.note)).length > 1500 || Array.from(change).length > 1500 ||
        source.conversationContext?.text || seed.conversationContext?.text) {
      merged.note = [fullText(before.note), '补充要求：\n' + change].filter(Boolean).join('\n\n');
    }
    if (ticket) cards().finish(ticket, { phase: 'draft', proposal: merged });
    else { state.proposal = merged; render(); }
    if (current() && typeof seed.onRefined === 'function') seed.onRefined(merged);
    return true;
  }

  function refine(text, options) {
    const change = fullText(text);
    if (!active() || !change.trim()) return Promise.resolve(false);
    const scope = refineScope;
    const run = refineTail.then(() => {
      if (scope !== refineScope) return false;
      return refineNow(change, options || {});
    }).catch(() => false);
    refineTail = run;
    return run;
  }

  function close(silent) {
    const snapshot = capture();
    releaseCard?.(); releaseCard = null;
    clearTimeout(probeTimer);
    probeSeq += 1;
    resetRefineQueue();
    const surface = state.surface;
    const layer = state.layer;
    const seed = state.seed;
    state.seq += 1;
    state.surface = null;
    state.layer = null;
    state.seed = {};
    state.proposal = null;
    state.saved = false;
    state.saving = false;
    state.createdId = '';
    state.card = null;
    if (layer) global.ForwardSelect?.destroy(layer);
    if (layer) layer.classList.remove('entered');
    if (surface) {
      if (silent || surface.inline) surface.destroy();
      else setTimeout(() => surface.destroy(), 120);
    }
    if (!silent) { seed.onCardClose?.(snapshot); seed.onClose?.(); }
  }

  global.WorkAutomationSheet = { open, active, refine, close };
  if (global.WorkAutomationSheet) Object.assign(global.WorkAutomationSheet, {
    draft: (parsed, text, prior, catalogs) => proposalOf(parsed, text, prior, text, catalogs), validate, bodyOf });
  if (global.WorkAutomationSheet) Object.assign(global.WorkAutomationSheet, { capture, hasSurface });
  global.addEventListener?.('soduwork-data-scope-changed', () => { identityEpoch++; cardController?.reset(); close(true); });

  if (global.PluginUIHost) {
    PluginUIHost.registerAction({
      id: 'work.automation.create', command: '自动化',
      aliases: ['自动化任务', '定时任务', '定时', '巡检', 'automation'],
      name: '创建自动化', icon: '自', badge: '内置表单', priority: 30,
      description: '按时间或周期交给 Agent 执行，在对话中查看过程、结果与异常',
      open: context => open(context),
    });
  }
})(window);
