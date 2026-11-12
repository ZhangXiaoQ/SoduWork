/*
 * Create/edit automation in a contextual drawer; restore focus to its trigger on closing.
 */
let _schEditorReturnFocus = null;
let _schEditorRequest = 0;
let _schEditorPending = false;

/*
 * Load templates only from administrator-configured automation_templates_v1 through
 * /schedules/templates. Hide the section when unconfigured instead of adding client-side
 * samples.
 */

/*
 * Resolve optional name/description/note/title locale maps through shared
 * SoduworkLocalizedText helpers for both cards and prefilling.
 */
function _schPickLocale(map, locale) {
  return window.SoduworkLocalizedText.pickLocale(map, locale);
}

function _schTemplateLocale() {
  return window.SoduworkLocalizedText.currentLocale();
}

function _schTemplateText(item, field) {
  return window.SoduworkLocalizedText.resolve(item, field);
}

function _schRecipeValues(item) {
  /*
   * Use one localized values object for template previews and prefilling; generated
   * requirement titles and AI instructions follow the selected language.
   */
  const locale = _schTemplateLocale();
  return {
    title: _schPickLocale(item.titleLocales, locale) ||
      _schPickLocale(item.nameLocales, locale) || item.title || item.name,
    note: _schPickLocale(item.noteLocales, locale) || item.note || '',
    every: item.every || 'daily', atHour: item.atHour, atMinute: item.atMinute,
    ...(item.every === 'custom' ? {customRule: item.customRule || ''} : {}),
    weekday: item.weekday, timeZone: item.timeZone,
    startDate: item.startDate || '', endDate: item.endDate || '',
    requiredCapabilities: item.requiredCapabilities || [], retryLimit: item.retryLimit,
    retryDelayMinutes: item.retryDelayMinutes, pluginBindingId: item.pluginBindingId || '',
    pluginInputs: item.pluginInputs || {},
  };
}

function _schRecipeHtml(compact) {
  if (!_schTemplates.length) return '';
  const recipes = _schTemplates.map((item) => {
    const title = _schTemplateText(item, 'name');
    const desc = _schTemplateText(item, 'description') || _schTemplateText(item, 'note') || '由管理端配置的自动化模板';
    return {
      id: item.id, mark: title.slice(0, 1) || '模', title,
      desc, descIsUserContent: !!(item.description || item.note),
      values: _schRecipeValues(item),
    };
  });
  const useLabel = (window.SoduWorkI18n && window.SoduWorkI18n.translateText)
    ? window.SoduWorkI18n.translateText('使用模板') : '使用模板';
  return '<section class="sch-recipes' + (compact ? ' compact' : '') + '"><header><div><b>从模板开始</b>' +
    '<span>选择模板，设置时间与执行方式</span></div></header><div>' +
    recipes.map((recipe) => '<button type="button" data-sch-recipe="' + esc(recipe.id) +
      '" aria-haspopup="dialog" data-user-attributes="aria-label" aria-label="' + esc(useLabel) + ' · ' + esc(recipe.title) + '"><i>' + _schVisualIcon('template') +
      '</i><span><b data-user-content>' + esc(recipe.title) + '</b><small' +
      (recipe.descIsUserContent ? ' data-user-content' : '') + '>' + esc(recipe.desc) + '</small></span>' +
      '<em aria-hidden="true">' + _schVisualIcon('arrow') + '</em></button>').join('') + '</div></section>';
}

function _schBindRecipes(root) {
  root.querySelectorAll('[data-sch-recipe]').forEach((button) => button.addEventListener('click', () => {
    const recipeId = button.getAttribute('data-sch-recipe');
    const remote = _schTemplates.find((item) => item.id === recipeId);
    if (!remote) return;
    const recipe = { values: _schRecipeValues(remote) };
    const draft = Object.assign({ assigneeId: '', repoId: '', flow: false,
      pluginBindingId: '', personalPluginKey: '', pluginInputs: {},
      retryLimit: 2, retryDelayMinutes: 5, enabled: true }, recipe.values);
    void _schPrepareEditor(draft, button);
  }));
}


function _schDefaultAgentId() {
  const ready = _schAgents.find(item => item && item.available !== false);
  return String((ready || _schAgents[0] || {}).id || '');
}

function _schNormalizeExecutionAgents(result) {
  const rows = [];
  for (const item of ((result && result.substrates) || [])) {
    if (!item || !item.key) continue;
    const locations = Array.isArray(item.locations) && item.locations.length
      ? item.locations : [null];
    for (const location of locations) {
      const remote = location && location.mode === 'remote';
      const locationId = String((location && (location.assigneeId || location.id)) || item.key);
      const locationLabel = String((location && location.label) || item.locationLabel || '');
      rows.push({
        // A group such as local:pi can contain several concrete seats. Keep
        // the selected assignee stable so an automation cannot silently move
        // from the chosen work computer to another device on the next run.
        id: locationId,
        name: String(item.name || item.cli || item.key) +
          (locations.length > 1 && locationLabel ? ' · ' + locationLabel : ''),
        cli: String(item.cli || ''),
        available: item.available !== false,
        note: String(item.note || ''),
        modelPick: item.modelPick !== false,
        // Native model catalogs are device-local. Remote native targets keep
        // their own account selection and must not query this desktop.
        nativeModelPick: item.nativeModelPick === true && !remote,
        modelSource: String(item.modelSource || ''),
        locationLabel,
        onlineSeats: locations.length > 1 ? 1 : Math.max(0, Number(item.onlineSeats) || 0),
        mode: String((location && location.mode) || 'local'),
        runnerId: String((location && location.runnerId) || ''),
        clientId: String((location && location.clientId) || ''),
        runnerKind: String((location && location.runnerKind) || ''),
        host: String((location && location.host) || ''),
      });
    }
  }
  return rows;
}

