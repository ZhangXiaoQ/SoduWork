/*
 * Requirement creation forms, attachments, team assignment, and direct AI/workflow
 * dispatch. Classic scripts share global scope.
 */

/* Create a requirement. */
/* Hold selected Files until requirement creation, then upload them under its ID. */
let _pendingAtts = [];
let _addPendingTask = null;
function _renderPendingAtts() {
  const box = document.getElementById('addAttList');
  if (!box) return;
  box.innerHTML = _pendingAtts.map((f, i) =>
    '<span class="add-att-chip"><span class="add-att-ico">' + _fileIcon(f.name, f.type) + '</span>' +
    '<span class="add-att-nm" title="' + esc(f.name) + '">' + esc(f.name) + '</span>' +
    '<span class="add-att-sz">' + _fmtSize(f.size) + '</span>' +
    '<button type="button" class="add-att-x" data-rm="' + i + '" title="移除">✕</button></span>').join('');
  box.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => {
    _pendingAtts.splice(parseInt(b.getAttribute('data-rm'), 10), 1); _renderPendingAtts();
  }));
}
function _addPendingFiles(fl) {
  for (const f of (fl || [])) if (f) _pendingAtts.push(f);
  _renderPendingAtts();
}

function openAdd() {
  const mask = document.getElementById('addMask');
  if (!mask) return;
  mask.classList.add('show');
  const _m = mask.querySelector('.modal');
  if (_m && typeof placeDockPopup === 'function') placeDockPopup(_m);
  if (typeof expandForOverlay === 'function') expandForOverlay();
  const today = _todayInputValue();
  ['inStart', 'inDue'].forEach((id) => {
    const el = document.getElementById(id);
    if (el && !el.value) el.value = today;
  });
  const ti = document.getElementById('inTitle');
  if (ti) setTimeout(() => ti.focus(), 60);
  // Bind attachment selection and drag/drop once.
  if (!openAdd._attWired) {
    openAdd._attWired = true;
    const inp = document.getElementById('addAttInput');
    const pick = document.getElementById('addAttPick');
    const zone = document.getElementById('addAttZone');
    if (pick && inp) pick.addEventListener('click', () => inp.click());
    if (inp) inp.addEventListener('change', () => { _addPendingFiles(inp.files); inp.value = ''; });
    if (zone) {
      ['dragenter', 'dragover'].forEach(e => zone.addEventListener(e, ev => { ev.preventDefault(); ev.stopPropagation(); zone.classList.add('drag'); }));
      ['dragleave', 'dragend'].forEach(e => zone.addEventListener(e, ev => { ev.preventDefault(); zone.classList.remove('drag'); }));
      zone.addEventListener('drop', ev => { ev.preventDefault(); ev.stopPropagation(); zone.classList.remove('drag'); _addPendingFiles(ev.dataTransfer && ev.dataTransfer.files); });
    }
  }
  _pendingAtts = []; _renderPendingAtts();
  const af = document.getElementById('addAttField'); if (af) af.style.display = '';
  const hp0 = document.getElementById('handlerPick'); const hf0 = hp0 && hp0.closest('.field');
  if (hf0) hf0.style.display = 'none';   // Hide the obsolete handler selector while self-assignment is its only option.

  /* Task creation is one-time; recurring work belongs to Automation. */
  _requestPopulateAssign();
  _fillAddGo();
}

/*
 * Offer immediate AI dispatch within requirement creation and restore the previous valid
 * repository, executor, and workflow selections.
 */
const _GO_KEY = 'soduwork_work_lastgo_v2';          /* Remember only the last valid execution mode, runtime, and repository. */
function _addSameId(left, right) {
  return String(left == null ? '' : left).trim().toLowerCase() ===
    String(right == null ? '' : right).trim().toLowerCase();
}
function _addAvailable(item) {
  if (!item || typeof item !== 'object') return false;
  const flag = item.available;
  if (flag === false || flag === 0) return false;
  const normalized = String(flag == null ? '' : flag).trim().toLowerCase();
  return normalized !== 'false' && normalized !== '0' &&
    normalized !== 'no' && normalized !== 'offline' && normalized !== 'unavailable';
}
function _goLast() {
  try { return JSON.parse(localStorage.getItem(_GO_KEY) || '{}') || {}; } catch (e) { return {}; }
}
function _goRemember(v) {
  try { localStorage.setItem(_GO_KEY, JSON.stringify(v)); } catch (e) { /* Continue without persistence when storage is unavailable. */ }
}
let _addGoLoadSeq = 0;
let _addGoReloadTimer = 0;
let _addGoPending = Promise.resolve();
let _addGoQueryKey = '';
let _addGoRepos = [];
let _addGoOptions = null;
let _addGoPluginRenderKey = '';

