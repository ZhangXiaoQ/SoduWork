/*
 * Enterprise method picker accepts only approved, bound, user-visible versions from
 * task-execution-options. Do not reconstruct eligibility from separate plugin, Runner, or
 * project catalogs.
 */
let _fwpOpen = '';

function _fwpRuntimeRequirements(plugin) {
  const capability = plugin.capabilities || {};
  const workflow = plugin.workflow || [];
  if (!workflow.length) return [capability.runtime || []];
  return workflow.filter(node => (node.type === 'ai' || node.type === 'ai_review') &&
    (!node.route || node.route.agentSource === 'runtime'))
    .map(node => (node.route && node.route.runtime) || capability.runtime || []);
}

function _fwpAvailable(value) {
  if (!value || typeof value !== 'object') return false;
  const flag = value.available;
  if (flag === false || flag === 0) return false;
  const normalized = String(flag == null ? '' : flag).trim().toLowerCase();
  return normalized !== 'false' && normalized !== '0' &&
    normalized !== 'no' && normalized !== 'offline' && normalized !== 'unavailable';
}

function _fwpSeatCanRun(substrate, requirements) {
  if (!_fwpAvailable(substrate)) return false;
  const sets = Array.isArray(substrate.capabilitySets) ? substrate.capabilitySets : [];
  if (!requirements.some(items => (items || []).length) || !sets.length) return true;
  return requirements.every(required => {
    const need = (required || []).map(String);
    return !need.length || sets.some(items => need.every(key => (items || []).includes(key)));
  });
}

function _fwpUsesRuntime(plugin) {
  const workflow = plugin.workflow || [];
  if (!workflow.length) return true;
  return workflow.some(node => (node.type === 'ai' || node.type === 'ai_review') &&
    (!node.route || node.route.agentSource === 'runtime'));
}

function _fwpSubstrates(options, plugin) {
  const requirements = _fwpRuntimeRequirements(plugin);
  const substrates = window.TaskExecutionClient?.targets
    ? TaskExecutionClient.targets(options || {}) : (options.substrates || []);
  const rows = substrates.filter(item =>
    item && item.key && _fwpSeatCanRun(item, requirements)).map(item => ({
      value: item.key,
      label: item.name || item.key,
      note: item.note || '',
      onlineSeats: Number(item.onlineSeats || 0),
      modelPick: item.modelPick !== false,
    }));
  // Automatic routing may use different Agents for different runtime nodes.
  // Only a user-selected global default must cover every such node itself.
  const available = substrates.filter(_fwpAvailable);
  const autoReady = available.length && requirements.every(required =>
    available.some(item => _fwpSeatCanRun(item, [required])));
  if (plugin.runnable !== false && autoReady) {
    rows.unshift({ value: '', label: '由 SoduWork 按节点自动选择',
      note: '遵循插件路由和当前设备在线状态',
      modelPick: rows.every(item => item.modelPick !== false) });
  }
  return rows;
}

function _fwpReady(plugin, options) {
  const blockers = ((plugin || {}).readiness || {}).blockers || [];
  if (!plugin || plugin.runnable === false || blockers.length) return false;
  return !_fwpUsesRuntime(plugin) || _fwpSubstrates(options || {}, plugin).length > 0;
}

function _fwpOption(value, label, selected) {
  return '<option value="' + esc(value) + '"' + (value === selected ? ' selected' : '') + '>' +
    esc(label) + '</option>';
}

function _fwpModelLabel(options, name) {
  const rows = (options?.modelOptions || []).filter(item => item?.name === name);
  if (!rows.length || rows.some(item => !String(item.providerName || '').trim())) return name;
  // Repeated model names can refer to different providers. Never guess which
  // provider an inherited or explicitly selected name will resolve to.
  if (rows.length > 1 && rows.some(item => !item.providerId)) return name;
  const ids = new Set(rows.map(item => item.providerId || item.providerName));
  const names = new Set(rows.map(item => String(item.providerName).trim()));
  return ids.size === 1 && names.size === 1 ? name + ' · ' + [...names][0] : name;
}

function _fwpModelState(options, selected) {
  // The API's legacy list deliberately omits its default. Keep every usable
  // catalog entry selectable, including a catalog containing just one model.
  const models = Array.from(new Set([options?.defaultModel, ...(options?.models || []),
    ...(options?.modelOptions || []).map(item => item.name)].filter(Boolean)));
  const value = String(selected || '');
  return {models, labels: Object.fromEntries(models.map(name => [name, _fwpModelLabel(options, name)])),
    value, stale: Boolean(value && !models.includes(value))};
}