function _schNormalizeModelOptions(result) {
  const rows = Array.isArray(result?.modelOptions) ? result.modelOptions : [];
  const names = Array.isArray(result?.models) ? result.models : [];
  const out = [];
  const seen = new Set();
  const add = raw => {
    const name = typeof raw === 'string' ? raw : (raw && (raw.name || raw.id));
    const value = String(name || '').trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push({ name: value, label: String((raw && raw.label) || value) });
  };
  rows.forEach(add); names.forEach(add);
  return out;
}

function _schNormalizeNativeModelOptions(result) {
  const rows = Array.isArray(result?.models) ? result.models : [];
  const out = [];
  const seen = new Set();
  rows.forEach(raw => {
    const name = String((raw && (raw.id || raw.name)) || raw || '').trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ name, label: String((raw && (raw.label || raw.displayName)) || name) });
  });
  return out;
}

function _schNativeOptionsFor(agentId) {
  return (_schNativeModelOptions && _schNativeModelOptions[String(agentId || '')]) || [];
}

function _schModelOptionsFor(agentId) {
  const agent = _schAgents.find(item => String(item.id) === String(agentId || ''));
  return agent && agent.nativeModelPick ? _schNativeOptionsFor(agent.id) : _schModelOptions;
}

async function _schLoadNativeModelOptions(agents) {
  const scope = _schScope;
  const nativeAgents = (agents || []).filter(item => item && item.nativeModelPick);
  if (!nativeAgents.length) return;
  const bridge = window.soduWorkAPI && (window.soduWorkAPI.conversationSession || window.soduWorkAPI.piSession);
  if (!bridge || typeof bridge.runtimeModels !== 'function') return;
  await Promise.all(nativeAgents.map(async agent => {
    const adapterId = String(agent.cli || agent.id || '').replace(/^local:/, '');
    if (!adapterId) return;
    try {
      const result = await bridge.runtimeModels(adapterId);
      if (scope === _schScope && _schNativeModelOptions) _schNativeModelOptions[agent.id] = _schNormalizeNativeModelOptions(result);
    } catch (_) {
      if (scope === _schScope && _schNativeModelOptions) _schNativeModelOptions[agent.id] = [];
    }
  }));
}

/*
 * Automations and manual tasks share the execution-options contract. Stable local:<cli>
 * types resolve to an eligible Runner at execution time instead of persisting transient
 * seats.
 */
async function _schLoadExecutionAgents(context) {
  if (_schAgentLoading) return _schAgentLoading;
  const scope = _schScope;
  _schNativeModelOptions = Object.create(null);
  _schAgentLoading = (async () => {
    if (SoduWorkAPI.taskExecutionOptions) {
      try {
        const result = await SoduWorkAPI.taskExecutionOptions({
          title: String((context || {}).title || ''),
          note: String((context || {}).note || ''),
          tags: [], repoId: String((context || {}).repoId || ''),
        });
        if (scope === _schScope) {
          _schModelOptions = _schNormalizeModelOptions(result);
          _schDefaultModel = String((result && result.defaultModel) ||
            (_schModelOptions[0] && _schModelOptions[0].name) || '').trim();
        }
        const agents = _schNormalizeExecutionAgents(result);
        if (scope !== _schScope) return [];
        _schAgentReason = String((((result || {}).availability || {}).agentReason) ||
          (!agents.length ? '当前设备还没有在线执行底座，请打开 Agent 管理确认 Runner 已启动' : ''));
        const selected = context?.assigneeId || (agents.find(item => item.available !== false) || agents[0])?.id;
        await _schLoadNativeModelOptions(agents.filter(item => item.id === selected));
        if (scope !== _schScope) return [];
        return agents;
      } catch (_) {
        if (scope !== _schScope) return [];
        _schModelOptions = []; _schDefaultModel = '';
        /* Fall back to legacy agent lists only when the unified-contract API fails. */
      }
    }
    if (SoduWorkAPI.listAIAgents) {
      const result = await SoduWorkAPI.listAIAgents().catch(() => ({ agents: [] }));
      if (scope !== _schScope) return [];
      const agents = ((result && result.agents) || []).filter(item => item && !item.off && item.id)
        .map(item => ({ ...item, id: String(item.id), name: String(item.name || item.cliName || item.id),
          available: item.online !== false }));
      _schAgentReason = String((result && result.reason) ||
        (!agents.length ? '当前设备还没有在线执行底座，请打开 Agent 管理确认 Runner 已启动' : ''));
      const selected = context?.assigneeId || (agents.find(item => item.available !== false) || agents[0])?.id;
      await _schLoadNativeModelOptions(agents.filter(item => item.id === selected));
      if (scope !== _schScope) return [];
      return agents;
    }
    _schAgentReason = '当前客户端不支持读取执行底座，请升级后重试';
    return [];
  })().then(agents => {
    if (scope !== _schScope) return [];
    _schAgents = Array.isArray(agents) ? agents : [];
    return _schAgents;
  }).finally(() => { if (scope === _schScope) _schAgentLoading = null; });
  return _schAgentLoading;
}