function _goStrategyValue() {
  return (document.querySelector('input[name=addGoStrategy]:checked') || {}).value || 'manual';
}
function _goRequestBody(repoId) {
  const tagText = ((document.getElementById('inTags') || {}).value || '').trim();
  return {
    title: ((document.getElementById('inTitle') || {}).value || '').trim(),
    note: ((document.getElementById('inNote') || {}).value || '').trim(),
    tags: tagText ? tagText.split(/[,，]/).map(s => s.trim()).filter(Boolean) : [],
    repoId: repoId === undefined ? (((document.getElementById('addGoRepo') || {}).value) || '') : repoId
  };
}
function _queueAddGoReload() {
  clearTimeout(_addGoReloadTimer);
  _addGoReloadTimer = setTimeout(() => _fillAddGo({ keepStrategy: true }), 320);
}
function _goUnavailable() {
  const field = document.getElementById('addGoField');
  const mode = document.getElementById('addGoMode');
  const who = document.getElementById('addGoWho');
  const repo = document.getElementById('addGoRepo');
  const loading = document.getElementById('addGoLoading');
  if (!field) return;
  field.classList.remove('is-loading');
  field.classList.add('is-unavailable');
  _addGoQueryKey = '';
  if (loading) {
    loading.style.display = '';
    loading.innerHTML = '<span>执行选项没有加载成功；仍可仅创建需求，修改内容或工程后会自动重试。</span>';
  }
  if (!_addGoOptions) {
    _addGoRepos = [];
    [mode, who, repo].forEach((el) => { if (el) el.disabled = true; });
  } else {
    if (mode) mode.disabled = true;
    if (who) who.disabled = true;
    if (repo) repo.disabled = false;
  }
  document.querySelectorAll('input[name=addGoStrategy]').forEach((el) => {
    el.checked = el.value === 'manual';
    el.disabled = el.value !== 'manual';
  });
  _goModeSync();
}
function _fillAddGo(config) {
  clearTimeout(_addGoReloadTimer);
  _addGoReloadTimer = 0;
  const raw = _loadAddGo(config || {});
  let safe;
  safe = raw.catch(() => {
    if (_addGoPending === safe) _goUnavailable();
  });
  _addGoPending = safe;
  return safe;
}
async function _loadAddGo(config) {
  const seq = ++_addGoLoadSeq;
  const field = document.getElementById('addGoField');
  const mode = document.getElementById('addGoMode');
  const who = document.getElementById('addGoWho');
  const repo = document.getElementById('addGoRepo');
  const loading = document.getElementById('addGoLoading');
  if (!field || !mode || !who || !repo) return;
  if (!(window.SoduWorkAPI && SoduWorkAPI.taskExecutionOptions && SoduWorkAPI.dispatchToAI)) {
    field.style.display = 'none';
    return;
  }
  field.style.display = '';
  field.classList.add('is-loading');
  field.classList.remove('is-unavailable');
  const last = _goLast();
  if (!_loadAddGo._wired) {
    _loadAddGo._wired = true;
    document.querySelectorAll('input[name=addGoStrategy]').forEach(
      el => el.addEventListener('change', _goModeSync));
    mode.addEventListener('change', _goModeSync);
    who.addEventListener('change', _goModeSync);
    repo.addEventListener('change', () => {
      clearTimeout(_addGoReloadTimer);
      _addGoReloadTimer = 0;
      _fillAddGo({ keepStrategy: true, repoId: repo.value });
    });
    ['inTitle', 'inNote', 'inTags'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', _queueAddGoReload);
    });
  }
  if (!_addGoOptions) {
    [mode, who, repo].forEach((el) => {
      el.disabled = true; el.innerHTML = '<option>正在加载…</option>';
    });
  }
  if (loading) {
    loading.style.display = '';
    loading.innerHTML = '<i></i><span>正在匹配工程、工作流和执行底座…</span>';
  }
  const requestedRepo = config.repoId !== undefined
    ? String(config.repoId || '')
    : String(repo.value || last.repoId || '');
  const request = _goRequestBody(requestedRepo);
  const previousFlow = mode.value;
  const previousSubstrate = who.value;
  let result;
  try {
    result = await SoduWorkAPI.taskExecutionOptions(request);
  } catch (error) {
    if (seq !== _addGoLoadSeq) return;
    throw error;
  }
  if (seq !== _addGoLoadSeq || document.getElementById('addGoWho') !== who) return;
  const normalizedResult = result || {};
  _addGoOptions = {
    ...normalizedResult,
    substrates: window.TaskExecutionClient?.targets
      ? TaskExecutionClient.targets(normalizedResult)
      : (normalizedResult.substrates || []),
  };
  _addGoQueryKey = JSON.stringify(request);
  _addGoPluginRenderKey = '';
  const model = document.getElementById('addGoModel');
  if (model) {
    const previousModel = model.value || '';
    const models = (result.models || []).filter(Boolean);
    model.innerHTML = '<option value="">' + esc('跟随底座默认') + '</option>' +
      models.map(item => '<option value="' + esc(item) + '">' + esc(item) + '</option>').join('');
    if (models.includes(previousModel)) model.value = previousModel;
  }
  _addGoRepos = Array.isArray(result.repos) ? result.repos : [];
  const workflows = (result.workflows || []).filter(x => x && x.bindingId);
  const substrates = (_addGoOptions.substrates || []).filter(x => x && x.key);
  const recommendation = result.recommendation || {};

  repo.innerHTML = '<option value="">不关联工程 · 通用办公</option>' + _addGoRepos.map((r) =>
    '<option value="' + esc(r.id) + '">' +
    esc((r.projectName ? r.projectName + ' · ' : '') + r.name) + '</option>').join('');
  repo.disabled = false;
  repo.value = (result.selection && result.selection.repoId) || '';

  mode.innerHTML = workflows.length ? workflows.map((flow) => {
    const ready = typeof _fwpReady === 'function' ? _fwpReady(flow, result) : flow.runnable !== false;
    const blockers = ((flow.readiness || {}).blockers || []);
    const warning = ((flow.readiness || {}).warnings || [])[0] || '';
    // Show the enterprise workflow identity and delivery environment, such as QA or a department trial, when it is selected.
    const process = flow.process || {};
    const envs = (process.environments || []).map(env => env && env.label).filter(Boolean);
    const flowNote = process.enterprise ? [process.route,
      envs.length ? '交付环境：' + envs.join('、') : ''].filter(Boolean).join('；') : '';
    const detail = blockers[0] || warning || flowNote || flow.description || '';
    const tag = process.enterprise ? '【' + (process.label || '企业流程') + '】' : '';
    return '<option value="' + esc(flow.bindingId) + '" data-name="' + esc(flow.name) +
      '" data-detail="' + esc(detail) + '"' + (!ready ? ' disabled' : '') + '>' +
      esc(tag + flow.name + (flow.version ? ' · v' + flow.version : '') +
        (!ready ? ' · 尚未就绪' : flow.recommended ? ' · 推荐' : '')) + '</option>';
  }).join('') : '<option value="">当前需求没有匹配的工作流</option>';
  const runnableFlows = workflows.filter(flow => typeof _fwpReady === 'function' ? _fwpReady(flow, result) : flow.runnable !== false);
  mode.disabled = !runnableFlows.length;
  const rememberedFlow = String(last.workflowId || '').replace(/^plugin:/, '');
  const flowValue = [
    config.keepStrategy && previousFlow,
    rememberedFlow,
    recommendation.workflowBindingId,
    runnableFlows[0] && runnableFlows[0].bindingId
  ].find(value => value && runnableFlows.some(flow => _addSameId(flow.bindingId, value)));
  if (flowValue) mode.value = flowValue;

  who.innerHTML = substrates.length ? substrates.map((item) =>
    '<option value="' + esc(item.key) + '" data-name="' + esc(item.name) +
    '" data-detail="' + esc(item.note || '') + '"' + (!_addAvailable(item) ? ' disabled' : '') + '>' +
    esc(item.name + ' · 自动选择' +
      (item.onlineSeats ? '（' + item.onlineSeats + ' 个在线席位）' : '') +
      (!_addAvailable(item) ? ' · 能力未就绪' : '')) + '</option>').join('')
    : '<option value="">当前没有在线执行底座</option>';
  const availableSubstrates = substrates.filter(_addAvailable);
  who.disabled = !availableSubstrates.length;
  const rememberedSubstrate = String(last.substrateKey || last.agentId || '');
  const whoValue = [
    config.keepStrategy && previousSubstrate,
    rememberedSubstrate,
    recommendation.substrateKey,
    availableSubstrates[0] && availableSubstrates[0].key
  ].find(value => value && availableSubstrates.some(item => _addSameId(item.key, value)));
  if (whoValue) who.value = whoValue;

  const legacyStrategy = last.strategy ||
    (last.on ? (String(last.mode || '').indexOf('plugin:') === 0 ? 'workflow' : 'direct') : '');
  let strategy = config.keepStrategy ? _goStrategyValue() : (legacyStrategy || recommendation.strategy || 'manual');
  const valid = {
    manual: true,
    direct: !!availableSubstrates.length,
    workflow: !!runnableFlows.length
  };
  if (!valid[strategy]) strategy = valid[recommendation.strategy]
    ? recommendation.strategy : (valid.direct ? 'direct' : valid.workflow ? 'workflow' : 'manual');
  document.querySelectorAll('input[name=addGoStrategy]').forEach((el) => {
    el.disabled = !valid[el.value];
    el.checked = el.value === strategy;
    const label = el.closest('label');
    if (label) label.classList.toggle('is-recommended', el.value === recommendation.strategy);
  });
  const scene = document.getElementById('addGoScenario');
  if (scene) scene.textContent = ((result.scenario || {}).name || '');
  field.classList.remove('is-loading', 'is-unavailable');
  if (loading) loading.style.display = 'none';
  _goModeSync();
}

