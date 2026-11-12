/*
 * Schedule work methods include enterprise bindings and local personal plugins. Store
 * plugin keys and verifiable version snapshots; keep plugin bodies on the device. New
 * schedules pin versions, legacy schedules may follow latest. The owner Runner resolves
 * execution and obtains temporary device-scoped MCP grants.
 */

/* Enterprise plugins. */
let _schPluginCache = Object.create(null);
let _schPluginLoading = Object.create(null);

function _schHasInteractiveUi(item) {
  if (item?.jiyong && item.entrypoints?.automation) return false;
  return Boolean(item && item.ui && Array.isArray(item.ui.contributions) &&
    item.ui.contributions.length);
}

async function _schLoadPlugins(projectId, force) {
  // Keep this request attached to its original identity's cache objects.
  const cache = _schPluginCache, loading = _schPluginLoading;
  const key = String(projectId || '');
  if (!force && cache[key]) return cache[key];
  if (loading[key]) return loading[key];
  if (!SoduWorkAPI.automationPlugins) {
    cache[key] = [];
    return cache[key];
  }
  loading[key] = SoduWorkAPI.automationPlugins(key)
    .then(result => {
      const items = ((result && result.items) || []).filter(item =>
        item && item.entrypoints && item.entrypoints.automation && !_schHasInteractiveUi(item));
      cache[key] = items;
      return items;
    })
    .catch(() => {
      cache[key] = cache[key] || [];
      return cache[key];
    })
    .finally(() => { delete loading[key]; });
  return loading[key];
}

function _schPluginsForRepo(repoId) {
  return _schPluginCache[_schProjectId(repoId)] || _schPluginCache[''] || [];
}

function _schFindPlugin(bindingId) {
  for (const items of Object.values(_schPluginCache)) {
    const found = (items || []).find(item => item.bindingId === bindingId);
    if (found) return found;
  }
  return null;
}

/* Reuse public-input rendering for enterprise and personal plugins while keeping their value containers separate. */
function _schFieldHtml(field, values, attr) {
  const hasValue = Object.prototype.hasOwnProperty.call(values || {}, field.key);
  const value = hasValue ? values[field.key] : field.default;
  const help = field.description ? "<small data-user-content>" + esc(field.description) + '</small>' : '';
  if (field.type === 'boolean') {
    return '<label class="sch-plugin-check"><input type="checkbox" ' + attr + '="' +
      esc(field.key) + '" data-input-type="boolean"' + (value ? ' checked' : '') +
      '><span>' + esc(field.label) + (field.required ? ' *' : '') + help + '</span></label>';
  }
  if (field.type === 'select') {
    return '<label class="sch-plugin-field"><span>' + esc(field.label) +
      (field.required ? ' *' : '') + help + '</span><select class="sch-in" ' + attr + '="' +
      esc(field.key) + '" data-input-type="select"><option value="">请选择</option>' +
      (field.options || []).map(option => '<option value="' + esc(option.value) + '"' +
        (String(option.value) === String(value == null ? '' : value) ? ' selected' : '') + '>' +
        esc(option.label || option.value) + '</option>').join('') + '</select></label>';
  }
  const tag = field.type === 'textarea' ? 'textarea' : 'input';
  const inputType = field.type === 'number' ? 'number' : 'text';
  const close = tag === 'textarea' ? '>' + esc(value || '') + '</textarea>' :
    ' type="' + inputType + '"' + (inputType === 'number' ? ' step="any"' : '') +
    ' value="' + esc(value == null ? '' : value) + '">';
  return '<label class="sch-plugin-field"><span>' + esc(field.label) +
    (field.required ? ' *' : '') + help + '</span><' + tag +
    ' class="sch-in" ' + attr + '="' + esc(field.key) + '" data-input-type="' +
    esc(field.type) + '" placeholder="' + esc(field.placeholder || '') + '"' + close + '</label>';
}