function _schAgentOptionLabel(agent) {
  /* Translate option-label fragments when constructing them; retain names and timezones as data. */
  const _tx = value => (window.SoduWorkI18n && window.SoduWorkI18n.translateText)
    ? window.SoduWorkI18n.translateText(value) : value;
  const suffix = [agent.locationLabel,
    agent.onlineSeats ? _tx(agent.onlineSeats + ' 个在线席位') : '',
    agent.available === false ? _tx('当前未就绪') : ''].filter(Boolean);
  return String(agent.name || agent.id) + (suffix.length ? ' · ' + suffix.join(' · ') : '');
}

function _schAgentOptionsHtml(current) {
  const selected = String(current || _schDefaultAgentId());
  const rows = _schAgents.slice();
  if (selected && !rows.some(item => String(item.id) === selected)) {
    const saved = (window.SoduWorkI18n && window.SoduWorkI18n.translateText)
      ? window.SoduWorkI18n.translateText('已保存的执行底座') : '已保存的执行底座';
    rows.unshift({ id: selected, name: saved, available: false });
  }
  if (!rows.length) {
    const empty = (window.SoduWorkI18n && window.SoduWorkI18n.translateText)
      ? window.SoduWorkI18n.translateText('当前设备没有可选执行底座') : '当前设备没有可选执行底座';
    return '<option value="">' + esc(empty) + '</option>';
  }
  return rows.map(agent => '<option value="' + esc(agent.id) + '"' +
    (String(agent.id) === selected ? ' selected' : '') + '>' +
    esc(_schAgentOptionLabel(agent)) + '</option>').join('');
}

function _schEditorTx(value) {
  return (window.SoduWorkI18n && typeof window.SoduWorkI18n.translateText === 'function')
    ? window.SoduWorkI18n.translateText(value) : value;
}

function _schRefreshAgentField(preferred) {
  const select = document.getElementById('schWho');
  if (!select) return;
  const current = String(select.value || preferred || '');
  select.innerHTML = _schAgentOptionsHtml(current);
  select.disabled = !_schAgents.length && !current;
  const hint = document.getElementById('schWhoHint');
  if (hint) hint.textContent = _schAgentReason || (_schAgents.length
    ? '保存的是执行底座类型；每次运行会在当前设备选择可用席位'
    : '请打开 Agent 管理，确认 Runner 已启动并已连接当前环境');
  // Refreshing a catalog must not impersonate a user's substrate change.
  const event = new Event('change', { bubbles: true }); event.catalogRefresh = true;
  select.dispatchEvent(event);
  _schRefreshModelField();
}

function _schModelOptionsHtml(current, options) {
  const selected = current === undefined || current === null
    ? '' : String(current || '').trim();
  const rows = (options || _schModelOptions).slice();
  if (selected && !rows.some(item => item.name === selected)) {
    rows.unshift({ name: selected, label: selected + _schEditorTx('（已保存，当前不可用）'), stale: true });
  }
  if (!selected) rows.unshift({ name: '', label: _schEditorTx('请选择模型'), placeholder: true });
  if (!rows.length) return '<option value="">' + esc(_schEditorTx('当前没有可用模型')) + '</option>';
  return rows.map(item => '<option value="' + esc(item.name) + '"' +
    (item.name === selected ? ' selected' : '') + (item.stale ? ' disabled' : '') +
    (item.placeholder ? ' disabled' : '') + '>' +
    esc(item.label || item.name) + '</option>').join('');
}

function _schAgentAllowsModel(agentId) {
  // Gateway and native-per-run runtimes accept an explicit model. A runtime
  // that owns its account/model remains the one case where an override is not
  // valid, even though the substrate itself is selectable independently.
  const id = String(agentId || '').trim();
  const agent = _schAgents.find(item => String(item.id) === id);
  return !agent || agent.modelPick !== false || agent.nativeModelPick === true;
}

function _schModelFieldHtml(current, agentId) {
  const selected = current === undefined || current === null
    ? '' : String(current || '').trim();
  if (!_schAgentAllowsModel(agentId)) {
    return '<label class="sch-f-lbl" for="schModel">' + esc(_schEditorTx('模型')) +
      '</label><select class="sch-in" id="schModel" disabled>' +
      '<option value="">' + esc(_schEditorTx('由底座自身管理模型')) + '</option></select>' +
      '<small class="sch-executor-hint" id="schModelHint">' +
      esc(_schEditorTx('当前底座不接受自动化单独指定模型。')) + '</small>';
  }
  const options = _schModelOptionsFor(agentId);
  return '<label class="sch-f-lbl" for="schModel">' + esc(_schEditorTx('模型')) +
    '</label><select class="sch-in" id="schModel" aria-describedby="schModelHint">' +
    _schModelOptionsHtml(selected, options) + '</select>' +
    '<small class="sch-executor-hint" id="schModelHint">' +
    esc(_schEditorTx('模型与执行底座独立保存；每次自动化运行都使用这里选择的模型。')) + '</small>';
}

