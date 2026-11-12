/*
 * Shared conversation composer shell. Entry and conversation-footer surfaces supply
 * content while reusing input, focus, and context controls.
 */
(function (global) {
  'use strict';

  // The execution-location control is rendered after the locale adapter has
  // already scanned the page. Translate its markup at creation/update time so
  // switching between English and Chinese cannot leave a mixed menu behind.
  const tx = value => (global.SoduWorkI18n && typeof global.SoduWorkI18n.translateText === 'function'
    ? global.SoduWorkI18n.translateText(value) : value) || value;

  const esc = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/\"/g, '&quot;');

  const ICONS = Object.freeze({
    folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    shield: '<svg viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 4.8-2.8 8-7 10-4.2-2-7-5.2-7-10V6z"/><path d="M9 12l2 2 4-4"/></svg>',
    shieldAlert: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v5c0 4.8-2.8 8-7 10-4.2-2-7-5.2-7-10V6z"/><path d="M12 7.5v5"/><circle cx="12" cy="16" r=".85" fill="currentColor" stroke="none"/></svg>',
    ability: '<svg viewBox="0 0 24 24"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M18 15l.7 2.3L21 18l-2.3.7L18 21l-.7-2.3L15 18l2.3-.7z"/></svg>',
    send: '<svg viewBox="0 0 24 24"><path d="M12 19V6M6.5 11.5 12 6l5.5 5.5"/></svg>',
    attach: '<svg viewBox="0 0 24 24"><path d="M21 12.5l-8.4 8.4a5 5 0 0 1-7.1-7.1l9-9a3.4 3.4 0 0 1 4.8 4.8l-9 9a1.8 1.8 0 0 1-2.5-2.5l8.3-8.3"/></svg>',
    screenshot: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3"/><rect x="7" y="7" width="10" height="10" rx="1"/></svg>',
    mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  });

  function html(options) {
    const o = options || {};
    const rows = Number(o.rows || 1);
    const klass = ['work-composer', o.className || ''].filter(Boolean).join(' ');
    return '<div class="' + esc(klass) + '"' + (o.id ? ' id="' + esc(o.id) + '"' : '') + '>' +
      (o.beforeInput || '') +
      '<textarea class="wc-input" id="' + esc(o.inputId) + '" rows="' + rows + '" placeholder="' +
        esc(o.placeholder || '') + '"></textarea>' +
      (o.afterInput || '') +
      '<div class="wc-toolbar">' +
        '<div class="wc-tools">' + (o.tools || '') + '</div>' +
        (o.context || '') +
        '<div class="wc-actions">' +
          (o.hint ? '<span class="wc-hint">' + esc(o.hint) + '</span>' : '') +
          (o.actions || '') +
          '<button type="button" class="wc-send ' + esc(o.sendClass || '') + '" id="' + esc(o.sendId) + '" title="' +
            esc(o.sendTitle || '发送') + '" aria-label="' + esc(o.sendTitle || '发送') + '">' + ICONS.send + '</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function contextButton(options) {
    const o = options || {};
    const icon = String(o.iconHtml || '') || ICONS[o.icon] || '';
    const tag = o.readOnly ? 'span' : 'button';
    return '<' + tag + ' class="wc-context-button' + (o.readOnly ? ' wc-context-static' : '') + (o.muted ? ' muted' : '') + '" id="' + esc(o.id) + '"' +
      (o.popup ? ' aria-haspopup="true" aria-expanded="false"' : '') +
      ' aria-label="' + esc(o.title || o.value || o.label || '') + '" title="' + esc(o.title || '') + '">' +
      icon + '<span class="wc-context-copy"><i>' + esc(o.label || '') + '</i><b id="' + esc(o.valueId || '') + '">' +
      esc(o.value || '') + '</b></span>' +
      (o.popup && o.chevron !== false && o.id !== 'cpWorkspace' ? '<span class="wc-chevron">⌄</span>' : '') + '</' + tag + '>';
  }

  function syntaxHint() {
    // The hint stays inside the editor: one plain line at a time, with a slow
    // carousel for shortcuts and a few useful ways to start a turn.
    return '<div class="wc-placeholder-rail" aria-hidden="true" role="presentation">' +
      '<div class="wc-placeholder-track">' +
      '<span class="wc-placeholder-item" title="\u6253\u5f00\u63d2\u4ef6\u3001\u6280\u80fd\u6216\u901a\u77e5\u7528\u6237"><kbd>/</kbd><b>\u4f7f\u7528\u63d2\u4ef6</b><i> \u00b7 </i><kbd>#</kbd><b>\u4f7f\u7528\u6280\u80fd</b><i> \u00b7 </i><kbd>@</kbd><b>\u7528\u6237\u53d1\u9001\u6d88\u606f</b></span>' +
      '<span class="wc-placeholder-item">\u544a\u8bc9 SoduWork \u4f60\u60f3\u5b8c\u6210\u4ec0\u4e48\u2026</span>' +
      '<span class="wc-placeholder-item">\u7c98\u8d34\u6587\u4ef6\u6216\u56fe\u7247\uff0c\u8865\u5145\u4efb\u52a1\u80cc\u666f</span>' +
      '<span class="wc-placeholder-item">\u8f93\u5165\u201c\u7ee7\u7eed\u201d\uff0c\u6062\u590d\u4e0a\u4e00\u8f6e\u5de5\u4f5c</span>' +
      /* Repeat the first item at the end for a seamless four-step carousel loop. */
      '<span class="wc-placeholder-item" aria-hidden="true" title="\u6253\u5f00\u63d2\u4ef6\u3001\u6280\u80fd\u6216\u901a\u77e5\u7528\u6237"><kbd>/</kbd><b>\u4f7f\u7528\u63d2\u4ef6</b><i> \u00b7 </i><kbd>#</kbd><b>\u4f7f\u7528\u6280\u80fd</b><i> \u00b7 </i><kbd>@</kbd><b>\u7528\u6237\u53d1\u9001\u6d88\u606f</b></span>' +
      '</div></div>';
  }

  function bindPlaceholder(node) {
    if (!node || !node.querySelector) return node;
    global.SoduWorkQuotaNotice?.mount(node);
    const input = node.querySelector('.wc-input');
    const rail = node.querySelector('.wc-placeholder-rail');
    if (!input || !rail) return node;
    node.classList.add('wc-has-placeholder');
    const sync = () => {
      const filled = String(input.value || '').length > 0;
      node.classList.toggle('wc-has-value', filled);
      rail.setAttribute('aria-hidden', filled ? 'true' : 'false');
    };
    const syncFocus = () => {
      node.classList.toggle('wc-input-focused', document.activeElement === input);
    };
    input.addEventListener('input', sync);
    input.addEventListener('change', sync);
    input.addEventListener('focus', syncFocus);
    input.addEventListener('blur', syncFocus);
    sync();
    syncFocus();
    return node;
  }
  function openPlugins() {
    if (global.WorkspaceHost && typeof global.WorkspaceHost.open === 'function') {
      return global.WorkspaceHost.open('skills', {});
    }
    if (typeof global.openCapabilityPanel === 'function') return global.openCapabilityPanel();
    if (typeof global.openSkillPanel === 'function') return global.openSkillPanel();
  }

  // Display-only cache. Selection and Send still resolve current permissions.
  // Warm both composer surfaces before opening; never reuse another account's catalog.
  let menuCatalog = null, menuCatalogAt = 0, menuCatalogFlight = null, menuCatalogRevision = 0;
  function peekMenuPlugins() { return menuCatalog; }
  function menuPluginRevision() { return menuCatalogRevision; }
  function loadMenuPlugins(force = false) {
    if (menuCatalogFlight) return menuCatalogFlight;
    if (!force && menuCatalog && Date.now() - menuCatalogAt < 30000) return Promise.resolve(menuCatalog);
    const revision = menuCatalogRevision;
    let timer;
    const flight = Promise.race([
      Promise.resolve().then(() => {
        if (!global.SoduWorkAPI?.pluginCatalog) throw Error('Plugin service unavailable');
        return global.SoduWorkAPI.pluginCatalog();
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Plugin catalog timeout')), 12000); }),
    ]).then(result => {
      if (revision !== menuCatalogRevision) throw Error('Plugin catalog scope changed');
      menuCatalog = result; menuCatalogAt = Date.now();
      return result;
    }).finally(() => {
      clearTimeout(timer);
      if (menuCatalogFlight === flight) menuCatalogFlight = null;
    });
    menuCatalogFlight = flight;
    return flight;
  }
  function invalidateMenuPlugins() {
    menuCatalogRevision++; menuCatalog = null; menuCatalogAt = 0; menuCatalogFlight = null;
    document.querySelectorAll('#cpMorePop,#nchatMorePop').forEach(pop => {
      pop.hidden = true; pop.classList.remove('show');
      const list = pop.querySelector('.wc-more-plugins');
      if (list) list.textContent = '正在加载插件…';
    });
    document.querySelectorAll('#cpMore,#nchatMore').forEach(button => button.setAttribute('aria-expanded', 'false'));
  }
  ['soduwork-data-scope-changed', 'soduwork:plugins-changed', 'soduwork-plugin-policy']
    .forEach(name => global.addEventListener(name, invalidateMenuPlugins));

  function pluginSection(listId, allId) {
    return '<section class="wc-more-section"><div class="wc-more-section-head">' +
      '<b>插件</b><button type="button" id="' + esc(allId) + '">查看全部</button></div>' +
      '<div class="wc-more-plugins" id="' + esc(listId) + '" aria-live="polite">' +
      '<span>打开后加载可用插件…</span></div></section>';
  }

  function pluginRows(items, selection) {
    if (!items.length) return '<span>还没有安装插件，可以从「查看全部」中添加。</span>';
    const selected = new Set((selection || []).map(item => item.pluginId));
    return items.map(item => {
      const state = global.ChatPluginMention.availability(item, '');
      const display = field => global.ChatPluginMentionModel?.displayText(item, field,
        value => global.SoduWorkI18n?.translateText?.(value) || value) || item[field] || '';
      const name = display('name');
      const description = display('description') || '选择后用于本轮对话';
      const icons = global.SoduWorkPluginIcon;
      const icon = icons?.markup?.(item) || icons?.imageFor?.(item) || ICONS.ability;
      return '<button type="button" class="wc-more-plugin" data-more-plugin="' + esc(item.pluginId || '') +
        '" aria-pressed="' + selected.has(item.pluginId) + '"' + (!state.available ? ' disabled' : '') +
        ' title="' + esc(name + '：' + (state.available ? description : state.label)) + '">' +
        '<i class="wc-plugin-icon" aria-hidden="true">' + icon + '</i>' +
        '<span><b data-user-content>' + esc(name) + '</b><small' + (item.description ? ' data-user-content' : '') + '>' + esc(description) + '</small></span>' +
        (selected.has(item.pluginId) ? '<em class="wc-plugin-selected" aria-label="已选择">✓</em>' :
          !state.available ? '<em>' + esc(state.label) + '</em>' : '') + '</button>';
    }).join('');
  }

  function chatPluginMenu(node, close, options) {
    const o = options || {}, list = node.querySelector('#nchatMorePlugins');
    let request = 0, items = [];
    const scope = () => o.scope?.();
    const current = (token, owner) => node.isConnected && request === token && scope() === owner;
    const render = () => { list.innerHTML = pluginRows(items, o.picker?.()?.selected() || []); };
    const message = (value, retry = false) => {
      const label = document.createElement('span');
      label.textContent = value; list.replaceChildren(label);
      if (!retry) return;
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'wc-more-retry';
      button.dataset.moreRetry = ''; button.textContent = '重新加载'; list.appendChild(button);
    };
    async function load(force = false) {
      const token = ++request, owner = scope(), revision = menuPluginRevision();
      const valid = () => current(token, owner) && revision === menuPluginRevision();
      const cached = peekMenuPlugins();
      if (cached) {
        items = global.ChatPluginMention.normalizeCatalog(cached).filter(item => item.installed || item.personal);
        render();
      } else message('正在加载插件…');
      try {
        const result = await loadMenuPlugins(force);
        if (!valid()) return;
        items = global.ChatPluginMention.normalizeCatalog(result).filter(item => item.installed || item.personal);
        render();
      } catch (_) {
        if (valid()) message('插件目录暂时无法加载', true);
      }
    }
    list.addEventListener('click', async event => {
      if (event.target.closest('[data-more-retry]')) { void load(true); return; }
      const button = event.target.closest('[data-more-plugin]'), picker = o.picker?.();
      if (!button || button.disabled || !picker) return;
      const token = request, owner = scope(), revision = menuPluginRevision();
      const valid = () => current(token, owner) && revision === menuPluginRevision();
      button.disabled = true; button.setAttribute('aria-busy', 'true');
      try {
        await picker.select(button.dataset.morePlugin, valid, { keepText: true });
        if (valid()) { o.changed?.(); close(); }
      } catch (error) {
        if (valid()) global.petSay?.(error.message || '这个插件当前不可用');
      } finally {
        if (valid()) render();
      }
    });
    void load();
    return () => {
      const state = o.state?.() || {};
      const goal = node.querySelector('#nchatMoreGoal');
      goal.querySelector('b').textContent = state.goal ? '持续目标' : '设定目标';
      goal.querySelector('i').textContent = state.goal ? '在对话目标栏中查看与管理' : '请在新对话发送前设置';
      void load();
    };
  }

  function placeMore(button, popup) {
    if (!button || !popup || popup.hidden) return;
    const host = popup.closest('.desk-panel');
    const frame = host ? host.getBoundingClientRect() : { left: 0, right: innerWidth, top: 0, bottom: innerHeight };
    const bounds = { left: Math.max(12, frame.left + 12), right: Math.min(innerWidth - 12, frame.right - 12),
      top: Math.max(12, frame.top + 12), bottom: Math.min(innerHeight - 12, frame.bottom - 12) };
    const anchor = button.getBoundingClientRect();
    const above = anchor.top - bounds.top - 9, below = bounds.bottom - anchor.bottom - 9;
    const upward = below < 360 && above > below;
    popup.style.top = upward ? 'auto' : 'calc(100% + 9px)';
    popup.style.bottom = upward ? 'calc(100% + 9px)' : 'auto';
    popup.style.maxHeight = Math.max(0, Math.min(480, upward ? above : below)) + 'px';
    popup.style.maxWidth = Math.max(0, bounds.right - bounds.left) + 'px';
    popup.style.left = '0px';
    const rect = popup.getBoundingClientRect();
    popup.style.left = Math.max(bounds.left - rect.left, Math.min(0, bounds.right - rect.right)) + 'px';
  }

  // Both composer surfaces keep the picker attached to the selected Agent.
  // Measure the local origin so fixed and positioned containers share the same
  // viewport clamping without assuming where their containing block starts.
  function placeRuntime(button, popup) {
    if (!button || !popup || popup.hidden || !popup.getClientRects().length) return;
    const gap = 10, edge = 16, anchor = button.getBoundingClientRect();
    const parent = popup.offsetParent;
    const origin = parent ? parent.getBoundingClientRect() : { left: 0, top: 0 };
    const originLeft = origin.left + (parent?.clientLeft || 0) - (parent?.scrollLeft || 0);
    const originTop = origin.top + (parent?.clientTop || 0) - (parent?.scrollTop || 0);
    const width = Math.min(320, global.innerWidth - edge * 2);
    const above = Math.max(0, anchor.top - edge - gap);
    const below = Math.max(0, global.innerHeight - anchor.bottom - edge - gap);
    const upward = above >= 240 || above >= below;
    popup.style.width = width + 'px';
    popup.style.maxHeight = Math.min(400, upward ? above : below) + 'px';
    const rect = popup.getBoundingClientRect();
    const left = Math.max(edge, Math.min(anchor.left, global.innerWidth - edge - rect.width));
    const top = upward ? anchor.top - gap - rect.height : anchor.bottom + gap;
    // Do not move the popup to (0, 0) to measure: that transient position can
    // create scrollbars and move a centered composer underneath the anchor.
    popup.style.left = (left - originLeft) + 'px';
    popup.style.top = (top - originTop) + 'px'; popup.style.bottom = 'auto';
    popup.dataset.placement = upward ? 'above' : 'below';
    popup.style.setProperty('--runtime-anchor-x', Math.max(16, Math.min(rect.width - 16,
      anchor.left + anchor.width / 2 - left)) + 'px');
  }

  function bindMoreKeyboard(button, popup, close) {
    if (!button || !popup) return;
    button.setAttribute('aria-haspopup', 'dialog');button.setAttribute('aria-controls', popup.id);
    popup.setAttribute('role', 'dialog');
    if (!popup.hasAttribute('aria-label')) popup.setAttribute('aria-label', '添加内容与插件');
    const items = () => Array.from(popup.querySelectorAll('button:not(:disabled)'))
      .filter(node => node.getClientRects().length);
    button.addEventListener('keydown', event => {
      if (event.key === 'Escape') { close(); return; }
      if (event.key !== 'ArrowDown') return;
      event.preventDefault();
      if (popup.hidden) button.click();
      const first = items()[0]; if (first) first.focus();
    });
    popup.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); close(); button.focus();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const rows = items(), index = rows.indexOf(document.activeElement);
        const next = rows[(index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length];
        if (next) next.focus();
      }
    });
    popup.parentElement.addEventListener('focusout', () => {
      setTimeout(() => {
        // Replacing a loading/retry row moves focus to body, not out of the menu.
        if (document.activeElement !== document.body && !popup.parentElement.contains(document.activeElement)) close();
      }, 0);
    });
  }

  function screenshotRow(id) {
    return '<div class="wc-screenshot-row"><button type="button" class="wc-more-row" id="' + esc(id) + '">' + ICONS.screenshot +
      '<span><b>截图与标注</b><i>框选屏幕，编辑后粘贴到对话</i></span></button>' +
      '<button type="button" class="wc-screenshot-hide" data-screenshot-hide title="隐藏当前窗口后截图" aria-label="隐藏当前窗口后截图">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.2A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.1 3.8M6.5 6.5A19 19 0 0 0 2 12s4 7 10 7a10 10 0 0 0 5.5-1.5"/></svg></button></div>';
  }

  function bindScreenshot(button, close) {
    if (!button) return;
    const hideButton = button.parentElement?.querySelector('[data-screenshot-hide]');
    async function capture(hideOwner) {
      if (button.disabled) return;
      button.disabled = true;
      if (hideButton) hideButton.disabled = true;
      try {
        close();
        // Wait for the hidden menu to paint before the desktop frame is frozen.
        await new Promise(resolve => global.requestAnimationFrame(() => global.requestAnimationFrame(resolve)));
        if (!global.ShortcutSettings?.capture) throw new Error('截图功能尚未就绪，请稍后重试');
        await global.ShortcutSettings.capture('edit', { hideOwner });
      } catch (error) { global.petSay?.(String(error?.message || error || '截图暂时不可用')); }
      finally { button.disabled = false; if (hideButton) hideButton.disabled = false; }
    }
    button.addEventListener('click', () => capture(false));
    hideButton?.addEventListener('click', () => capture(true));
  }

  let executionMenuId = 0, activeExecutionMenu = null;
  function executionMode(attribute) {
    const local = '<svg class="wc-execution-local" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></svg>';
    const cloud = '<svg class="wc-execution-cloud" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18h11a4 4 0 0 0 .5-8 6.5 6.5 0 0 0-12.4-1A4.5 4.5 0 0 0 7 18Z"/></svg>';
    const id = 'wcExecutionMenu' + ++executionMenuId;
    const row = (value, label, icon) => '<button type="button" ' + attribute + '="' + value +
      '" role="menuitemradio" aria-checked="' + (value === 'local') + '" tabindex="-1">' + icon + '<span>' + label +
      '</span><svg class="wc-execution-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg></button>';
    return '<span class="wc-execution-mode"><button type="button" data-execution-menu data-location="local" ' +
      'aria-haspopup="menu" aria-expanded="false" aria-controls="' + id + '" aria-label="' + esc(tx('执行位置：本机')) + '" title="' + esc(tx('本机执行，点击选择执行位置')) + '">' +
      local + cloud + '</button><span class="wc-execution-pop" id="' + id + '" role="menu" aria-label="' + esc(tx('选择执行位置')) + '" hidden>' +
      row('local', tx('本地'), local) + row('cloud', tx('云端'), cloud) + '</span></span>';
  }

  function closeExecutionMenu(restoreFocus = false) {
    const active = activeExecutionMenu;
    if (!active) return;
    activeExecutionMenu = null;
    active.popup.hidden = true; active.button.setAttribute('aria-expanded', 'false');
    if (restoreFocus && active.button.isConnected && !active.button.disabled) active.button.focus({ preventScroll: true });
  }

  // Change the execution location only after selection; opening, canceling, and keyboard browsing leave it unchanged.
  function bindExecutionMenu(host) {
    if (host.dataset.menuBound) return;
    host.dataset.menuBound = 'true';
    const button = host.querySelector('[data-execution-menu]'), popup = host.querySelector('.wc-execution-pop');
    const items = () => Array.from(popup.querySelectorAll('button:not(:disabled)'));
    const open = () => {
      if (button.disabled) return;
      closeExecutionMenu();
      popup.hidden = false; button.setAttribute('aria-expanded', 'true');
      activeExecutionMenu = { host, button, popup };
      placeMore(button, popup);
      const rows = items();
      (rows.find(row => row.getAttribute('aria-checked') === 'true') || rows[0])?.focus({ preventScroll: true });
    };
    button.addEventListener('click', () => { if (popup.hidden) open(); else closeExecutionMenu(true); });
    popup.addEventListener('click', event => {
      const row = event.target.closest('button');
      if (row && !row.disabled) closeExecutionMenu(true);
    });
    host.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (popup.hidden) { open(); return; }
      const rows = items(), index = rows.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      rows[next]?.focus({ preventScroll: true });
    });
    host.addEventListener('focusout', event => {
      if (!host.contains(event.relatedTarget) && activeExecutionMenu?.host === host) closeExecutionMenu();
    });
  }

  function syncExecutionMenu(root, location, disabled, scope) {
    root?.querySelectorAll('.wc-execution-mode').forEach(host => {
      bindExecutionMenu(host);
      const button = host.querySelector('[data-execution-menu]');
      if (activeExecutionMenu?.host === host && (disabled || button.dataset.location !== location ||
        (scope !== undefined && host.dataset.executionScope !== scope))) closeExecutionMenu();
      if (scope !== undefined) host.dataset.executionScope = scope;
      button.dataset.location = location; button.disabled = disabled;
      button.setAttribute('aria-label', tx(location === 'cloud' ? '执行位置：云端' : '执行位置：本机'));
      button.title = tx(location === 'cloud' ? '云端执行，点击选择执行位置' : '本机执行，点击选择执行位置');
    });
  }

  global.document?.addEventListener('pointerdown', event => {
    if (activeExecutionMenu && !activeExecutionMenu.host.contains(event.target)) closeExecutionMenu();
  }, true);
  global.document?.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !activeExecutionMenu) return;
    event.preventDefault(); event.stopImmediatePropagation(); closeExecutionMenu(true);
  }, true);
  global.addEventListener('soduwork-data-scope-changed', () => closeExecutionMenu());

  function upgradeChat(node, options) {
    if (!node) return null;
    const meta = node.querySelector('#nchatMeta');
    const more = '<span class="wc-chat-more cp-more"><button type="button" class="cp-more-button" id="nchatMore" ' +
      'aria-haspopup="menu" aria-expanded="false" title="添加内容和能力" aria-label="添加内容和能力">' + ICONS.plus + '</button>' +
      '<div class="cp-more-pop wc-chat-more-pop" id="nchatMorePop" role="menu" hidden>' +
        '<div class="cp-more-title">添加与设置</div>' +
        '<button type="button" class="wc-more-row" id="nchatFilePick">' + ICONS.attach +
          '<span><b>文件和图片</b><i>选择文件，或直接粘贴到输入框</i></span></button>' +
        screenshotRow('nchatScreenshot') +
        '<button type="button" class="wc-more-row" id="nchatMoreGoal" disabled>' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M22 12h-3M12 22v-3M2 12h3"/></svg>' +
          '<span><b>设定目标</b><i>请在新对话发送前设置</i></span></button>' +
      '</div></span>';
    const context = `<div class='wc-context' id='nchatContext'>` +
      contextButton({ id: 'nchatMode', valueId: 'nchatModeName', icon: 'shield',
        label: '权限', value: '兼容权限', title: '本次会话权限', popup: true, chevron: false }) +
      contextButton({ id: 'nchatWd', valueId: 'nchatWdName', icon: 'folder',
        label: '工作位置', value: '准备工作区', title: '工作位置', readOnly: true }) +
      contextButton({ id: 'nchatAbility', valueId: 'nchatAbilityName', icon: 'ability',
        label: '能力', value: '基础对话', title: '能力在会话开始时确定', muted: true }) + '</div>';
    const next = replace(node, {
      className: 'nbox', inputId: 'nchatInput', rows: 1, placeholder: '接着说…',
      beforeInput: '<div class="catt-tray" id="nchatAtts"></div>',
      afterInput: syntaxHint() + (global.WorkIntent ? WorkIntent.rail('nchat') : ''),
      tools: '<input type="file" id="nchatFile" multiple hidden>' + more + executionMode('data-chat-execution'),
      sendId: 'nchatSend', sendClass: 'nsend', sendTitle: '发送', context,
      actions: (meta ? meta.outerHTML : '') + '<div class="nmodel" id="nchatModel">' +
        '<button type="button" class="nmodel-button" aria-haspopup="dialog" aria-expanded="false" aria-label="选择会话模型">' +
        '<svg class="nmodel-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9zM4.5 7.8l7.5 4.3 7.5-4.3M12 12.1V21"/></svg><span>选择模型</span><i class="nmodel-thinking-dot" aria-hidden="true"></i><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button>' +
        '<div class="nmodel-pop" role="dialog" aria-label="切换模型" hidden></div></div>' +
        '<button type="button" class="wc-agent-badge" id="nchatRuntime" title="本次会话执行底座"><span id="nchatRuntimeIcon"></span><b id="nchatRuntimeName" data-user-content>Agent</b></button>' +
        '<span class="wc-runtime-availability" id="nchatRuntimeAvailability" hidden>' +
          '<span class="wc-runtime-missing" id="nchatRuntimeMissing" role="img" aria-label="' + esc(tx('缺失的执行底座')) + '"></span>' +
          '<button type="button" class="wc-runtime-more" id="nchatRuntimeMore" data-runtime-more hidden title="' + esc(tx('打开 Agent 管理')) + '">' + esc(tx('更多')) + '</button>' +
        '</span>' +
        '<button type="button" class="wc-voice" id="nchatMic" title="语音输入" aria-label="语音输入">' +
        ICONS.mic + '</button>',
    });
    const morePop = next && next.querySelector('#nchatMorePop');
    ['nchatAbility'].forEach((id) => {
      const button = next && next.querySelector('#' + id);
      if (button && morePop) morePop.appendChild(button);
    });
    if (morePop) morePop.insertAdjacentHTML('beforeend', pluginSection('nchatMorePlugins', 'nchatPlugins'));
    const closeMore = () => {
      const button = next && next.querySelector('#nchatMore');
      if (morePop) { morePop.classList.remove('show'); morePop.hidden = true; }
      if (button) button.setAttribute('aria-expanded', 'false');
    };
    const moreButton = next && next.querySelector('#nchatMore');
    const loadPlugins = morePop ? chatPluginMenu(next, closeMore, options) : null;
    if (moreButton && morePop) moreButton.addEventListener('click', (event) => {
      event.stopPropagation();
      const show = morePop.hidden;
      closeMore();
      if (show) {
        morePop.hidden = false; morePop.classList.add('show');
        moreButton.setAttribute('aria-expanded', 'true');
        placeMore(moreButton, morePop);
        loadPlugins();
      }
    });
    const filePick = next && next.querySelector('#nchatFilePick');
    if (filePick) filePick.addEventListener('click', () => {
      const input = next.querySelector('#nchatFile');
      closeMore(); if (input) input.click();
    });
    bindScreenshot(next && next.querySelector('#nchatScreenshot'), closeMore);
    const plugins = next && next.querySelector('#nchatPlugins');
    if (plugins) plugins.addEventListener('click', () => {
      closeMore();
      openPlugins();
    });
    bindMoreKeyboard(moreButton, morePop, closeMore);
    if (morePop) morePop.addEventListener('click', (event) => event.stopPropagation());
    document.addEventListener('click', (event) => {
      if (!event.target.closest('.wc-chat-more')) closeMore();
    });
    ['nchatAbility'].forEach((id) => {
      const button = next && next.querySelector('#' + id);
      if (button) button.disabled = true;
    });
    return next;
  }

  function permissionLabel(mode) { return mode === 'standard' ? '默认权限' : mode === 'full' ? '完全访问' : mode === 'readonly' ? '只读' : '兼容权限'; }

  function permissionAppearance(button, { selectedMode, currentMode, pending = false }) {
    if (!button) return;
    const risk = selectedMode === 'full' || currentMode === 'full';
    button.classList.toggle('wc-permission-risk', risk);
    const icon = risk ? 'shieldAlert' : 'shield';
    if (button.dataset.permissionIcon !== icon) {
      const svg = button.querySelector(':scope > svg');
      if (svg) svg.outerHTML = ICONS[icon];
      button.dataset.permissionIcon = icon;
    }
    if (!risk) { button.removeAttribute('aria-description'); return; }
    const warning = currentMode === 'full' && selectedMode !== 'full'
      ? '当前轮仍为完全访问，新权限将在下一轮生效，请谨慎使用。'
      : pending && currentMode !== 'full'
        ? '下一轮将启用完全访问，请注意文件与数据安全。'
        : '完全访问：可修改文件、运行命令并访问网络，请注意数据安全。';
    button.title = warning;
    button.setAttribute('aria-description', warning);
  }

  function replace(node, options) {
    if (!node) return null;
    const marker = document.createElement('div');
    marker.innerHTML = html(options);
    const next = marker.firstElementChild;
    node.replaceWith(next);
    bindPlaceholder(next);
    return next;
  }

  global.WorkComposer = { html, replace, upgradeChat, contextButton, permissionLabel, permissionAppearance, syntaxHint, executionMode, syncExecutionMenu, closeExecutionMenu,
    openPlugins, pluginSection, pluginRows, loadMenuPlugins, peekMenuPlugins, menuPluginRevision,
    bindMoreKeyboard, screenshotRow, bindScreenshot, placeMore, placeRuntime, bindPlaceholder, icons: ICONS };
  global.addEventListener('resize', () => {
    document.querySelectorAll('.cp-runtime-pop.show').forEach(popup =>
      placeRuntime(popup.parentElement.querySelector('#cpRuntime'), popup));
    if (activeExecutionMenu) placeMore(activeExecutionMenu.button, activeExecutionMenu.popup);
    document.querySelectorAll('.cp-more-button[aria-expanded="true"]').forEach(button =>
      placeMore(button, button.parentElement.querySelector('.cp-more-pop')));
  });
})(window);