function _schPluginConfigHtml(repoId, bindingId, values) {
  const items = _schPluginsForRepo(repoId);
  const selected = items.find(item => item.bindingId === bindingId) || _schFindPlugin(bindingId);
  let options = '<option value="">选择一个自动化插件</option>';
  options += items.map(item => '<option value="' + esc(item.bindingId) + '"' +
    (item.bindingId === bindingId ? ' selected' : '') +
    (!item.runnable ? ' disabled' : '') + '>' + esc(item.name) +
    (item.projectSpecific ? ' · 当前项目' : '') + (!item.runnable ? ' · 待配置' : '') +
    '</option>').join('');
  if (bindingId && !items.some(item => item.bindingId === bindingId)) {
    options += '<option value="' + esc(bindingId) + '" selected disabled>原插件已停用或无权使用</option>';
  }
  if (!selected) {
    return '<label class="sch-f-lbl">工作方法插件</label><select class="sch-in" id="schPlugin">' +
      options + '</select><div class="sch-plugin-empty">' +
      (items.length ? '选择后可查看执行步骤和需要填写的内容。'
        : '当前范围还没有可用于自动化的企业插件，请先由管理员审核并绑定。' +
          '你自己的个人插件在「直接执行 → 工作方法」里选用。') + '</div>';
  }
  const nodes = (selected.workflow || []).map((node, index) =>
    '<span><i>' + (index + 1) + '</i>' + esc(node.name || node.key) + '</span>').join('');
  const blockers = (((selected.readiness || {}).blockers) || []);
  const fields = (selected.inputs || []).map(field =>
    _schFieldHtml(field, values || {}, 'data-plugin-input')).join('');
  return '<label class="sch-f-lbl">工作方法插件</label><select class="sch-in" id="schPlugin">' +
    options + '</select><div class="sch-plugin-card' + (selected.runnable ? '' : ' blocked') + '">' +
    "<div class=\"sch-plugin-title\"><span><b data-user-content>" + esc(selected.name) + '</b><i>v' +
    esc(selected.version || '') + '</i></span><em>' +
    (selected.runnable ? '已就绪' : '还需配置') + '</em></div>' +
    (selected.description ? "<p data-user-content>" + esc(selected.description) + '</p>' : '') +
    (nodes ? '<div class="sch-plugin-flow">' + nodes + '</div>' : '') +
    (blockers.length ? '<div class="sch-plugin-blockers">' +
      blockers.map(item => '<span>' + esc(item) + '</span>').join('') + '</div>' : '') +
    (fields ? '<div class="sch-plugin-inputs">' + fields + '</div>' : '') + '</div>';
}

/* Local personal plugins. */
let _schmItems = null;          /* Eligible personal plugins are enabled and declare entrypoints.automation. */
let _schmLoading = null;
let _schmGeneration = 0;
const SCHM_CAP_LABEL = { browser: '浏览网页', computer: '操作电脑', office: '办公文档' };

async function _schmLoad() {
  // Re-entering automation must observe plugins created, updated or disabled elsewhere.
  // Keep only in-flight deduplication; the last snapshot is for synchronous form rendering.
  if (_schmLoading) return _schmLoading;
  const scope = _schmGeneration;
  const bridge = (typeof window !== 'undefined' && window.soduWorkAPI &&
    window.soduWorkAPI.personalPlugins) || null;
  if (!bridge || typeof bridge.list !== 'function') { _schmItems = []; return _schmItems; }
  _schmLoading = Promise.resolve(bridge.list())
    .then(async result => {
      if (scope !== _schmGeneration) return [];
      _schmItems = (((result || {}).items) || []).filter(item =>
        item && item.enabled !== false && item.entrypoints && item.entrypoints.automation &&
        !_schHasInteractiveUi(item));
      if (window.SoduWorkJiyongSchedules && SoduWorkAPI.pluginCatalog) {
        const catalog = await SoduWorkAPI.pluginCatalog();
        if (scope !== _schmGeneration) return [];
        _schmItems.push(...(catalog.items || []).map(window.SoduWorkJiyongSchedules.remote).filter(Boolean));
      }
      return _schmItems;
    })
    .catch(() => scope === _schmGeneration ? (_schmItems = _schmItems || []) : [])
    .finally(() => { if (scope === _schmGeneration) _schmLoading = null; });
  return _schmLoading;
}

function _schmFind(key) {
  return (Array.isArray(_schmItems) ? _schmItems : [])
    .find(item => item.key === String(key || '')) || null;
}

/* Map plugin capabilities into the schedule contract; files/terminal are inherent Runner abilities and are omitted. */
function _schmCaps(plugin) {
  return (((plugin || {}).capabilities || {}).runtime || [])
    .filter(key => Object.prototype.hasOwnProperty.call(SCHM_CAP_LABEL, key));
}