function _goPreviewHtml(kind, title, description, chips) {
  const icon = kind === 'workflow' ? 'flow' : kind === 'direct' ? 'ai' : 'inbox';
  return '<div class="add-go-preview ' + kind + '"><span class="add-go-preview-mark">' + _svg(icon) + '</span>' +
    '<span class="add-go-preview-copy"><small>本次将如何处理</small><b>' + esc(title) + '</b>' +
    '<i>' + esc(description) + '</i><span>' + (chips || []).filter(Boolean).map(item =>
      '<em>' + esc(item) + '</em>').join('') + '</span></span></div>';
}

function _renderAddPluginPicker() {
  const box = document.getElementById('addGoPluginConfig');
  const mode = document.getElementById('addGoMode');
  const workflows = ((_addGoOptions || {}).workflows || []).filter(flow =>
    flow && flow.bindingId && (typeof _fwpReady !== 'function' || _fwpReady(flow, _addGoOptions)));
  if (!box || _goStrategyValue() !== 'workflow' || !workflows.length) {
    if (box) { box.style.display = 'none'; box.innerHTML = ''; }
    _addGoPluginRenderKey = '';
    return;
  }
  const key = workflows.map(flow => flow.bindingId + ':' + flow.version).join('|');
  box.style.display = '';
  if (_addGoPluginRenderKey !== key) {
    box.innerHTML = _fwpSection(workflows, _addGoOptions || {});
    _addGoPluginRenderKey = key;
    _fwpBind('', box, (_tid, choice) => {
      if (!mode || !choice) return;
      mode.value = choice.id;
      _fwpSetSelected(box, choice.id);
      _goModeSync();
    }, _addGoOptions || {});
  }
  _fwpSetSelected(box, (mode && mode.value) || '');
}

