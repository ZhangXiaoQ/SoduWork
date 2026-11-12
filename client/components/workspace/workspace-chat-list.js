/* Renderer behavior extracted without copying its owner's state. */
(function (global) {
  'use strict';
  const FALLBACK_HARNESS_NAMES = {
    pi:'Pi', codex:'Codex', 'codex-harness':'Codex Harness', opencode:'OpenCode',
    claude:'Claude Code', kimi:'Kimi Code', qwen:'Qwen Code', dsh:'DeepSeek Harness', harness2:'Google Harness²',
  };
  function harnessNames() { return global.AgentBrand?.LABELS || FALLBACK_HARNESS_NAMES; }
  function historyHarnesses(row) {
    const labels = harnessNames();
    if (Array.isArray(row.usedHarnesses)) {
      // The main process supplies whole-conversation execution provenance. An
      // explicit empty set must never fall back to an unsent composer choice.
      return [...new Set(row.usedHarnesses.map(value => typeof value === 'string'
        ? global.AgentBrand?.canonical(value) || value.toLowerCase() : '')
        .filter(id => id !== 'custom' && Object.hasOwn(labels, id)))];
    }
    if (row.pending || row.workOnly || row.count === 0) return [];
    const legacy = String(row.adapterId || row.runtime || '').toLowerCase();
    return legacy !== 'custom' && Object.hasOwn(labels, legacy) ? [legacy] : [];
  }
  function harnessIcon(id) {
    if (global.AgentBrand?.html) return global.AgentBrand.html(id);
    return '<span class="agent-brand" data-agent-brand="' + id + '"><svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="m12 3 8 4v10l-8 4-8-4V7zM4 7l8 4 8-4M12 11v10"/></svg></span>';
  }
  function create(ctx) {
  function accountOwner() {
    const api = global.SoduWorkAPI;
    if (global.WorkspaceSidebarState?.accountOptions) {
      const options = global.WorkspaceSidebarState.accountOptions({ api });
      return options.writable === false ? '' : options.key;
    }
    return String(api?.taskStorageKey?.('tasks') || '');
  }
  let historyOwner = accountOwner(), hadOwner = Boolean(historyOwner), historyEpoch = 0;
  let mutationGeneration = 0, accountMutationGeneration = 0, lifecycleOverflow = false;
  const lifecycle = new Map(), MAX_LIFECYCLE_IDS = 1024;
  let localRows = [], localLoad = null, localReady = false, localNext = null, localRestart = false;
  let localCatalog = null, localRecords = new Map(), localAliases = new Set();
  let localError = '', accountError = '', nativeRefreshStarted = false;
  let localRefreshTimer = null, localRefreshPending = false, closed = false;
  const historyApi = () => global.soduWorkAPI && (global.soduWorkAPI.conversationSession || global.soduWorkAPI.piSession);
  const supportsLocalHistory = () => historyApi()?.localHistorySupported === true;
  const isLocalId = id => localAliases.has(String(id || ''));
  const canonicalLocalId = id => global.WorkspaceSidebarState?.localHistoryId(id) || '';
  const localVisible = row => {
    const record = localRecords.get(canonicalLocalId(row?.id));
    return record && !record.archived && !record.deleted;
  };
  const historyText = (key, fallback) => global.SoduWorkI18n?.t(key, fallback) || fallback;
  function rowIds(row, fallback) {
    return [...new Set([fallback, row?.id, row?.localId,
      ...(Array.isArray(row?.historyAliasIds) ? row.historyAliasIds : []),
      ...(Array.isArray(row?.aliasIds) ? row.aliasIds : [])].filter(Boolean).map(String))];
  }
  function hiddenRow(row) {
    return rowIds(row).some(id => lifecycle.get(id)?.hidden);
  }
  function activeConversationIds() {
    const ids = new Set(rowIds({ id: ctx.activeChatId }));
    try {
      const info = global.NativeChat?.sessionInfo?.();
      for (const key of ['sessionId', 'ref', 'runtimeConversationId']) {
        if (info?.[key]) ids.add(String(info[key]));
      }
    } catch (_) { /* The native bridge may be unavailable during teardown. */ }
    return ids;
  }
  async function openNewConversation() {
    const payload = { newSession: true, tab: 'chat' };
    try {
      if (typeof global.WorkspaceHost?.open === 'function') {
        const opened = await Promise.resolve(global.WorkspaceHost.open('create', payload));
        if (opened !== false) return true;
      }
      if (typeof global.openComposePanel === 'function')
        return (await Promise.resolve(global.openComposePanel(payload))) !== false;
    } catch (_) {
      try {
        if (typeof global.openComposePanel === 'function')
          return (await Promise.resolve(global.openComposePanel(payload))) !== false;
      } catch (_) { /* Keep the list usable even when the shell is closing. */ }
    }
    return false;
  }
  function needsHistoryConfirmation(row) {
    return lifecycleOverflow && !row.pending && !rowIds(row).some(id =>
      lifecycle.get(id)?.hidden === false || ctx.chatItems.some(item => rowIds(item).includes(id)));
  }
  function applyLifecycle(row, fallback, startedAt = Infinity) {
    const hidden = row.archived === true || row.deleted === true;
    const ids = new Set(rowIds(row, fallback));
    // Canonical IDs, authenticated aliases and an existing record form one lifecycle.
    // Do not join by title/task/sourceSessionId: foreign copies can be independent.
    for (const id of ids) {
      for (const alias of lifecycle.get(id)?.ids || []) ids.add(alias);
      for (const item of ctx.chatItems) {
        const aliases = rowIds(item);
        if (aliases.includes(id)) for (const alias of aliases) ids.add(alias);
      }
    }
    if (!ids.size) return false;
    const previous = [...new Set([...ids].map(id => lifecycle.get(id)).filter(Boolean))];
    const suppliedRevision = Number(row.lifecycleRevision ?? row.revision);
    const revision = Number.isFinite(suppliedRevision) && suppliedRevision > 0 ? suppliedRevision : 0;
    if (previous.some(record => revision && record.revision > revision ||
        record.generation > startedAt && record.hidden !== hidden)) return false;
    const retainedRevision = Math.max(revision, ...previous.map(record => record.revision), 0);
    const changed = [...ids].some(id => {
      const record = lifecycle.get(id);
      return !record || record.hidden !== hidden || record.revision !== retainedRevision;
    });
    if (changed) {
      mutationGeneration++;
      // A device tombstone cannot invalidate an unrelated account directory
      // reply that is loading concurrently with the local catalog.
      if (!supportsLocalHistory() || [...ids].some(id => !isLocalId(id))) {
        accountMutationGeneration++; ctx.historyLoad = null;
      }
    }
    const record = { hidden, revision: retainedRevision, generation: mutationGeneration, ids: new Set(ids) };
    for (const id of ids) {
      lifecycle.get(id)?.ids.delete(id);
      lifecycle.delete(id); lifecycle.set(id, record);
    }
    while (lifecycle.size > MAX_LIFECYCLE_IDS) {
      const oldest = lifecycle.keys().next().value;
      lifecycle.get(oldest).ids.delete(oldest); lifecycle.delete(oldest);
      // After eviction, unknown presence is only an invalidation hint. The
      // authoritative history read confirms it instead of reviving an old row.
      lifecycleOverflow = true;
    }
    if (hidden) ctx.chatItems = ctx.chatItems.filter(item => !hiddenRow(item));
    return { changed, hidden, ids: [...ids] };
  }
  function syncHistoryOwner() {
    const next = accountOwner();
    if (next === historyOwner) return false;
    historyOwner = next;
    // The initial bootstrap only binds the already-open local history. Token
    // renewal and device replacement have the same Hub/account owner key.
    if (!hadOwner) { hadOwner = Boolean(next); return Boolean(next); }
    historyEpoch++;
    mutationGeneration++;
    lifecycle.clear(); lifecycleOverflow = false;
    ctx.historyLoad = null;
    ctx.chatItems = supportsLocalHistory() ? ctx.chatItems.filter(row => isLocalId(row.id)) : [];
    if (supportsLocalHistory()) {
      for (const id of ctx.chatNames?.keys() || []) if (!isLocalId(id)) ctx.chatNames.delete(id);
    } else ctx.chatNames?.clear();
    if (!isLocalId(ctx.activeChatId)) ctx.activeChatId = '';
    ctx.chatsLoading = !localReady && Boolean(next); accountError = '';
    closeChatMenu();
    try { ctx.sessionOff?.(); } finally { ctx.sessionOff = null; }
    if (ctx.root) ctx.renderChats();
    return true;
  }
  function refreshAccount() {
    if (!syncHistoryOwner() || !ctx.root) return;
    subscribeConversationPresence();
    void refreshConversationHistory();
  }
  global.addEventListener?.('soduwork-device-auth', refreshAccount);
  global.addEventListener?.('soduwork-data-scope-changed', refreshAccount);
  global.addEventListener?.('beforeunload', () => {
    closed = true; localRefreshPending = false;
    if (localRefreshTimer !== null) global.clearTimeout(localRefreshTimer);
    localRefreshTimer = null;
  });
  function scheduleLocalHistoryRefresh() {
    if (!supportsLocalHistory() || closed || typeof global.setTimeout !== 'function') return;
    if (localRefreshTimer !== null) global.clearTimeout(localRefreshTimer);
    // Native persistence trails presence. This coalesced read is best effort;
    // only the resulting durable catalog can promote a row to shared history.
    localRefreshTimer = global.setTimeout(() => {
      localRefreshTimer = null; localRefreshPending = true;
      flushLocalHistoryRefresh();
    }, 1200);
  }
  function flushLocalHistoryRefresh() {
    if (closed || !localRefreshPending || localLoad) return;
    localRefreshPending = false;
    void refreshLocalHistory();
  }

function pinStorageKey() {
    let scope = 'default';
    try {
      if (global.SoduWorkAPI && typeof SoduWorkAPI.hubBase === 'function') scope = SoduWorkAPI.hubBase() || scope;
    } catch (e) { /* Use the default isolation scope until Hub is ready. */ }
    return 'soduwork_work_chat_pins_v1:' + encodeURIComponent(scope);
  }

function legacyPinnedIds() {
    try {
      const value = JSON.parse(localStorage.getItem(pinStorageKey()) || '[]');
      return new Set(Array.isArray(value) ? value.map(String) : []);
    } catch (e) { return new Set(); }
  }

function pinnedIds() {
    return ctx.sidebarProjects ? ctx.sidebarProjects.pins() : legacyPinnedIds();
  }

function togglePinned(id) {
    if (!id) return;
    if (ctx.sidebarProjects) { ctx.sidebarProjects.togglePin(String(id)); renderChats(); return; }
    const ids = pinnedIds();
    if (ids.has(String(id))) ids.delete(String(id)); else ids.add(String(id));
    try { localStorage.setItem(pinStorageKey(), JSON.stringify([...ids])); } catch (e) {}
    renderChats();
  }

function forgetPinned(id, failureMessage = '会话已删除，但侧栏记录未能保存，请重新点击删除清理', archived = false) {
    const removed = [...new Set((Array.isArray(id) ? id : [id]).filter(Boolean).map(String))];
    if (!removed.length) return true;
    try {
      if (archived && ctx.sidebarProjects?.forgetArchived) return ctx.sidebarProjects.forgetArchived(removed) === true;
      if (ctx.sidebarProjects?.forgetMany) return ctx.sidebarProjects.forgetMany(removed) === true;
      if (ctx.sidebarProjects) {
        for (const key of removed) if (ctx.sidebarProjects.forget(key) === null) return false;
        return true;
      }
      const ids = pinnedIds(); let changed = false;
      for (const key of removed) if (ids.delete(key)) changed = true;
      if (changed) localStorage.setItem(pinStorageKey(), JSON.stringify([...ids]));
      return true;
    } catch (error) {
      global.petSay?.(failureMessage);
      return false;
    }
  }

/*
 * Ask the main process for deletion-specific confirmation text, then use the shared
 * application dialog. Send a second IPC with confirmed only after acceptance; cancellation
 * never executes deletion.
 */
async function requestDelete(api, key, current) {
    let got = null;
    try { got = await api.deleteHistory(key); }
    catch (error) { return { ok: false, reason: String(error && error.message || error) }; }
    if (!current()) return { ok: false, cancelled: true };
    if (!got || !got.needsConfirm) return got;
    const dialog = global.SoduWorkConfirmDialog;
    if (!dialog || typeof dialog.open !== 'function') return { ok: false, reason: '确认弹窗没有加载出来，这次先不删' };
    const approved = await dialog.open({ ...(got.confirm || {}), danger: true });
    if (!approved || !current()) return { ok: false, cancelled: true };
    // A missing-content confirmation must never authorize deleting files that
    // become available while the confirmation dialog is open.
    const options = got.missingContent === true ? { confirmed: true, missingOnly: true } : { confirmed: true };
    try { return await api.deleteHistory(key, options); }
    catch (error) { return { ok: false, reason: String(error && error.message || error) }; }
}

async function deleteHistoryChat(id) {
    const key = String(id || '');
    const api = global.soduWorkAPI && (global.soduWorkAPI.conversationSession || global.soduWorkAPI.piSession);
    if (!key || !api || typeof api.deleteHistory !== 'function') return false;
    const activeIds = activeConversationIds();
    syncHistoryOwner();
    const epoch = historyEpoch, startedAt = mutationGeneration;
    const current = () => { syncHistoryOwner(); return epoch === historyEpoch; };
    const got = await requestDelete(api, key, current);
    syncHistoryOwner();
    if (epoch !== historyEpoch) return false;
    if (!got || !got.ok) {
      if (!(got && got.cancelled) && typeof global.petSay === 'function') {
        global.petSay(String(got && got.reason || '这条会话暂时删不掉'));
      }
      return false;
    }
    const applied = applyLifecycle({ ...got, deleted: true }, key, startedAt);
    if (!applied) return true;
    if (!forgetPinned(applied.ids)) return false;
    for (const id of applied.ids) ctx.chatNames?.delete(id);
    if (global.ChatCollaborationStore && typeof ChatCollaborationStore.remove === 'function') {
      // The conversation is gone; its requirement bindings must not survive it,
      // or the next "open conversation" would try to resume a missing archive.
      for (const id of applied.ids) ChatCollaborationStore.remove(id);
    }
    if ([...activeIds].some(activeId => applied.ids.includes(activeId)) || hiddenRow({ id: ctx.activeChatId })) {
      ctx.activeChatId = '';
      await openNewConversation();
    }
    renderChats();
    return true;
  }

async function archiveHistoryChat(id) {
    const key = String(id || '');
    const api = global.soduWorkAPI && (global.soduWorkAPI.conversationSession || global.soduWorkAPI.piSession);
    if (!key || !api || typeof api.archiveHistory !== 'function') return false;
    const activeIds = activeConversationIds();
    syncHistoryOwner();
    const epoch = historyEpoch, startedAt = mutationGeneration;
    let got = null;
    try { got = await api.archiveHistory(key); }
    catch (error) { got = { ok: false, reason: String(error && error.message || error) }; }
    syncHistoryOwner();
    if (epoch !== historyEpoch) return false;
    if (!got || !got.ok) {
      if (typeof global.petSay === 'function') global.petSay(String(got && got.reason || '这条会话暂时无法归档'));
      return false;
    }
    const applied = applyLifecycle({ ...got, archived: true }, key, startedAt);
    if (!applied) return true;
    if (!forgetPinned(applied.ids, '这条会话暂时无法归档', true)) return false;
    if ([...activeIds].some(activeId => applied.ids.includes(activeId)) || hiddenRow({ id: ctx.activeChatId })) {
      ctx.activeChatId = '';
      await openNewConversation();
    }
    renderChats();
    return true;
  }

function rememberChatName(row) {
    if (!row || !row.id) return row;
    const id = String(row.id), previous = ctx.chatNames.get(id);
    if (row.customTitle && (!previous || Number(row.titleUpdatedAt) >= previous.titleUpdatedAt)) {
      ctx.chatNames.set(id, { title: row.customTitle, customTitle: row.customTitle, titleUpdatedAt: Number(row.titleUpdatedAt) || 0 });
    }
    const saved = ctx.chatNames.get(id);
    return saved ? { ...row, ...saved } : row;
  }

function updateChatState(event) {
    if (Array.isArray(event?.events)) {
      for (const item of event.events) {
        try { updateChatState({ ...event, ...item, events: undefined }); } catch (_) {}
      }
      return;
    }
    const row = rememberChatName(event && event.presence);
    const id = String(event && event.sessionId || row && row.id || '');
    if (!id || !row) return;
    const previous = ctx.chatItems.find(item => String(item.id || '') === id);
    if (!row.emptyPlaceholder && !row.accountConversation && !row.remoteProjection &&
        (event.kind === 'renamed' || event.kind === 'history-lifecycle' ||
        !previous || ctx.chatState(previous) !== ctx.chatState(row) &&
        ['completed', 'failed', 'stopped'].includes(ctx.chatState(row)))) scheduleLocalHistoryRefresh();
    if (row.emptyPlaceholder) { ctx.upsertChat({ ...row, id }); return; }
    if (row.archived || row.deleted) {
      // A legacy snapshot has no lifecycle ordering. After an explicit restore,
      // only another explicit lifecycle action may hide this conversation again.
      if (event.kind !== 'history-lifecycle' &&
          rowIds(row, id).some(key => lifecycle.get(key)?.hidden === false)) return;
      const applied = applyLifecycle(row, id);
      if (applied) {
        if (event.kind === 'history-lifecycle') {
          forgetPinned(applied.ids, row.deleted ? undefined : '这条会话暂时无法归档', !row.deleted);
        }
        renderChats();
      }
      return;
    }
    if (event.kind === 'history-lifecycle' && row.archived === false && row.deleted === false) {
      const restored = applyLifecycle(row, id);
      if (!restored) return;
      if (restored.changed && !row.title) void refreshConversationHistory();
    }
    if (hiddenRow({ ...row, id })) return;
    if (event.kind === 'renamed' && global.ChatChrome?.rename) global.ChatChrome.rename(id, row.title);
    const index = ctx.chatItems.findIndex((item) => String(item.id || '') === id);
    if (index < 0) {
      if (row.title) ctx.upsertChat({ ...row, id, pending: false });
      return;
    }
    const before = ctx.chatItems[index];
    const nextState = ctx.chatState(row);
    const merged = { ...before, ...row };
    if (ctx.chatState(before) === nextState && before.title === row.title && before.live === row.live &&
      JSON.stringify(historyHarnesses(before)) === JSON.stringify(historyHarnesses(merged))) return;
    if (row.accountConversation || row.cloud) {
      ctx.upsertChat({ ...row, id, pending: false });
      return;
    }
    ctx.chatItems[index] = { ...before, ...row, id, pending: false };
    renderChats();
  }

async function renameChat(id, value) {
    id = String(id || '');
    const name = String(value || '').replace(/\s+/g, ' ').trim();
    if (!id) throw Error('请先打开一个会话');
    if (!name || Array.from(name).length > 120) throw Error(name ? '最多 120 个字符' : '请输入会话名称');
    const api = global.soduWorkAPI && (global.soduWorkAPI.conversationSession || global.soduWorkAPI.piSession);
    if (!api?.renameHistory) throw Error('请更新客户端后使用会话改名');
    syncHistoryOwner();
    const epoch = historyEpoch;
    const got = await api.renameHistory(id, name);
    if (!got?.ok) throw Error(got?.reason || '改名未保存，请重试');
    syncHistoryOwner();
    if (epoch !== historyEpoch) return got;
    // An open archived chat need not be among the bounded recent rows. Retain
    // its revision before a pre-rename history request can arrive.
    const renamed = rememberChatName({ ...got, id });
    const index = ctx.chatItems.findIndex(item => String(item.id) === id);
    if (index >= 0) ctx.chatItems[index] = { ...ctx.chatItems[index], ...renamed };
    ctx.sidebarProjects?.remember([renamed]);
    global.ChatChrome?.rename?.(id, renamed.title || name);
    renderChats();
    return got;
  }

function closeChatMenu(restoreFocus = false) {
    const current = ctx.openChatMenu;
    if (!current) return;
    ctx.openChatMenu = null;
    if (current.menu?.isConnected) current.menu.hidden = true;
    current.row?.classList.remove('has-chat-menu');
    current.more?.setAttribute('aria-expanded', 'false');
    if (restoreFocus && current.more?.isConnected) current.more.focus({ preventScroll: true });
  }

function openChatRename(id, value) {
    const targetId = String(id || '');
    if (!targetId) return;
    // Reuse the header dialog when the conversation page is mounted so both
    // entry points share validation and persistence.
    if (typeof global.ChatChrome?.openRename === 'function') {
      try {
        global.ChatChrome.openRename(targetId, value);
        if (document.querySelector('.nchat-rename-dialog')) return;
      } catch (_) { /* Use the sidebar dialog when no chat header is mounted. */ }
    }
    const dialog = document.createElement('dialog');
    dialog.className = 'ws-chat-rename-dialog';
    dialog.setAttribute('aria-labelledby', 'wsChatRenameTitle');
    dialog.innerHTML = '<form class="ws-chat-rename-form" novalidate>' +
      '<header><h2 id="wsChatRenameTitle">重命名会话</h2>' +
      '<button type="button" class="ws-chat-rename-close" aria-label="关闭">×</button></header>' +
      '<input class="ws-chat-rename-input" type="text" maxlength="120" autocomplete="off" aria-label="会话名称">' +
      '<p class="ws-chat-rename-error" role="alert" hidden></p>' +
      '<footer><button type="button" data-chat-rename-cancel>取消</button>' +
      '<button type="submit" class="ws-chat-rename-save">保存</button></footer></form>';
    const form = dialog.querySelector('form');
    const input = dialog.querySelector('input');
    const error = dialog.querySelector('[role="alert"]');
    const finish = () => { if (dialog.open) dialog.close(); dialog.remove(); };
    dialog.querySelector('.ws-chat-rename-close').onclick = finish;
    dialog.querySelector('[data-chat-rename-cancel]').onclick = finish;
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
    input.value = String(value || '');
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const name = input.value.replace(/\s+/g, ' ').trim();
      if (!name || Array.from(name).length > 120) {
        error.textContent = name ? '最多 120 个字符' : '请输入会话名称';
        error.hidden = false; input.focus(); return;
      }
      const save = form.querySelector('.ws-chat-rename-save');
      save.disabled = true; form.setAttribute('aria-busy', 'true');
      try { await renameChat(targetId, name); finish(); }
      catch (problem) { error.textContent = problem.message || '改名未保存，请重试'; error.hidden = false; }
      finally { save.disabled = false; form.removeAttribute('aria-busy'); }
    });
    document.body.appendChild(dialog);
    dialog.showModal(); input.focus(); input.select();
  }

function chatMenuItem(label, iconMarkup, className = '') {
    const item = document.createElement('button');
    item.type = 'button'; item.className = 'ws-chat-menu-item' + (className ? ' ' + className : '');
    item.setAttribute('role', 'menuitem');
    item.innerHTML = iconMarkup + '<span>' + label + '</span>';
    return item;
  }

function bindTitleScroll(button, title) {
    let frame = 0, origin = null, text = '';
    function stop() {
      if (frame) global.cancelAnimationFrame(frame);
      frame = 0; origin = null; title.scrollLeft = 0;
      title.style.paddingRight = '';
    }
    function tick(now) {
      frame = 0;
      if (!button.isConnected || global.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { stop(); return; }
      const distance = Math.max(0, title.scrollWidth - title.clientWidth);
      if (!distance) { stop(); return; }
      if (origin === null || text !== title.textContent) { origin = now; text = title.textContent; }
      // Pause at both ends and scroll only the text, leaving row controls stationary.
      const travel = distance / 32 * 1000;
      const elapsed = (now - origin) % (600 + travel + 1200);
      title.scrollLeft = Math.min(distance, Math.max(0, elapsed - 600) * 0.032);
      frame = global.requestAnimationFrame(tick);
    }
    function start() {
      stop();
      if (global.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
      const controls = button.parentElement?.querySelector('.ws-chat-actions');
      if (controls) {
        const overlap = title.getBoundingClientRect().right - controls.getBoundingClientRect().left;
        title.style.paddingRight = Math.max(0, overlap + 8) + 'px';
      }
      frame = global.requestAnimationFrame(tick);
    }
    button.addEventListener('mouseenter', start);
    button.addEventListener('mouseleave', stop);
    button.addEventListener('focus', start);
    button.addEventListener('blur', stop);
  }

function _newChatRow() {
    const row = document.createElement('div');
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'ws-task ws-chat';
    const dot = document.createElement('i'); dot.className = 'st-chat';
    const title = document.createElement('span'); title.className = 'ws-chat-title';
    const runtime = document.createElement('small');
    runtime.className = 'ws-chat-runtime'; runtime.hidden = true;
    b.append(dot, title, runtime);
    bindTitleScroll(b, title);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = b.dataset.chatId || '';
      if (id && global.WorkspaceHost) {
        const project = ctx.sidebarProjects?.projectForChat(id);
        global.WorkspaceHost.open('create', {
          tab: 'chat', chatId: id, chatTitle: title.textContent || '', taskSession: b.dataset.taskSession === '1',
          ...(project ? { sidebarProjectId: project.id, sidebarProjectName: project.name, projectId: project.businessProjectId || '' } : {}),
        });
        ctx.setActiveChat(id);
        return;
      }
      if (id) ctx.setActiveChat(id);
    });
    b.addEventListener('keydown', event => {
      if (event.key === 'F2') { event.preventDefault(); global.ChatChrome?.openRename?.(b.dataset.chatId, title.textContent); }
    });
    const pin = document.createElement('button');
    pin.type = 'button'; pin.className = 'ws-chat-pin';
    pin.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 4h8l-1 6 3 3H6l3-3zM12 13v7"/></svg>';
    pin.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = b.dataset.chatId || '';
      if (id) togglePinned(id);
    });
    const more = document.createElement('button');
    more.type = 'button'; more.className = 'ws-chat-more';
    more.setAttribute('aria-label', '会话操作'); more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false'); more.title = '会话操作';
    more.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>';
    const menu = document.createElement('div');
    menu.className = 'ws-chat-menu'; menu.setAttribute('role', 'menu'); menu.hidden = true;
    const rename = chatMenuItem('重命名', ctx.icon('rename'), 'ws-chat-rename');
    rename.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = b.dataset.chatId || '';
      const label = b.querySelector('.ws-chat-title')?.textContent || '';
      closeChatMenu(); openChatRename(id, label);
    });
    const move = chatMenuItem('移动到…', ctx.icon('move'), 'ws-chat-move');
    move.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = b.dataset.chatId || '';
      closeChatMenu();
      if (id && typeof ctx.sidebarProjects?.openMoveMenu === 'function') ctx.sidebarProjects.openMoveMenu(id);
    });
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'ws-chat-delete ws-chat-menu-item';
    remove.setAttribute('role', 'menuitem');
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path d="M4.5 6.5h15M9 6.5v-2A1 1 0 0 1 10 3.5h4a1 1 0 0 1 1 1v2"/>' +
      '<path d="m6.5 6.5.7 12.1a2 2 0 0 0 2 1.9h5.6a2 2 0 0 0 2-1.9l.7-12.1M10 10.5v6M14 10.5v6"/></svg><span>删除</span>';
    remove.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = b.dataset.chatId || '';
      if (!id || remove.dataset.busy === '1') return;
      // The main-process delete handler owns the native confirmation dialog and
      // recycle-bin policy; close this lightweight menu before awaiting it.
      closeChatMenu();
      remove.dataset.busy = '1'; remove.disabled = true;
      try { await deleteHistoryChat(id); }
      finally { remove.dataset.busy = ''; remove.disabled = false; }
    });
    const archive = document.createElement('button');
    archive.type = 'button'; archive.className = 'ws-chat-archive ws-chat-menu-item';
    archive.setAttribute('role', 'menuitem');
    archive.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 8h16v12H4zM3 4h18v4H3z"/><path d="M9 13h6"/></svg><span>归档会话</span>';
    archive.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = b.dataset.chatId || '';
      if (!id || archive.dataset.busy === '1') return;
      archive.dataset.busy = '1'; archive.disabled = true;
      try { await archiveHistoryChat(id); }
      finally { archive.dataset.busy = ''; archive.disabled = false; }
    });
    const actions = document.createElement('div'); actions.className = 'ws-chat-actions';
    actions.append(pin, more);
    menu.append(rename, move, archive, remove);
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      if (ctx.openChatMenu?.row === row) { closeChatMenu(true); return; }
      closeChatMenu();
      ctx.openChatMenu = { row, menu, more };
      row.classList.add('has-chat-menu'); menu.hidden = false; more.setAttribute('aria-expanded', 'true');
      const rowRect = row.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const scrollRect = ctx.root?.querySelector('#wsSideScroll')?.getBoundingClientRect();
      const lowerEdge = Math.min(window.innerHeight - 8, scrollRect?.bottom || window.innerHeight - 8);
      menu.classList.toggle('is-up', rowRect.bottom + menuRect.height > lowerEdge);
      menu.querySelector('[role="menuitem"]:not([hidden]):not(:disabled)')?.focus({ preventScroll: true });
    });
    row.append(b, actions, menu);
    return row;
  }