function _schmDefaultInputs(plugin) {
  const values = {};
  for (const field of (plugin && plugin.inputs) || []) {
    if (field && field.key && Object.prototype.hasOwnProperty.call(field, 'default')) {
      values[field.key] = field.default;
    }
  }
  return values;
}

function _schmConfigHtml(selectedKey, values, snapshot) {
  snapshot = snapshot || {};
  const items = Array.isArray(_schmItems) ? _schmItems : [];
  const selected = _schmFind(selectedKey);
  const policy = selectedKey && snapshot.versionPolicy === 'latest' ? 'latest' : 'pinned';
  const pinnedVersion = String(snapshot.version || (selected && selected.version) || '');
  const pinnedChecksum = String(snapshot.checksum || (selected && selected.checksum) || '');
  const currentChanged = Boolean(selected && policy === 'pinned' && snapshot.version &&
    (snapshot.version !== selected.version ||
      (snapshot.checksum && snapshot.checksum !== selected.checksum)));
  let options = '<option value="">不用插件 · 自由发挥</option>';
  options += items.map(item => '<option value="' + esc(item.key) + '"' +
    (item.key === selectedKey ? ' selected' : '') + '>' + esc(item.name) +
    ' · v' + esc(item.version || '') + '</option>').join('');
  if (selectedKey && !selected) {
    options += '<option value="' + esc(selectedKey) +
      '" selected disabled>原个人插件已删除或停用</option>';
  }
  const head = '<label class="sch-f-lbl">工作方法<em>可选：按你的个人插件执行，只在这台 SoduWork 上跑</em></label>' +
    '<select class="sch-in" id="schMethod">' + options + '</select>';
  if (!selected) {
    if (selectedKey) {
      return head + '<div class="sch-plugin-empty sch-method-missing"><b>原方法当前不可用</b>' +
        '该计划保存的版本、参数与能力合同仍会原样保留；恢复插件后可继续执行，或另选一个方法。</div>';
    }
    return head + (items.length ? '' :
      '<div class="sch-plugin-empty">还没有可用的个人插件。到「插件」页安装或创建一个，这里就能按它的方法自动干活。</div>');
  }
  const mcp = (((selected.capabilities || {}).mcpServers) || []);
  const caps = _schmCaps(selected);
  const fields = (selected.inputs || []).map(field =>
    _schFieldHtml(field, values || {}, 'data-method-input')).join('');
  const workflow = selected.workflow || [];
  const hasWorkflow = Boolean(((selected.capabilities || {}).hasWorkflow) || workflow.length);
  const nodes = workflow.map((node, index) => '<span><i>' + (index + 1) + '</i>' +
    esc(node.name || node.key) + '</span>').join('');
  const kind = hasWorkflow
    ? '<b>个人工作流草稿</b><i>由一个 Agent 按 ' + workflow.length + ' 步连续试运行</i>'
    : '<b>单 Agent 工作方法</b><i>一轮内按方法与完成标准执行</i>';
  const boundary = hasWorkflow
    ? '发布为企业插件后，才启用逐节点 Agent / 模型、人工门禁与断点恢复。'
    : '适合结果明确的办公方法；需要审批或多角色协作时，请发布为企业插件。';
  const versionHint = currentChanged
    ? '<small>本机当前是 v' + esc(selected.version || '') +
      '；固定旧版本时，原参数与能力合同保持只读。切到最新版后才会按新版编辑。</small>' : '';
  return head + '<div class="sch-plugin-card sch-method-card' +
    (currentChanged ? ' snapshot-locked' : '') + '">' +
    "<div class=\"sch-plugin-title\"><span><b data-user-content>" + esc(selected.name) + '</b><i>v' +
    esc(selected.version || '') + '</i></span><em>设备私有</em></div>' +
    (selected.description ? "<p data-user-content>" + esc(selected.description) + '</p>' : '') +
    '<div class="sch-method-kind">' + kind + '</div>' +
    (nodes ? '<div class="sch-plugin-flow">' + nodes + '</div>' : '') +
    '<div class="sch-version-policy" data-pinned-version="' + esc(pinnedVersion) +
    '" data-pinned-checksum="' + esc(pinnedChecksum) + '" data-snapshot-mismatch="' +
    (currentChanged ? '1' : '0') + '"><span>运行版本</span>' +
    '<label class="' + (policy === 'pinned' ? 'on' : '') + '"><input type="radio" ' +
    'name="schMethodVersionPolicy" value="pinned"' + (policy === 'pinned' ? ' checked' : '') +
    '><b>固定 v' + esc(pinnedVersion) + '</b><i>结果可复现</i></label>' +
    '<label class="' + (policy === 'latest' ? 'on' : '') + '"><input type="radio" ' +
    'name="schMethodVersionPolicy" value="latest"' + (policy === 'latest' ? ' checked' : '') +
    '><b>跟随最新版</b><i>自动采用更新</i></label>' + versionHint + '</div>' +
    ((caps.length || mcp.length) ? '<span class="sch-i-caps">' +
      caps.map(key => '<i>' + esc(SCHM_CAP_LABEL[key]) + '</i>').join('') +
      mcp.map(name => '<i>MCP · ' + esc(name) + '</i>').join('') + '</span>' : '') +
    (fields ? '<div class="sch-plugin-inputs">' + fields + '</div>' : '') +
    '<div class="sch-method-note">' + esc(boundary) +
    (mcp.length ? '<br>连接器届时用设备身份临时授权，凭据不进入任务。' : '') + '</div></div>';
}

