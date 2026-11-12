/* Shared execution selector for requirement assignment and creation.
   Classic-script dependencies are declared in index.html and desk.html. */
const _CLI_CLS = { claude: 'cli-claude', opencode: 'cli-opencode', codex: 'cli-codex', pi: 'cli-pi' };
let _fwdTab = 'ai';
let _fwdTaskId = '';
let _fwdOptions = null;
let _fwdLocalAgents = [];
let _fwdLocalFailures = [];
let _fwdLocalLoading = false;
let _fwdLocalPaintPending = false;
let _repoCache = [];
let _fwdLoadSeq = 0;
let _fwdSelection = { ai: null, mate: null };
let _fwdModel = '';
let _fwdLoading = { ai: false, mate: false };
let _fwdMateRows = [];
let _fwdMateQuery = '';
let _fwdMateFilter = 'ready';
let _fwdMateReason = '';

function _fwdId(value) {
  return String(value == null ? '' : value).trim();
}

function _fwdBool(value) {
  const normalized = _fwdId(value).toLowerCase();
  return value === true || value === 1 || normalized === '1' ||
    normalized === 'true' || normalized === 'yes';
}

function _fwdAvailable(value) {
  if (!value || typeof value !== 'object') return false;
  const flag = value.available;
  if (flag === false || flag === 0) return false;
  const normalized = _fwdId(flag).toLowerCase();
  return normalized !== 'false' && normalized !== '0' &&
    normalized !== 'no' && normalized !== 'offline' && normalized !== 'unavailable';
}

function _fwdSameId(left, right) {
  return _fwdId(left).toLowerCase() === _fwdId(right).toLowerCase();
}

function _fwdReset(tid, force) {
  const key = _fwdId(tid);
  if (!force && _fwdTaskId === key) return;
  _fwdTaskId = key;
  _fwdLoadSeq++;
  _fwdOptions = null;
  _fwdLocalAgents = [];
  _fwdLocalFailures = [];
  _fwdLocalLoading = false;
  _fwdLocalPaintPending = false;
  _repoCache = [];
  _fwdSelection = { ai: null, mate: null };
  _fwdResetMethodChoice();
  _fwdModel = '';
  _fwdLoading = { ai: false, mate: false };
  _fwdMateRows = [];
  _fwdMateQuery = '';
  _fwdMateFilter = 'ready';
  _fwdMateReason = '';
  _fwpOpen = '';
}