function _fwpDefaultModelLabel(options, agent) {
  const cli = String(agent?.cli || agent?.key || '').replace(/^local:/, '');
  // Defer remote or mixed-seat resolution without claiming which device owns
  // the preference; dispatch may use the requesting credential owner's model.
  if (agent?.remote || agent?.locationMode === 'remote' || agent?.locationMode === 'mixed')
    return '跟随默认模型（派发时解析）';
  if (options?.defaultModelErrors?.[cli]) return '底座默认不可用，请明确选择模型';
  const resolved = options?.defaultModels?.[cli];
  if (resolved) return '跟随底座默认 · ' + _fwpModelLabel(options, resolved);
  return options?.defaultModel ? '跟随底座默认（目录默认：' + _fwpModelLabel(options, options.defaultModel) + '）' : '跟随底座默认';
}

function _fwpModelOptions(state, defaultLabel) {
  return (state.stale ? '<option value="__unselected__" disabled selected>原模型已不可用，请重新选择</option>' : '') +
    _fwpOption('', defaultLabel, state.stale ? null : state.value) +
    state.models.map(item => _fwpOption(item, state.labels?.[item] || item, state.stale ? null : state.value)).join('');
}

function _fwpRouteLabel(node) {
  const route = node.route || {};
  if (['plugin', 'project'].includes(route.agentSource) && route.agentKind) return route.agentKind.replace(/^local:/, '');
  return route.agentSource === 'runtime' ? '运行时选择' : '';
}

function _fwpFlow(plugin) {
  const nodes = plugin.workflow || [];
  if (!nodes.length) {
    return '<div class="fwp-direct-use"><b>单 Agent 能力</b><span>按这套企业方法完成当前需求，并保留结果与证据。</span></div>';
  }
  const visible = nodes.slice(0, 6).map((node, index) => {
    const route = _fwpRouteLabel(node);
    return '<span class="fwp-step"><b>' + (index + 1) + '</b><span>' + esc(node.name || node.key) +
      (route ? '<small>' + esc(route) + '</small>' : '') + '</span></span>';
  }).join('');
  return '<div class="fwp-flow">' + visible +
    (nodes.length > 6 ? '<span class="fwp-more">+' + (nodes.length - 6) + '</span>' : '') + '</div>';
}

function _fwpEnvironment(plugin) {
  const process = plugin.process || {};
  const envs = (process.environments || []).map(env => env && env.label).filter(Boolean);
  if (!process.route && !envs.length) return '';
  return '<div class="fwp-process"><span>' + esc(process.route || '执行路径') + '</span>' +
    envs.map(label => '<em>' + esc(label) + '</em>').join('') + '</div>';
}