function _goModeSync() {
  const strategy = _goStrategyValue();
  const mode = document.getElementById('addGoMode');
  const who = document.getElementById('addGoWho');
  const repo = document.getElementById('addGoRepo');
  const whoField = document.getElementById('addGoWhoField');
  const modelField = document.getElementById('addGoModelField');
  const flowField = document.getElementById('addGoFlowField');
  const tip = document.getElementById('addGoTip');
  if (whoField) whoField.style.display = strategy === 'direct' ? '' : 'none';
  if (flowField) flowField.style.display = 'none';
  const chosenAgent = ((_addGoOptions || {}).substrates || []).find(item => _addSameId(item.key, who && who.value));
  const routeLabel = chosenAgent && (chosenAgent.locationLabel || (chosenAgent.remote
    ? String.fromCharCode(0x8fdc, 0x7a0b) + ' Runner'
    : String.fromCharCode(0x672c, 0x673a)));
  const canPickModel = strategy === 'direct' && chosenAgent && chosenAgent.modelPick !== false &&
    ((_addGoOptions || {}).models || []).length;
  if (modelField) modelField.style.display = canPickModel ? '' : 'none';
  if (!canPickModel) {
    const modelInput = document.getElementById('addGoModel');
    if (modelInput) modelInput.value = '';
  }
  _renderAddPluginPicker();
  if (!tip) return;
  const scenario = (_addGoOptions && _addGoOptions.scenario) || {};
  const repoRow = (_addGoRepos || []).find(item => _addSameId(item.id, repo && repo.value));
  const baseChips = [scenario.name, repoRow && (repoRow.projectName || repoRow.name), routeLabel].filter(Boolean);
  if (strategy === 'manual') {
    tip.innerHTML = _goPreviewHtml('manual', '仅创建需求', repoRow
      ? '需求归入“' + repoRow.projectName + '”，由承办人稍后认领或安排。'
      : '需求进入需求池，不会自动启动 Agent。', baseChips.concat(['人工安排']));
    return;
  }
  if (strategy === 'workflow') {
    const flow = ((_addGoOptions || {}).workflows || []).find(item => _addSameId(item.bindingId, mode && mode.value));
    if (!flow) {
      tip.innerHTML = _goPreviewHtml('workflow', '暂时没有可运行的企业工作方法',
        '请检查项目绑定、审批版本和运行依赖。', baseChips.concat(['未就绪']));
      return;
    }
    const process = flow.process || {};
    const envs = (process.environments || []).map(item => item && item.label).filter(Boolean);
    const warning = ((flow.readiness || {}).warnings || [])[0];
    tip.innerHTML = _goPreviewHtml('workflow', flow.name,
      warning || process.route || flow.description || '按已审批版本自动推进，并在门禁处等待人工验收。',
      baseChips.concat([
        flow.projectSpecific ? '项目专属' : '组织通用',
        flow.version ? 'v' + flow.version : '',
        (flow.workflow || []).length ? (flow.workflow || []).length + ' 个节点' : '',
        envs.length ? envs.join(' / ') : '',
      ]));
    return;
  }
  const agent = ((_addGoOptions || {}).substrates || []).find(item => _addSameId(item.key, who && who.value));
  if (!agent) {
    tip.innerHTML = _goPreviewHtml('direct', '本机暂无可用 Agent',
      '请先在 Agent 管理中安装并启动 Runner。', baseChips.concat(['未就绪']));
    return;
  }
  tip.innerHTML = _goPreviewHtml('direct', agent.name,
    agent.note || scenario.reason || '由当前设备上的可用 Runner 执行并回传结果。',
    baseChips.concat(['当前设备', agent.onlineSeats ? agent.onlineSeats + ' 个在线席位' : '', '直接执行']));
}

/*
 * Disable submission during creation/dispatch to prevent duplicate requirements.
 */
function _goBusy(on, label) {
  const b = document.getElementById('addOk');
  if (!b) return;
  b.disabled = !!on;
  b.textContent = on ? (label || '正在交给 AI…') : '创建需求';
}
let _addSubmitting = false;
function _addSubmitIdle() {
  _addSubmitting = false;
  _goBusy(false);
}

/*
 * Persist the requirement before dispatch through the same backend API used by task
 * details; reuse its event and delivery semantics.
 */
