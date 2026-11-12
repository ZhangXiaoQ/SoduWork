/* Archive history for local Pi/Runner conversations and sidebar projects. */
(function (global) {
  'use strict';
  const tr = value => global.SoduWorkI18n?.translateText(value) || value;
  const locale = () => global.SoduWorkI18n?.getLocale() || 'zh-CN';
  let renderEpoch = 0;
  let stateStore = null;
  let stateKey = '';
  let activeTab = 'chats';
  const filters = { query: '', sort: 'updated' };
  let archiveChats = [];
  let archiveProjects = [];

  function api() {
    return global.soduWorkAPI?.conversationSession || global.soduWorkAPI?.piSession || null;
  }
  function projectStore() {
    const options = global.WorkspaceSidebarState?.accountOptions({ storage: localStorage, api: global.SoduWorkAPI });
    if (!options) return null;
    if (!stateStore || stateKey !== options.key) {
      stateStore = global.WorkspaceSidebarState.create(options);
      stateKey = options.key;
    }
    return stateStore;
  }
  function date(value) {
    const at = Number(value || 0);
    if (!at) return '时间未知';
    try { return new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at)); }
    catch (_) { return new Date(at).toLocaleString(); }
  }
  function text(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (['archive-history-item-title', 'archive-history-item-detail'].includes(className)) node.setAttribute('data-user-content', '');
    if (value !== undefined) node.textContent = value;
    return node;
  }
  function action(label, className, handler) {
    const button = text('button', className, label);
    button.type = 'button'; button.addEventListener('click', handler); return button;
  }
  function iconAction(label, className, handler) {
    const button = action('', className + ' archive-history-icon-button', handler);
    button.setAttribute('aria-label', label); button.title = label;
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"></path></svg>';
    return button;
  }
  function copy(node, source, params = {}) {
    node.setAttribute('data-i18n', source);
    node.setAttribute('data-i18n-source', source);
    node.setAttribute('data-i18n-params', JSON.stringify(params));
    node.textContent = global.SoduWorkI18n?.t(source, source, params) || source.replace(/\{(\w+)\}/g, (_, key) => params[key] ?? '');
    return node;
  }
  function message(value, error = false, params = {}) {
    const el = document.getElementById('archiveHistoryStatus');
    if (!el) return;
    copy(el, value || '', params); el.classList.toggle('is-error', !!error);
  }
  function confirmPermanentDeletion(title, detail, confirmLabel, params = {}) {
    return new Promise(resolve => {
      const dialog = document.createElement('dialog');
      dialog.className = 'archive-delete-dialog';
      const form = document.createElement('form'); form.className = 'archive-delete-form';
      const head = text('header', 'archive-delete-head');
      head.append(text('span', 'archive-delete-kicker', '永久删除'), text('h2', 'archive-delete-title', title));
      const detailNode = copy(text('p', 'archive-delete-copy'), detail, params);
      const footer = text('footer', 'archive-delete-actions');
      const cancel = action('取消', 'archive-delete-cancel', () => finish(false));
      const confirm = action(confirmLabel || '彻底删除', 'archive-delete-confirm', () => finish(true));
      footer.append(cancel, confirm); form.append(head, detailNode, footer); dialog.appendChild(form);
      let settled = false;
      function finish(value) {
        if (settled) return;
        settled = true; dialog.close(); dialog.remove(); resolve(Boolean(value));
      }
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
      document.body.appendChild(dialog);
      global.SoduWorkI18n?.translateNode(dialog);
      dialog.showModal();
      cancel.focus();
    });
  }
  function renderEmpty(target, label) {
    target.appendChild(text('div', 'archive-history-empty', label));
  }
  function selectTab(tab) {
    activeTab = tab === 'projects' ? 'projects' : 'chats';
    document.querySelectorAll('#archivePanel [data-archive-tab]').forEach(button => {
      const selected = button.getAttribute('data-archive-tab') === activeTab;
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
    document.querySelectorAll('#archivePanel [data-archive-tabpanel]').forEach(pane => {
      pane.hidden = pane.getAttribute('data-archive-tabpanel') !== activeTab;
    });
  }
  function bindTabs(panel) {
    if (panel._archiveTabsBound) return;
    panel._archiveTabsBound = true;
    panel.querySelectorAll('[data-archive-tab]').forEach(button => {
      button.addEventListener('click', () => selectTab(button.getAttribute('data-archive-tab')));
    });
  }
  function bindFilters(panel) {
    if (panel._archiveFiltersBound) return;
    panel._archiveFiltersBound = true;
    const search = panel.querySelector('#archiveHistorySearch');
    const sortMenu = panel.querySelector('#archiveHistorySortMenu');
    const sortTrigger = panel.querySelector('#archiveHistorySortTrigger');
    const sortOptions = panel.querySelector('#archiveHistorySortOptions');
    if (search) search.addEventListener('input', () => { filters.query = search.value.trim().toLocaleLowerCase(); renderFiltered(); });
    if (sortTrigger && sortOptions) {
      sortTrigger.addEventListener('click', event => {
        event.stopPropagation();
        const open = !sortOptions.hidden;
        sortOptions.hidden = open;
        sortTrigger.setAttribute('aria-expanded', open ? 'false' : 'true');
        sortMenu?.classList.toggle('is-open', !open);
      });
      sortOptions.querySelectorAll('[data-archive-sort]').forEach(option => option.addEventListener('click', () => {
        filters.sort = option.getAttribute('data-archive-sort') || 'updated';
        sortOptions.querySelectorAll('[data-archive-sort]').forEach(item => item.setAttribute('aria-selected', item === option ? 'true' : 'false'));
        const label = panel.querySelector('#archiveHistorySortLabel');
        if (label) label.textContent = { updated: '更新时间', created: '创建时间', alpha: '按字母顺序' }[filters.sort];
        global.SoduWorkI18n?.translateNode(label);
        sortOptions.hidden = true; sortTrigger.setAttribute('aria-expanded', 'false'); sortMenu?.classList.remove('is-open');
        renderFiltered();
      }));
      panel.addEventListener('click', event => {
        if (sortMenu && !sortMenu.contains(event.target)) {
          sortOptions.hidden = true; sortTrigger.setAttribute('aria-expanded', 'false'); sortMenu.classList.remove('is-open');
        }
      });
    }
  }
  function projectForChat(row) {
    return archiveProjects.find(project => (project.chatIds || []).includes(String(row?.id || '')));
  }
  function searchable(value) { return String(value || '').toLocaleLowerCase(); }
  function matchesChat(row) {
    const project = projectForChat(row);
    if (!filters.query) return true;
    return [row.title, row.cwd, row.workdir, row.taskTitle, project?.name].some(value => searchable(value).includes(filters.query));
  }
  function matchesProject(project) {
    if (!filters.query) return true;
    return [project.name, ...(project.folders || [])].some(value => searchable(value).includes(filters.query));
  }
  function sortRows(rows, projectRows = false) {
    return rows.slice().sort((left, right) => {
      if (filters.sort === 'alpha') return String(projectRows ? left.name : left.title || '').localeCompare(String(projectRows ? right.name : right.title || ''), locale());
      const leftAt = Number((filters.sort === 'created' ? left.createdAt || left.at || left.archivedAt : left.archivedAt || left.at) || 0);
      const rightAt = Number((filters.sort === 'created' ? right.createdAt || right.at || right.archivedAt : right.archivedAt || right.at) || 0);
      return rightAt - leftAt;
    });
  }
  function renderFiltered() {
    const list = document.getElementById('archiveHistoryList');
    const projectsList = document.getElementById('archiveProjectsList');
    const count = document.getElementById('archiveHistoryCount');
    if (!list || !projectsList) return;
    list.replaceChildren(); projectsList.replaceChildren();
    const chats = sortRows(archiveChats.filter(matchesChat));
    const projects = sortRows(archiveProjects.filter(matchesProject), true);
    if (!chats.length) renderEmpty(list, filters.query ? '没有匹配的归档会话' : '还没有归档会话');
    else chats.forEach(row => conversationRow(row, list));
    if (!projects.length) renderEmpty(projectsList, filters.query ? '没有匹配的归档项目' : '还没有归档项目');
    else projects.forEach(project => projectRow(project, projectsList));
    if (count) count.textContent = chats.length + ' 条会话 · ' + projects.length + ' 个项目';
  }
  function isMissingResult(result) {
    return Boolean(result && (result.notFound || result.alreadyDeleted));
  }
  async function runChatOperation(ids, operation, rollback, failureLabel) {
    const completed = [];
    for (const id of ids || []) {
      let result;
      try { result = await operation(id); }
      catch (error) { result = { ok: false, reason: String(error?.message || error) }; }
      if (result?.ok) { completed.push(id); continue; }
      if (isMissingResult(result)) continue;
      if (rollback) {
        for (const restoredId of completed.reverse()) {
          try { await rollback(restoredId); } catch (_) { /* best effort rollback */ }
        }
      }
      throw Error(result?.reason || failureLabel);
    }
  }
  function conversationRow(row, target) {
    const item = text('article', 'archive-history-item');
    const main = text('div', 'archive-history-item-main');
    main.append(text('strong', 'archive-history-item-title', row.title || tr('未命名对话')));
    const meta = text('div', 'archive-history-item-meta', [date(row.archivedAt || row.at), row.cwd || row.workdir || tr('本机对话')].join(' · '));
    meta.setAttribute('data-user-content', '');
    main.append(meta);
    const actions = text('div', 'archive-history-item-actions');
    actions.append(action('\u53d6\u6d88\u5f52\u6863', 'archive-history-restore', async () => {
      const store = projectStore();
      actions.querySelectorAll('button').forEach(button => { button.disabled = true; });
      try {
        const got = await api()?.restoreHistory?.(row.id);
        if (!got?.ok) throw Error(got?.reason || '恢复失败');
        store?.restoreChat?.(row.id);
        message('已恢复“{title}”', false, { title: row.title || tr('未命名对话') });
        global.WorkspaceShell?.refreshConversationHistory?.();
        await render();
      } catch (error) { message(error.message || '恢复失败', true); actions.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
    }));
    actions.append(iconAction('\u5220\u9664', 'archive-history-delete', async () => {
      if (!await confirmPermanentDeletion('彻底删除这条会话？', '“{title}”以及它的本地会话记录将被永久删除，删除后无法恢复。', undefined, { title: row.title || tr('未命名对话') })) return;
      actions.querySelectorAll('button').forEach(button => { button.disabled = true; });
      const store = projectStore();
      try {
        const got = await api()?.permanentDeleteHistory?.(row.id);
        if (!got?.ok) throw Error(got?.reason || '彻底删除失败');
        store?.forget?.(row.id);
        message('已彻底删除对话');
        await render();
      } catch (error) { message(error.message || '彻底删除失败', true); actions.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
    }));
    item.append(main, actions); target.appendChild(item);
  }
  function projectRow(project, target) {
    const item = text('article', 'archive-history-item');
    const main = text('div', 'archive-history-item-main');
    main.append(text('strong', 'archive-history-item-title', project.name || tr('未命名项目')));
    main.append(text('div', 'archive-history-item-meta', [date(project.archivedAt), (project.chatIds || []).length + ' 条会话'].join(' · ')));
    if (project.folders?.length) main.append(text('div', 'archive-history-item-detail', project.folders.join('、')));
    const actions = text('div', 'archive-history-item-actions');
    actions.append(action('\u53d6\u6d88\u5f52\u6863', 'archive-history-restore', async () => {
      actions.querySelectorAll('button').forEach(button => { button.disabled = true; });
      try {
        const store = projectStore();
        const sessionApi = api();
        if (!sessionApi?.restoreHistory || !sessionApi?.archiveHistory) throw Error('归档会话接口暂不可用，请重试');
        await runChatOperation(
          project.chatIds,
          id => sessionApi.restoreHistory(id),
          sessionApi.archiveHistory ? id => sessionApi.archiveHistory(id) : null,
          '恢复项目中的会话失败',
        );
        if (!store?.restoreProject) throw Error('项目数据暂不可用，请重试');
        store.restoreProject(project.id);
        global.WorkspaceShell?.refreshConversationHistory?.();
        message('已恢复项目“{name}”', false, { name: project.name || tr('未命名项目') });
        await render();
      } catch (error) { message(error.message || '恢复项目失败', true); actions.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
    }));
    actions.append(iconAction('\u5220\u9664\u9879\u76ee', 'archive-history-delete', async () => {
      if (!await confirmPermanentDeletion('彻底删除这个项目？', '“{name}”及其中的会话记录将被永久删除，删除后无法恢复。', '删除项目', { name: project.name || tr('未命名项目') })) return;
      actions.querySelectorAll('button').forEach(button => { button.disabled = true; });
      try {
        const store = projectStore();
        const sessionApi = api();
        if (!sessionApi?.permanentDeleteHistory) throw Error('归档会话接口暂不可用，请重试');
        await runChatOperation(project.chatIds, id => sessionApi.permanentDeleteHistory(id), null, '删除项目中的会话失败');
        if (!store?.permanentlyDeleteProject) throw Error('项目数据暂不可用，请重试');
        store.permanentlyDeleteProject(project.id);
        global.WorkspaceShell?.refreshConversationHistory?.();
        message('已彻底删除项目');
        await render();
      } catch (error) { message(error.message || '彻底删除项目失败', true); actions.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
    }));
    item.append(main, actions); target.appendChild(item);
  }
  async function render() {
    const panel = document.getElementById('archivePanel');
    if (!panel || !document.getElementById('archiveHistoryList') || !document.getElementById('archiveProjectsList')) return;
    bindTabs(panel);
    bindFilters(panel);
    selectTab(activeTab);
    projectStore();
    const epoch = ++renderEpoch, scope = stateKey;
    const sessionApi = api();
    const current = () => { projectStore(); return epoch === renderEpoch && scope === stateKey; };
    let localRows = [], remoteRows = [], catalog = null;
    function paint() {
      if (!current()) return;
      const records = new Map((catalog?.items || []).map(item => [item.id, item]));
      const rows = new Map();
      for (const row of [...remoteRows, ...localRows]) {
        const canonical = global.WorkspaceSidebarState?.localHistoryId?.(row.id) || row.id;
        const record = records.get(canonical);
        if (record && (record.deleted || !record.archived)) continue;
        rows.set(record?.id || row.id, { ...row, id: record?.id || row.id });
      }
      archiveChats = [...rows.values()];
      archiveProjects = (projectStore()?.get().archivedProjects || []).slice()
        .sort((a, b) => Number(b.archivedAt || 0) - Number(a.archivedAt || 0));
      renderFiltered();
    }
    async function readLocal(refresh) {
      let after = null, restarts = 0;
      let rows = [];
      const cursors = new Set();
      while (true) {
        const got = await sessionApi.history({ source: 'local', archived: true, limit: 200, after,
          ...(catalog ? { workspace: catalog.workspace, catalogRevision: catalog.revision } : {}),
          refresh: refresh && !after });
        if (!current()) return;
        if (got?.localCatalog && global.WorkspaceSidebarState?.localHistoryRevision?.(got.localCatalog.workspace) > got.localCatalog.revision)
          return;
        if (!got?.ok || !global.WorkspaceSidebarState?.setLocalHistory(got.localCatalog, got.chats || []))
          throw Error(got?.reason || '读取归档历史失败');
        // A later page may include a newer inventory with records before the
        // cursor. Restart that traversal instead of claiming it is complete.
        // Bound retries so continuous writes cannot keep the panel loading.
        if (after && catalog?.revision !== got.localCatalog.revision) {
          catalog = got.localCatalog;
          if (++restarts > 2) { paint(); throw Error('读取归档历史失败'); }
          after = null; rows = []; cursors.clear();
          continue;
        }
        // A refresh with unchanged inventory only updates the visible page's
        // decorations. Avoid reading every archived page a second time.
        if (refresh && !after && restarts === 0 && catalog?.revision === got.localCatalog.revision) {
          const latest = new Map((got.chats || []).map(row => [row.id, row]));
          localRows = localRows.map(row => latest.get(row.id) || row);
          paint(); return;
        }
        if (Array.isArray(got.localCatalog.items)) catalog = got.localCatalog;
        rows.push(...(got.chats || []));
        // Keep the existing complete-archive search contract, but render only
        // the first page and completed inventory instead of rebuilding per page.
        if (!after || !got.next) { localRows = rows; paint(); }
        after = got.next;
        if (after) {
          const cursor = JSON.stringify(after);
          if (cursors.has(cursor)) throw Error('读取归档历史失败');
          cursors.add(cursor);
        }
        if (!after) break;
      }
    }
    // Local archives render independently of account requests or expired credentials.
    const local = sessionApi?.localHistorySupported === true
      ? readLocal(false).then(() => current() && readLocal(true)).catch(error => {
        if (current()) message(error.message || '读取归档历史失败', true);
      }) : Promise.resolve();
    async function readAccount() {
      const separate = sessionApi?.localHistorySupported === true;
      let after = null;
      const rows = [], cursors = new Set();
      do {
        const got = separate
          ? await sessionApi.history({ source: 'account', archived: true, limit: 200, after })
          : await sessionApi?.archivedHistory?.();
        if (!current()) return;
        if (got && !got.ok) throw Error(got.reason || '读取归档历史失败');
        rows.push(...(got?.chats || []));
        if (!after || !got?.next) { remoteRows = rows; paint(); }
        after = separate ? got?.next : null;
        if (after) {
          const cursor = JSON.stringify(after);
          if (cursors.has(cursor)) throw Error('读取归档历史失败');
          cursors.add(cursor);
        }
      } while (after);
    }
    const remote = readAccount().catch(error => {
      if (current()) message(error.message || '读取归档历史失败', true);
    });
    await Promise.all([local, remote]);
  }
  function openArchiveHistory() {
    const panel = document.getElementById('archivePanel');
    if (!panel) return;
    panel.classList.add('show'); message(''); bindTabs(panel); bindFilters(panel); selectTab(activeTab);
    document.getElementById('archiveClose')?.addEventListener('click', closeArchiveHistory, { once: true });
    render();
  }
  function closeArchiveHistory() {
    document.getElementById('archivePanel')?.classList.remove('show');
  }
  global.addEventListener('soduwork-locale-change', () => {
    if (document.getElementById('archivePanel')?.classList.contains('show')) renderFiltered();
  });
  const refreshAccount = () => {
    const before = stateKey;
    projectStore();
    if (stateKey === before) return;
    renderEpoch++;
    archiveChats = []; archiveProjects = [];
    if (document.getElementById('archivePanel')?.classList.contains('show')) {
      renderFiltered();
      void render();
    }
  };
  global.addEventListener('soduwork-device-auth', refreshAccount);
  global.addEventListener('soduwork-data-scope-changed', refreshAccount);
  global.openArchiveHistory = openArchiveHistory;
  global.closeArchiveHistory = closeArchiveHistory;
})(window);