function _schRefreshModelField(preferred) {
  const select = document.getElementById('schModel');
  if (!select) return;
  const current = preferred !== undefined ? String(preferred || '').trim() :
    String(select.value || '').trim();
  const agent = document.getElementById('schWho');
  if (!_schAgentAllowsModel(agent && agent.value)) {
    const option = document.createElement('option'); option.value = '';
    option.textContent = _schEditorTx('由底座自身管理模型');
    select.replaceChildren(option);
    select.value = '';
    select.disabled = true;
    return;
  }
  const options = _schModelOptionsFor(agent && agent.value);
  select.innerHTML = _schModelOptionsHtml(current, options);
  // Do not replace the explicit model with the substrate default. If the
  // catalog is temporarily unavailable, retain the saved value so the user
  // can still see and edit the automation instead of losing its selection.
  select.disabled = !options.length && !current;
}

function _schEditorDrawerHtml() {
  const editing = _schEditing && _schEditing !== 'new' ? _schEditing : null;
  const isEdit = Boolean(editing && editing.id);
  return '<header class="sch-editor-head"><span class="sch-editor-mark" aria-hidden="true">' +
    '<svg viewBox="0 0 24 24"><path d="M7 3h7l3 3v15H7z"/><path d="M14 3v4h4M10 12h5M10 16h5"/></svg></span>' +
    '<span class="sch-editor-title"><small>自动化配置</small><h2 id="schEditorTitle">' +
    (isEdit ? '编辑自动化' : '新建自动化') + '</h2><p>' +
    (isEdit ? '调整触发方式、执行方法和运行条件，保存后按新设置生效。' :
      '把重复工作交代清楚，SoduWork 会按时执行，并在对话中保留过程和结果。') +
    '</p></span><button class="sch-editor-close" data-editor-close aria-label="关闭自动化配置">' +
    '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></header>' +
    '<div class="sch-editor-scroll">' + _schFormHtml(editing) + '</div>';
}

function _schRenderEditorDrawer(focusDrawer) {
  const layer = document.getElementById('schEditorLayer');
  const content = document.getElementById('schEditorContent');
  if (!layer || !content) return;
  const isOpen = Boolean(_schEditing);
  document.querySelectorAll('.sch-item [data-act="edit"]').forEach(button => {
    const card = button.closest('.sch-item');
    const sid = card && card.getAttribute('data-sid');
    button.setAttribute('aria-expanded', String(isOpen && _schEditing !== 'new' &&
      String((_schEditing || {}).id || '') === sid));
  });
  if (!isOpen) {
    window.ForwardSelect?.destroy(content);
    layer.classList.remove('show'); layer.setAttribute('aria-hidden', 'true'); content.replaceChildren();
    return;
  }
  window.ForwardSelect?.destroy(content);
  content.innerHTML = _schEditorDrawerHtml();
  layer.classList.add('show'); layer.setAttribute('aria-hidden', 'false');
  content.querySelectorAll('[data-editor-close]').forEach(button =>
    button.addEventListener('click', () => _schCloseEditor(true)));
  _wireSchForm();
  const clock = content.querySelector('.sch-clock');
  if (clock) window.ForwardSelect?.enhance(clock);
  _schBindAgentReload();
  if (focusDrawer) requestAnimationFrame(() => {
    const firstInput = content.querySelector('#schTitle');
    if (firstInput) firstInput.focus({ preventScroll: true });
  });
}

function _schAgentFieldHtml(current) {
  return '<label class="sch-f-lbl" for="schWho">执行底座</label><select class="sch-in" id="schWho" aria-describedby="schWhoHint"' +
    (!_schAgents.length && !current ? ' disabled' : '') + '>' + _schAgentOptionsHtml(current) + '</select>' +
    '<div class="sch-executor-tools"><small class="sch-executor-hint" id="schWhoHint">' +
    esc(_schAgentReason || (_schAgents.length ? '保存的是执行底座类型；运行时选择可用席位' :
      '请打开 Agent 管理，确认 Runner 已启动并已连接当前环境')) + '</small>' +
    '<button type="button" class="btn-mini" id="schReloadAgents">刷新底座</button></div>' +
    _schModelFieldHtml(_schEditing && _schEditing !== 'new'
      ? _schEditing.modelName : '', current);
}