function _fwdSwitch(tid, tab, options) {
  const opts = options || {};
  _fwdReset(tid, opts.fresh === true);
  _fwdTab = tab === 'mate' ? 'mate' : 'ai';
  const root = document.getElementById('fwdPop') || document;
  root.querySelectorAll('.fwd-tab').forEach(button => {
    const active = button.getAttribute('data-fwdtab') === _fwdTab;
    button.classList.toggle('on', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  const searchWrap = document.getElementById('fwdSearchWrap');
  if (searchWrap) searchWrap.hidden = _fwdTab !== 'ai';
  const searchEmpty = document.getElementById('fwdSearchEmpty');
  if (searchEmpty) searchEmpty.hidden = true;
  const note = document.getElementById('fwdNote');
  if (note) note.placeholder = _fwdTab === 'ai'
    ? '补充验收标准、口径或参考资料（选填）'
    : '给同事补充一句交代（选填）';
  const submission = document.getElementById('fwdSubmissionMode')?.closest('label');
  if (submission) submission.hidden = _fwdTab !== 'ai';
  const repo = document.getElementById('fwdRepo');
  if (repo) repo.style.display = _fwdTab === 'ai' ? '' : 'none';
  const preview = document.getElementById('fwdPrev');
  if (preview) { preview.style.display = 'none'; preview.innerHTML = ''; }
  const confirm = document.getElementById('fwdConfirm');
  if (confirm) confirm.onclick = () => _fwdConfirm(tid);
  window.ForwardSelect?.closeAll();
  const settingsTitle = root.querySelector('.fwd-settings-title');
  if (settingsTitle) settingsTitle.textContent = _fwdTab === 'ai' ? '执行设置' : '选择承办人';
  _fwdSetStatus('');
  if (_fwdTab === 'ai') _loadAIPickList(tid);
  else _loadMateList(tid);
}

function _joinPath(root, sub) {
  if (!root) return '';
  const sep = root.indexOf('\\') >= 0 ? '\\' : '/';
  const clean = String(sub || '').replace(/[\\/]+/g, sep).replace(/^[\\/]+|[\\/]+$/g, '');
  return clean ? root + sep + clean : root;
}

function _pickedRepo() {
  const select = document.getElementById('fwdRepoSel');
  if (!select || !select.value) return null;
  const row = (_repoCache || []).find(item => _fwdSameId(item.id, select.value));
  if (!row) return null;
  const root = typeof workRoot === 'function' ? workRoot() : '';
  return {
    id: row.id,
    path: root ? _joinPath(root, row.localDir || row.name) : '',
    name: row.name,
    kind: row.kind,
    gitUrl: row.gitUrl,
    branch: row.branch,
    note: row.note,
  };
}

function _fillRepoPicker(options) {
  const box = document.getElementById('fwdRepo');
  const select = document.getElementById('fwdRepoSel');
  const hint = document.getElementById('fwdRepoHint');
  if (!box || !select) return;
  _repoCache = Array.isArray(options && options.repos) ? options.repos : [];
  box.style.display = _fwdTab === 'ai' ? '' : 'none';
  select.innerHTML = '<option value="">不关联工程 · 通用办公</option>' + _repoCache.map(row =>
    '<option value="' + esc(row.id) + '">' +
      esc((row.projectName ? row.projectName + ' · ' : '') + row.name +
        (row.branch ? ' · ' + row.branch : '')) + '</option>').join('');
  select.value = String(((options || {}).selection || {}).repoId || '');
  select.disabled = !_repoCache.length;
  if (hint) hint.textContent = !_repoCache.length
    ? (((options || {}).selection || {}).projectLocked ? '需求所属项目暂无可关联工程。' : '当前账号暂无可关联工程，可选择不关联工程执行。')
    : ((options || {}).selection || {}).projectLocked
      ? '需求所属项目已锁定，只显示该项目的可用工程。' : '选择工程后会重新识别适用插件和交付路径。';
  if (!select.dataset.fwdWired) {
    select.dataset.fwdWired = '1';
    select.addEventListener('change', () => _loadAIPickList(_fwdTaskId, select.value));
  }
  window.ForwardSelect?.enhance(box);
}

function _fwdScenarioHtml(result) {
  const scenario = result.scenario || {};
  if (!scenario.name && !scenario.reason) return '';
  const selected = (result.selection || {}).repoId;
  const repo = (result.repos || []).find(item => _fwdSameId(item.id, selected));
  const chips = [];
  if (repo) chips.push('<em>' + esc(repo.projectName || repo.name) + '</em>');
  return "<div class=\"fwd-scenario\"><span><b" + (scenario.name ? ' data-user-content' : '') + '>' + esc(scenario.name || '已识别这项工作') + '</b>' +
    (scenario.reason ? '<small>' + esc(scenario.reason) + '</small>' : '') +
    '</span><span class="fwd-scenario-tags">' + chips.join('') + '</span></div>';
}

function _fwdDirectRow(item, recommended) {
  const ready = _fwdAvailable(item);
  const seats = Number(item.onlineSeats || 0);
  const versions = (item.versions || []).filter(Boolean);
  const sub = [item.note, versions.length ? '版本 ' + versions.join(' / ') : ''].filter(Boolean).join(' · ');
  const routeLabel = item.locationLabel || (item.remote
    ? String.fromCharCode(0x8fdc, 0x7a0b) + ' Runner'
    : String.fromCharCode(0x672c, 0x673a));
  const routedSub = [routeLabel, sub].filter(Boolean).join(' · ');
  return _fwdRow({
    id: item.key, type: 'direct', name: item.name || item.cli || 'Agent', ico: 'ai',
    tag: 'Agent', tagCls: _CLI_CLS[item.cli] || 'cli-other', cli: item.cli || '', sub: routedSub,
    busy: item.busySeats >= item.onlineSeats && seats > 0,
    off: !ready, disabled: !ready,
    isDef: _fwdSameId(recommended, item.key),
    meta: seats ? seats + ' 个在线席位' : '未就绪',
  });
}

async function _loadAIPickList(tid, repoId) {
  const box = document.getElementById('fwdList');
  if (!box || !(window.SoduWorkAPI && SoduWorkAPI.taskExecutionOptions)) return;
  const seq = ++_fwdLoadSeq;
  _fwdLocalAgents = [];
  _fwdLocalFailures = [];
  _fwdLocalLoading = false;
  _fwdLocalPaintPending = false;
  _fwdLoading.ai = true;
  _fwdRepoLoadState(false);
  _fwdSyncConfirm(tid);
  box.innerHTML = '<div class="fwd-loading"><i></i><span>正在核对需求、插件与本机 Agent…</span></div>';
  _fwdSetStatus('');
  let result;
  try {
    const selectedRepo = repoId === undefined
      ? String((((_fwdOptions || {}).selection || {}).repoId) || '') : String(repoId || '');
    result = await SoduWorkAPI.taskExecutionOptions({ taskId: tid, repoId: selectedRepo });
    if (result && result.ok === false) {
      throw new Error(result.reason || result.error || result.message || '执行方式没有加载成功');
    }
  } catch (error) {
    if (seq !== _fwdLoadSeq || document.getElementById('fwdList') !== box) return;
    _fwdLoading.ai = false;
    _fwdOptions = null;
    _fwdSelection.ai = null;
    _fwdRepoLoadState(true);
    const message = typeof _humanErr === 'function'
      ? _humanErr(error, '执行方式没有加载成功') : '执行方式没有加载成功';
    box.innerHTML = '<div class="fwd-empty is-error"><b>暂时无法安排</b><span>' + esc(message) +
      '</span><button type="button" data-fwd-retry>重试</button></div>';
    const retry = box.querySelector('[data-fwd-retry]');
    if (retry) retry.addEventListener('click', () => _loadAIPickList(tid, repoId));
    _fwdSyncConfirm(tid);
    return;
  }
  if (seq !== _fwdLoadSeq || document.getElementById('fwdList') !== box || _fwdTab !== 'ai') return;
  // Repository selection belongs to the executor; show the catalog immediately without awaiting local Agent probes.
  const normalizedResult = result || {};
  _fwdOptions = {
    ...normalizedResult,
    substrates: window.TaskExecutionClient?.targets
      ? TaskExecutionClient.targets(normalizedResult)
      : (normalizedResult.substrates || []),
  };
  _fillRepoPicker(_fwdOptions);
  _fwdLoading.ai = false;
  _fwdOptions.pluginInstallationUnknown = ['workflows', 'blockedWorkflows'].some(key =>
    (_fwdOptions[key] || []).some(item => item?.bindingId && !item.selectionSource && item.sourceKind !== 'builtin'));
  // Older Hubs may still return market entries. Unknown installation state is
  // never treated as an installed plugin by this assignment picker.
  for (const key of ['workflows', 'blockedWorkflows']) {
    _fwdOptions[key] = (_fwdOptions[key] || []).filter(_fwdInstalledMethod);
  }
  const task = tasks.find(item => _fwdSameId(item.id, tid));
  _fwdLocalLoading = Boolean(window.RequirementSessionChoice?.canUseLocalAgents?.(task, _fwdOptions));
  _fwdRestoreAIChoice();
  _fwdRenderAIPickers(tid, box);
  _fwdSyncConfirm(tid);
  _fwdCarry(tid);
  if (_fwdLocalLoading) void _fwdLoadLocalAgents(tid, task, box, seq);
}

async function _fwdLoadLocalAgents(tid, task, box, seq) {
  const current = () => seq === _fwdLoadSeq && document.getElementById('fwdList') === box && _fwdTab === 'ai';
  const paint = () => {
    const pop = document.getElementById('fwdPop');
    const menu = window.ForwardSelect?.capture(pop);
    const focused = document.activeElement?.dataset?.selectId || document.activeElement?.id;
    _fwdRestoreAIChoice();
    _fwdRenderAIPickers(tid, box);
    _fwdSyncConfirm(tid);
    if (menu) { window.ForwardSelect?.restore(menu, pop); return; }
    if (focused === 'fwdAgentSelect' || focused === 'fwdPluginSelect') {
      const select = document.getElementById(focused);
      if (window.ForwardSelect?.focus) window.ForwardSelect.focus(select); else select?.focus();
    }
  };
  try {
    const result = await window.RequirementSessionChoice.localAgents(task, _fwdOptions, agent => {
      if (!current()) return;
      if (!_fwdLocalAgents.some(row => _fwdSameId(row.key, agent.key))) _fwdLocalAgents.push(agent);
      // A late directory result must never replace controls during submission.
      if (document.getElementById('fwdConfirm')?.dataset.idleLabel == null) paint();
      else _fwdLocalPaintPending = true;
    });
    if (current()) _fwdLocalFailures = result?.failures || [];
  } catch (_) { /* The Hub directory remains usable when local detection fails. */ }
  if (!current()) return;
  _fwdLocalLoading = false;
  if (document.getElementById('fwdConfirm')?.dataset.idleLabel == null) paint();
  else _fwdLocalPaintPending = true;
}

async function _loadMateList(tid) {
  const box = document.getElementById('fwdList');
  if (!box || !(window.SoduWorkAPI && SoduWorkAPI.listTeammates)) return;
  const seq = ++_fwdLoadSeq;
  _fwdLoading.mate = true;
  _fwdMateReason = '';
  _fwdSyncConfirm(tid);
  box.innerHTML = '<div class="fwd-loading"><i></i><span>正在核对可转交的同事…</span></div>';
  let result;
  let loadError = false;
  try { result = await SoduWorkAPI.listTeammates(); }
  catch (error) {
    loadError = true;
    result = { mates: [], reason: '同事名单没有加载成功' };
  }
  if (seq !== _fwdLoadSeq || document.getElementById('fwdList') !== box || _fwdTab !== 'mate') return;
  _fwdLoading.mate = false;
  if (loadError || !result || result.ok === false) {
    _fwdMateRows = [];
    _fwdSelection.mate = null;
    const message = (result && result.reason) || '同事名单暂时无法加载';
    box.innerHTML = '<div class="fwd-empty is-error"><b>暂时无法加载同事</b><span>' +
      esc(message) + '</span><button type="button" data-fwd-mate-retry>重试</button></div>';
    const retry = box.querySelector('[data-fwd-mate-retry]');
    if (retry) retry.addEventListener('click', () => _loadMateList(tid));
    _fwdSyncConfirm(tid);
    return;
  }
  _fwdMateRows = _fwdNormalizeMates(result.mates);
  _fwdMateReason = _fwdId(result.reason);
  const current = _fwdSelection.mate;
  if (current && !_fwdMateRows.some(item => _fwdSameId(item.id, current.id) && item.hasBox)) {
    _fwdSelection.mate = null;
  }
  _fwdRenderMatePanel(box, tid);
  _fwdSyncConfirm(tid);
  _fwdCarry(tid);
}

function _fwdChoose(tid, choice) {
  if (document.getElementById('fwdConfirm')?.dataset.idleLabel != null) return;
  const previous = _fwdSelection[_fwdTab];
  if (_fwdTab === 'ai') _fwdRememberMethodChoice(choice);
  _fwdSelection[_fwdTab] = choice ? Object.assign({}, choice, {
    id: _fwdId(choice.id),
  }) : null;
  if (choice) _fwdSetStatus('');
  if (_fwdTab === 'ai' && (previous?.type !== choice?.type || previous?.id !== choice?.id)) {
    _fwpOpen = '';
    _fwdRenderAIPickers(tid, document.getElementById('fwdList'));
  }
  _fwdPaintSelection(document.getElementById('fwdList'));
  _fwdSyncConfirm(tid);
}

function _fwdWorkflowOf(id) {
  return ((_fwdOptions || {}).workflows || []).find(item =>
    _fwdSameId(item.bindingId, id)) || null;
}

function _fwdSubstrateOf(id) {
  return _fwdDirectAgents().find(item =>
    _fwdSameId(item.key, id)) || null;
}

function _fwdChoiceIsCurrent(choice) {
  if (choice?.type === 'native') return false;
  if (!choice || !_fwdAvailable(choice)) return false;
  const id = _fwdId(choice.id);
  if (!id) return false;
  if (choice.type === 'mate') {
    return _fwdMateRows.some(row => _fwdSameId(row.id, id) && row.hasBox);
  }
  if (choice.type === 'workflow') {
    const flow = _fwdWorkflowOf(id);
    return !!flow && (typeof _fwpReady !== 'function'
      ? flow.runnable !== false : _fwpReady(flow, _fwdOptions || {}));
  }
  if (choice.type === 'direct') {
    const agent = _fwdSubstrateOf(id);
    return !!agent && _fwdAvailable(agent);
  }
  return false;
}

function _fwdSyncConfirm(tid) {
  const decision = document.getElementById('fwdDecision');
  const button = document.getElementById('fwdConfirm');
  if (!decision || !button) return;
  const busy = !!button.dataset.idleLabel;
  window.ForwardSelect?.destroy(decision);
  if (_fwdLoading[_fwdTab]) {
    decision.innerHTML = '';
    button.disabled = true;
    return;
  }
  let choice = _fwdSelection[_fwdTab];
  if (choice?.type === 'direct' && _fwdLocalLoading && !_fwdChoiceIsCurrent(choice)) {
    decision.innerHTML = '';
    button.disabled = true;
    return;
  }
  if (choice && !_fwdChoiceIsCurrent(choice)) {
    _fwdSelection[_fwdTab] = null;
    choice = null;
  }
  if (!choice) {
    decision.innerHTML = '';
    button.disabled = true;
    button.textContent = _fwdTab === 'ai' ? '确认派活' : '确认转交';
    return;
  }
  const title = choice.name || '';
  const agent = choice.type === 'direct' ? _fwdSubstrateOf(choice.id) : null;
  if (!agent || agent.modelPick === false) _fwdModel = '';
  const modelState = _fwpModelState(_fwdOptions, _fwdModel);
  const modelHtml = agent && agent.modelPick !== false && (modelState.models.length || modelState.stale)
    ? '<label class="fwd-model"><span>本次模型</span><select id="fwdModel"' + (busy ? ' disabled' : '') + '>' +
      _fwpModelOptions(modelState, _fwpDefaultModelLabel(_fwdOptions, agent)) +
      '</select></label>' : '';
  let directoryHint = '';
  if (choice.type === 'direct' || choice.type === 'native') {
    if (_fwdOptions?.selection?.repoId) {
      directoryHint = '所选工程的工作目录由执行端确定。';
    } else if (choice.type === 'native' || (/^local:/.test(choice.id) && !agent?.remote &&
        (!agent?.locationMode || agent.locationMode === 'local'))) {
      directoryHint = '新建本机会话时，文件路径相对于独立的会话目录。会话建立后，点击「打开位置」可查看目录。';
    }
  }
  decision.innerHTML = modelHtml + (directoryHint ? '<small class="fwd-directory-hint">' + directoryHint + '</small>' : '');
  window.ForwardSelect?.enhance(decision);
  const modelSelect = document.getElementById('fwdModel');
  if (modelSelect) modelSelect.addEventListener('change', () => {
    if (button.dataset.idleLabel != null || (modelSelect.value && !modelState.models.includes(modelSelect.value))) return;
    _fwdModel = modelSelect.value || '';
    _fwdSetStatus('');
    _fwdSyncConfirm(tid);
    document.getElementById('fwdModel')?.focus();
  });
  const validAgent = choice.type !== 'workflow' || !document.getElementById('fwdAgentSelect') ||
    _fwpPayload(document.getElementById('fwdList'), choice.id, false).ok;
  button.disabled = busy || !_fwdChoiceIsCurrent(choice) || !validAgent || modelState.stale;
  if (modelState.stale) _fwdSetStatus('原模型已不可用，请重新选择', true);
  button.textContent = choice.type === 'workflow' ? '按这套方法开始' :
    choice.type === 'native' ? '确认在对话执行' :
    choice.type === 'direct' ? '确认交给 ' + title : '确认转给 ' + title;
}

function _fwdSetStatus(message, error) {
  const status = document.getElementById('fwdStatus');
  if (!status) return;
  status.classList.toggle('is-error', !!error);
  status.textContent = message || '';
}

function _fwdSetBusy(on, label) {
  const button = document.getElementById('fwdConfirm');
  if (!button) return;
  const controls = document.getElementById('fwdPop')?.querySelectorAll(
    '#fwdPluginSelect,#fwdAgentSelect,#fwdRepoSel,#fwdModel,#fwdSubmissionMode,#fwdNote,[data-fwp-model],[data-fwp-kind],.fwd-tab,[data-fwp-toggle],[data-fwd-recheck],[data-material-add],.rq-session-controls') || [];
  controls.forEach(control => {
    if (on) {
      if (control.dataset.fwdWasDisabled == null) control.dataset.fwdWasDisabled = control.disabled ? '1' : '0';
      control.disabled = true;
    } else if (control.dataset.fwdWasDisabled != null) {
      control.disabled = control.dataset.fwdWasDisabled === '1';
      delete control.dataset.fwdWasDisabled;
    }
  });
  if (on) {
    button.dataset.idleLabel = button.textContent;
    button.disabled = true;
    button.textContent = label || '正在安排…';
  } else {
    if (button.dataset.idleLabel) button.textContent = button.dataset.idleLabel;
    delete button.dataset.idleLabel;
    if (_fwdLocalPaintPending && _fwdTab === 'ai') {
      _fwdLocalPaintPending = false;
      _fwdRestoreAIChoice();
      _fwdRenderAIPickers(_fwdTaskId, document.getElementById('fwdList'));
    }
    _fwdSyncConfirm(_fwdTaskId);
  }
}

/* Structured plugin inputs are part of the task conversation, never the routing popover. */
const _TPI_KEY_PREFIX = 'soduwork.task-plugin-input.';
const _TPI_TTL = 30 * 60 * 1000;
let _tpiActiveTask = '';
let _tpiActiveHandle = null;
const _tpiDrafts = Object.create(null);

function _tpiText(value, limit) {
  return String(value == null ? '' : value).trim().slice(0, limit || 4000);
}

function _tpiPlugin(plugin) {
  const source = plugin || {};
  return {
    pluginId: _tpiText(source.pluginId || source.bindingId || source.key, 100),
    bindingId: _tpiText(source.bindingId || source.pluginId || source.key, 100),
    key: _tpiText(source.key, 100),
    name: _tpiText(source.name, 120) || '\u4f01\u4e1a\u5de5\u4f5c\u65b9\u6cd5',
    description: _tpiText(source.description, 500),
    version: _tpiText(source.version, 40),
    inputs: Array.isArray(source.inputs) ? source.inputs.slice(0, 50) : [],
    workflow: (Array.isArray(source.workflow) ? source.workflow : []).slice(0, 8).map(node => ({
      key: _tpiText(node && node.key, 80), name: _tpiText(node && node.name, 120),
    })),
  };
}

function _tpiKey(taskId) {
  const scope = window.SoduWorkAPI?.taskStorageKey?.('ops');
  return scope ? _TPI_KEY_PREFIX + encodeURIComponent(scope) + '.' + String(taskId || '') : '';
}

function _tpiSeed(taskId, request) {
  const source = request || {};
  const task = (typeof tasks !== 'undefined' ? tasks : []).find(
    item => String(item.id) === String(taskId || '')) || {};
  return String(source.instruction || [task.title, task.note].filter(Boolean).join('\n\n')).trim();
}

function _tpiFallbackPlan(plugin, seed, savedValues) {
  const fields = window.PluginInputSheet && typeof PluginInputSheet.normalizeInputs === 'function'
    ? PluginInputSheet.normalizeInputs(plugin.inputs) : (plugin.inputs || []);
  const saved = savedValues && typeof savedValues === 'object' ? savedValues : {};
  const values = {};
  fields.forEach(field => {
    if (Object.prototype.hasOwnProperty.call(field, 'default')) values[field.key] = field.default;
    if (Object.prototype.hasOwnProperty.call(saved, field.key)) values[field.key] = saved[field.key];
  });
  const hasValue = (field, value) => field.type === 'boolean' ? value === true
    : field.type === 'number' ? value !== '' && value != null && Number.isFinite(Number(value))
      : Boolean(String(value == null ? '' : value).trim());
  let missing = fields.filter(field => field.required && !hasValue(field, values[field.key]));
  const goalKeys = new Set(['goal', 'objective', 'request', 'requirement', 'prompt', 'instruction',
    'task', 'query', 'question', 'topic', 'brief', 'description', 'content', 'message']);
  const goalLabel = /(?:目标|需求|要求|需求|问题|主题|说明|描述|背景|内容|指令|要做什么)/;
  const candidates = missing.filter(field => ['text', 'textarea'].includes(field.type) &&
    (goalKeys.has(String(field.key || '').toLowerCase()) || goalLabel.test(String(field.label || ''))));
  const preferred = candidates.filter(field => goalKeys.has(String(field.key || '').toLowerCase()));
  const message = String(seed || '').trim();
  let inferred = [];
  if (message && preferred.length === 1) inferred = preferred;
  else if (message && missing.length === 1 && candidates.length === 1) inferred = candidates;
  inferred.forEach(field => { values[field.key] = message; });
  missing = fields.filter(field => field.required && !hasValue(field, values[field.key]));
  return { fields, values, missing, ready: !missing.length };
}

function _tpiPlan(plugin, seed, savedValues) {
  if (window.ChatPluginMention && typeof ChatPluginMention.prepareConversationInputs === 'function') {
    return ChatPluginMention.prepareConversationInputs(plugin.inputs, seed, savedValues);
  }
  return _tpiFallbackPlan(plugin, seed, savedValues);
}

function _tpiPrepare(taskId, request) {
  const id = String(taskId || '');
  const source = request || {};
  const plugin = _tpiPlugin(source.plugin);
  const instruction = _tpiSeed(id, source);
  const draft = _tpiDrafts[id];
  const savedValues = Object.assign({}, (source.body || {}).inputs || {},
    source.initialValues || {}, draft && draft.bindingId === plugin.bindingId ? draft.values : {});
  return { id, source, plugin, instruction, plan: _tpiPlan(plugin, instruction, savedValues) };
}

function _tpiQueue(taskId, request) {
  const prepared = _tpiPrepare(taskId, request);
  const { id, source, plugin, instruction, plan } = prepared;
  if (!id || !plugin.bindingId || plan.ready || !plan.missing.length) return false;
  const body = source.body || {};
  const record = {
    at: Date.now(), taskId: id, plugin,
    instruction, initialValues: plan.values,
    body: {
      bindingId: plugin.bindingId,
      repoId: _tpiText(body.repoId, 100),
      execution: body.execution && typeof body.execution === 'object' ? body.execution : {},
    },
  };
  try { const key = _tpiKey(id); if (!key) return false; localStorage.setItem(key, JSON.stringify(record)); return true; }
  catch (_error) { return false; }
}

function _tpiRead(taskId) {
  const id = String(taskId || '');
  try {
    const key = _tpiKey(id); if (!key) return null;
    const record = JSON.parse(localStorage.getItem(key) || 'null');
    if (!record || record.taskId !== id || Date.now() - Number(record.at || 0) > _TPI_TTL) {
      localStorage.removeItem(_tpiKey(id)); return null;
    }
    return record;
  } catch (_error) { return null; }
}

function _tpiClear(taskId) {
  const id = String(taskId || '');
  delete _tpiDrafts[id];
  try { localStorage.removeItem(_tpiKey(id)); } catch (_error) {}
}

async function _tpiStart(taskId, request, values) {
  const scope = window.RequirementAssignment.scope();
  const plugin = _tpiPlugin(request.plugin);
  const body = Object.assign({}, request.body || {}, {
    bindingId: plugin.bindingId,
    inputs: values || {},
    instruction: String(request.instruction || '').trim(),
  });
  let run;
  try { run = await SoduWorkAPI.startTaskPlugin(taskId, body); }
  catch (error) {
    const message = typeof _humanErr === 'function'
      ? _humanErr(error, '\u6d41\u7a0b\u6ca1\u6709\u542f\u52a8') : (error && error.message);
    throw new Error(message || '\u6d41\u7a0b\u6ca1\u6709\u542f\u52a8\uff0c\u8bf7\u91cd\u8bd5');
  }
  if (!window.RequirementAssignment.inScope(scope)) return false;
  _tpiClear(taskId);
  _tpiSuspend(taskId);
  const task = (typeof tasks !== 'undefined' ? tasks : []).find(item => String(item.id) === String(taskId));
  if (task && task.status === 'todo') {
    task.status = 'doing';
    if (typeof save === 'function') save();
  }
  if (typeof petSay === 'function') {
    petSay('\u201c' + plugin.name + '\u201d\u5df2\u5f00\u59cb\uff0c\u8fdb\u5ea6\u3001\u95e8\u7981\u548c\u8bc1\u636e\u4f1a\u6301\u7eed\u56de\u5230\u9700\u6c42\u91cc\u3002');
  }
  await window.RequirementAssignment.completed(taskId, scope);
  return true;
}

function _tpiOpen(taskId, request) {
  const scope = window.RequirementAssignment.scope();
  const prepared = _tpiPrepare(taskId, request);
  const { id, source, plugin, instruction, plan } = prepared;
  if (!id || plan.ready || !plan.missing.length || !window.PluginInputSheet) return false;
  const queued = _tpiQueue(id, Object.assign({}, source, {
    plugin, instruction, initialValues: plan.values,
  }));
  if (!queued) return false;
  const host = document.querySelector('.rq-detail-content');
  if (!host || host?.dataset.taskId !== id) {
    Promise.resolve(window.RequirementsDetail.open(id)).then(() => {
      if (window.RequirementAssignment.inScope(scope) &&
          document.querySelector('.rq-detail-content')?.dataset.taskId === id) _tpiResume(id);
    });
    return true;
  }
  const seed = instruction;
  const draft = _tpiDrafts[id];
  const initialValues = draft && draft.bindingId === plugin.bindingId
    ? Object.assign({}, plan.values, draft.values) : plan.values;
  _tpiActiveTask = id;
  const handle = PluginInputSheet.open({
    plugin: Object.assign({}, plugin, { inputs: plan.missing }),
    host: () => {
      const node = document.querySelector('.rq-detail-content');
      return node?.dataset.taskId === id ? node : null;
    },
    anchor: () => document.querySelector('.rq-detail-materials'),
    seed,
    initialValues,
    onChange: (values) => {
      _tpiDrafts[id] = {
        bindingId: plugin.bindingId, values: Object.assign({}, plan.values, values || {}),
      };
    },
    surfaceContext: 'task',
    eyebrow: 'TASK WORKFLOW',
    contextLabel: '\u9700\u6c42\u4e0a\u4e0b\u6587',
    sectionTitle: '\u542f\u52a8\u524d\u8865\u5145',
    sectionSubtitle: '\u53ea\u6536\u96c6\u8fd9\u5957\u5de5\u4f5c\u65b9\u6cd5\u5fc5\u9700\u7684\u4fe1\u606f',
    footnote: '\u63d0\u4ea4\u540e\u9501\u5b9a\u63d2\u4ef6\u7248\u672c\uff0c\u8fdb\u5ea6\u4e0e\u8bc1\u636e\u56de\u5230\u9700\u6c42\u94fe\u8def',
    submitLabel: '\u786e\u8ba4\u5e76\u542f\u52a8',
    busyLabel: '\u6b63\u5728\u5efa\u7acb\u6267\u884c\u94fe\u8def\u2026',
    onApply: (_prompt, values) => _tpiStart(id,
      Object.assign({}, source, { plugin, instruction }), Object.assign({}, plan.values, values)),
    onClose: () => { _tpiClear(id); if (_tpiActiveTask === id) { _tpiActiveTask = ''; _tpiActiveHandle = null; } },
  });
  if (!handle) { _tpiActiveTask = ''; return false; }
  _tpiActiveHandle = handle;
  setTimeout(() => handle.root && handle.root.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 0);
  return true;
}

async function _tpiStartOrPrompt(taskId, request) {
  const prepared = _tpiPrepare(taskId, request);
  const { id, source, plugin, instruction, plan } = prepared;
  if (!id || !plugin.bindingId) throw new Error('插件执行信息不完整，请重新选择');
  if (plan.ready) {
    await _tpiStart(id, Object.assign({}, source, { plugin, instruction }), plan.values);
    return { started: true, prompted: false };
  }
  const prompted = _tpiOpen(id, Object.assign({}, source, {
    plugin, instruction, initialValues: plan.values,
  }));
  if (!prompted) throw new Error('需求输入区没有准备好，请关闭后重试');
  return { started: false, prompted: true };
}

function _tpiResume(taskId) {
  const id = String(taskId || '');
  if (_tpiActiveTask === id) {
    if (document.querySelector('.rq-detail-content .pis-surface')) return true;
    _tpiActiveTask = '';
  }
  const record = _tpiRead(id);
  return record ? _tpiOpen(id, record) : false;
}

function _tpiSuspend(taskId) {
  if (!_tpiActiveTask || _tpiActiveTask !== String(taskId || '')) return;
  _tpiActiveHandle?.close(true);
  _tpiActiveHandle = null; _tpiActiveTask = '';
}

window.TaskPluginInput = {
  open: _tpiOpen, start: _tpiStartOrPrompt, queue: _tpiQueue,
  resume: _tpiResume, clear: _tpiClear, prepare: _tpiPrepare,
  suspend: _tpiSuspend,
};
window.addEventListener('soduwork-data-scope-changed', () => {
  _tpiSuspend(_tpiActiveTask);
  for (const id of Object.keys(_tpiDrafts)) delete _tpiDrafts[id];
});

async function _fwdConfirm(tid) {
  const scope = window.RequirementAssignment.scope();
  let choice = _fwdSelection[_fwdTab];
  if (!choice) return;
  if (!_fwdChoiceIsCurrent(choice)) {
    _fwdSelection[_fwdTab] = null;
    _fwdSyncConfirm(tid);
    _fwdSwitch(tid, _fwdTab);
    _fwdSetStatus('\u6267\u884c\u9009\u9879\u5df2\u66f4\u65b0\uff0c\u8bf7\u91cd\u65b0\u9009\u62e9\u53ef\u7528\u9879', true);
    return;
  }
  if (_fwdTab === 'mate') return _handoffTo(tid, choice.id, choice.name);
  if (choice.type === 'native') return _dispatchNativeTo(tid);
  if (choice.type === 'direct') {
    if (_fwdSubstrateOf(choice.id)?.modelPick !== false && _fwpModelState(_fwdOptions, _fwdModel).stale) {
      _fwdSyncConfirm(tid);
      _fwdSetStatus('原模型已不可用，请重新选择', true);
      document.getElementById('fwdModel')?.focus();
      return;
    }
    return _dispatchAITo(tid, { id: choice.id, type: 'agent', cliName: choice.cli || '' }, choice.name);
  }
  const box = document.getElementById('fwdList');
  const payload = typeof _fwpPayload === 'function' ? _fwpPayload(box, choice.id, true) :
    { ok: false, reason: '插件执行组件没有加载成功' };
  if (!payload.ok) { _fwdSetStatus(payload.reason, true); return; }
  const flow = _fwdWorkflowOf(choice.id) || {};
  const note = ((document.getElementById('fwdNote') || {}).value || '').trim();
  const submissionMode = String(document.getElementById('fwdSubmissionMode')?.value || '');
  const repo = _pickedRepo();
  payload.body.instruction = note;
  payload.body.repoId = (repo && repo.id) || '';
  if (submissionMode === 'auto' || submissionMode === 'manual') payload.body.submissionMode = submissionMode;
  if ((flow.inputs || []).length) {
    _fwdSetBusy(true, '正在准备执行…');
    _fwdSetStatus('正在结合需求上下文核对插件所需信息…');
    try {
      const outcome = await TaskPluginInput.start(tid, {
        plugin: flow, body: payload.body, instruction: note,
      });
      if (!window.RequirementAssignment.inScope(scope)) return;
      _closeFwd();
      if (outcome.prompted && typeof petSay === 'function') {
        petSay('还缺少少量必填信息，请在需求详情里补充后启动“' + (flow.name || payload.name) + '”。');
      }
    } catch (error) {
      _fwdSetBusy(false);
      _fwdSetStatus(typeof _humanErr === 'function'
        ? _humanErr(error, '流程没有启动') : (error.message || '流程没有启动'), true);
    }
    return;
  }
  _fwdSetBusy(true, '正在启动完整流程…');
  _fwdSetStatus('正在锁定插件版本并建立执行链路…');
  try {
    const run = await SoduWorkAPI.startTaskPlugin(tid, payload.body);
    if (!window.RequirementAssignment.inScope(scope)) return;
    if (!run || run.ok === false) {
      throw new Error((run && (run.reason || run.error || run.message)) ||
        '\u63d2\u4ef6\u6ca1\u6709\u6210\u529f\u542f\u52a8');
    }
    const task = tasks.find(item => _fwdSameId(item.id, tid));
    if (task && task.status === 'todo') { task.status = 'doing'; save(); render(); }
    _closeFwd();
    await window.RequirementAssignment.completed(tid, scope);
    if (typeof petSay === 'function') petSay('“' + payload.name + '”已经开始，进度、门禁和证据都会留在需求里。');

  } catch (error) {
    _fwdSetBusy(false);
    _fwdSetStatus(typeof _humanErr === 'function' ? _humanErr(error, '流程没有启动') : '流程没有启动', true);
  }
}

async function _fwdCarry(tid) {
  const foot = document.getElementById('fwdFoot');
  if (!foot) return;
  const carryTask = _fwdId(tid);
  const carryTab = _fwdTab;
  const carrySeq = _fwdLoadSeq;
  const task = tasks.find(item => _fwdId(item.id) === carryTask) || {};
  const pieces = [];
  if ((task.note || '').trim()) pieces.push('需求说明');
  if ((task.tags || []).length) pieces.push((task.tags || []).length + ' 个标签');
  if ((task.progress || []).some(item => (item.text || '').trim())) pieces.push('已有进展');
  let count = 0;
  if (!document.querySelector('.fwd-materials')) {
    try { count = ((await SoduWorkAPI.listAttachments(tid)) || []).filter(item => !item.byAgent).length; } catch (error) {}
  }
  if (count) pieces.push(count + ' 个附件');
  if (document.getElementById('fwdFoot') !== foot ||
      _fwdTaskId !== carryTask || _fwdTab !== carryTab || _fwdLoadSeq !== carrySeq) return;
  if (carryTab === 'ai') {
    foot.innerHTML = '<span>会带过去：需求标题' + (pieces.length ? ' · ' + esc(pieces.join(' · ')) : '') +
      '</span>';
  } else {
    foot.innerHTML = '<span>需求及' + (pieces.length ? esc(pieces.join('、')) : '全部信息') +
      '会一起转到对方 SoduWork</span>';
  }
}

async function _fwdPreview(tid) {
  const box = document.getElementById('fwdPrev');
  if (!box) return;
  if (box.style.display !== 'none') { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = 'block';
  box.innerHTML = '<div class="fwd-loading"><i></i><span>正在整理派活原文…</span></div>';
  try {
    const brief = (document.getElementById('fwdNote') || {}).value || '';
    const result = await SoduWorkAPI.aiPreview(tid, brief.trim(), _pickedRepo());
    if (document.getElementById('fwdPrev') !== box) return;
    box.innerHTML = '<div class="fwd-prev-h">将发送给 Agent 的完整内容</div>' +
      "<div class=\"fwd-prev-t\"" + ((result || {}).title ? ' data-user-content' : '') + '>' + esc((result || {}).title || '') + '</div>' +
      "<pre class=\"fwd-prev-b\"" + ((result || {}).description ? ' data-user-content' : '') + '>' + esc((result || {}).description || '') + '</pre>';
  } catch (error) {
    box.innerHTML = '<div class="fwd-msg is-err">派活原文暂时无法预览</div>';
  }
}

function _closeFwd() {
  _fwdLoadSeq++;
  const popup = document.getElementById('fwdPop');
  if (popup) popup.style.display = 'none';
  window.RequirementAssignment?.close();
}
