(function (global) {
  'use strict';

  const tx = value => (global.SoduWorkI18n && typeof global.SoduWorkI18n.translateText === 'function'
    ? global.SoduWorkI18n.translateText(value) : value) || value;

  const EFFORT_LABELS = Object.freeze({
    minimal: '极简', low: '低', medium: '中', high: '高',
    xhigh: '极高', max: '最高', ultra: '超高',
  });
  const states = new Map();
  let enterpriseModels = [];
  let enterpriseDefaults = {};
  let enterpriseDefault = '';
  let enterpriseDefaultErrors = {};
  let loadPromise = null;
  let loadChanged, signalLoadChange;
  let imageModels = [];
  let nativeModels = [];
  let nativeReason = '';
  let activeRuntime = '';
  let activeScope = '';
  let activeOwner = '';
  let loading = null;
  let enterpriseLoaded = false;
  let nativeLoaded = '';
  let loadSeq = 0;
  let options = {};
  let offModels = null;
  let searchQuery = '';
  let nativeView = 'effort';

  function runtime() {
    const id = global.ComposeRuntime ? ComposeRuntime.value() : 'pi';
    const rows = global.ComposeRuntime ? ComposeRuntime.catalog() : [];
    return rows.find((row) => row.id === id) ||
      { id, displayName: id === 'codex' ? 'Codex' : 'Agent', modelMode: 'managed' };
  }
  const cloud = () => global.ComposeRuntime?.location?.() === 'cloud';

  function loadContext(row = runtime()) {
    // This public scope contains Hub/device/account identifiers, never tokens.
    const owner = String(global.SoduWorkAPI?.taskStorageKey?.('ops') || 'renderer');
    return { owner, key: JSON.stringify([owner, cloud() ? 'cloud' : 'local', row.id, row.modelMode]) };
  }

  function state(id) {
    const key = String(id || 'pi');
    if (!states.has(key)) states.set(key, { modelName: '', reasoningEffort: '', thinkingLevel: '' });
    return states.get(key);
  }

  function escape(value) {
    return options.escape ? options.escape(value) : String(value == null ? '' : value)
      .replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function api() {
    return typeof options.api === 'function' ? options.api() : null;
  }

  function modelById(id) {
    return nativeModels.find((row) => row.id === id) || null;
  }

  function effortChoices(selected) {
    return Object.keys(EFFORT_LABELS).filter(effort => selected?.reasoningLevels?.includes(effort));
  }

  function defaultEffort(model) {
    const levels = effortChoices(model);
    return levels.includes('medium') ? 'medium'
      : levels.includes(model?.defaultReasoning) ? model.defaultReasoning : levels[0] || '';
  }

  function reconcileEffort(selected) {
    const model = modelById(selected.modelName);
    if (!effortChoices(model).includes(selected.reasoningEffort)) {
      selected.reasoningEffort = defaultEffort(model);
    }
  }

  function currentLabel(row, selected) {
    if (row.id === 'codex') {
      const model = modelById(selected.modelName);
      const modelLabel = model ? model.label : 'Codex 默认';
      const effortLabel = selected.reasoningEffort
        ? EFFORT_LABELS[selected.reasoningEffort] || selected.reasoningEffort : '';
      return modelLabel + (effortLabel ? ' · ' + effortLabel : '');
    }
    const image = imageModels.find(item => global.SoduWorkModelChoice?.imageKey(item) === selected.modelName);
    if (image) return '生成图片 · ' + (image.label || image.name);
    const model = enterpriseModels.find((item) => item.name === selected.modelName);
    return model ? (model.label || model.name) : tx('选择模型');
  }

  function clearStaleManagedSelection(row) {
    if (row.modelMode !== 'managed') return;
    const selected = state(row.id);
    const chatMatch = enterpriseModels.some((item) => item.name === selected.modelName);
    const imageMatch = !cloud() && row.id === 'pi' && imageModels.some((item) =>
      global.SoduWorkModelChoice && SoduWorkModelChoice.imageKey(item) === selected.modelName);
    if (!chatMatch && !imageMatch) {
      // A model can be removed from personal model settings while this renderer remains active.
      // Do not keep sending that stale name as an explicit per-turn override.
      const defaultName = Object.hasOwn(enterpriseDefaults, row.id)
        ? enterpriseDefaults[row.id] : enterpriseDefault;
      selected.modelName = enterpriseModels.find(item => item.name === defaultName)?.name || '';
      selected.thinkingLevel = '';
    }
  }

  function check() {
    return '<span class="cp-mtick"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>';
  }

  function heading(subtitle, back = false) {
    return '<div class="cp-model-heading">' + (back ? '<button type="button" class="cp-model-back" data-native-back aria-label="' + escape(tx('返回推理设置')) + '">‹</button>' : '') + '<span><b>' + escape(tx('选择模型')) + '</b><i>' + escape(tx(subtitle)) +
      '</i></span><button type="button" class="cp-model-close" data-model-close aria-label="关闭模型选择">×</button></div>' +
      '<label class="cp-model-search"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/></svg>' +
      '<input type="search" aria-label="搜索模型" placeholder="搜索可用模型" value="' + escape(searchQuery) + '"></label>';
  }

  function filterModels(pop) {
    const query = searchQuery.trim().toLocaleLowerCase();
    let count = 0;
    pop.querySelectorAll?.('.cp-mrow').forEach((row) => {
      row.hidden = !row.textContent.toLocaleLowerCase().includes(query);
      if (!row.hidden) count++;
    });
    const empty = pop.querySelector?.('.cp-model-empty');
    if (empty) empty.hidden = count > 0;
  }

  function emptyList() {
    return '<p class="cp-model-empty" hidden role="status">没有匹配的可用模型</p>';
  }

  function position() {
    const pop = document.getElementById('cpModelPop');
    const button = document.getElementById('cpModelBtn');
    if (!pop?.classList.contains('show') || !pop.getBoundingClientRect || !button?.getBoundingClientRect) return;
    const anchor = button.getBoundingClientRect();
    const available = Math.min(global.innerHeight - 24, anchor.top - 24);
    pop.style.maxHeight = Math.max(160, Math.min(560, available)) + 'px';
    const rect = pop.getBoundingClientRect();
    pop.style.left = Math.max(12, Math.min((anchor.left + anchor.right - rect.width) / 2, global.innerWidth - 12 - rect.width)) + 'px';
    pop.style.top = Math.max(12, Math.min(anchor.top - 9 - rect.height, global.innerHeight - 12 - rect.height)) + 'px';
  }

  function thinkingProfile(item) {
    const value = item || {};
    const config = value.config && typeof value.config === 'object' ? value.config : {};
    const mode = String(value.thinkingMode || config.thinkingMode || '').trim().toLowerCase();
    if (mode === 'none') return { supported: false, canDisable: false };
    if (mode === 'always') return { supported: true, canDisable: false };
    if (mode === 'controllable') return { supported: true, canDisable: true };
    const reasoning = typeof value.reasoning === 'boolean' ? value.reasoning
      : (typeof config.reasoning === 'boolean' ? config.reasoning : null);
    if (reasoning !== null) return { supported: reasoning, canDisable: reasoning };
    const key = String(value.name || value.id || '').toLowerCase();
    const supported = /(?:deepseek|glm|zhipu|qwen|qwq|think|thinking|reason|reasoner|\br1\b|\bo[134]\b|gpt-5)/.test(key);
    return { supported, canDisable: supported };
  }

  function managedHtml(selected) {
    const selectedModel = enterpriseModels.find(item => item.name === selected.modelName);
    const thinkingInfo = thinkingProfile(selectedModel);
    const canThink = thinkingInfo.supported;
    const canDisable = thinkingInfo.canDisable;
    const thinkingOn = canThink && (!canDisable || (selected.thinkingLevel && selected.thinkingLevel !== 'off'));
    const rows = enterpriseModels.map((item) => ({
        name: item.name,
        label: item.label || item.name,
        sub: [item.providerName ? tx(item.providerName) : '', item.providerKind === 'anthropic' ? 'Anthropic' :
          item.providerKind === 'openai-compat' ? tx('OpenAI 兼容') : '',
          item.keyFrom === 'mine' ? tx('自己的额度') : ''].filter(Boolean).join(' \u00b7 '),
      }));
    if (!cloud() && runtime().id === 'pi' && global.SoduWorkModelChoice) rows.push(...imageModels.map(item => ({
      name: SoduWorkModelChoice.imageKey(item), label: item.label || item.name,
      sub: [tx('生成图片'), item.providerName ? tx(item.providerName) : '', item.keyFrom === 'mine' ? tx('自己的额度') : ''].filter(Boolean).join(' \u00b7 '),
    })));
    const thinkingLabel = !canThink
      ? '\u5f53\u524d\u6a21\u578b\u4e0d\u63d0\u4f9b\u53ef\u63a7\u601d\u8003'
      : (!canDisable ? '\u5df2\u5f00\u542f \u00b7 \u6a21\u578b\u56fa\u5b9a\u601d\u8003'
        : (thinkingOn ? '\u5df2\u5f00\u542f \u00b7 \u4e2d\u7b49\u5f3a\u5ea6' : '\u5df2\u5173\u95ed \u00b7 \u66f4\u5feb\u54cd\u5e94'));
    const thinkingHint = !canThink ? '\u8bf7\u5207\u6362\u5230\u63a8\u7406\u6a21\u578b\u540e\u4f7f\u7528'
      : (!canDisable ? '\u5f53\u524d\u6a21\u578b\u4e0d\u652f\u6301\u5173\u95ed\u601d\u8003' : '\u53ea\u5bf9\u672c\u6b21\u65b0\u5efa\u7684\u4f1a\u8bdd\u751f\u6548');
    const thinking = !canThink ? '<div class="cp-model-summary"><span>思考模式</span><span>不支持</span></div>' : '<div class="cp-thinking' + (thinkingOn ? ' on' : '') + '">' +
      '<span class="cp-thinking-icon" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M10 2.5v3m0 9v3M2.5 10h3m9 0h3M4.7 4.7l2.1 2.1m6.4 6.4 2.1 2.1m0-10.6-2.1 2.1m-6.4 6.4-2.1 2.1"/><circle cx="10" cy="10" r="3.2"/></svg></span>' +
      '<span class="cp-thinking-copy"><b>\u601d\u8003\u6a21\u5f0f</b><i>' + thinkingLabel + '</i><small>' + thinkingHint + '</small></span>' +
      '<button type="button" class="cp-thinking-switch" role="switch" aria-checked="' + (thinkingOn ? 'true' : 'false') + '" data-thinking-toggle' + (canThink && canDisable ? '' : ' disabled') + '><span></span><em class="sr-only">\u5207\u6362\u601d\u8003\u6a21\u5f0f</em></button></div>';
    return heading(runtime().id === 'pi' && imageModels.length ? '对话与图片模型 · 用于本次会话' : '用于本次会话') +
      '<div class="cp-model-scroll">' + rows.map((item) =>
        '<button type="button" class="cp-mrow' + (item.name === selected.modelName ? ' on' : '') +
          '" aria-pressed="' + (item.name === selected.modelName) + '" data-model="' + escape(item.name) + '">' + check() +
          '<span class="cp-model-symbol" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="m10 3 2 5 5 2-5 2-2 5-2-5-5-2 5-2Z"/></svg></span><span class="cp-mtxt"><b>' + escape(item.label) + '</b>' +
            (item.sub ? '<i>' + escape(item.sub) + '</i>' : '') + '</span></button>').join('') +
      emptyList() + '</div>' + (!selected.modelName && enterpriseDefaultErrors[runtime().id]
        ? '<div class="cp-native-note is-warning">默认模型暂不可用，请选择其他模型</div>' : '') +
      (enterpriseModels.some(item => item.providerKind === 'anthropic')
        ? '<div class="cp-native-note is-warning" role="note">企业模型对话通道只支持 OpenAI 兼容协议；列表中的 Anthropic 模型需使用支持其协议的 Agent。</div>' : '') + thinking;
  }

  function codexHtml(selected) {
    const selectedModel = modelById(selected.modelName);
    const reason = nativeReason && !nativeModels.length
      ? '<div class="cp-native-note is-warning">' + escape(nativeReason) + '</div>' : '';
    if (nativeView === 'models') return heading('Codex · 使用本机账号', true) +
      '<div class="cp-model-scroll cp-native-models">' + nativeModels.map((item) =>
        '<button type="button" class="cp-mrow' + (item.id === selected.modelName ? ' on' : '') +
          '" aria-pressed="' + (item.id === selected.modelName) + '" data-native-model="' + escape(item.id) + '">' + check() +
          '<span class="cp-mtxt"><b>' + escape(item.label) + '</b></span></button>').join('') +
      emptyList() + '</div>' + reason;
    return reason + effortCard(selected, selectedModel);
  }

  // Both composers use the same native account model and effort surface.
  function effortCard(selected, selectedModel) {
    const efforts = effortChoices(selectedModel);
    return '<div class="cp-effort-card' + (!efforts.length ? ' is-unavailable' : '') + '">' +
        '<div class="cp-effort-heading"><span aria-hidden="true"></span>' +
          '<button type="button" class="cp-native-model-trigger" data-native-list aria-label="' + escape(tx('选择 Codex 模型')) + '" aria-haspopup="dialog"><b data-effort-label>' + escape(tx(EFFORT_LABELS[selected.reasoningEffort] || '选择模型')) + '</b>' +
          '<small>' + escape(selectedModel?.label || tx('Codex 默认')) + '<span aria-hidden="true"> ›</span></small></button>' +
          '<button type="button" data-effort-reset aria-label="重置推理强度" title="重置推理强度"' + (!efforts.length ? ' disabled' : '') + '><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 7a6.5 6.5 0 1 1-.3 5M4 3v4h4"/></svg></button></div>' +
        '<div class="cp-effort-track"><div class="cp-effort-fill" aria-hidden="true"><div class="cp-effort-sparks">' +
          [8, 22, 39, 55, 72, 88].map((left, index) => '<span style="--spark-x:' + left + '%;--spark-y:' + (index % 2 ? 68 : 30) + '%;--spark-delay:-' + (index * .21) + 's"></span>').join('') +
          '</div></div><div class="cp-effort-stops" aria-hidden="true">' +
          efforts.map(() => '<span></span>').join('') + '</div>' +
          '<span class="cp-effort-thumb" aria-hidden="true"></span>' +
          '<input type="range" min="0" max="' + Math.max(0, efforts.length - 1) + '" step="1" value="' + Math.max(0, efforts.indexOf(selected.reasoningEffort)) +
          '" data-effort-slider aria-label="推理强度" aria-valuetext="' + escape(EFFORT_LABELS[selected.reasoningEffort] || '不可调节') + '"' + (efforts.length < 2 ? ' disabled' : '') + '></div>' +
        (efforts.length > 1 ? '<div class="cp-effort-endpoints" aria-hidden="true"><span>' + escape(EFFORT_LABELS[efforts[0]]) + '</span><span>' + escape(EFFORT_LABELS[efforts.at(-1)]) + '</span></div>' : '') + '</div>';
  }

  function paintEffort() {
    const selected = state(runtime().id);
    paintEffortCard(document.getElementById('cpModelPop'), selected, modelById(selected.modelName));
  }

  function paintEffortCard(pop, selected, model) {
    const levels = effortChoices(model);
    const index = Math.max(0, levels.indexOf(selected.reasoningEffort));
    const card = pop?.querySelector?.('.cp-effort-card');
    if (!card) return;
    const position = String(levels.length > 1 ? index / (levels.length - 1) : 0);
    card.style.setProperty('--effort-fill', position);
    // The thumb follows the committed stop, not the raw pointer: every level
    // has a stable capture region, with a short transition when crossing it.
    card.style.setProperty('--effort-position', position);
    card.classList.toggle('is-intense', index > 0 && index >= levels.length - 2);
    card.querySelectorAll('.cp-effort-stops span').forEach((dot, i) => dot.classList.toggle('is-reached', i < index));
    const slider = card.querySelector('[data-effort-slider]');
    slider.value = index;
    slider.setAttribute('aria-valuetext', EFFORT_LABELS[selected.reasoningEffort] || '不可调节');
    card.querySelector('[data-effort-label]').textContent = tx(EFFORT_LABELS[selected.reasoningEffort] || '选择模型');
  }

  function previewEffort(event) {
    const slider = event.target.closest?.('[data-effort-slider]');
    if (!slider || slider.disabled) return;
    const card = slider.closest('.cp-effort-card');
    const bounds = slider.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left - 14) / Math.max(1, bounds.width - 28)));
    const levels = effortChoices(modelById(state(runtime().id).modelName));
    const index = Math.round(ratio * (levels.length - 1));
    const pressed = card.dataset.pointerId === String(event.pointerId);
    if (pressed && event.type === 'pointermove') {
      card.classList.add('is-dragging');
    }
    const onThumb = Math.abs(ratio * (levels.length - 1) - Number(slider.value)) *
      (bounds.width - 28) / Math.max(1, levels.length - 1) <= 18;
    card.classList.add('is-hovering');
    card.classList.toggle('is-thumb-hover', onThumb);
    card.querySelectorAll('.cp-effort-stops span').forEach((dot, i) => dot.classList.toggle('is-preview', i === index && !onThumb));
  }

  function finishEffortPointer() {
    const card = document.getElementById('cpModelPop')?.querySelector?.('.cp-effort-card');
    if (!card) return;
    const slider = card.querySelector('[data-effort-slider]');
    const pointerId = Number(card.dataset.pointerId);
    delete card.dataset.pointerId;
    card.classList.remove('is-pressed', 'is-dragging');
    if (slider?.hasPointerCapture?.(pointerId)) slider.releasePointerCapture(pointerId);
    paintEffort();
  }

  function leaveEffort(event) {
    const slider = event.target.closest?.('[data-effort-slider]');
    if (!slider) return;
    const card = slider.closest('.cp-effort-card');
    card.classList.remove('is-hovering', 'is-thumb-hover');
    card.querySelectorAll('.cp-effort-stops span').forEach(dot => dot.classList.remove('is-preview'));
  }

  function render() {
    const wrap = document.querySelector('.cp-modelwrap');
    const pop = document.getElementById('cpModelPop');
    const button = document.getElementById('cpModelBtn');
    const name = document.getElementById('cpModelName');
    if (!wrap || !pop || !button || !name) return;

    const row = runtime();
    if (enterpriseLoaded) clearStaleManagedSelection(row);
    const selected = state(row.id);
    const supported = row.modelMode === 'managed'
      ? enterpriseModels.length > 0 || (row.id === 'pi' && imageModels.length > 0) : row.id === 'codex';
    wrap.style.display = supported ? '' : 'none';
    if (cloud() && row.modelMode === 'account') {
      wrap.style.display = ''; name.textContent = tx('云端默认模型'); button.disabled = true;
      button.title = tx('使用云端执行机账号配置的模型'); close(); return;
    }
    button.disabled = false;
    if (!supported) {
      close();
      return;
    }

    const label = currentLabel(row, selected);
    name.textContent = label;
    button.dataset.label = '模型';
    button.dataset.runtimeMode = row.id === 'codex' ? 'native' : 'managed';
    button.title = (row.id === 'codex' ? tx('Codex 设置：') : tx('模型：')) + label;
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-haspopup', 'dialog');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', tx(row.id === 'codex' ? 'Codex 模型与推理设置' : '对话与图片模型选择'));
    const active = document.activeElement;
    const focused = pop.contains?.(active) ? {
      search: active.matches('input[type="search"]'),
      start: active.selectionStart, end: active.selectionEnd,
      nativeModel: active.getAttribute('data-native-model'), model: active.getAttribute('data-model'),
      effort: active.matches('[data-effort-slider]'), reset: active.matches('[data-effort-reset]'), thinking: active.matches('[data-thinking-toggle]'),
      nativeList: active.matches('[data-native-list]'), back: active.matches('[data-native-back]'),
      close: active.matches('[data-model-close]'),
    } : null;
    const scroll = pop.querySelector?.('.cp-model-scroll')?.scrollTop || 0;
    pop.dataset.modelView = row.id === 'codex' ? nativeView : 'managed';
    pop.innerHTML = row.id === 'codex' ? codexHtml(selected) : managedHtml(selected);
    try { global.SoduWorkI18n?.translateNode?.(pop); } catch (_) {}
    paintEffort();
    filterModels(pop);
    position();
    if (focused && pop.classList.contains('show')) {
      const target = focused.search ? pop.querySelector('input[type="search"]')
        : focused.effort ? pop.querySelector('[data-effort-slider]')
          : focused.reset ? pop.querySelector('[data-effort-reset]')
          : focused.nativeList ? pop.querySelector('[data-native-list]')
          : focused.back ? pop.querySelector('[data-native-back]')
          : focused.thinking ? pop.querySelector('[data-thinking-toggle]')
            : focused.close ? pop.querySelector('[data-model-close]')
              : Array.from(pop.querySelectorAll('.cp-mrow')).find((item) =>
                focused.nativeModel !== null ? item.getAttribute('data-native-model') === focused.nativeModel
                  : focused.model !== null && item.getAttribute('data-model') === focused.model);
      if (target && !target.hidden) {
        target.focus({ preventScroll: true });
        if (focused.search) target.setSelectionRange(focused.start, focused.end);
      }
    }
    const list = pop.querySelector?.('.cp-model-scroll');
    if (list) list.scrollTop = scroll;
  }

  async function load(force, row, sequence, scope) {
    const current = () => sequence === loadSeq && scope === loadContext().key;
    if (cloud() && row.modelMode === 'account') return render();
    if (row.modelMode === 'managed') {
      if (enterpriseLoaded && !force) { render(); notify(); return; }
      try {
        const response = global.SoduWorkAPI && SoduWorkAPI.myModels
          ? await SoduWorkAPI.myModels() : null;
        if (!current()) return;
        if (!response || !Array.isArray(response.usable)) throw Error('模型目录暂时不可用');
        enterpriseModels = response.usable;
        enterpriseDefaults = response?.defaultModels || {};
        enterpriseDefaultErrors = response?.defaultModelErrors || {};
        // Older Hubs do not expose per-Agent defaults. Keep their runtime
        // resolution intact instead of assuming the first row is correct.
        enterpriseDefault = response?.defaultModel || '';
        imageModels = Array.isArray(response?.mediaUsable?.image) ? response.mediaUsable.image : [];
        clearStaleManagedSelection(row);
        enterpriseLoaded = true;
      } catch (error) {
        if (!current()) return;
        // A temporary lookup failure must not discard the known selection.
      }
      render();
      notify();
      return;
    }
    if (row.id === 'codex') {
      if (nativeLoaded === row.id && !force) return render();
      try {
        const bridge = api();
        const response = bridge && typeof bridge.runtimeModels === 'function'
          ? await bridge.runtimeModels(row.id) : null;
        if (!current()) return;
        if (!response?.ok || !Array.isArray(response.models)) throw Error('模型目录暂时不可用');
        nativeModels = response.models;
        const selected = state(row.id);
        if (nativeModels.length && !modelById(selected.modelName)) {
          selected.modelName = (modelById(response.defaultModel) || nativeModels[0]).id;
        }
        reconcileEffort(state(row.id));
        nativeReason = String(response && response.reason || '');
        nativeLoaded = row.id;
      } catch (error) {
        if (!current()) return;
        nativeReason = tx('本机 Codex 模型目录暂时无法读取，可继续使用默认模型');
      }
      render();
      notify();
    }
  }

  function chooseModel(id) {
    const row = runtime();
    const selected = state(row.id);
    selected.modelName = String(id || '');
    if (row.id !== 'codex') {
      const picked = enterpriseModels.find(item => item.name === selected.modelName) ||
        (selected.modelName ? null : enterpriseModels[0]);
      const info = thinkingProfile(picked);
      if (!info.supported) selected.thinkingLevel = '';
      else if (!info.canDisable) selected.thinkingLevel = 'medium';
    }
    if (row.id === 'codex') { reconcileEffort(selected); nativeView = 'effort'; searchQuery = ''; }
    render();
    notify();
  }

  function chooseEffort(value) {
    if (runtime().id !== 'codex') return;
    const selected = state(runtime().id);
    if (!effortChoices(modelById(selected.modelName)).includes(value)) return;
    selected.reasoningEffort = value;
    // Keep the native range element alive throughout a pointer drag.
    paintEffort();
    const name = document.getElementById('cpModelName');
    if (name) name.textContent = currentLabel(runtime(), selected);
    const button = document.getElementById('cpModelBtn');
    if (button) {
      button.title = tx('Codex 设置：') + currentLabel(runtime(), selected);
      button.setAttribute('aria-label', button.title);
    }
    position();
    notify();
  }

  function notify() {
    if (typeof options.onChange === 'function') options.onChange(value());
  }

  function close() {
    const pop = document.getElementById('cpModelPop');
    const button = document.getElementById('cpModelBtn');
    if (pop) {
      finishEffortPointer();
      const card = pop.querySelector?.('.cp-effort-card');
      card?.classList.remove('is-hovering', 'is-thumb-hover');
      pop.hidePopover?.();
      pop.classList.remove('show');
    }
    if (button) button.setAttribute('aria-expanded', 'false');
  }

  async function toggle() {
    const pop = document.getElementById('cpModelPop');
    const button = document.getElementById('cpModelBtn');
    if (!pop || !button) return;
    const opening = !pop.classList.contains('show');
    close();
    if (!opening) return;
    searchQuery = '';
    nativeView = 'effort';
    const pending = refresh(true);
    pop.classList.add('show');
    pop.showPopover?.();
    button.setAttribute('aria-expanded', 'true');
    position();
    pop.setAttribute('aria-busy', 'true');
    const empty = pop.querySelector?.('.cp-model-empty');
    if (empty && !empty.hidden) empty.textContent = tx('正在加载模型…');
    await pending;
    pop.setAttribute('aria-busy', 'false');
    if (pop.classList.contains('show')) pop.querySelector?.(runtime().id === 'codex' ? '[data-native-list]' : 'input')?.focus();
  }

  function bind(config) {
    const hadModelBridge = typeof options.api === 'function';
    options = config || {};
    const button = document.getElementById('cpModelBtn');
    const pop = document.getElementById('cpModelPop');
    if (!button || !pop || button.dataset.modelPickerBound === '1') return;
    // Keep theme inheritance while escaping sidebar stacking and overflow clips.
    pop.setAttribute('popover', 'manual');
    button.dataset.modelPickerBound = '1';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      toggle();
    });
    pop.addEventListener('click', (event) => {
      event.stopPropagation();
      if (event.target.closest('[data-model-close]')) { close(); button.focus?.(); return; }
      if (event.target.closest('[data-native-list]')) {
        nativeView = 'models'; searchQuery = ''; render();
        pop.querySelector?.('input[type="search"]')?.focus(); return;
      }
      if (event.target.closest('[data-native-back]')) {
        nativeView = 'effort'; searchQuery = ''; render();
        pop.querySelector?.('[data-native-list]')?.focus(); return;
      }
      if (event.target.closest('[data-effort-reset]')) {
        chooseEffort(defaultEffort(modelById(state(runtime().id).modelName))); return;
      }
      const thinkingToggle = event.target.closest('[data-thinking-toggle]');
      if (thinkingToggle) {
        const selected = state(runtime().id);
        const picked = enterpriseModels.find(item => item.name === selected.modelName) || (selected.modelName ? null : enterpriseModels[0]);
        const info = thinkingProfile(picked);
        if (info.supported && info.canDisable) {
          selected.thinkingLevel = selected.thinkingLevel && selected.thinkingLevel !== 'off' ? 'off' : 'medium';
          render();
          notify();
        }
        return;
      }
      const model = event.target.closest('[data-model]');
      if (model) {
        chooseModel(model.getAttribute('data-model'));
        close();
        return;
      }
      const nativeModel = event.target.closest('[data-native-model]');
      if (nativeModel) {
        chooseModel(nativeModel.getAttribute('data-native-model'));
        pop.querySelector?.('[data-native-list]')?.focus();
        return;
      }
    });
    pop.addEventListener('input', (event) => {
      if (event.target.matches('[data-effort-slider]')) {
        const levels = effortChoices(modelById(state(runtime().id).modelName));
        chooseEffort(levels[Number(event.target.value)]); return;
      }
      if (!event.target.matches('input[type="search"]')) return;
      searchQuery = event.target.value;
      filterModels(pop);
    });
    pop.addEventListener('pointermove', previewEffort);
    pop.addEventListener('pointerover', previewEffort);
    pop.addEventListener('pointerout', leaveEffort);
    pop.addEventListener('pointerdown', (event) => {
      const slider = event.target.closest?.('[data-effort-slider]');
      if (!slider || slider.disabled || event.button !== 0) return;
      const card = slider.closest('.cp-effort-card');
      card.dataset.pointerId = String(event.pointerId);
      card.classList.add('is-pressed');
      slider.setPointerCapture(event.pointerId);
    });
    pop.addEventListener('pointerup', finishEffortPointer);
    pop.addEventListener('pointercancel', finishEffortPointer);
    pop.addEventListener('lostpointercapture', finishEffortPointer);
    pop.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (runtime().id === 'codex' && nativeView === 'models') {
          event.preventDefault(); event.stopPropagation(); nativeView = 'effort'; searchQuery = ''; render();
          pop.querySelector?.('[data-native-list]')?.focus(); return;
        }
        event.preventDefault(); event.stopPropagation(); close(); button.focus?.(); return;
      }
      if (event.target.matches('input[type="range"]')) return;
      const rows = Array.from(pop.querySelectorAll('.cp-mrow:not([hidden])'));
      const index = rows.indexOf(document.activeElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : rows.length - 1)
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
        rows[next]?.focus();
      } else if (event.key === 'Enter' && event.target.matches('input') && rows.length) {
        event.preventDefault(); rows[0].click();
      }
    });
    // Initial preference paint can already have started discovery before bind.
    // Reuse that request; a newly mounted draft with no pending load still
    // refreshes the directory to pick up settings changed elsewhere.
    // Native discovery needs the bridge first supplied by bind.
    offModels?.();
    offModels = api()?.onModelsChanged?.(() => { void refresh(true); }) || null;
    const needsNativeBridge = runtime().id === 'codex' && !hadModelBridge;
    refresh(needsNativeBridge || loading?.scope !== loadContext().key);
  }

  function refresh(force) {
    const row = runtime();
    const context = loadContext(row);
    if (activeScope !== context.key) {
      if (activeOwner && activeOwner !== context.owner) states.clear();
      activeOwner = context.owner;
      activeScope = context.key;
      enterpriseModels = []; enterpriseDefaults = {}; enterpriseDefault = '';
      enterpriseDefaultErrors = {}; imageModels = []; enterpriseLoaded = false;
      nativeModels = []; nativeReason = ''; nativeLoaded = '';
      nativeView = 'effort';
      close();
    }
    if (activeRuntime !== row.id) {
      activeRuntime = row.id;
      close();
      notify();
    }
    render();
    // Layout and permission updates all refresh this control. They must await
    // the first request, not replace it with an ever-later model lookup.
    if (!force && loading?.scope === context.key) return loading.promise;
    const changed = signalLoadChange;
    loadChanged = new Promise(resolve => { signalLoadChange = resolve; });
    const sequence = ++loadSeq;
    const promise = load(Boolean(force), row, sequence, context.key).finally(() => {
      if (loading?.promise === promise) loading = null;
    });
    loading = { scope: context.key, promise };
    loadPromise = promise;
    changed?.();
    return loadPromise;
  }

  async function ready() {
    if (!loadPromise || activeScope !== loadContext().key) refresh();
    let pending;
    do {
      pending = loadPromise;
      await Promise.race([pending, loadChanged]);
      if (activeScope !== loadContext().key) refresh();
    } while (pending !== loadPromise);
    return Boolean(state(runtime().id).modelName || !enterpriseDefaultErrors[runtime().id]);
  }

  function value() {
    const row = runtime();
    const selected = state(row.id);
    if (cloud()) return { modelName: row.modelMode === 'managed' ? selected.modelName : '', reasoningEffort: '', thinkingLevel: '' };
    if (row.id === 'codex') {
      return { modelName: selected.modelName, reasoningEffort: selected.reasoningEffort };
    }
    if (row.modelMode === 'managed') {
      const picked = enterpriseModels.find(item => item.name === selected.modelName) || (selected.modelName ? null : enterpriseModels[0]);
      const info = thinkingProfile(picked);
      return { modelName: selected.modelName, reasoningEffort: '', thinkingLevel: info.supported && !info.canDisable ? 'medium' : (selected.thinkingLevel || '') };
    }
    return { modelName: '', reasoningEffort: '' };
  }

  global.ComposeModelPicker = { bind, close, refresh, ready, value,
    nativeEffort: { html: effortCard, paint: paintEffortCard, levels: effortChoices, defaultLevel: defaultEffort },
    label: () => currentLabel(runtime(), state(runtime().id)) };
  const scopeChanged = () => {
    if (activeScope && activeScope !== loadContext().key) void refresh();
  };
  global.addEventListener?.('soduwork-data-scope-changed', scopeChanged);
  global.addEventListener?.('soduwork-device-auth', scopeChanged);
  // Hubs without model-change push still converge while the composer is visible.
  const refreshVisibleModels = () => {
    const button = document.getElementById('cpModelBtn');
    if (button?.isConnected && button.getClientRects().length && document.visibilityState !== 'hidden' && !loading) void refresh(true);
  };
  global.addEventListener?.('focus', refreshVisibleModels);
  global.setInterval?.(refreshVisibleModels, 60000);
  global.addEventListener?.('resize', position);
  if (typeof module !== 'undefined' && module.exports) module.exports = global.ComposeModelPicker;
})(typeof window !== 'undefined' ? window : globalThis);
