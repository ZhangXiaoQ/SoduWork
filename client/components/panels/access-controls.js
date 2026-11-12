(function (global) {
  'use strict';
  const overlays = new WeakMap();
  function clean(value, key) {
    if (/token|secret|password|authorization|api[_-]?key/i.test(key || '')) return '••••';
    if (Array.isArray(value)) return value.map(item => clean(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v, k)]));
    return value;
  }
  function render(request, escape, options = {}) {
    const esc = escape;
    const text = source => global.SoduWorkI18n?.html ? global.SoduWorkI18n.html(source, source)
      : esc(global.SoduWorkI18n?.t ? global.SoduWorkI18n.t(source) : source);
    const titles = { 'file.read': '允许读取文件？', 'file.write': '允许修改文件？', 'command.execute': '允许运行命令？', 'tool.execute': '允许使用此工具？' };
    const targetLabels = { 'file.read': '文件位置', 'file.write': '文件位置', 'command.execute': '将运行的命令' };
    const payload = clean(request.arguments || {});
    const command = request.action === 'command.execute' || request.action === 'terminal.execute' || request.action === 'native.command' ||
      (request.kind === 'execute' && typeof payload.command === 'string');
    const action = command ? 'command.execute' : request.kind === 'edit' ? 'file.write' : request.kind === 'read' ? 'file.read' : request.action;
    const commandPreview = command && typeof payload.command === 'string' ? payload.command +
      (Array.isArray(payload.args) ? payload.args.map(arg => ' ' + JSON.stringify(String(arg))).join('') : '') : '';
    const files = Array.isArray(payload.changes) ? payload.changes.filter(row => row && typeof row.path === 'string').map(row => row.path) : [];
    const target = commandPreview || (files.length ? [...new Set(files)].join('\n') : request.target) || '';
    const missingInput = payload.inputUnavailable === true || payload.input === null;
    const detail = missingInput ? '' : typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    const scopeNote = Number.isInteger(options.fullRevision)
      ? text('始终允许') + '：' + text('仅对此会话生效，可随时调整') : text('仅允许这一次操作。');
    const button = (decision, label, className = '') =>
      '<button type="button" class="nask-btn ' + className +
      '" data-ui-answer="permission" data-ui-value="' + decision + '" data-permission-request="' + esc(request.requestId) +
      '" data-permission-revision="' + Number(request.policyRevision) + '"' +
      (decision === 'full' ? ' data-access-revision="' + options.fullRevision + '"' : '') + '>' + text(label) + '</button>';
    return '<section class="access-request" role="dialog" aria-modal="true" aria-label="权限确认" data-permission-ref="' + esc(options.ref || '') + '">' +
      '<header class="access-head" aria-live="polite"><span class="access-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m12 3 7 3v5c0 4.6-2.7 7.9-7 10-4.3-2.1-7-5.4-7-10V6z"/><path d="m8.8 11.9 2.1 2.2 4.4-4.6"/></svg></span>' +
      '<div><b>' + text(titles[action] || '允许使用此工具？') + '</b><i>' + text('确认后继续当前任务') + '</i></div>' +
      '<span class="access-count" role="status"></span></header><div class="access-body">' +
      (target ? '<div class="access-target-wrap"><span class="access-target-label">' + text(targetLabels[action] || '操作对象') +
      '</span><code class="access-target" data-user-content>' + esc(target) + '</code></div>' : '') +
      (missingInput ? '<p class="access-input-note">' + text('详情不完整，仅允许本次操作。') + '</p>' : '') +
      (!missingInput && payload.inputIncomplete ? '<p class="access-input-note">' + text('详情不完整，请单独确认。') + '</p>' : '') +
      (detail ? '<details><summary><span>' + text('查看操作详情') + '</span>' +
      (request.tool || request.agent ? '<code data-user-content>' + esc(request.tool || request.agent) + '</code>' : '') +
      '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4"/></svg></summary><pre data-user-content>' + esc(detail.slice(0, 20000)) + '</pre></details>' : '') +
      '</div>' +
      '<footer><div class="nask-btns" role="group" aria-label="' + text('权限确认') + '">' + button('deny', '拒绝') + button('once', '允许一次') +
      (Number.isInteger(options.fullRevision) ? button('full', '始终允许', 'access-full') : '') + '</div>' +
      '<small>' + scopeNote + '</small><p class="access-error" role="alert" hidden></p></footer></section>';
  }
  function sync(el, ref, snapshot, escape, onAnswer) {
    if (!el) return;
    const requests = Array.isArray(snapshot?.pendingPermissions) ? snapshot.pendingPermissions
      : snapshot?.pendingUi?.method === 'permission' ? [snapshot.pendingUi] : [];
    const request = ref && requests[0];
    if (!request) { destroy(el); return; }
    let state = overlays.get(el);
    if (!state) {
      const dock = el.querySelector('.nchat-entry-dock'), composer = el.querySelector('.nbox');
      if (!dock || !composer) return;
      const layer = document.createElement('div'); layer.className = 'nchat-access-overlay';
      dock.appendChild(layer);
      const life = new AbortController();
      const position = () => {
        if (!layer.isConnected) return;
        const r = composer.getBoundingClientRect(), d = dock.getBoundingClientRect();
        const top = Math.max(8, el.getBoundingClientRect().top + 8);
        const width = Math.max(0, Math.min(r.width - 16, global.innerWidth - 24));
        const left = Math.max(12, Math.min(r.left + (r.width - width) / 2, global.innerWidth - width - 12));
        layer.style.width = width + 'px';
        layer.style.left = (left - d.left) + 'px';
        layer.style.right = 'auto';
        layer.style.bottom = (d.bottom - r.top + 10) + 'px';
        layer.style.maxHeight = Math.max(40, Math.min(440, r.top - top - 10)) + 'px';
      };
      state = { layer, dock, life, position, key: '', onAnswer, inertBefore: new Map(), guard: null };
      layer.addEventListener('click', event => {
        const button = event.target.closest('[data-ui-answer="permission"]');
        if (button && !button.disabled) { event.stopPropagation(); state.onAnswer?.(button); }
      }, { signal: life.signal });
      global.addEventListener('resize', position, { signal: life.signal });
      if (global.ResizeObserver) {
        state.observer = new ResizeObserver(position); state.observer.observe(composer); state.observer.observe(dock);
      }
      overlays.set(el, state);
    }
    state.onAnswer = onAnswer;
    // The approval card is modal for the composer. It is positioned above the
    // input, so pointer events could otherwise fall through to the permission
    // picker and send/stop controls underneath it. Keep the approval layer
    // interactive while every other dock child is inert until the request is
    // cleared by the authoritative snapshot.
    const focusables = () => [...state.layer.querySelectorAll(
      'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex]:not([tabindex="-1"])'
    )].filter(node => node.checkVisibility?.() !== false && !node.closest('[hidden]'));
    const focusDialog = () => {
      const active = document.activeElement;
      if (state.layer.contains(active)) return;
      focusables()[0]?.focus({ preventScroll: true });
    };
    const blockDock = blocked => {
      const dock = state.dock;
      if (!dock) return;
      if (blocked) {
        dock.dataset.permissionBlocked = 'true';
        dock.setAttribute('aria-busy', 'true');
        const root = el.querySelector('.nchat') || el;
        for (const node of root.querySelectorAll('button,a[href],input,select,textarea,summary,[tabindex]')) {
          if (state.layer.contains(node)) continue;
          if (!state.inertBefore.has(node)) state.inertBefore.set(node, node.inert);
          node.inert = true;
        }
        if (!state.guard) {
          state.guard = event => {
            if (state.layer.contains(event.target)) {
              if (event.type === 'keydown' && event.key === 'Tab') {
                const items = focusables();
                if (!items.length) return;
                const index = items.indexOf(document.activeElement);
                const next = event.shiftKey
                  ? items[(index <= 0 ? items.length : index) - 1]
                  : items[(index + 1) % items.length];
                if (index < 0 || (event.shiftKey && index === 0) || (!event.shiftKey && index === items.length - 1)) {
                  event.preventDefault();
                  next.focus({ preventScroll: true });
                }
              }
              return;
            }
            if (event.type === 'focusin') {
              event.preventDefault(); event.stopImmediatePropagation(); focusDialog(); return;
            }
            event.preventDefault(); event.stopImmediatePropagation();
            if (event.type === 'keydown' || event.type === 'keyup') focusDialog();
          };
          for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'touchstart', 'contextmenu', 'keydown', 'keyup', 'focusin']) {
            el.addEventListener(type, state.guard, { capture: true, signal: state.life.signal });
          }
        }
        queueMicrotask(focusDialog);
      } else {
        delete dock.dataset.permissionBlocked;
        dock.removeAttribute('aria-busy');
        for (const [node, wasInert] of state.inertBefore) node.inert = wasInert;
        state.inertBefore.clear();
      }
    };
    state.blockDock = blockDock;
    const policy = snapshot.nextAccessPolicy || snapshot.accessPolicy;
    const fullRevision = snapshot.accessControl?.supported && snapshot.accessControl.canChangeDuringSession === true &&
      snapshot.accessControl.modes?.includes('full') && policy?.mode !== 'full' && Number.isInteger(policy?.revision)
      ? policy.revision : undefined;
    const key = JSON.stringify([ref, request.requestId, request.policyRevision, request.action, request.tool,
      request.agent, request.target, request.arguments, request.allowSession, request.sessionScope, fullRevision]);
    if (state.key !== key) {
      state.layer.innerHTML = render(request, escape, { ref, fullRevision }); state.key = key;
    }
    blockDock(true);
    const count = state.layer.querySelector('.access-count');
    const extra = requests.length - 1;
    count.hidden = extra <= 0;
    if (count.dataset.count !== String(extra)) {
      count.textContent = '+' + extra;
      count.title = '还有 ' + extra + ' 项待确认';
      count.setAttribute('aria-label', count.title);
      count.dataset.count = String(extra);
    }
    state.position();
  }
  function destroy(el) {
    const state = el && overlays.get(el);
    if (!state) return;
    state.blockDock?.(false);
    state.life.abort(); state.observer?.disconnect(); state.layer.remove(); overlays.delete(el);
  }
  async function answer(button, api, ref) {
    const card = button.closest('.access-request');
    if (!card || card.dataset.answerPending === 'true') return { ok: false };
    if (card.dataset.permissionRef && card.dataset.permissionRef !== ref) return { ok: false, reason: '权限请求已失效' };
    const response = { requestId: button.dataset.permissionRequest,
      policyRevision: Number(button.dataset.permissionRevision), decision: button.dataset.uiValue };
    const buttons = [...card.querySelectorAll('[data-ui-answer]')];
    const error = card.querySelector('.access-error');
    card.dataset.answerPending = 'true'; card.setAttribute('aria-busy', 'true');
    buttons.forEach(item => { item.disabled = true; }); if (error) error.hidden = true;
    let accepted = false;
    try {
      const full = response.decision === 'full';
      let result;
      if (full) {
        if (typeof api.setAccessMode !== 'function') throw Error('Unsupported access change');
        const rect = button.getBoundingClientRect();
        result = await api.setAccessMode(ref, 'full', Number(button.dataset.accessRevision), { anchor: {
          left: rect.left, top: rect.top, width: rect.width, height: rect.height,
          screenX: Number(global.screenX) + rect.left, screenY: Number(global.screenY) + rect.top,
        } });
      } else result = await api.answerUi(ref, response);
      accepted = result?.ok === true && result.effective !== 'next-turn';
      if (accepted) card.hidden = true;
      else if (error && !result?.cancelled && !result?.canceled) {
        error.hidden = false;
        const message = result?.ok ? '新权限将在下一轮生效。' : result?.reason || '权限确认失败，请重试';
        error.textContent = global.SoduWorkI18n?.t?.(message) || message;
        error.classList.toggle('access-feedback', result?.ok === true);
      }
      return result || { ok: false, reason: '权限确认失败，请重试' };
    } catch (_) {
      if (error) { error.hidden = false; error.textContent = '权限确认失败，请重试'; }
      return { ok: false, reason: '权限确认失败，请重试' };
    } finally {
      if (!accepted && card.isConnected) {
        card.dataset.answerPending = 'false'; card.setAttribute('aria-busy', 'false');
        buttons.forEach(item => { item.disabled = false; });
      }
    }
  }
  global.AccessControls = { render, sync, destroy, answer };
})(window);
