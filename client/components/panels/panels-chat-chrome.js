/*
 * Conversation header owns title, workspace, and canvas visibility. ChatWorkbench remains
 * responsible for file/web previews and output state.
 */
(function (global) {
  'use strict';

  const ICONS = {
    request: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="3.5" width="15" height="17" rx="3"/><path d="m8 9 1.5 1.5L12 8m-4 7 1.5 1.5L12 14m2-4h2m-2 6h2"/></svg>',
    folder: '<svg viewBox="0 0 24 24"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>',
    summary: '<svg viewBox="0 0 24 24"><path d="M5 7h7M16 7h3M5 12h3M12 12h7M5 17h8M17 17h2"/><circle cx="14" cy="7" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="15" cy="17" r="2"/></svg>',
    pane: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4" width="17" height="16" rx="3"/><path d="M13.5 4v16"/></svg>',
    more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>',
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>',
  };

  let root = null;
  let getContext = null;
  let title = '新对话';
  let workspace = { name: '准备工作区', dir: '' };
  let sessionId = '';
  let pendingHistory = null;
  let workbench = { open: false, maximized: false, count: 0, has: false, summary: {} };
  let summaryOpen = false;
  /* Initially show twelve files; expand within the panel to match the total badge. */
  let summaryExpanded = false;
  const SUMMARY_FILE_LIMIT = 12;
  let titleMenuOpen = false;
  let renameDialog = null;
  let unbindDocument = null;

  const compact = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 40) || '新对话';
  const esc = (value) => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function header() {
    const appChat = global.__deskPanel === 'chatbar';
    return '<header class="nchat-head">' +
      '<div class="nchat-head-title">' + (appChat ? '<button type="button" class="nchat-head-icon" data-app-chat-history title="历史对话" aria-label="历史对话" aria-haspopup="dialog" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button>' : ICONS.folder) + '<span>' +
        (appChat ? '<button type="button" class="nchat-app-title" data-app-chat-history-title title="历史对话" aria-haspopup="dialog" aria-expanded="false">' : '') +
        '<b id="nchatTitle">新对话</b>' + (appChat ? '</button>' : '') + '</span>' +
        (appChat ? '' : '<div class="nchat-title-tools"><button type="button" class="nchat-head-icon" data-chat-menu disabled' +
          ' aria-label="会话操作" title="会话操作" aria-haspopup="menu" aria-controls="nchatTitleMenu" aria-expanded="false">' + ICONS.more + '</button>' +
          '<div class="nchat-title-menu" id="nchatTitleMenu" role="menu" aria-label="会话操作" hidden>' +
            '<button type="button" role="menuitem" data-chat-rename>' + ICONS.edit + '<span>重命名</span><kbd>Ctrl+Alt+R</kbd></button>' +
            '<button type="button" role="menuitem" data-chat-cloud hidden>' + (global.ChatCloudHandoff?.ICON || ICONS.pane) + '<span>云端会话</span></button>' +
          '</div></div>') + '</div>' +
      '<div class="nchat-head-actions">' +
        '<button type="button" class="nchat-head-action" data-chat-open-location title="打开当前工作位置">' +
          ICONS.folder + '<span>打开位置</span></button>' +
        '<button type="button" class="nchat-head-icon" data-chat-summary aria-expanded="false" aria-controls="nchatSummary" aria-label="切换成果摘要面板" title="切换成果摘要面板">' +
          ICONS.summary + '<i data-chat-result-count></i></button>' +
        '<button type="button" class="nchat-head-icon" data-chat-pane aria-pressed="false" title="显示成果承载区">' +
          ICONS.pane + '</button>' +
        (appChat ? '<button type="button" class="nchat-head-icon" data-app-chat-new title="新建对话" aria-label="新建对话"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>' : '') +
        '<section class="nchat-summary" id="nchatSummary" data-chat-summary-pop aria-label="本次工作" hidden>' +
          '<header><b>本次工作</b><span data-chat-summary-count></span>' +
            '<button type="button" class="nchat-summary-close" data-chat-summary-close aria-label="关闭成果摘要" title="关闭成果摘要">' + ICONS.close + '</button></header>' +
          '<div data-chat-summary-body></div></section>' +
      '</div></header>';
  }

  function summaryHtml() {
    const data = workbench.summary || {};
    const live = data.services || [];
    const files = data.files || [];
    const changes = data.changes || [];
    let html = live.map((item) => '<button type="button" data-wb-service="' + esc(item.id) +
      "\"><span class=\"nchat-summary-live\"></span><b" + (item.title ? ' data-user-content' : '') + '>' + esc(item.title || '本地预览') +
      '</b><small>' + esc(item.url || item.state || '') + '</small></button>').join('');
    const shown = summaryExpanded ? files : files.slice(0, SUMMARY_FILE_LIMIT);
    html += shown.map((item) => '<button type="button" ' +
      (item.workspace ? 'data-wb-file' : 'data-chat-open-file') + '="' + esc(item.path) +
      "\"><span class=\"nchat-summary-file\">文</span><b" + (item.name ? ' data-user-content' : '') + '>' + esc(item.name || '成果文件') +
      '</b><small>' + esc(item.size || '') + '</small></button>').join('');
    const total = Number(workbench.count) || (files.length + live.length);
    if (summaryExpanded && files.length > SUMMARY_FILE_LIMIT) {
      html += '<button type="button" class="nchat-summary-more" data-chat-summary-expand>收起</button>';
    } else if (!summaryExpanded && total > live.length + shown.length) {
      html += '<button type="button" class="nchat-summary-more" data-chat-summary-expand>查看全部 ' + total + ' 项</button>';
    }
    if (!html && changes.length) html = '<button type="button" data-wb-tool="' + esc(changes[changes.length - 1].id) +
      '"><span class="nchat-summary-file">改</span><b>本轮修改</b><small>' + changes.length + ' 处</small></button>';
    return html || '<div class="nchat-summary-empty">成果、运行页面和变更会集中显示在这里。</div>';
  }

  function mountSummary() {
    const panel = root?.querySelector('[data-chat-summary-pop]');
    // Escape the scrolling chat column without reserving any layout width.
    if (panel && panel.parentElement !== root) root.append(panel);
  }

  function closeSummary(restoreFocus = false) {
    summaryOpen = false;
    paint();
    if (restoreFocus) root?.querySelector('[data-chat-summary]')?.focus({ preventScroll: true });
  }

  function paint() {
    if (!root) return;
    root.classList.toggle('nchat-summary-open', summaryOpen);
    const context = typeof getContext === 'function' ? getContext() : null;
    global.ChatCloudHandoff?.sync(root, context?.snapshot, context);
    const titleNode = root.querySelector('#nchatTitle');
    const location = root.querySelector('[data-chat-open-location]');
    const summary = root.querySelector('[data-chat-summary]');
    const pane = root.querySelector('[data-chat-pane]');
    const pop = root.querySelector('[data-chat-summary-pop]');
    const menuButton = root.querySelector('[data-chat-menu]');
    const titleMenu = root.querySelector('#nchatTitleMenu');
    if (titleNode) { titleNode.toggleAttribute('data-user-content', !!sessionId || !!pendingHistory || title !== '新对话'); if (titleNode.textContent !== title) titleNode.textContent = title; if (titleNode.title !== title) titleNode.title = title; }
    if (menuButton) { menuButton.disabled = !sessionId; menuButton.setAttribute('aria-expanded', String(titleMenuOpen)); }
    if (titleMenu) titleMenu.hidden = !titleMenuOpen;
    if (location) location.title = workspace.dir ? ('打开 ' + workspace.dir) : '打开当前工作位置';
    if (summary) {
      summary.classList.toggle('active', summaryOpen);
      summary.setAttribute('aria-expanded', String(summaryOpen));
      const count = summary.querySelector('[data-chat-result-count]');
      if (count) { const next = workbench.count ? String(workbench.count) : ''; if (count.textContent !== next) count.textContent = next; }
    }
    if (pane) {
      pane.hidden = !workbench.has;
      pane.classList.toggle('active', workbench.open);
      pane.setAttribute('aria-pressed', String(workbench.open));
      pane.title = workbench.open ? '隐藏运行预览' : '显示运行预览';
    }
    if (pop) {
      pop.hidden = !summaryOpen;
      const count = pop.querySelector('[data-chat-summary-count]');
      const body = pop.querySelector('[data-chat-summary-body]');
      if (count) { const next = workbench.count ? workbench.count + ' 项' : ''; if (count.textContent !== next) count.textContent = next; }
      if (body) { const html = summaryHtml(); if (body.innerHTML !== html) body.innerHTML = html; }
    }
  }

  function bind(nextRoot, context) {
    root = nextRoot;
    getContext = context;
    global.SoduWorkAppConversations?.bind(root);
    mountSummary();
    if (!root || root.dataset.chatChromeBound) { paint(); return; }
    root.dataset.chatChromeBound = '1';
    if (unbindDocument) unbindDocument();
    const outside = event => {
      if (titleMenuOpen && !event.target.closest('.nchat-title-tools')) closeTitleMenu();
      if (summaryOpen && !event.target.closest('[data-chat-summary-pop],[data-chat-summary]')) closeSummary();
    };
    const keyboard = event => {
      if (!root || !root.isConnected || renameDialog) return;
      if (event.isComposing || event.keyCode === 229) return;
      if (sessionId && (event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === 'r') {
        event.preventDefault(); openRename();
      } else if (titleMenuOpen && event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); closeTitleMenu(true);
      } else if (summaryOpen && event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); closeSummary(true);
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', keyboard);
    unbindDocument = () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', keyboard); };
    root.addEventListener('keydown', event => {
      if (!event.target.closest('.nchat-title-tools')) return;
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        if (!sessionId) return;
        event.preventDefault(); titleMenuOpen = true; paint();
        const items = [...root.querySelectorAll('#nchatTitleMenu [role="menuitem"]')];
        const current = items.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      } else if (event.key === 'Tab' && titleMenuOpen) closeTitleMenu(true);
    });
    root.addEventListener('click', (event) => {
      const hit = event.target.closest('[data-chat-menu],[data-chat-rename],[data-chat-cloud],[data-chat-cloud-status],[data-chat-execution],[data-chat-open-location],[data-chat-summary],[data-chat-summary-close],[data-chat-pane],[data-chat-summary-expand],' +
        '[data-chat-open-file],[data-wb-file],[data-wb-service],[data-wb-tool]');
      if (!hit) return;
      if (hit.hasAttribute('data-chat-menu')) {
        if (!sessionId) return;
        titleMenuOpen = !titleMenuOpen; paint();
        if (titleMenuOpen) root.querySelector('[data-chat-rename]')?.focus();
        return;
      }
      if (hit.hasAttribute('data-chat-rename')) { openRename(); return; }
      if (hit.hasAttribute('data-chat-execution')) {
        void global.ChatCloudHandoff?.select(hit.dataset.chatExecution, getContext?.()); return;
      }
      if (hit.hasAttribute('data-chat-cloud') || hit.hasAttribute('data-chat-cloud-status')) {
        closeTitleMenu(); global.ChatCloudHandoff?.open(getContext?.()?.ref); return;
      }
      if (hit.hasAttribute('data-chat-open-location')) {
        const api = global.soduWorkAPI && (global.soduWorkAPI.conversationSession || global.soduWorkAPI.piSession);
        const ctx = typeof getContext === 'function' ? (getContext() || {}) : {};
        if (api && ctx.ref && typeof api.openSessionWorkdir === 'function') api.openSessionWorkdir(ctx.ref);
        else if (api && typeof api.openWorkdir === 'function') api.openWorkdir();
        return;
      }
      if (hit.hasAttribute('data-chat-summary')) {
        summaryOpen = !summaryOpen;
        paint();
        return;
      }
      if (hit.hasAttribute('data-chat-summary-close')) { closeSummary(true); return; }
      if (hit.hasAttribute('data-chat-summary-expand')) {
        summaryExpanded = !summaryExpanded;
        paint();
        return;
      }
      if (hit.hasAttribute('data-chat-open-file')) {
        summaryOpen = false;
        if (global.ChatWorkbench && typeof ChatWorkbench.openOutput === 'function') {
          ChatWorkbench.openOutput(hit.dataset.chatOpenFile);
        }
        paint();
        return;
      }
      if (hit.hasAttribute('data-wb-file') || hit.hasAttribute('data-wb-service') || hit.hasAttribute('data-wb-tool')) {
        summaryOpen = false;
        global.setTimeout(paint, 0);
        return;
      }
      if (!global.ChatWorkbench) return;
      if (hit.hasAttribute('data-chat-pane')) ChatWorkbench.toggle();
    });
    paint();
  }

  function closeTitleMenu(restoreFocus = false) {
    titleMenuOpen = false; paint();
    if (restoreFocus) root?.querySelector('[data-chat-menu]')?.focus({ preventScroll: true });
  }

  function openRename(id = sessionId, value = title) {
    if (global.__deskPanel === 'chatbar') return;
    if (!id || !root) return;
    closeTitleMenu();
    if (renameDialog) renameDialog.dismiss(false);
    const targetId = String(id), original = String(value || '');
    const dialog = document.createElement('dialog');
    dialog.className = 'nchat-rename-dialog';
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'nchatRenameTitle');
    dialog.setAttribute('aria-describedby', 'nchatRenameHint');
    dialog.innerHTML = '<form class="nchat-rename-form" novalidate>' +
      '<header><div><h2 id="nchatRenameTitle">重命名对话</h2><p id="nchatRenameHint">保持简短，方便下次找到。</p></div>' +
        '<button type="button" class="nchat-rename-close" data-rename-cancel aria-label="关闭改名">' + ICONS.close + '</button></header>' +
      '<input class="nchat-rename-input" type="text" aria-label="会话名称" aria-describedby="nchatRenameError" autocomplete="off">' +
      '<p class="nchat-rename-error" id="nchatRenameError" role="alert" hidden></p>' +
      '<footer><button type="button" data-rename-cancel>取消</button><button type="submit" class="nchat-rename-save">保存</button></footer></form>';
    const form = dialog.querySelector('form'), input = dialog.querySelector('input');
    const save = dialog.querySelector('[type="submit"]'), error = dialog.querySelector('[role="alert"]');
    input.value = original;
    let busy = false;
    dialog.dismiss = (restoreFocus = true) => {
      if (dialog.open) dialog.close();
      dialog.remove();
      if (renameDialog === dialog) renameDialog = null;
      if (restoreFocus && root?.isConnected) root.querySelector('[data-chat-menu]')?.focus({ preventScroll: true });
    };
    dialog.querySelectorAll('[data-rename-cancel]').forEach(button => button.addEventListener('click', () => dialog.dismiss()));
    dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.dismiss(); });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.dismiss();
    });
    form.addEventListener('keydown', event => {
      if ((event.isComposing || event.keyCode === 229) && event.key === 'Enter') event.preventDefault();
    });
    input.addEventListener('input', () => { error.hidden = true; input.removeAttribute('aria-invalid'); });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (busy) return;
      const name = input.value.replace(/\s+/g, ' ').trim();
      const fail = message => {
        if (!dialog.isConnected) { global.petSay?.(message); return; }
        error.textContent = message; error.hidden = false; input.setAttribute('aria-invalid', 'true'); input.focus();
      };
      if (!name || Array.from(name).length > 120) { fail(name ? '最多 120 个字符' : '请输入会话名称'); return; }
      if (name === original) { dialog.dismiss(); return; }
      busy = true; save.disabled = true; input.readOnly = true; form.setAttribute('aria-busy', 'true'); save.textContent = '保存中…';
      try {
        if (typeof global.WorkspaceShell?.renameChat !== 'function') throw Error('改名暂不可用，请重新打开会话');
        await global.WorkspaceShell.renameChat(targetId, name);
        if (dialog.isConnected) dialog.dismiss();
      } catch (problem) { fail(problem.message || '改名未保存，请重试'); }
      finally { busy = false; save.disabled = false; input.readOnly = false; form.removeAttribute('aria-busy'); save.textContent = '保存'; }
    });
    renameDialog = dialog; document.body.append(dialog); dialog.showModal(); input.focus(); input.select();
  }

  function begin(text) {
    if (title === '新对话') title = compact(text);
    if (!sessionId && !pendingHistory && global.WorkspaceShell && typeof WorkspaceShell.upsertChat === 'function') {
      pendingHistory = { localId: 'draft-' + Date.now().toString(36), title, at: Date.now(), pending: true };
      WorkspaceShell.upsertChat(pendingHistory);
    }
    paint();
  }

  function identify(value) {
    if (!value) return;
    const id = String(value);
    if (id !== sessionId) {
      titleMenuOpen = false;
      if (renameDialog) renameDialog.dismiss(false);
    }
    sessionId = id;
    global.SoduWorkAppConversations?.identified(id, title);
    paint();
    if (global.WorkspaceShell && typeof global.WorkspaceShell.setActiveChat === 'function') {
      global.WorkspaceShell.setActiveChat(id);
    }
    if (!pendingHistory) return;
    pendingHistory = { ...pendingHistory, id };
    if (global.WorkspaceShell && typeof WorkspaceShell.upsertChat === 'function') {
      WorkspaceShell.upsertChat(pendingHistory);
    }
  }


  function confirmHistory(refresh) {
    if (!pendingHistory || typeof refresh !== 'function') return;
    [120, 650, 1800].forEach((delay) => global.setTimeout(refresh, delay));
  }

  function cancelPending() {
    if (pendingHistory && global.WorkspaceShell && typeof WorkspaceShell.removeChat === 'function') {
      WorkspaceShell.removeChat(pendingHistory.localId);
    }
    pendingHistory = null;
  }

  function resume(value) {
    if (value) title = String(value).replace(/\s+/g, ' ').trim();
    if (sessionId) global.SoduWorkAppConversations?.identified(sessionId, title);
    paint();
  }
  function rename(id, value) { if (String(id) === sessionId) resume(value); }
  function setWorkspace(next) { workspace = { ...workspace, ...(next || {}) }; paint(); }
  function workbenchState(next) { workbench = { ...workbench, ...(next || {}) }; paint(); }
  function openSummary() { summaryOpen = true; paint(); }
  function reset() {
    if (renameDialog) renameDialog.dismiss(false);
    if (unbindDocument) unbindDocument();
    unbindDocument = null; titleMenuOpen = false;
    root = null; getContext = null; title = '新对话'; workspace = { name: '准备工作区', dir: '' };
    sessionId = '';
    if (global.WorkspaceShell && typeof global.WorkspaceShell.setActiveChat === 'function') {
      global.WorkspaceShell.setActiveChat('');
    }
    summaryOpen = false; summaryExpanded = false;
    pendingHistory = null; workbench = { open: false, maximized: false, count: 0, has: false, summary: {} };
  }

  global.ChatChrome = { header, bind, begin, identify, confirmHistory, cancelPending, resume, rename, openRename, setWorkspace,
    get sessionTitle() { return sessionId && title !== '新对话' ? title : ''; },
    get workspace() { return { ...workspace }; }, workbenchState, openSummary, reset };
})(window);