function _paintChatLocale(button) {
    const copy = button._localeChat;
    if (!copy) return;
    const label = copy.title || ctx.wsT('chat.untitled', '未命名对话');
    const status = ctx.wsT('chat.state.' + copy.state, ctx.CHAT_STATE[copy.state]);
    // The title is user data. Translate only the surrounding status, and keep
    // the generic DOM adapter from interpreting the combined attribute text.
    button.setAttribute('data-user-attributes', 'title aria-label');
    const separator = global.SoduWorkI18n?.getLocale() === 'en-US' ? ', ' : '，';
    button.setAttribute('aria-label', label + separator + status + (copy.harnesses ? separator + copy.harnesses : ''));
    button.title = label + ' · ' + status + (copy.harnesses ? ' · ' + copy.harnesses : '');
    const title = button.querySelector('.ws-chat-title');
    if (title.textContent !== label) title.textContent = label;
  }

function _paintChatRow(row, c, isPinned) {
    const id = String(c.id || '');
    const selected = ctx.active === 'create' && Boolean(id) && id === ctx.activeChatId;
    const state = ctx.chatState(c);
    const label = c.title || '未命名对话';
    const b = row.querySelector('.ws-chat');
    const dot = b.querySelector('.st-chat');
    const runtime = b.querySelector('.ws-chat-runtime');
    const pin = row.querySelector('.ws-chat-pin');
    const more = row.querySelector('.ws-chat-more');
    const archive = row.querySelector('.ws-chat-archive');
    const remove = row.querySelector('.ws-chat-delete');
    const menuOpen = ctx.openChatMenu?.row === row;
    row.className = 'ws-chat-row' + (isPinned ? ' is-pinned' : '') + (menuOpen ? ' has-chat-menu' : '');
    row.dataset.chatKey = ctx._chatUiKey(c);
    b.className = 'ws-task ws-chat is-' + state + (c.pending ? ' is-pending' : '') +
      (selected ? ' is-active' : '');
    b.dataset.chatId = id; b.disabled = !id;
    b.setAttribute('aria-current', selected ? 'page' : 'false');
    const harnesses = historyHarnesses(c);
    const runtimeName = harnesses.map(id => harnessNames()[id]).join('、');
    b._localeChat = { title: c.title, state, harnesses: runtimeName };
    _paintChatLocale(b);
    dot.className = 'st-chat st-chat-' + state;
    /* A local collaboration cache is presentation state, not proof that this
       history entry is a task session. It can outlive a task or be keyed by a
       temporary id, so ordinary chats must not be routed through openTask. */
    const linked = Boolean(c.taskId || (Array.isArray(c.taskIds) && c.taskIds.length) ||
      c.collaboration || c.mode === 'goal');
    b.dataset.taskSession = linked ? '1' : '0';
    runtime.hidden = !harnesses.length;
    const markup = harnesses.map(harnessIcon).join('');
    if (runtime._harnessMarkup !== markup) {
      runtime.innerHTML = markup;
      runtime._harnessMarkup = markup;
    }
    runtime.title = runtimeName;
    runtime.setAttribute('aria-hidden', 'true');
    runtime.setAttribute('data-user-attributes', 'title');
    pin.title = isPinned ? '取消置顶' : '置顶聊天';
    pin.setAttribute('aria-label', pin.title);
    pin.setAttribute('aria-pressed', String(isPinned));
    if (more) {
      more.title = '会话操作';
      more.setAttribute('aria-label', '会话操作：' + label);
      more.setAttribute('aria-expanded', String(menuOpen));
    }
    /* Allow deletion of Pi archives and Runner records except active conversations; IPC enforces the same restriction. */
    const canDelete = Boolean(id) && !c.pending &&
      state !== 'starting' && state !== 'running' && state !== 'waiting';
    archive.hidden = !canDelete;
    archive.title = '归档此会话';
    archive.setAttribute('aria-label', '归档“' + label + '”');
    /*
     * Recent conversations support archive only; permanent deletion belongs to archived
     * conversations. Retain hidden nodes for compatibility with older callers.
     */
    remove.hidden = !canDelete;
    remove.disabled = !canDelete;
    remove.title = '删除聊天';
    remove.setAttribute('aria-label', '删除“' + label + '”');
    ctx.sidebarProjects?.enhanceRow(row, c);
  }