function _fwpCard(plugin, options, separateAgent = false, selection = null) {
  const process = plugin.process || {};
  const readiness = plugin.readiness || {};
  const blockers = readiness.blockers || [];
  const warnings = readiness.warnings || [];
  const runnable = plugin.runnable !== false && !blockers.length;
  const hasWorkflow = (plugin.capabilities || {}).executionMode === 'workflow' ||
    (plugin.workflow || []).length > 0;
  const interactive = Boolean(plugin.ui && Array.isArray(plugin.ui.contributions) &&
    plugin.ui.contributions.length);
  const usesRuntime = _fwpUsesRuntime(plugin);
  const substrates = usesRuntime ? _fwpSubstrates(options, plugin) : [];
  const routeReady = !usesRuntime || substrates.length > 0;
  const available = runnable && routeReady;
  // Node-specific routes are authoritative. Do not turn a project recommendation
  // into a global override for every otherwise-unconfigured node.
  const selectedKind = selection?.kind ?? ((substrates[0] || {}).value || '');
  const entryLabel = window.TaskExecutionClient ? TaskExecutionClient.nodeAgentLabel(plugin) : '';
  const selectedSubstrate = substrates.find(item => item.value === selectedKind);
  const modelState = _fwpModelState(options, selection?.model);
  const canPickModel = !selectedSubstrate || selectedSubstrate.modelPick !== false;
  const open = _fwpOpen === plugin.bindingId || (canPickModel && modelState.stale);
  const scope = plugin.projectSpecific ? '项目专属' : '组织通用';
  const status = available ? '已就绪' : '执行条件未满足';
  const reason = blockers[0] || (!routeReady ? '当前设备没有满足节点要求的 Agent' : warnings[0] || '');
  return '<article class="fwp-card' + (separateAgent ? ' fwp-assignment-details' : '') + (open ? ' is-expanded' : '') + (available ? '' : ' is-blocked') +
    '" data-fwp-card="' + esc(plugin.bindingId) + '" data-fwp-mode="' +
    (hasWorkflow ? 'workflow' : 'direct') + '" data-fwp-ready="' + (available ? '1' : '0') +
    '" data-fwp-name="' + esc(plugin.name) + '">' +
    '<button type="button" class="fwp-summary" data-fwp-toggle aria-expanded="' + (open ? 'true' : 'false') + '">' +
      (separateAgent ? '<span>插件流程与配置</span>' :
      '<span class="fwp-radio" aria-hidden="true"><i></i></span>' +
      '<span class="fwp-mark">' + _svg(hasWorkflow ? 'flow' : 'ai') + '</span>' +
      "<span class=\"fwp-copy\"><b data-user-content>" + esc(plugin.name) + "</b><i" + (plugin.description ? ' data-user-content' : '') + '>' +
        esc(plugin.description || (hasWorkflow ? '按已发布流程推进并留存门禁证据' : '使用企业方法完成当前需求')) + '</i></span>' +
      '<span class="fwp-badges">' + (plugin.recommended ? '<em class="is-recommended">推荐</em>' : '') +
        (interactive ? '<em class="is-interactive" title="需要在需求详情等可见页面中使用">交互插件</em>' : '') +
        '<em>' + esc(scope) + '</em><small>v' + esc(plugin.version || '-') + ' · ' + status + '</small></span>') +
      '<span class="fwp-chevron">⌄</span></button>' +
    '<div class="fwp-body"' + (open ? '' : ' hidden') + '>' +
      '<div class="fwp-identity"><b>' + esc(process.label || (hasWorkflow ? (interactive ? '交互需求流程' : '自动化工作流') : '企业能力')) +
        '</b><span>已审批版本 · ' + esc(scope) + '</span></div>' +
      _fwpFlow(plugin) + _fwpEnvironment(plugin) +
      (entryLabel ? '<div class="fwp-entry-route">' + esc(entryLabel) +
        '<span>按节点配置执行；后续节点分别沿用各自配置。</span></div>' : '') +
      (reason ? '<div class="fwp-readiness ' + (available ? 'is-warn' : 'is-blocked') + '">' + esc(reason) + '</div>' : '') +
      ((plugin.inputs || []).length ? '<div class="fwp-input-note"><span><b>' + (plugin.inputs || []).length +
        '\u9879\u542f\u52a8\u4fe1\u606f</b><small>\u786e\u8ba4\u540e\u5728\u9700\u6c42\u5bf9\u8bdd\u533a\u586b\u5199\uff0c\u4e0d\u4f1a\u6324\u5728\u5f53\u524d\u5f39\u5c42\u3002</small></span>' +
        '<em>\u7ee7\u7eed\u540e\u586b\u5199</em></div>' : '') +
      (usesRuntime ? '<div class="fwp-runtime"><label class="fwp-route"' + (separateAgent ? ' hidden' : '') + '><span>未指定节点的 Agent</span><select data-fwp-kind' +
        (routeReady ? '' : ' disabled') + '>' + substrates.map(item => _fwpOption(item.value,
          item.label + (item.onlineSeats ? ' · ' + item.onlineSeats + ' 个在线席位' : ''), selectedKind)).join('') +
        "</select><small" + ((substrates.find(item => item.value === selectedKind) || {}).note ? ' data-user-content' : '') + '>' + esc(((substrates.find(item => item.value === selectedKind) || {}).note) ||
          '固定路由节点仍按插件配置执行') + '</small></label>' +
        (modelState.models.length || modelState.stale ? '<label class="fwp-model" data-fwp-model-wrap' + (canPickModel ? '' : ' hidden') +
          '><span>本次模型 <i>可选</i></span><select data-fwp-model' + (separateAgent ? ' id="fwdWorkflowModel"' : '') + (canPickModel ? '' : ' disabled') + '>' +
          _fwpModelOptions(modelState, '沿用节点配置，未指定时跟随默认') + '</select></label>' : '') + '</div>' : '') +
    '</div></article>';
}

function _fwpSection(plugins, options, firstChoice = '') {
  if ((!plugins || !plugins.length) && !firstChoice) return '';
  plugins = plugins || [];
  const runnable = plugins.filter(item => _fwpReady(item, options || {})).length;
  if (plugins.length && !runnable && !plugins.some(item => String(item.bindingId || '') === _fwpOpen)) {
    _fwpOpen = String(plugins[0].bindingId || '');
  }
  return '<section class="fwp-area"><div class="fwp-title"><span><b>选择工作方法</b>' +
    '<i>' + (firstChoice ? '默认不用插件，也可手动选择已授权的插件' :
      '可选已授权的插件，也可直接交给 Agent；推荐不代替你的选择') + '</i></span><em>' + runnable + ' 项插件可运行</em></div>' +
    firstChoice + plugins.map(plugin => _fwpCard(plugin, options || {})).join('') + '</section>';
}