async function _goDispatch(tid, title, go) {
  _goRemember(go.plugin
    ? { strategy: 'workflow', workflowId: go.plugin.bindingId,
        repoId: (go.repo && go.repo.id) || '' }
    : { strategy: 'direct', substrateKey: go.who.id,
        repoId: (go.repo && go.repo.id) || '' });
  try {
    if (typeof Store !== 'undefined' && !await Store.persistTask(tid)) throw new Error('需求尚未同步到服务端');
    if (go.plugin) {
      /* Start a WorkflowRun and let the workflow engine advance subsequent stages. */
      const run = await SoduWorkAPI.startTaskPlugin(tid, Object.assign({}, go.plugin.body || {}, {
        bindingId: go.plugin.bindingId,
        repoId: (go.repo && go.repo.id) || '',
        executionContext: go.executionContext || {}
      }));
      if (!run || run.ok === false) {
        throw new Error((run && (run.reason || run.error || run.message)) ||
          '\u4f01\u4e1a\u5de5\u4f5c\u6d41\u672a\u6210\u529f\u542f\u52a8');
      }
      if (typeof petSay === 'function') petSay('「' + title + '」已按「' + go.plugin.name + '」流程启动，到了要你验收的那一关我叫你~');
      if (typeof render === 'function') render();
      return { ok: true };
    }
    const result = await SoduWorkAPI.dispatchToAI(tid, go.who, '', go.repo, go.model || '', go.executionContext || null);
    if (!result || result.ok === false) {
      throw new Error((result && (result.reason || result.error || result.message)) ||
        '\u6267\u884c\u673a\u672a\u63a5\u53d7\u8fd9\u6b21\u6d3e\u6d3b');
    }
    if (typeof petSay === 'function') petSay('「' + title + '」已交给 ' + go.who.name + ' 去做，干完我叫你~');
    if (typeof render === 'function') render();
    return { ok: true };
  } catch (e) {
    /* Preserve the created requirement when dispatch fails and explain how to retry from its details. */
    if (typeof petSay === 'function') {
      petSay('需求建好了，但没交出去（' +
        (typeof _humanErr === 'function' ? _humanErr(e, '派活失败') : '派活失败') + '），可以在详情里重派');
    }
    return { ok: false, error: e };
  }
}

function _addExecutionContext() {
  const repoSel = document.getElementById('addGoRepo');
  const repo = (_addGoRepos || []).find(x => _addSameId(x.id, repoSel && repoSel.value)) || null;
  const scenario = (_addGoOptions && _addGoOptions.scenario) || {};
  const who = document.getElementById('addGoWho');
  const mode = document.getElementById('addGoMode');
  const model = document.getElementById('addGoModel');
  const executionContext = window.TaskExecutionClient
    ? TaskExecutionClient.context(_addGoOptions || {}, {
      strategy: _goStrategyValue(), agentId: who && who.value,
      substrateKey: who && who.value, workflowId: mode && mode.value,
      repoId: repo && repo.id, projectId: repo && repo.projectId,
      model: model && model.value,
    }) : null;
  return {
    repo: repo,
    projectId: (repo && repo.projectId) || '',
    workScenarioKey: scenario.key || '',
    workScenarioName: scenario.name || '',
    workRouting: scenario.routing || {},
    executionContext: executionContext
  };
}

/* Choose post-creation execution; repository and scenario remain requirement context even in create-only mode. */
function _addGoPayload(focusInvalid) {
  const strategy = _goStrategyValue();
  if (strategy === 'manual') return null;
  const who = document.getElementById('addGoWho');
  const mode = document.getElementById('addGoMode');
  const context = _addExecutionContext();
  if (strategy === 'workflow') {
    if (!mode || !mode.value) return { error: '当前没有可运行的企业工作方法' };
    const definitions = ((_addGoOptions || {}).workflows || []);
    const definition = window.TaskExecutionClient
      ? TaskExecutionClient.runnableWorkflow(definitions, mode.value)
      : definitions.find(item => item && _addSameId(item.bindingId, mode.value) &&
        item.runnable !== false);
    if (!definition) return { error: window.TaskExecutionClient
      ? TaskExecutionClient.workflowProblem(_addGoOptions || {}, mode.value)
      : '\u9009\u62e9\u7684\u5de5\u4f5c\u65b9\u6cd5\u5df2\u4e0d\u53ef\u7528' };
    const opt = mode.selectedOptions && mode.selectedOptions[0];
    const payload = _fwpPayload(document.getElementById('addGoPluginConfig'), mode.value, !!focusInvalid);
    if (!payload.ok) return { error: payload.reason || '这套工作方法尚未配置完整' };
    return { plugin: { bindingId: mode.value,
                       name: (opt && opt.dataset.name) || payload.name || '企业流程',
                       body: payload.body, definition },
             repo: context.repo, executionContext: context.executionContext };
  }
  if (!who || !who.value) return { error: '当前设备没有可用 Agent' };
  const opt = who.selectedOptions && who.selectedOptions[0];
  const r = context.repo;
  const root = (typeof workRoot === 'function') ? workRoot() : '';
  let repo = null;
  if (r) {
    const sep = root.indexOf('\\') >= 0 ? '\\' : '/';
    const sub = String(r.localDir || r.name).replace(/[\\/]+/g, sep).replace(/^[\\/]+|[\\/]+$/g, '');
    repo = { id: r.id, path: (root && sub) ? root + sep + sub : root, name: r.name, kind: r.kind,
             gitUrl: r.gitUrl, branch: r.branch, note: r.note, flow: true };
  }
  return { who: { id: who.value, type: (opt && opt.dataset.type) || 'agent',
                  name: (opt && opt.dataset.name) || who.value },
           repo: repo, model: String((context.executionContext || {}).model || ''),
           executionContext: context.executionContext };
}
async function _verifyAddPlugin(go) {
  if (!go || !go.plugin) return;
  const request = _goRequestBody();
  request.execution = Object.assign({}, (go.plugin.body || {}).execution || {});
  const verified = await SoduWorkAPI.taskExecutionOptions(request);
  const definition = window.TaskExecutionClient
    ? TaskExecutionClient.runnableWorkflow((verified || {}).workflows || [], go.plugin.bindingId)
    : null;
  if (!definition) {
    throw new Error(window.TaskExecutionClient
      ? TaskExecutionClient.workflowProblem(verified || {}, go.plugin.bindingId)
      : '\u9009\u62e9\u7684\u5de5\u4f5c\u65b9\u6cd5\u5df2\u4e0d\u53ef\u7528');
  }
  const normalized = verified || {};
  _addGoOptions = {
    ...normalized,
    substrates: window.TaskExecutionClient?.targets
      ? TaskExecutionClient.targets(normalized)
      : (normalized.substrates || []),
  };
  go.plugin.definition = definition;
}