function _syncChatList(target, items, isPinned, pool) {
    target.querySelectorAll('.ws-list-empty').forEach((node) => node.remove());
    const wanted = new Set();
    items.forEach((item, index) => {
      const key = ctx._chatUiKey(item);
      if (!key) return;
      wanted.add(key);
      /* A conversation may appear in pinned and project sections. Reuse each pooled node once and create additional rows for other placements. */
      const row = (pool.get(key) || []).shift() || _newChatRow();
      _paintChatRow(row, item, isPinned);
      const current = target.children[index];
      if (current !== row) target.insertBefore(row, current || null);
    });
    /* Keep at most one row per key within each container after moves or duplicate-display refreshes. */
    const seen = new Set();
    Array.from(target.children).forEach((node) => {
      if (!node.classList.contains('ws-chat-row')) return;
      const key = String(node.dataset.chatKey || '');
      if (!key || !wanted.has(key) || seen.has(key)) node.remove();
      else seen.add(key);
    });
  }

function renderChats() {
    ctx.mount();
    let accountCount = 0;
    // Source-specific read limits do not create separate presentation groups.
    // Existing project state owns chronological and manual placement.
    const list = localReady ? ctx.chatItems.filter(item => isLocalId(item.id) || ++accountCount <= ctx.MAX_CHAT_ITEMS)
      : ctx.chatItems.slice(0, ctx.MAX_CHAT_ITEMS);
    ctx.sidebarProjects?.remember(list);
    const pins = pinnedIds();
    const scroller = ctx.root.querySelector('#wsSideScroll');
    const scrollTop = scroller.scrollTop;
    const pool = new Map([...ctx.root.querySelectorAll('.ws-chat-row')]
      .reduce((acc, row) => {                                  /* Pool every row for a shared key so duplicate placements do not leave orphaned nodes. */
        const key = String(row.dataset.chatKey || '');
        if (!key) return acc;
        const list = acc.get(key);
        if (list) list.push(row); else acc.set(key, [row]);
        return acc;
      }, new Map()));
    const groups = ctx.sidebarProjects?.partition(list);
    const pinned = (groups ? groups.pinned : list.filter((item) => pins.has(String(item.id || ''))))
      .filter(item => !hiddenRow(item));
    const recent = (groups ? groups.recent : list.filter((item) => !pins.has(String(item.id || ''))))
      .filter(item => !hiddenRow(item));
    const pinnedBox = ctx.root.querySelector('#wsPinnedBox');
    pinnedBox.hidden = !pinned.length;
    pinnedBox.classList.toggle('is-empty', !pinned.length);
    ctx.root.querySelector('#wsChatsBox').classList.toggle('is-empty', !recent.length);
    _syncChatList(ctx.pinnedChats, pinned, true, pool);
    _syncChatList(ctx.chats, recent, false, pool);
    if (supportsLocalHistory()) {
      let accountStatus = ctx.root.querySelector('#wsAccountHistoryStatus');
      if (!accountStatus) {
        accountStatus = document.createElement('div'); accountStatus.id = 'wsAccountHistoryStatus';
        accountStatus.className = 'ws-history-status'; accountStatus.setAttribute('role', 'status');
        ctx.root.querySelector('#wsChatsBox').appendChild(accountStatus);
      }
      accountStatus.hidden = !accountError;
      accountStatus.textContent = accountError ? historyText('workspace.history.accountError', '部分会话暂时无法读取') : '';
      let actions = ctx.root.querySelector('#wsLocalHistoryActions');
      if (!actions) {
        actions = document.createElement('div'); actions.id = 'wsLocalHistoryActions'; actions.className = 'ws-history-actions';
        const status = document.createElement('span'); status.setAttribute('role', 'status');
        const button = document.createElement('button'); button.type = 'button';
        button.onclick = () => { void refreshLocalHistory({ append: !localError, refresh: !!localError }); };
        actions.append(status, button); ctx.root.querySelector('#wsChatsBox').appendChild(actions);
      }
      actions.hidden = !localNext && !localRestart && !localError && (localReady || !localLoad);
      actions.querySelector('span').textContent = localError ? historyText('workspace.history.localError', '本机历史暂时无法读取') : '';
      const button = actions.querySelector('button'); button.disabled = !!localLoad;
      button.textContent = localLoad ? historyText('workspace.history.loading', '正在加载…') : localError
        ? historyText('workspace.history.retry', '重新加载') : historyText('workspace.history.more', '加载更多');
    }
    for (const project of groups?.projects || []) {
      const items = project.items.filter(item => !hiddenRow(item));
      _syncChatList(project.target, items, false, pool);
      if (!items.length) ctx._empty(project.target, '拖入会话，开始整理');
    }
    if (!recent.length && !localError && !accountError) ctx._empty(ctx.chats, list.length ? '没有更多聊天' :
      (ctx.chatsLoading ? '正在加载聊天…' : '还没有聊天'));
    if (ctx.openChatMenu && !ctx.openChatMenu.row?.isConnected) closeChatMenu();
    scroller.scrollTop = scrollTop;
  }