async function _schPrepareEditor(value, source) {
  const request = ++_schEditorRequest;
  const timing = window.SoduWorkPagePerformance?.interaction?.('schedule-editor');
  _schEditorPending = true;
  _schOpenEditor(value, source);
  timing?.mark('shell');
  const content = document.getElementById('schEditorContent');
  const save = document.getElementById('schSave');
  if (save) { save.disabled = true; save.setAttribute('aria-busy', 'true'); }
  try {
    const draft = value === 'new' ? {} : value;
    await Promise.all([_schLoadExecutionAgents(draft).then(() => timing?.mark('agents')),
      _schLoadPlugins(_schProjectId(draft.repoId)).then(() => timing?.mark('plugins')),
      _schmLoad().then(() => timing?.mark('methods'))]);
    if (request !== _schEditorRequest || !document.getElementById('schPanel')?.classList.contains('show')) return false;
    // Capture edited fields before replacing catalog-dependent controls.
    const current = save?.scheduleDraft?.();
    const focused = content?.contains(document.activeElement) ? document.activeElement.id : '';
    const selection = document.activeElement?.selectionStart;
    const selectionEnd = document.activeElement?.selectionEnd;
    const scroll = content?.querySelector('.sch-editor-scroll')?.scrollTop || 0;
    if (current) _schEditing = { ...draft, ...current };
    _schEditorPending = false;
    _schRenderEditorDrawer(false);
    const input = focused && document.getElementById(focused);
    input?.focus?.({ preventScroll: true });
    if (Number.isInteger(selection)) input?.setSelectionRange?.(selection, selectionEnd);
    const scroller = content?.querySelector('.sch-editor-scroll');
    if (scroller) scroller.scrollTop = scroll;
    timing?.mark('ready');
    return true;
  } finally {
    if (request === _schEditorRequest) _schEditorPending = false;
    if (source?.isConnected) { source.disabled = false; source.removeAttribute('aria-busy'); }
  }
}

function _schBindAgentReload() {
  const button = document.getElementById('schReloadAgents');
  if (!button) return;
  button.addEventListener('click', async () => {
    const select = document.getElementById('schWho');
    button.disabled = true;
    try {
      await _schLoadExecutionAgents({ title: document.getElementById('schTitle')?.value,
        note: document.getElementById('schNote')?.value, assigneeId: select?.value });
      if (select === document.getElementById('schWho')) _schRefreshAgentField();
    } finally { button.disabled = false; }
  });
}

function _schOpenEditor(value, source) {
  _schCloseCreateMenu(false);
  _schCloseRuns(false);
  _schEditorReturnFocus = source || null;
  _schEditing = value || 'new';
  _schRenderEditorDrawer(true);
}

function _schCloseEditor(restoreFocus) {
  _schEditorRequest += 1;
  _schEditorPending = false;
  const returnFocus = _schEditorReturnFocus;
  _schEditorReturnFocus = null;
  _schEditing = null;
  _schRenderEditorDrawer(false);
  if (restoreFocus && returnFocus && returnFocus.isConnected) {
    requestAnimationFrame(() => returnFocus.focus({ preventScroll: true }));
  }
}

// Account/Hub/device changes invalidate both snapshots and pending responses.
// Detached requests may finish, but must never refill the next identity's UI.
function _schResetScope() {
  _schScope++;
  closeSchedulePanel();
  _schRows = null; _schLoading = null; _schLoadError = '';
  _schAgents = []; _schAgentReason = ''; _schAgentLoading = null;
  _schModelOptions = []; _schDefaultModel = ''; _schNativeModelOptions = Object.create(null);
  _schRepos = []; _schTemplates = [];
  _schPluginCache = Object.create(null); _schPluginLoading = Object.create(null);
  _schmGeneration++; _schmItems = []; _schmLoading = null;
  _schRunRows = Object.create(null); _schRunLoading = Object.create(null); _schRunErrors = Object.create(null);
  const body = document.getElementById('schBody');
  if (body) body.replaceChildren();
}

/* The creation entry selects input mode; the existing confirmation flow owns saving and starting. */
let _schCreateDismiss = null;

function _schCreateMenuHtml() {
  return '<div class="sch-create">' +
    '<button type="button" class="sch-create-trigger" id="schNew" aria-haspopup="menu" ' +
    'aria-expanded="false" aria-controls="schCreateMenu"><span>创建</span>' +
    '<span class="sch-create-chevron" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="m6 8 4 4 4-4"/></svg></span></button>' +
    '<div class="sch-create-menu" id="schCreateMenu" role="menu" aria-label="创建自动化" hidden>' +
    '<button type="button" role="menuitem" tabindex="-1" data-sch-create="chat">' +
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a8.5 8.5 0 0 1-8.5 8.5 9 9 0 0 1-3.5-.7L3 21l1.7-5a9 9 0 0 1-.7-3.5A8.5 8.5 0 1 1 20 11.5Z"/></svg>' +
    '<span>对话创建</span></button>' +
    '<button type="button" role="menuitem" tabindex="-1" data-sch-create="manual">' +
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 5.5 4 4M4 20l4.5-1 11-11a2.8 2.8 0 0 0-4-4l-11 11L4 20Z"/></svg>' +
    '<span>手动配置</span></button></div></div>';
}

function _schCloseCreateMenu(restoreFocus) {
  if (_schCreateDismiss) { _schCreateDismiss(); _schCreateDismiss = null; }
  const menu = document.getElementById('schCreateMenu');
  const trigger = document.getElementById('schNew');
  if (menu) menu.hidden = true;
  if (trigger) {
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }
}