function _fwpCardById(box, bindingId) {
  return Array.from((box || document).querySelectorAll('[data-fwp-card]')).find(card =>
    card.getAttribute('data-fwp-card') === String(bindingId || '')) || null;
}

function _fwpSetSelected(box, bindingId) {
  (box || document).querySelectorAll('[data-fwp-card]').forEach(card =>
    card.classList.toggle('is-selected', card.getAttribute('data-fwp-card') === String(bindingId || '')));
}

function _fwpSyncModel(card, options) {
  const kind = card && card.querySelector('[data-fwp-kind]');
  const model = card && card.querySelector('[data-fwp-model]');
  const wrap = card && card.querySelector('[data-fwp-model-wrap]');
  if (!kind || !model || !wrap) return;
  const substrate = _fwpSubstrates(options || {}, {
    runnable: true, capabilities: { executionMode: 'direct' }, workflow: []
  }).find(item => item.value === kind.value);
  const allowed = !substrate || substrate.modelPick !== false;
  wrap.hidden = !allowed;
  model.disabled = !allowed;
  if (!allowed) model.value = '';
}

function _fwpBind(tid, box, onChoose, options) {
  box.querySelectorAll('[data-fwp-card]').forEach(card => {
    _fwpSyncModel(card, options);
    const kind = card.querySelector('[data-fwp-kind]');
    if (kind) kind.addEventListener('change', () => _fwpSyncModel(card, options));
  });
  box.querySelectorAll('[data-fwp-toggle]').forEach(button => button.addEventListener('click', event => {
    event.preventDefault(); event.stopPropagation();
    const card = button.closest('[data-fwp-card]');
    const body = card && card.querySelector('.fwp-body');
    if (!card || !body) return;
    const willOpen = body.hidden;
    box.querySelectorAll('[data-fwp-card]').forEach(other => {
      const otherBody = other.querySelector('.fwp-body');
      const otherButton = other.querySelector('[data-fwp-toggle]');
      other.classList.remove('is-expanded');
      if (otherBody) otherBody.hidden = true;
      if (otherButton) otherButton.setAttribute('aria-expanded', 'false');
    });
    body.hidden = !willOpen;
    card.classList.toggle('is-expanded', willOpen);
    button.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    _fwpOpen = willOpen ? card.getAttribute('data-fwp-card') : '';
    const choose = onChoose || (typeof _fwdChoose === 'function' ? _fwdChoose : null);
    if (card.getAttribute('data-fwp-ready') === '1' && choose) {
      choose(tid, {
        type: 'workflow', id: card.getAttribute('data-fwp-card'),
        name: card.getAttribute('data-fwp-name') || '工作流', available: true,
      });
    }
  }));
  box.querySelectorAll('[data-fwp-kind],[data-fwp-model]').forEach(input => {
    input.addEventListener('input', () => {
      if (typeof _fwdSyncConfirm === 'function') _fwdSyncConfirm(tid);
    });
    input.addEventListener('change', () => {
      if (typeof _fwdSyncConfirm === 'function') _fwdSyncConfirm(tid);
    });
  });
}

function _fwpPayload(box, bindingId, focusInvalid) {
  const card = _fwpCardById(box, bindingId);
  if (!card) return { ok: false, reason: '选择的工作方法已经不可用，请重新选择' };
  if (card.getAttribute('data-fwp-ready') !== '1') {
    return { ok: false, reason: '这套工作方法尚未就绪，请先修复卡片中标出的配置' };
  }
  const kind = String(((card.querySelector('[data-fwp-kind]') || {}).value) || '');
  const model = String(((card.querySelector('[data-fwp-model]') || {}).value) || '');
  const agentPicker = box?.querySelector?.('#fwdAgentSelect');
  if (agentPicker && card.querySelector('[data-fwp-kind]') &&
      (agentPicker.value === '__unselected__' || agentPicker.value !== kind)) {
    if (focusInvalid) agentPicker.focus();
    return {ok:false, reason:'原 Agent 已不可用，请重新选择后再安排执行'};
  }
  if (model === '__unselected__') {
    if (focusInvalid) card.querySelector('[data-fwp-model]')?.focus();
    return {ok:false, reason:'原模型已不可用，请重新选择'};
  }
  return {
    ok: true,
    name: card.getAttribute('data-fwp-name') || '工作流',
    body: {
      bindingId: card.getAttribute('data-fwp-card'),
      inputs: {},
      execution: (kind || model) ? { agentKind: kind, model: model } : {},
    },
  };
}
