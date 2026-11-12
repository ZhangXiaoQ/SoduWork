/* Session identity and permission changes. Server policies are the source of truth. */
(function (global) {
  'use strict';
  const MODES = [
    ['standard', '默认权限', '常规操作自动执行，敏感操作询问'],
    ['full', '完全访问', '读写文件、运行命令、访问网络'],
    ['readonly', '只读', '仅分析和读取，不修改文件'],
  ];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const text = source => global.SoduWorkI18n?.html ? global.SoduWorkI18n.html(source, source) : '<span>' + esc(source) + '</span>';
  function create(el, options) {
    const button = el.querySelector('#nchatMode'), label = el.querySelector('#nchatModeName');
    const badge = el.querySelector('#nchatRuntime'), brand = el.querySelector('#nchatRuntimeIcon'), name = el.querySelector('#nchatRuntimeName');
    if (!button) return { render() {}, destroy() {}, wait: () => Promise.resolve(true) };
    const life = new AbortController();
    const on = (node, type, callback) => node.addEventListener(type, callback, { signal: life.signal });
    const host = document.createElement('span'); host.className = 'nchat-access-wrap';
    button.before(host); host.appendChild(button);
    host.insertAdjacentHTML('beforeend', '<div class="nchat-access-pop" id="nchatAccessPop" role="dialog" aria-label="本次会话权限" hidden>' +
      '<header>' + text('本次会话权限') + '</header><div class="nchat-access-options">' + MODES.map(([mode, title, detail]) =>
        '<button type="button" data-access-mode="' + mode + '" aria-pressed="false"><span><b>' + text(title) + '</b><small>' + text(detail) + '</small></span>' +
        '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 10 3.2 3.2L15 6.5"/></svg></button>').join('') +
      '</div><p class="nchat-access-note">' + text('新权限将在下一轮生效。') + '</p>' +
      '<p class="nchat-access-current" data-access-current></p><p class="nchat-access-status" role="status" hidden></p></div>');
    const pop = host.querySelector('#nchatAccessPop'), status = pop.querySelector('[role=status]');
    button.disabled = false; button.classList.remove('muted');
    button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-controls', pop.id); button.setAttribute('aria-expanded', 'false');
    const pendingMark = document.createElement('span'); pendingMark.className = 'nchat-access-pending'; pendingMark.hidden = true;
    pendingMark.innerHTML = text('下一轮'); button.appendChild(pendingMark);
    let ref = '', lastIdentity = '', generation = 0, saving = false, request = null, destroyed = false, lastAgent = '', capabilityNotice = false;
    const api = () => global.soduWorkAPI && (global.soduWorkAPI.conversationSession || global.soduWorkAPI.piSession);
    function position() {
      if (pop.hidden) return;
      const r = button.getBoundingClientRect(), width = Math.min(300, global.innerWidth - 24);
      pop.style.width = width + 'px'; pop.style.left = Math.max(12, Math.min(r.left, global.innerWidth - width - 12)) + 'px';
      const above = Math.max(0, r.top - 20), below = Math.max(0, global.innerHeight - r.bottom - 20);
      const upwards = above >= below;
      pop.style.maxHeight = Math.min(420, upwards ? above : below) + 'px';
      pop.style.top = upwards ? 'auto' : (r.bottom + 8) + 'px';
      pop.style.bottom = upwards ? (global.innerHeight - r.top + 8) + 'px' : 'auto';
    }
    function close(focus = false) { pop.hidden = true; button.setAttribute('aria-expanded', 'false'); if (focus) button.focus(); }
    function message(value = '') { capabilityNotice = false; status.hidden = !value; status.textContent = value; }
    function supported(state) {
      if (state.draftOnly) return !!(options.draft && state.accessControl?.supported && state.accessControl.schema === 'soduwork.access-policy/v1');
      return !!(state.ref && typeof api()?.setAccessMode === 'function' && state.accessControl?.supported && state.accessControl.canChangeDuringSession === true && state.accessControl.schema === 'soduwork.access-policy/v1');
    }
    function render() {
      const state = options.state();
      const identity = state.ref || (state.draftOnly ? 'draft:' + state.draftId : '');
      if (lastIdentity !== identity) { lastIdentity = identity; ref = state.ref || ''; generation++; saving = false; request = null; message(); close(); }
      const taskRuntime = state.taskRuntime || '';
      const id = taskRuntime || state.adapterId || '';
      const title = (taskRuntime ? global.AgentBrand?.LABELS[id] : state.displayName) || global.AgentBrand?.LABELS[id] || id || 'Agent';
      if (badge) {
        badge.title = '本次会话执行底座：' + title;
        badge.setAttribute('aria-label', badge.title); badge.setAttribute('role', 'button');
        if (name && name.textContent !== title) name.textContent = title;
        if (brand && lastAgent !== id) { lastAgent = id; brand.innerHTML = global.AgentBrand?.html(taskRuntime && !global.AgentBrand?.LABELS[id] ? 'custom' : id, { className: 'runtime-brand' }) || ''; }
      }
      const effective = state.nextAccessPolicy || state.accessPolicy;
      const mode = effective?.mode || (state.mode === 'readonly' ? 'readonly' : 'legacy');
      const titleText = global.WorkComposer.permissionLabel(mode);
      if (label.textContent !== titleText) label.textContent = titleText;
      button.title = '本次会话权限：' + titleText;
      button.setAttribute('aria-label', '本次会话权限：' + titleText);
      global.WorkComposer.permissionAppearance(button, { selectedMode: mode, currentMode: state.accessPolicy?.mode, pending: !!state.nextAccessPolicy });
      const immediate = state.accessControl?.changeTakesEffect === 'current-turn';
      pendingMark.innerHTML = text(immediate ? '切换中' : '下一轮');
      pop.querySelector('.nchat-access-note').innerHTML = text(state.draftOnly ? '首次发送时使用所选权限。' : immediate
        ? '本轮完成后按新权限继续。'
        : '新权限将在下一轮生效。');
      pendingMark.hidden = !state.nextAccessPolicy;
      if (state.nextAccessPolicy) {
        const notice = immediate ? '切换中' : '下一轮生效';
        button.title += ' · ' + notice;
        button.setAttribute('aria-label', '本次会话权限：' + titleText + ' · ' + notice);
      }
      button.setAttribute('aria-busy', String(saving));
      button.disabled = Boolean(state.cloudHandoff);
      if (state.cloudHandoff) {
        const personal = state.cloudHandoff.target?.runnerKind === 'work-computer';
        label.textContent = personal ? '电脑权限' : '云端权限';
        button.title = personal ? '权限由所选本人电脑的执行环境管理' : '权限由云端执行环境管理';
        button.setAttribute('aria-label', label.textContent + '：' + button.title);
        pop.hidden = true;
      }
      const current = pop.querySelector('[data-access-current]');
      current.textContent = '当前权限：' + global.WorkComposer.permissionLabel(state.accessPolicy?.mode || (state.mode === 'readonly' ? 'readonly' : 'legacy'));
      pop.querySelectorAll('[data-access-mode]').forEach(row => {
        row.disabled = saving || !supported(state) || !state.accessControl.modes?.includes(row.dataset.accessMode);
        row.setAttribute('aria-pressed', String(row.dataset.accessMode === mode));
      });
      if (!saving && !supported(state)) {
        message(state.draftOnly ? state.draftAccessHint || '当前 Agent 不支持统一权限模式' : !state.ref ? '正在连接会话，请稍候' :
          typeof api()?.setAccessMode !== 'function' ? '请重启客户端后切换会话权限' : '当前 Agent 暂不支持会话内切换权限');
        capabilityNotice = true;
      } else if (capabilityNotice) message();
      position();
    }
    on(button, 'click', event => { event.stopPropagation(); const open = pop.hidden; close(); if (open) { render(); pop.hidden = false; button.setAttribute('aria-expanded', 'true'); position(); } });
    on(pop, 'click', event => {
      event.stopPropagation();
      const row = event.target.closest('[data-access-mode]'), state = options.state();
      if (!row || row.disabled || saving || !supported(state)) return;
      const selected = state.nextAccessPolicy || state.accessPolicy;
      if (row.dataset.accessMode === selected?.mode) { close(true); return; }
      const token = ++generation, activeRef = ref;
      const anchorRect = button.getBoundingClientRect();
      const anchor = { left: anchorRect.left, top: anchorRect.top, width: anchorRect.width,
        height: anchorRect.height, screenX: Number(global.screenX) + anchorRect.left,
        screenY: Number(global.screenY) + anchorRect.top };
      // Hide the picker before waiting for native confirmation. Leaving it
      // open and disabled makes the UI look frozen behind the second dialog.
      close(false);
      saving = true; message('正在更新权限…'); render();
      request = Promise.resolve().then(async () => {
        try {
          if (state.draftOnly) {
            const accepted = await options.draft.chooseAccess(row.dataset.accessMode, state.adapterId, anchor);
            if (accepted && !destroyed && token === generation) { message(); close(true); }
            return accepted;
          }
          const result = await api().setAccessMode(activeRef, row.dataset.accessMode, selected?.revision || 0, { anchor });
          if (destroyed || token !== generation || activeRef !== options.state().ref) return false;
          if (!result?.ok) {
            if (result?.snapshot) options.accessChanged?.(result);
            message(result?.cancelled || result?.canceled ? '已取消，权限保持不变' : result?.reason || '权限更新失败，当前设置未改变');
            return false;
          }
          options.accessChanged?.(result); message(); close(true); return true;
        } catch (_) {
          if (!destroyed && token === generation && activeRef === options.state().ref) message('权限更新失败，当前设置未改变');
          return false;
        } finally {
          if (!destroyed && token === generation) { saving = false; request = null; render(); }
        }
      });
    });
    on(document, 'click', event => { if (!host.contains(event.target)) close(); });
    on(document, 'keydown', event => {
      if (pop.hidden) return;
      if (event.key === 'Escape') { event.preventDefault(); close(true); }
      if (pop.contains(event.target) && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault(); const rows = [...pop.querySelectorAll('button:not(:disabled)')], index = rows.indexOf(document.activeElement);
        rows[(index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus();
      }
    });
    on(button, 'keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); if (pop.hidden) button.click(); pop.querySelector('button:not(:disabled)')?.focus(); } });
    on(global, 'resize', position); on(global, 'soduwork-locale-change', render);
    render();
    return { render, wait: () => request || Promise.resolve(true), reset() { generation++; saving = false; request = null; close(); render(); }, destroy() { destroyed = true; generation++; close(); life.abort(); } };
  }
  global.ChatSessionControls = { create };
})(window);