function _schOpenCreateMenu(index) {
  const trigger = document.getElementById('schNew');
  const menu = document.getElementById('schCreateMenu');
  if (!trigger || trigger.disabled || !menu) return;
  _schCloseCreateMenu(false);
  menu.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
  const items = menu.querySelectorAll('[role="menuitem"]');
  items[index === -1 ? items.length - 1 : 0].focus({ preventScroll: true });
  const root = menu.parentElement;
  const outside = event => { if (!root.contains(event.target)) _schCloseCreateMenu(false); };
  document.addEventListener('pointerdown', outside);
  document.addEventListener('focusin', outside);
  _schCreateDismiss = () => {
    document.removeEventListener('pointerdown', outside);
    document.removeEventListener('focusin', outside);
  };
}

async function _schCreateFromChat() {
  const payload = {
    tab: 'chat', newSession: true, pluginId: 'work.automation.create', prefill: '/自动化 ',
    contextPrompts: ['当前从自动化页面进入。请整理用户希望重复执行的工作、执行时间和成果要求，起一个简短明确的自动化名称；缺少的信息先询问，确认配置后才创建，不立即执行工作。'],
  };
  const route = typeof openCreateEntry === 'function' ? openCreateEntry :
    typeof openComposePanel === 'function' ? openComposePanel : null;
  _schCloseCreateMenu(false);
  if (!route) {
    if (typeof petSay === 'function') petSay('对话入口尚未就绪，请稍后重试，或选择手动配置。');
    document.getElementById('schNew')?.focus({ preventScroll: true });
    return false;
  }
  try {
    // The shared entry returns void when navigation was handed to the workspace.
    if (await route(payload) === false) throw new Error('Conversation entry unavailable');
    closeSchedulePanel();
    if (typeof petSay === 'function') petSay('描述要自动完成的工作和执行时间，发送后确认配置。');
    return true;
  } catch (_) {
    if (typeof petSay === 'function') petSay('对话暂时没有打开，请重试；也可以选择手动配置。');
    document.getElementById('schNew')?.focus({ preventScroll: true });
    return false;
  }
}

function _schBindCreateMenu() {
  const trigger = document.getElementById('schNew');
  const menu = document.getElementById('schCreateMenu');
  trigger.addEventListener('click', () => {
    if (menu.hidden) _schOpenCreateMenu(0); else _schCloseCreateMenu(true);
  });
  trigger.parentElement.addEventListener('keydown', event => {
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
    const index = items.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      if (menu.hidden) { _schOpenCreateMenu(event.key === 'ArrowUp' || event.key === 'End' ? -1 : 0); return; }
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
        (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next].focus();
    } else if (!menu.hidden && event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); _schCloseCreateMenu(true);
    } else if (!menu.hidden && event.key === 'Tab') {
      _schCloseCreateMenu(true); // Native Tab continues out of the menu, without a focus trap.
    }
  });
  menu.addEventListener('click', event => {
    const item = event.target.closest('[data-sch-create]');
    if (!item || menu.hidden) return;
    if (item.dataset.schCreate === 'chat') { void _schCreateFromChat(); return; }
    _schCloseCreateMenu(false);
    void _schPrepareEditor('new', trigger);
  });
}

function _schOnceFieldsHtml(value) {
  const zone = value.timeZone || _schBrowserTimeZone();
  const local = window.ScheduleTiming?.localInput(value.runAt, zone) || '';
  return '<label class="sch-once-field" id="schOnceWrap"' + (value.every === 'once' ? '' : ' style="display:none"') + '>' +
    '<span>执行日期时间 · ' + esc(_schTimeZoneLabel(zone)) + '</span>' +
    '<input class="sch-in" id="schRunAt" type="datetime-local" step="60" value="' + esc(local) +
    '" aria-describedby="schOnceHint"><small id="schOnceHint"></small></label>';
}

function _schReadTiming() {
  const existing = _schEditing && _schEditing !== 'new' ? _schEditing : {};
  const every = document.getElementById('schEvery').value;
  const timeZone = existing.timeZone || _schBrowserTimeZone();
  const checked = selector => [...(document.querySelectorAll(selector) || [])]
    .filter(input => input.checked).map(input => Number(input.value))
    .filter(value => Number.isInteger(value));
  const weekdays = checked('#schWeekdays input[type="checkbox"]');
  const monthDays = checked('#schMonthDays input[type="checkbox"]');
  const legacyWeekday = Number(document.getElementById('schWd')?.value || existing.weekday || 1);
  const hasWeekdayGrid = Boolean(document.getElementById('schWeekdays'));
  let runAt = '';
  if (every === 'once') {
    const local = document.getElementById('schRunAt')?.value || '';
    const original = window.ScheduleTiming?.localInput(existing.runAt, timeZone) || '';
    // Native datetime-local can shorten .120 to .12. Compare the wall fields,
    // preserving the original ISO (including microseconds) when left unchanged.
    const canonical = value => {
      const parts = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
      return parts ? parts[1] + ':' + (parts[2] || '00') + '.' + (parts[3] || '').padEnd(3, '0') : '';
    };
    const same = local && original && canonical(local) === canonical(original);
    runAt = existing.every === 'once' && same ? existing.runAt
      : window.ScheduleTiming?.fromLocalInput(local, timeZone) || '';
  }
  const startControl = document.getElementById('schStartDate');
  const endControl = document.getElementById('schEndDate');
  const startDate = startControl ? startControl.value : (existing.startDate || '');
  const endDate = endControl ? endControl.value : (existing.endDate || '');
  const selectedWeekdays = every === 'weekly'
    ? (hasWeekdayGrid ? weekdays : [legacyWeekday])
    : [];
  const selectedMonthDays = every === 'monthly' ? monthDays : [];
  const policyControl = document.getElementById('schMonthLastDay');
  const policy = policyControl ? (policyControl.checked ? 'last_day' : 'skip') :
    (existing.monthDayPolicy || 'skip');
  const customRule = document.getElementById('schCustomRule')?.value ?? existing.customRule ?? '';
  return {
    every, runAt, timeZone,
    weekday: selectedWeekdays[0] || (every === 'weekly' ? null : legacyWeekday),
    weekdays: selectedWeekdays,
    monthDays: selectedMonthDays,
    monthDayPolicy: policy,
    startDate: every === 'once' || every === 'custom' ? null : startDate,
    endDate: every === 'once' || every === 'custom' ? null : endDate,
    ...(every === 'custom' ? { customRule: String(customRule).trim() } : {}),
    ...(existing.id ? { scheduleId: existing.id } : {}),
  };
}