/* Employees may assign requirements to eligible colleagues with an available SoduWork instance. */
function _resetAddForm() {
  _addPendingTask = null;
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value || ''; };
  ['inTitle', 'inSource', 'inReqName', 'inReqContact', 'inNote', 'inTags', 'inRemind'].forEach((id) => set(id, ''));
  const today = _todayInputValue(); set('inStart', today); set('inDue', today); set('inAssign', '');
  const prio = document.querySelector('input[name=prio][value=normal]'); if (prio) prio.checked = true;
  set('inStatus', 'todo');
}

function closeAdd() {
  const mask = document.getElementById('addMask');
  if (!mask) return;
  _addAssignLoadSeq++;
  _addAssignLoading = false;
  mask.classList.remove('show');
  if (typeof shrinkFromOverlay === 'function') shrinkFromOverlay();
}
async function _submitAdd() {
  if (_addSubmitting) return;
  const taskScope = window.SoduWorkAPI?.taskStorageKey?.('ops') || '';
  const sameTaskScope = () => taskScope === (window.SoduWorkAPI?.taskStorageKey?.('ops') || '');
  const title = (document.getElementById('inTitle').value || '').trim();
  if (!title) { petSay && petSay('需求名不能空哦'); return; }
  _addSubmitting = true;
  _goBusy(true, '正在确认执行方式…');
  const source = (document.getElementById('inSource').value || '').trim();
  const reqNameEl = document.getElementById('inReqName');
  const reqContactEl = document.getElementById('inReqContact');
  const requesterName = reqNameEl ? (reqNameEl.value || '').trim() : '';
  const requesterContact = reqContactEl ? (reqContactEl.value || '').trim() : '';
  const note = (document.getElementById('inNote').value || '').trim();
  const stEl = document.getElementById('inStatus');
  const st = (stEl && stEl.value) || 'todo';
  const hd = (document.querySelector('input[name=hd]:checked') || {}).value || 'me';
  const prio = (document.querySelector('input[name=prio]:checked') || {}).value || 'normal';
  const recur = '';
  const recurAt = null;
  const startEl = document.getElementById('inStart');
  const startVal = startEl ? startEl.value : '';
  let start = startVal ? new Date(startVal + 'T00:00:00').getTime() : null;
  const dueEl = document.getElementById('inDue');
  const dueVal = dueEl ? dueEl.value : '';
  let due = dueVal ? new Date(dueVal + 'T00:00:00').getTime() : null;
  /* Reject a start date after the deadline to avoid invalid schedule intervals. */
  if (start && due && start > due) { petSay && petSay('开始时间比截止还晚，已忽略开始时间'); start = null; }
  /*
   * Default one-off requirements to today's planned start. Recurring requirements use
   * cadence rather than a planned duration.
   */
  if (!start) { const d0 = new Date(); d0.setHours(0, 0, 0, 0); start = d0.getTime(); }
  const tagsEl = document.getElementById('inTags');
  const tagsRaw = tagsEl ? (tagsEl.value || '').trim() : '';
  const tags = tagsRaw ? tagsRaw.split(/[,，]/).map(s => s.trim()).filter(Boolean) : [];
  /*
   * Create-only mode does not await optional AI/workflow matching. Await those results only
   * when their execution mode is selected.
   */
  const selectedStrategy = _goStrategyValue();
  if (selectedStrategy !== 'manual') {
    const currentQuery = JSON.stringify(_goRequestBody());
    if (_addGoQueryKey !== currentQuery) await _fillAddGo({ keepStrategy: true });
    else await _addGoPending;
    if (!sameTaskScope()) { _addSubmitIdle(); return; }
  }
  let execution = _addExecutionContext();
  /* Reject reminders scheduled in the past. */
  const remindEl = document.getElementById('inRemind');
  let remindAt = null;
  if (remindEl && remindEl.value) {
    const t = new Date(remindEl.value).getTime();
    if (t > Date.now()) remindAt = t;
    else { petSay && petSay('提醒时间已过去，没设上哦'); }
  }
  /* Team assignment creates the requirement on the recipient's SoduWork, not the local task list. */
  const assignField = document.getElementById('assignField');
  const assignEl = document.getElementById('inAssign');
  const selectedAssignee = (assignField && assignField.style.display !== 'none' && assignEl)
    ? String(assignEl.value || '').trim() : '';
  let selectedMate = selectedAssignee
    ? _addAssignMembers.find((item) => _addSameId(item.id, selectedAssignee)) : null;
  /*
   * Self-assignment does not await the colleague directory. Explicit colleague selection
   * requires loaded, revalidated eligibility.
   */
  if (_addAssignLoading && selectedAssignee) {
    try { await _addAssignPending; } catch (_error) { /* Display the actionable unavailability reason below. */ }
    if (!sameTaskScope()) { _addSubmitIdle(); return; }
  }
  if (_addAssignLoading && selectedAssignee) {
    if (typeof petSay === 'function') petSay('同事清单暂时不可用，请刷新后再提交');
    _addSubmitIdle();
    return;
  }
  selectedMate = selectedAssignee
    ? _addAssignMembers.find((item) => _addSameId(item.id, selectedAssignee)) : null;
  if (selectedAssignee && !selectedMate) {
    if (typeof petSay === 'function') petSay('这位同事当前不可接收需求，请刷新后重新选择');
    _requestPopulateAssign();
    _addSubmitIdle();
    return;
  }
  const assignee = selectedMate ? selectedMate.id : '';
  let go = assignee ? null : _addGoPayload(true);
  let goWarning = '';
  if (go && go.error) {
    goWarning = String(go.error || 'AI 运行条件未满足');
    go = null;
  }
  if (go && go.plugin) {
    try {
      await _verifyAddPlugin(go);
    } catch (error) {
      goWarning = typeof _humanErr === 'function'
        ? _humanErr(error, '\u5de5\u4f5c\u6d41\u8fd0\u884c\u524d\u68c0\u67e5\u672a\u901a\u8fc7')
        : '\u5de5\u4f5c\u6d41\u8fd0\u884c\u524d\u68c0\u67e5\u672a\u901a\u8fc7';
      go = null;
    }
    if (!sameTaskScope()) { _addSubmitIdle(); return; }
  }
  execution = _addExecutionContext();
  _goBusy(true, '正在保存…');

  if (assignee) {
    try {
      if (!window.SoduWorkAPI || !SoduWorkAPI.createAssignedTask) {
        throw new Error('当前版本暂不支持直接交办，请升级 SoduWork 后重试');
      }
      const assignedTaskId = uid();
      const assigned = await SoduWorkAPI.createAssignedTask({
        taskId: assignedTaskId, title, note, priority: prio, start, due, tags,
        recur: recur || null, recurAt, assigneeUserId: assignee,
        requesterName, requesterContact,
        projectId: execution.projectId || null,
        repoId: (execution.repo && execution.repo.id) || '',
        workScenarioKey: execution.workScenarioKey || '',
        workScenarioName: execution.workScenarioName || '',
        workRouting: execution.workRouting || {},
      });
      if (!sameTaskScope()) { _addSubmitIdle(); return; }
      if (!assigned || !assigned.task || !assigned.task.id) {
        throw new Error('服务未确认需求创建');
      }
      let attachmentFailures = 0;
      if (_pendingAtts.length && SoduWorkAPI.uploadAttachment) {
        for (const file of _pendingAtts.slice()) {
          if (!sameTaskScope()) { _addSubmitIdle(); return; }
          try { await SoduWorkAPI.uploadAttachment(assigned.task.id, file); }
          catch (_uploadError) { attachmentFailures++; }
        }
      }
      if (!sameTaskScope()) { _addSubmitIdle(); return; }
      if (typeof petSay === 'function') {
        const targetName = assigned.targetName || '同事';
        petSay('已交给' + targetName + '「' + title + '」' +
          (attachmentFailures ? '，有 ' + attachmentFailures + ' 个附件上传失败' : ''));
      }
      /* Track a transferred task in details; never enqueue it on the sender. */
      _openCreatedTaskInChat(assigned.task.id, assigned.task.title || title, { ...assigned.task, readOnly: true });
    } catch (e) {
      if (typeof petSay === 'function') petSay(_humanErr(e, '派发没成功'));
      _addSubmitIdle();
      return;
    }
  } else {
    if (!_addPendingTask || _addPendingTask.scope !== taskScope) _addPendingTask = { id: uid(), scope: taskScope };
    const newId = _addPendingTask.id;
    const localTask = { id: newId, title, source, note, status: go ? 'todo' : st, handler: hd, createdAt: Date.now(), priority: prio, start: start, due: due, tags: tags, recur: recur || null, recurAt: recurAt, remindAt: remindAt, reminded: false, requesterName, requesterContact,
      projectId: execution.projectId || null, repoId: (execution.repo && execution.repo.id) || '',
      workScenarioKey: execution.workScenarioKey,
      workScenarioName: execution.workScenarioName,
      workRouting: Object.assign({}, execution.workRouting || {}, go && go.plugin
        ? { selectedStrategy: 'workflow', workflowBindingId: go.plugin.bindingId }
        : go ? { selectedStrategy: 'direct', selectedAgentKind: (go.who && (go.who.cliName || go.who.id)) || '', selectedModel: go.model || '' } : {}),
    };
    const existing = tasks.findIndex(task => task.id === newId);
    if (existing >= 0) Object.assign(tasks[existing], localTask); else tasks.push(localTask);
    save(); render();
    /*
     * Wait for the idempotent PUT result before closing the standalone creation window;
     * destroying its renderer would cancel requests and retries.
     */
    let persisted = true;
    if (typeof Store !== 'undefined') {
      try { persisted = await Store.persistTask(newId); }
      catch (_error) { persisted = false; }
    }
    if (!sameTaskScope()) { _addSubmitIdle(); return; }
    if (!persisted) {
      if (typeof Store !== 'undefined') {
        if (typeof Store.pauseUnconfirmedTask === 'function') Store.pauseUnconfirmedTask(newId);
      }
      if (typeof render === 'function') render();
      if (typeof petSay === 'function') petSay('SoduWork 服务尚未确认创建需求，请检查连接后重试');
      _addSubmitIdle();
      return;
    }
    const files = _pendingAtts.slice();
    if (files.length && window.SoduWorkAPI && SoduWorkAPI.uploadAttachment) {
      if (typeof petSay === 'function') petSay('收到「' + title + '」，上传附件中…');
      try {
        for (const f of files) {
          if (!sameTaskScope()) { _addSubmitIdle(); return; }
          await SoduWorkAPI.uploadAttachment(newId, f);
        }
        if (!sameTaskScope()) { _addSubmitIdle(); return; }
        if (typeof petSay === 'function') petSay('「' + title + '」附件已上传（' + files.length + '）~');
      } catch (e) {
        if (!sameTaskScope()) { _addSubmitIdle(); return; }
        if (typeof petSay === 'function') petSay('需求已建，附件上传失败' +
          (String(e).indexOf('413') >= 0 ? '：文件太大' : '，可到详情重试'));
      }
    } else if (typeof petSay === 'function') {
      petSay('收到「' + title + '」~');
    }
    /*
     * Persist before immediate AI dispatch so the backend can resolve the requirement ID;
     * attachment upload likewise follows synchronization.
     */
    if (goWarning) {
      if (typeof petSay === 'function') {
        petSay('需求已创建，但 AI 暂未启动（' + goWarning + '），可在详情补全运行条件后重试');
      }
      _pendingAtts = []; _renderPendingAtts();
      _resetAddForm(); _addSubmitIdle();
      _openCreatedTaskInChat(newId, title);
      closeAdd();
      if (typeof petReact === 'function') petReact('bounce');
      return;
    }
    const pluginInputs = go && go.plugin && go.plugin.definition &&
      Array.isArray(go.plugin.definition.inputs) ? go.plugin.definition.inputs : [];
    if (go && go.plugin && pluginInputs.length) {
      _goRemember({ strategy: 'workflow', workflowId: go.plugin.bindingId,
        repoId: (go.repo && go.repo.id) || '' });
      let outcome = null;
      try {
        if (!window.TaskPluginInput || typeof TaskPluginInput.start !== 'function') {
          throw new Error('插件执行组件没有加载成功');
        }
        outcome = await TaskPluginInput.start(newId, {
          plugin: go.plugin.definition,
          body: Object.assign({}, go.plugin.body || {}, {
            bindingId: go.plugin.bindingId,
            repoId: (go.repo && go.repo.id) || '',
          }),
          instruction: [title, note].filter(Boolean).join('\n\n'),
        });
      } catch (error) {
        if (typeof petSay === 'function') {
          petSay(typeof _humanErr === 'function'
            ? _humanErr(error, '需求已创建，但插件没有启动')
            : '需求已创建，但插件没有启动');
        }
      }
      _pendingAtts = [];
      _renderPendingAtts();
      _resetAddForm();
      _addSubmitIdle();
      if (outcome && outcome.prompted && typeof petSay === 'function') {
        petSay('需求已建好，还缺少少量必填信息；请在需求进展里补充后启动“' + go.plugin.name + '”。');
      }
      _openCreatedTaskInChat(newId, title);
      closeAdd();
      if (typeof petReact === 'function') petReact('bounce');
      return;
    }
    if (go) {
      /*
       * Finish dispatch before closing the creation window, which destroys this JavaScript
       * context and pending requests.
       */
      _goBusy(true);
      _goDispatch(newId, title, go).then((result) => {
        _resetAddForm(); _addSubmitIdle();
        /* Both success and failure must land in one collaboration session; failure stays retryable in the session. */
        _openCreatedTaskInChat(newId, title);
        closeAdd();
      });
      _pendingAtts = []; _renderPendingAtts();
      if (typeof petReact === 'function') petReact('bounce');
      return;
    }
    _goRemember({ strategy: 'manual', repoId: (execution.repo && execution.repo.id) || '' });
    if (typeof petReact === 'function') petReact('bounce');
  }
  _pendingAtts = []; _renderPendingAtts();
  _addSubmitIdle();
  closeAdd();
  _resetAddForm();
}