function subscribeConversationPresence() {
    syncHistoryOwner();
    if (!historyOwner) return;
    if (ctx.sessionOff) return;
    const api = global.soduWorkAPI && (global.soduWorkAPI.conversationSession || global.soduWorkAPI.piSession);
    const epoch = historyEpoch;
    const receive = event => { syncHistoryOwner(); if (epoch === historyEpoch) ctx.updateChatState(event); };
    if (api && typeof api.onEvent === 'function') ctx.sessionOff = api.onEventBatch
      ? api.onEventBatch(receive, { presenceOnly: true }) : api.onEvent(receive);
  }

function refreshAccountHistory() {
    syncHistoryOwner();
    // Main-process history captures an authenticated actor before reading.
    // A pre-login request cannot be reused when the first account arrives.
    if (!historyOwner) return Promise.resolve(false);
    if (ctx.historyLoad) return ctx.historyLoad;
    const api = global.soduWorkAPI && (global.soduWorkAPI.conversationSession || global.soduWorkAPI.piSession);
    if (!api || typeof api.history !== 'function') {
      ctx.chatsLoading = false;
      ctx.renderChats();
      return Promise.resolve(false);
    }
    const epoch = historyEpoch, generation = accountMutationGeneration;
    const current = () => { syncHistoryOwner(); return epoch === historyEpoch && generation === accountMutationGeneration; };
    const job = Promise.resolve().then(() => {
      if (!current()) return null;
      return supportsLocalHistory() ? api.history({ source: 'account' }) : api.history();
    }).then((got) => {
      if (!current()) return false;
      if (got && got.ok) {
        accountError = '';
        // Native history supplies authenticated lifecycle records, including
        // cold-start tombstones that have not produced a presence event.
        const archived = new Set(), deleted = new Set();
        for (const row of Array.isArray(got.lifecycle) ? got.lifecycle : []) {
          if (supportsLocalHistory() && isLocalId(row?.id)) continue;
          if (!row?.id || !(row.archived === true || row.deleted === true ||
              row.archived === false && row.deleted === false && Number(row.lifecycleRevision) > 0)) continue;
          const applied = applyLifecycle(row);
          if (applied) for (const id of applied.ids) {
            archived.delete(id); deleted.delete(id);
            if (applied.hidden) (row.deleted ? deleted : archived).add(id);
          }
        }
        // The directory may exceed the bounded live-event ledger. Retain this
        // response's accepted cleanup IDs even when old ledger entries expire.
        forgetPinned([...archived], '这条会话暂时无法归档', true);
        forgetPinned([...deleted]);
        ctx.setChats(supportsLocalHistory() ? [...localRows, ...(got.chats || []).filter(row => !isLocalId(row.id))] : got.chats || []);
      }
      else { accountError = 'unavailable'; ctx.chatsLoading = false; ctx.renderChats(); }
      return Boolean(got && got.ok);
    }).catch(() => {
      if (!current()) return false;
      accountError = 'unavailable';
      ctx.chatsLoading = false;
      ctx.renderChats();
      return false;
    }).finally(() => { if (ctx.historyLoad === job) ctx.historyLoad = null; });
    ctx.historyLoad = job;
    return job;
  }
  function refreshLocalHistory({ append = false, refresh = false } = {}) {
    if (!supportsLocalHistory()) return Promise.resolve(false);
    if (localLoad) return localLoad;
    if (append && !localNext && !localRestart) return Promise.resolve(true);
    const workspace = localCatalog?.workspace;
    const options = { source: 'local', limit: 50, ...(refresh ? { refresh: true } : {}),
      ...(append && localNext && !localRestart ? { after: localNext } : {}),
      ...(localCatalog ? { workspace, catalogRevision: localCatalog.revision } : {}) };
    const job = Promise.resolve().then(() => historyApi().history(options)).then(got => {
      if (got?.ok && got.localCatalog && (!workspace || got.localCatalog.workspace === workspace) &&
          got.localCatalog.revision < global.WorkspaceSidebarState.localHistoryRevision(got.localCatalog.workspace)) return false;
      if (!got?.ok || !got.localCatalog || workspace && got.localCatalog.workspace !== workspace ||
          !global.WorkspaceSidebarState?.setLocalHistory(got.localCatalog, got.chats || [])) throw Error('Local history unavailable');
      const catalog = got.localCatalog;
      let addedLocalIds = [];
      if (Array.isArray(catalog.items)) {
        const previousAliases = localAliases;
        addedLocalIds = catalog.items.filter(row => {
          const previous = localRecords.get(String(row.id));
          return !row.archived && !row.deleted && (!previous || previous.archived || previous.deleted);
        }).map(row => String(row.id));
        localRecords = new Map(catalog.items.map(row => [String(row.id), row]));
        localAliases = new Set(catalog.items.flatMap(row => [String(row.id), ...(row.historyAliasIds || [])]));
        ctx.chatItems = ctx.chatItems.filter(row => !previousAliases.has(String(row.id)) || localVisible(row));
        const archived = [], deleted = [];
        for (const row of catalog.items) {
          if (global.WorkspaceSidebarState.localHistoryId(row.id) !== row.id) continue;
          if (row.archived || row.deleted || hiddenRow(row)) {
            applyLifecycle({ ...row, lifecycleRevision: catalog.revision });
            if (row.deleted) deleted.push(row.id); else if (row.archived) archived.push(row.id);
          }
        }
        forgetPinned(archived, '这条会话暂时无法归档', true); forgetPinned(deleted);
      }
      localCatalog = { workspace: catalog.workspace, revision: catalog.revision };
      const oldRows = localRows.filter(localVisible), incoming = (got.chats || []).filter(localVisible);
      const ids = new Set(incoming.map(row => row.id));
      localRows = append ? [...oldRows.filter(row => !ids.has(row.id)), ...incoming]
        : [...incoming, ...oldRows.filter(row => !ids.has(row.id))];
      const loadedIds = new Set(localRows.map(row => canonicalLocalId(row.id)));
      const addedUnloaded = addedLocalIds.some(id => !loadedIds.has(id));
      // A newly imported older record can precede an existing cursor or follow
      // an exhausted one. Restart traversal without discarding loaded rows.
      if (append || !localReady || localRestart || addedUnloaded) localNext = got.next || null;
      else if (oldRows.length <= 50) localNext = got.next || null;
      localRestart = append && addedUnloaded;
      localReady = true; localError = got.refreshError ? 'refresh' : '';
      const remote = ctx.chatItems.filter(row => !isLocalId(row.id));
      ctx.setChats([...localRows, ...remote]);
      return true;
    }).catch(() => { localError = 'unavailable'; ctx.chatsLoading = false; ctx.renderChats(); return false; })
      .finally(() => { if (localLoad === job) localLoad = null; ctx.renderChats(); flushLocalHistoryRefresh(); });
    localLoad = job;
    return job;
  }
  function refreshConversationHistory() {
    const local = supportsLocalHistory() ? refreshLocalHistory() : null;
    if (local && !nativeRefreshStarted) {
      nativeRefreshStarted = true;
      void local.then(() => refreshLocalHistory({ refresh: true }));
    }
    const remote = refreshAccountHistory();
    return local ? Promise.all([local, remote]).then(values => values.some(Boolean)) : remote;
  }
  /* Insert an optimistic row on the first message, then replace it by title and time once Pi's archive index is available. */
  function setChats(items) {
    ctx.chatsLoading = false;
    // Apply lifecycle visibility before the existing optimistic-row reconciliation.
    ctx.chatItems = ctx.chatItems.filter(item => !hiddenRow(item));
    items = (items || []).filter(item => !hiddenRow(item));
    items = (items || []).map(rememberChatName);
    if (localReady) {
      const currentLocal = ctx.chatItems.filter(row => isLocalId(row.id)), incomingLocal = items.filter(row => isLocalId(row.id));
      const limit = Math.max(1, new Set([...currentLocal, ...incomingLocal].map(row => row.id)).size);
      ctx.chatItems = [...ctx._reconcileChats(currentLocal, incomingLocal, Date.now(), { limit, canonicalId: canonicalLocalId }),
        ...ctx._reconcileChats(ctx.chatItems.filter(row => !isLocalId(row.id)), items.filter(row => !isLocalId(row.id)), Date.now())];
    } else ctx.chatItems = ctx._reconcileChats(ctx.chatItems, items, Date.now());
    renderChats();
  }

  function upsertChat(item) {
    if (!item || hiddenRow(item)) return;
    if (needsHistoryConfirmation(item)) { void refreshConversationHistory(); return; }
    const local = localReady && isLocalId(item.id);
    const current = localReady ? ctx.chatItems.filter(row => isLocalId(row.id) === local) : ctx.chatItems;
    const options = { deferUnconfirmedCloudTasks: true, ...(local ? { limit: Math.max(1, current.length + 1), canonicalId: canonicalLocalId } : {}) };
    const next = ctx._upsertChatItems(current, rememberChatName(item), options);
    if (next === null) {
      void refreshConversationHistory();
      return;
    }
    if (!localReady) ctx.chatItems = next;
    else if (local) ctx.chatItems = [...next, ...ctx.chatItems.filter(row => !isLocalId(row.id))];
    else ctx.chatItems = [...ctx.chatItems.filter(row => isLocalId(row.id)), ...next];
    renderChats();
  }

  function removeChat(localId) {
    const target = String(localId || '');
    ctx.chatItems = ctx.chatItems.filter((row) =>
      String(row && row.localId || '') !== target &&
      String(row && row.id || '') !== target &&
      row._uiKey !== 'draft:' + target);
    renderChats();
  }

  function setActiveChat(id) {
    const next = String(id || '');
    if (ctx.activeChatId === next) return;
    ctx.activeChatId = next;
    global.WorkspaceNavigation?.chatChanged(next);
    for (const button of ctx.root?.querySelectorAll('.ws-chat') || []) {
      const selected = ctx.active === 'create' && Boolean(next) && button.dataset.chatId === next;
      if (button.classList.contains('is-active') === selected) continue;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-current', selected ? 'page' : 'false');
    }
  }

  return { setChats, upsertChat, removeChat, setActiveChat, pinStorageKey, legacyPinnedIds, pinnedIds, togglePinned, forgetPinned, deleteHistoryChat, archiveHistoryChat, rememberChatName, updateChatState, renameChat, closeChatMenu, openChatRename, chatMenuItem, _newChatRow, _paintChatLocale, _paintChatRow, _syncChatList, renderChats, subscribeConversationPresence, refreshConversationHistory, refreshLocalHistory };
  }
  global.WorkspaceChatList = { create };
})(window);