function _schTimingError(value, focus) {
  const existing = _schEditing && _schEditing !== 'new' ? _schEditing : undefined;
  const error = window.ScheduleTiming?.validate(value, existing) ||
    (!window.ScheduleTiming ? '\u65f6\u95f4\u8bbe\u7f6e\u5c1a\u672a\u5c31\u7eea\uff0c\u8bf7\u91cd\u65b0\u6253\u5f00\u81ea\u52a8\u5316' : '');
  if (error && focus) {
    let inputId = value.every === 'once' ? 'schRunAt' : value.every === 'custom' ? 'schCustomRule' :
      value.every !== 'hourly' && (!Number.isInteger(value.atHour) || value.atHour < 0 || value.atHour > 23) ? 'schH' : 'schM';
    if (/\u5f00\u59cb\u65e5\u671f/.test(error)) inputId = 'schStartDate';
    else if (/\u7ed3\u675f\u65e5\u671f/.test(error)) inputId = 'schEndDate';
    else if (/\u661f\u671f/.test(error)) inputId = 'schWeekdays';
    else if (/\u6708\u5ea6\u65e5\u671f/.test(error)) inputId = 'schMonthDays';
    let input = document.getElementById(inputId);
    if ((inputId === 'schWeekdays' || inputId === 'schMonthDays') && input &&
        typeof input.querySelector === 'function') {
      input = input.querySelector('input') || input;
    }
    if (input) {
      input.classList.add('invalid'); input.setAttribute('aria-invalid', 'true');
      input.focus({ preventScroll: true });
    }
    if (typeof petSay === 'function') petSay(_schTx(error));
  }
  return error;
}

function _schSyncTiming(every) {
  const customRule = document.getElementById('schCustomRule');
  if (customRule) { customRule.classList.remove('invalid'); customRule.removeAttribute('aria-invalid'); }
  const field = document.getElementById('schOnceWrap');
  const input = document.getElementById('schRunAt');
  if (!field || !input) return;
  field.style.display = every === 'once' ? '' : 'none';
  input.required = every === 'once';
  input.classList.remove('invalid'); input.removeAttribute('aria-invalid');
  const fired = _schEditing && _schEditing.onceFired && _schReadTiming().runAt === _schEditing.runAt;
  document.getElementById('schOnceHint').textContent = _schTx(fired
    ? '本次预约已触发；修改为将来时间可重新预约' : '到点触发一次；失败按设置重试');
}

/*
 * Preview the next run directly from current selections using the same scheduling rules as
 * the backend.
 */