function _schmRunProofHtml(run) {
  const receipt = run.receipt || {};
  const plugin = receipt.plugin || {};
  const resolved = (receipt.route || {}).resolved || {};
  const pluginName = plugin.name || plugin.key || '';
  const pluginText = pluginName
    ? ('插件 · ' + pluginName + (plugin.version ? ' v' + plugin.version : '') +
      (plugin.scope === 'personal'
        ? (plugin.versionPolicy === 'latest' ? ' · 跟随最新版' : ' · 固定版本') : ''))
    : '';
  const routeText = [resolved.host, resolved.agent || resolved.assigneeName, resolved.model]
    .filter(Boolean).join(' · ');
  return (pluginText ? '<i title="' + esc(pluginText) + '">' + esc(pluginText) + '</i>' : '') +
    (routeText ? '<i title="' + esc(routeText) + '">执行 · ' + esc(routeText) + '</i>' : '');
}

function _schmSnapshotState(editing, personalKey) {
  const method = _schmFind(personalKey);
  /*
   * An empty plugin key means no personal plugin, not a snapshot to preserve. Do not lock
   * capability controls merely because both keys are empty.
   */
  const same = Boolean(personalKey && editing && editing !== 'new' &&
    editing.personalPluginKey === personalKey);
  const box = document.querySelector('#schMethodWrap .sch-version-policy');
  const policyInput = document.querySelector(
    '#schMethodWrap input[name="schMethodVersionPolicy"]:checked');
  const versionPolicy = personalKey && policyInput ? policyInput.value :
    (same ? (editing.personalPluginVersionPolicy || 'latest') : 'latest');
  const personalVersion = personalKey && versionPolicy === 'pinned'
    ? String((box && box.dataset.pinnedVersion) ||
      (same && editing.personalPluginVersion) || (method && method.version) || '') : '';
  const personalChecksum = personalKey && versionPolicy === 'pinned'
    ? String((box && box.dataset.pinnedChecksum) ||
      (same && editing.personalPluginChecksum) || (method && method.checksum) || '') : '';
  const preserveSnapshot = Boolean(same &&
    (!method || (versionPolicy === 'pinned' && box && box.dataset.snapshotMismatch === '1')));
  return { method, versionPolicy, personalVersion, personalChecksum, preserveSnapshot };
}

function _schmSnapshotLocked(editing) {
  const key = (document.getElementById('schMethod') || {}).value || '';
  const state = _schmSnapshotState(editing, key);
  const locked = state.preserveSnapshot;
  const card = document.querySelector('#schMethodWrap .sch-method-card');
  if (card) card.classList.toggle('snapshot-locked', locked);
  document.querySelectorAll('#schMethodWrap [data-method-input]').forEach(input => {
    input.disabled = locked;
    input.title = locked ? '固定旧版本时保留原参数；切到最新版后可编辑' : '';
  });
  return locked;
}

/*
 * Create a schedule from conversation intent using the standard POST /schedules shape,
 * frequency/time, optional personal plugin, and first eligible Agent. Confirm inline
 * without opening another panel.
 */