function _schNextPreview() {
  const every = document.getElementById('schEvery').value;
  const timing = _schReadTiming();
  timing.atHour = window.ScheduleTiming.clockNumber(document.getElementById('schH').value);
  timing.atMinute = window.ScheduleTiming.clockNumber(document.getElementById('schM').value);
  if (every === 'once') {
    const previous = _schEditing || {};
    if (previous.onceFired && timing.runAt === previous.runAt) return _schTx('\u672c\u6b21\u9884\u7ea6\u5df2\u89e6\u53d1');
    const error = _schTimingError(timing);
    if (error) return _schTx(error);
    if (Date.parse(timing.runAt) <= Date.now()) return _schTx('\u7b49\u5f85\u8865\u8dd1\u4e00\u6b21');
    return '\u4e0b\u4e00\u6b21\uff1a' + _schTx(window.ScheduleTiming.summary(timing));
  }

  if (every === 'custom') {
    const error = _schTimingError(timing);
    if (error) return _schTx(error);
    return _schTx('保存后由服务端计算下一次执行时间');
  }

  const error = _schTimingError(timing);
  for (const id of ['schH', 'schM', 'schStartDate', 'schEndDate']) {
    const control = document.getElementById(id);
    if (control) { control.classList.remove('invalid'); control.removeAttribute('aria-invalid'); }
  }
  if (error) return _schTx(error);

  // Compare wall-clock fields in the saved zone, independently of the OS zone.
  const localNow = window.ScheduleTiming.localInput(new Date().toISOString(), timing.timeZone);
  const now = new Date(localNow + 'Z');
  const key = value => {
    const date = value instanceof Date ? value : new Date(value);
    return date.getUTCFullYear() + '-' + _sp2(date.getUTCMonth() + 1) + '-' + _sp2(date.getUTCDate());
  };
  const startKey = timing.startDate || '';
  const endKey = timing.endDate || '';
  const allowed = value => (!startKey || value >= startKey) && (!endKey || value <= endKey);
  const candidate = (day, hour, minute) => {
    const value = new Date(day);
    value.setUTCHours(hour, minute, 0, 0);
    return value;
  };
  const show = value => {
    const today = key(value) === key(now);
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const dateLabel = (window.SoduWorkI18n && typeof window.SoduWorkI18n.t === 'function')
      ? window.SoduWorkI18n.t('\u007bvalue1\u007d\u6708\u007bvalue2\u007d\u65e5',
        (value.getUTCMonth() + 1) + '\u6708' + value.getUTCDate() + '\u65e5',
        { value1: value.getUTCMonth() + 1, value2: value.getUTCDate() })
      : (value.getUTCMonth() + 1) + '\u6708' + value.getUTCDate() + '\u65e5';
    const label = today ? _schTx('\u4eca\u5929') : key(value) === key(tomorrow) ? _schTx('\u660e\u5929') : dateLabel;
    return _schTx('\u4e0b\u4e00\u6b21\uff1a') + label + ' ' + _sp2(value.getUTCHours()) + ':' + _sp2(value.getUTCMinutes());
  };

  if (every === 'hourly') {
    const probe = new Date(now);
    probe.setUTCSeconds(0, 0);
    if (startKey && key(probe) < startKey) {
      const [year, month, day] = startKey.split('-').map(Number);
      probe.setUTCFullYear(year, month - 1, day);
      probe.setUTCHours(0, timing.atMinute, 0, 0);
    } else {
      probe.setUTCMinutes(timing.atMinute, 0, 0);
    }
    if (probe <= now) probe.setUTCHours(probe.getUTCHours() + 1);
    if (allowed(key(probe))) return show(probe);
    return _schTx('\u8ba1\u5212\u5df2\u8d85\u51fa\u6709\u6548\u65e5\u671f\u8303\u56f4');
  }

  const selectedWeekdays = Array.isArray(timing.weekdays) ? timing.weekdays : [];
  const selectedMonthDays = Array.isArray(timing.monthDays) ? timing.monthDays : [];
  const probe = startKey && startKey > key(now) ? new Date(startKey + 'T00:00:00Z') : new Date(now);
  probe.setUTCHours(0, 0, 0, 0);
  for (let offset = 0; offset <= 62; offset += 1) {
    const day = new Date(probe);
    day.setUTCDate(probe.getUTCDate() + offset);
    const dateKey = key(day);
    if (endKey && dateKey > endKey) break;
    if (!allowed(dateKey)) continue;
    let matches = every === 'daily';
    if (every === 'weekly') {
      const weekday = day.getUTCDay() || 7;
      matches = selectedWeekdays.includes(weekday);
    }
    if (every === 'monthly') {
      const lastDay = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0)).getUTCDate();
      const monthDay = day.getUTCDate();
      const mapped = selectedMonthDays.some(value => value <= lastDay ? value === monthDay :
        timing.monthDayPolicy === 'last_day' && monthDay === lastDay);
      matches = mapped;
    }
    if (matches) {
      const run = candidate(day, timing.atHour, timing.atMinute);
      if (run > now) return show(run);
    }
  }
  return _schTx('\u8ba1\u5212\u5df2\u8d85\u51fa\u6709\u6548\u65e5\u671f\u8303\u56f4');
}

// Share presentation between editing-time and mandatory save-time preflight so stale successful states cannot remain visible.
function _schRenderPreflight(line, result = {}) {
  if (!line) return;
  line.className = 'sch-ready ' + (result.state || 'waiting');
  line.querySelector('b').textContent = _schTx(result.message || '执行条件待确认');
  if (result.machine && result.machine.name) {
    line.querySelector('b').textContent += ' · ' + result.machine.name;
  }
  const checks = (result.checks || []).map(item => item.label && _schTx(item.label)).filter(Boolean);
  const small = line.querySelector('small');
  small.textContent = checks.join(' · ');
  line.title = checks.join('\n');
  if (result.remedy && result.state !== 'ready') {
    /*
     * Link missing authorization/runtime results directly to the relevant Runner management
     * view.
     */
    const fix = document.createElement('button');
    fix.type = 'button';
    fix.className = 'btn-mini';
    fix.textContent = '去处理';
    fix.addEventListener('click', () => {
      if (typeof openAgentsPanel === 'function') openAgentsPanel({ tab: 'runners' });
      else if (typeof openAgentsEntry === 'function') openAgentsEntry();
    });
    small.appendChild(document.createTextNode(' '));
    small.appendChild(fix);
  }
}