async function _schmCreateAutomation(text, intent, options) {
  const generation = _schmGeneration;
  const current = () => generation === _schmGeneration && (!options?.isCurrent || options.isCurrent());
  const sch = { ...(intent.schedule || { every: 'daily', atHour: 9, atMinute: 0, weekday: 1 }) };
  const timeZone = sch.timeZone || (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; }
    catch (e) { return ''; }
  })();
  if (sch.every === 'once' && sch.runAt && !/[T].*(?:Z|[+-]\d{2}:?\d{2})$/i.test(String(sch.runAt))) {
    sch.runAt = window.ScheduleTiming?.fromLocalInput(String(sch.runAt), timeZone) || sch.runAt;
  }
  let timingError = '';
  if (window.ScheduleTiming) timingError = window.ScheduleTiming.validate({ ...sch, timeZone });
  else if (sch.every === 'once') timingError = '时间设置尚未就绪，请重新打开自动化';
  if (timingError) {
    const message = window.SoduWorkI18n?.translateText?.(timingError) || timingError;
    if (typeof petSay === 'function') petSay(message);
    return false;
  }
  // Conversation-created automations are plain chats. A selected personal
  // method is carried as a local plugin lock; it never creates a task or a
  // workflow-backed automation.
  const methodKey = String(sch.personalPluginKey || options?.personalPluginKey || '').trim();
  let method = null;
  if (methodKey) {
    await _schmLoad();
    if (!current()) return false;
    method = _schmFind(methodKey);
    if (!method) {
      if (typeof petSay === 'function') petSay('刚选的个人插件已不在本机，请重新选一个工作方法');
      return false;
    }
    /* If required plugin inputs lack defaults, route to the schedule form rather than creating an unusable schedule from the conversation. */
    const missing = (method.inputs || []).filter(f => f.required && !('default' in f))
      .map(f => f.label || f.key);
    if (missing.length) {
      if (typeof petSay === 'function') {
        petSay('「' + method.name + '」需要先填参数（' + missing.join('、') +
          '），请到「定时任务」面板里创建');
      }
      return false;
    }
  }
  const note = intent.acceptance
    ? text + '\n\n完成标准：\n' + intent.acceptance : text;
  let agents = [];
  try {
    if (typeof _schLoadExecutionAgents === 'function') {
      agents = await _schLoadExecutionAgents({ title: text, note });
    } else {
      const got = SoduWorkAPI.listAIAgents ? await SoduWorkAPI.listAIAgents() : null;
      agents = ((got && got.agents) || []).filter((a) => !a.off);
    }
  } catch (e) { agents = []; }
  if (!current()) return false;
  if (!agents.length) {
    if (typeof petSay === 'function') petSay('还没有可用的执行 Agent，先在「AI 助手」里配一个');
    return false;
  }
  /*
   * Conversation-created automations must use the same substrate/model that
   * was selected in the composer.  Previously this path always used the first
   * catalog row and the catalog default model, so a Qwen/Codex selection was
   * silently persisted as Pi and immediate execution opened with the wrong
   * runtime (or failed model admission).
   */
  const requestedAdapter = String(options?.adapterId || '').trim();
  const selectedAgent = requestedAdapter
    ? agents.find(agent => {
      const id = String(agent?.id || '').trim();
      const cli = String(agent?.cli || '').trim();
      const localCli = id.replace(/^local:/, '');
      const runnerCli = id.replace(/^runner:[^:]+:/, '');
      return requestedAdapter === id || requestedAdapter === cli ||
        requestedAdapter === localCli || requestedAdapter === runnerCli;
    })
    : agents[0];
  if (!selectedAgent) {
    if (typeof petSay === 'function') petSay('所选执行底座当前不可用，请刷新后重试');
    return false;
  }
  const hasExplicitModel = Boolean(options && Object.prototype.hasOwnProperty.call(options, 'modelName'));
  const requestedModel = hasExplicitModel ? String(options.modelName || '').trim() : '';
  const acceptsModel = selectedAgent.modelPick !== false || selectedAgent.nativeModelPick === true;
  const selectedModel = acceptsModel
    ? (hasExplicitModel ? requestedModel
      : (selectedAgent.nativeModelPick ? '' : String(_schDefaultModel || '')))
    : '';
  try {
    await SoduWorkAPI.createSchedule({
      title: text.slice(0, 60), note: note.slice(0, 8000),
      every: sch.every, atHour: sch.atHour, atMinute: sch.atMinute,
      ...(sch.every === 'custom' ? {customRule: sch.customRule} : {}),
      runAt: sch.every === 'once' ? sch.runAt : '',
      weekday: sch.weekday, weekdays: Array.isArray(sch.weekdays) ? sch.weekdays :
        (sch.every === 'weekly' ? window.ScheduleTiming.cleanList(sch.weekday, 1, 7) : []),
      monthDays: sch.monthDays || [], monthDayPolicy: sch.monthDayPolicy || 'skip',
      startDate: sch.every === 'once' || sch.every === 'custom' ? null : sch.startDate || null,
      endDate: sch.every === 'once' || sch.every === 'custom' ? null : sch.endDate || null, timeZone,
      assigneeId: selectedAgent.id, assigneeType: 'agent',
      modelName: selectedModel,
      repoId: String(sch.repoId || options?.repoId || '').trim(),
      personalPluginKey: methodKey,
      personalPluginVersionPolicy: method ? 'pinned' : 'latest',
      personalPluginVersion: method ? (sch.personalPluginVersion || method.version || '') : '',
      personalPluginChecksum: method ? (sch.personalPluginChecksum || method.checksum || '') : '',
      pluginInputs: method ? Object.assign(_schmDefaultInputs(method), sch.pluginInputs || {}) : {},
      requiredCapabilities: method ? _schmCaps(method) : [],
      retryLimit: 2, retryDelayMinutes: 5, enabled: true,
    });
  } catch (error) {
    if (!current()) return false;
    if (typeof petSay === 'function') {
      petSay(typeof _humanErr === 'function'
        ? _humanErr(error, '自动化任务没建起来') : '自动化任务没建起来');
    }
    return false;
  }
  if (!current()) return false;
  const translate = value => (typeof window !== 'undefined' && window.SoduWorkI18n &&
    typeof window.SoduWorkI18n.translateText === 'function' ? window.SoduWorkI18n.translateText(value) : value) || value;
  const selectedWeekdays = Array.isArray(sch.weekdays) && sch.weekdays.length ? sch.weekdays : [sch.weekday];
  const weekdayNames = selectedWeekdays.map(day => translate('周' + '一二三四五六日'.charAt(Number(day) - 1))).join('、');
  const monthNames = (Array.isArray(sch.monthDays) ? sch.monthDays : []).map(day => String(day).padStart(2, '0')).join('、');
  const clockText = String(sch.atHour).padStart(2, '0') + ':' + String(sch.atMinute).padStart(2, '0');
  let when = clockText;
  if (sch.every === 'once') when = window.ScheduleTiming.summary({ ...sch, timeZone });
  else if (sch.every === 'custom') when = window.ScheduleTiming.summary(sch);
  else if (sch.every === 'hourly') when = translate('每小时第几分') + ' ' + String(sch.atMinute).padStart(2, '0') + ' ' + translate('分钟');
  else if (sch.every === 'monthly') when = translate('每月') + ' ' + monthNames + ' ' + translate('日期') +
    (sch.monthDayPolicy === 'last_day' ? ' · ' + translate('缺少日期时使用当月最后一天') : '') + ' ' + clockText;
  else if (sch.every === 'weekly') when = translate('每周') + ' ' + weekdayNames + ' ' + clockText;
  else when = translate('每天') + ' ' + clockText;
  if (typeof petSay === 'function') {
    const whenT = translate(when);
    const messageKey = method
      ? '已建立自动化：{value1}按「{value2}」的方法自动执行，可在「定时任务」里调整'
      : '已建立自动化：{value1}自动执行，可在「定时任务」里调整';
    let message;
    if (typeof window.SoduWorkI18n?.t === 'function') {
      message = window.SoduWorkI18n.t(messageKey, messageKey, { value1: whenT, value2: method?.name || '' });
    } else if (method) {
      message = '已建立自动化：' + whenT + '按「' + method.name + '」的方法自动执行，可在「定时任务」里调整';
    } else {
      message = '已建立自动化：' + whenT + '自动执行，可在「定时任务」里调整';
    }
    petSay(message);
  }
  const input = document.getElementById('cpInput');
  if (input) { input.value = ''; input.style.height = ''; }
  return true;
}
