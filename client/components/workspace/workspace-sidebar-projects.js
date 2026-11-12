/* Local conversation groups may explicitly reference an authorized Hub project. */
(function (global) {
  'use strict';
  const invalidations = new WeakMap();
  global.addEventListener?.('soduwork-domain-changed', event => {
    if (event.detail?.domain !== 'conversation-projects') return;
    const box = global.document?.getElementById('wsProjectsBox');
    if (box) invalidations.get(box)?.();
  });
  const paths = {
    folder: '<path d="M3.5 7V5.5a2 2 0 0 1 2-2h4l2 3h7a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7ZM3.5 10h17"/>',
    app: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.8"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    chevron: '<path d="m8 10 4 4 4-4"/>',
    move: '<path d="M4 7h9M9 3l4 4-4 4M20 17h-9M15 13l-4 4 4 4"/>',
    createChat: '<path d="M13.5 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-7.5"/><path d="M10 14l.7-3.2L17.5 4a1.8 1.8 0 0 1 2.5 2.5l-6.8 6.8z"/>',
  };
  const icon = name => '<svg viewBox="0 0 24 24" aria-hidden="true">' + paths[name] + '</svg>';
  function groupIcon(project = {}) {
    const artwork = project.appId && global.SoduWorkPluginIcon?.image(project.appIcon);
    const fallback = project.appId ? 'app' : 'folder';
    return { markup: artwork || icon(fallback), key: artwork ? project.appIcon : fallback };
  }
  const button = (className, label, markup) => {
    const el = document.createElement('button'); el.type = 'button'; el.className = className;
    el.title = label; el.setAttribute('aria-label', label); if (markup) el.innerHTML = markup; return el;
  };
  function create({ root, getItems, render }) {
    const box = document.createElement('section');
    box.id = 'wsProjectsBox'; box.className = 'ws-list ws-projects ws-chat-group';
    box.innerHTML = '<div class="ws-projects-heading"><button type="button" class="ws-section-toggle" id="wsProjectsToggle" aria-controls="wsProjectsList" aria-expanded="true"><span>项目</span>' +
      icon('chevron') + '</button></div><div id="wsProjectsList" class="ws-list-body"></div>';
    root.querySelector('#wsSideScroll').insertBefore(box, root.querySelector('#wsChatsBox'));
    const list = box.querySelector('#wsProjectsList'), toggle = box.querySelector('#wsProjectsToggle');
    const add = button('ws-project-icon-button', '创建项目', icon('plus'));
    add.id = 'wsProjectAdd'; box.querySelector('.ws-projects-heading').appendChild(add);
    const status = document.createElement('span'); status.className = 'ws-sidebar-sr'; status.role = 'status';
    root.appendChild(status);
    root.querySelector('#wsPinnedBox').dataset.sidebarSection = 'pinned';
    root.querySelector('#wsChatsBox').dataset.sidebarSection = 'recent';
    let store = null, scope = '', dialog = null, sync = null;
    const archivingProjects = new Set();
    let lastSync = 0;
    invalidations.set(box, () => { void sync?.run(); });
    const notify = error => {
      const message = error.message || String(error);
      if (status.textContent === message) return;
      status.textContent = message; global.petSay?.(message);
    };
    function state() {
      const options = global.WorkspaceSidebarState.accountOptions({ storage: localStorage, api: global.SoduWorkAPI });
      if (options.key !== scope) {
        store = global.WorkspaceSidebarState.create({...options, onChange: () => { void sync?.run(); }});
        scope = options.key;
        const ownScope = scope;
        sync = options.writable === false ? null : global.WorkspaceSidebarState.projectSync({store, api: global.SoduWorkAPI,
          storage: localStorage, key: scope, current: () => ownScope === scope &&
            global.WorkspaceSidebarState.storageKey(global.SoduWorkAPI) === ownScope,
          changed: () => render(), error: e => { console.warn('Project sync:', e.message); }});
        lastSync = 0;
      }
      if (Date.now() - lastSync > 10000) {
        lastSync = Date.now(); Promise.resolve().then(() => sync?.run());
      }
      return store;
    }
    const safe = fn => { try { return fn(); } catch (error) { notify(error); return null; } };
    function allItems() {
      const groups = state().view(getItems());
      return [...groups.pinned, ...groups.recent, ...groups.projects.flatMap(p => p.items)];
    }
    function move(id, destination, before) {
      safe(() => {
        const item = allItems().find(row => String(row.id) === id);
        if (!item) throw Error('会话已不在列表中，请刷新后重试');
        state().move(item, destination, before, getItems());
        if (destination === 'pinned' || destination === 'recent') {
          const body = root.querySelector(destination === 'pinned' ? '#wsPinnedChats' : '#wsChats');
          if (body.hidden) root.querySelector(destination === 'pinned' ? '#wsPinnedToggle' : '#wsChatsToggle').click();
        }
        render();
        const label = destination === 'pinned' ? '置顶' : destination === 'recent' ? '最近聊天'
          : state().get().projects.find(p => p.id === destination)?.name;
        status.textContent = '已移到' + label;
      });
    }
    function file(id, projectId, row) {
      return safe(() => {
        const wanted = String(id || '');
        if (!wanted) return false;
        const project = state().get().projects.find(item => item.id === projectId);
        if (!project) return false;
        if (project.chatIds.includes(wanted)) return true;
        state().fileChat(wanted, projectId, row);
        status.textContent = '已移到' + project.name;
        return true;
      }) === true;
    }
    function openDialog(id, chatId) {
      if (dialog) return;
      safe(() => {
        const beforeFocus = document.activeElement, currentScope = scope;
        const project = id ? state().get().projects.find(p => p.id === id) : null;
        const folders = [...(project?.folders || [])];
        dialog = document.createElement('dialog'); dialog.className = 'ws-project-dialog';
        dialog.setAttribute('aria-labelledby', 'wsProjectDialogTitle');
        dialog.innerHTML = '<form class="ws-project-form"><header><h2 id="wsProjectDialogTitle"></h2></header>' +
          '<label class="ws-project-name"><span>' + icon('folder') + '</span><input id="wsProjectName" maxlength="80" autocomplete="off" placeholder="项目名称" aria-label="项目名称"></label>' +
          '<label class="ws-project-link"><span>关联需求池项目 <small>可选</small></span><select id="wsBusinessProject" disabled><option value="">正在读取项目…</option></select></label>' +
          '<div class="ws-project-folder-label">源文件夹 <small>可选</small></div><div class="ws-project-folders"></div>' +
          '<p class="ws-project-help">关联后可在会话中选择该项目的需求，沿用已有上下文。整理会话不会改变工作目录。</p>' +
          '<p class="ws-project-error" role="alert" hidden></p><footer></footer></form>';
        const form = dialog.querySelector('form'), footer = form.querySelector('footer'), input = form.querySelector('input');
        dialog.querySelector('h2').textContent = project ? '编辑项目' : '创建项目';
        input.value = project?.name || '';
        const projectSelect = form.querySelector('#wsBusinessProject');
        let businessProjectId = project?.businessProjectId || '';
        Promise.resolve().then(() => global.SoduWorkAPI?.getProjects?.()).then(rows => {
          if (!form.isConnected || scope !== currentScope) return;
          projectSelect.replaceChildren(new Option('暂不关联', ''));
          for (const row of Array.isArray(rows) ? rows : []) projectSelect.add(new Option(row.name || row.title, row.id));
          if (businessProjectId && ![...projectSelect.options].some(row => row.value === businessProjectId)) {
            projectSelect.add(new Option('原关联项目暂不可用', businessProjectId));
          }
          projectSelect.value = businessProjectId; projectSelect.disabled = !Array.isArray(rows);
        }).catch(() => { if (form.isConnected) projectSelect.replaceChildren(new Option('项目暂时无法读取，原关联保留', businessProjectId)); });
        projectSelect.onchange = () => { businessProjectId = projectSelect.value; };
        const close = button('ws-project-dialog-close', '关闭', icon('close'));
        dialog.querySelector('header').appendChild(close);
        function finish() {
          if (!dialog) return;
          const el = dialog; dialog = null; el.close(); el.remove();
          if (beforeFocus?.isConnected) beforeFocus.focus(); else add.focus();
        }
        close.onclick = finish;
        dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
        const error = message => {
          const el = form.querySelector('.ws-project-error'); el.textContent = message; el.hidden = false;
        };
        function paintFolders() {
          const container = form.querySelector('.ws-project-folders'); container.replaceChildren();
          folders.forEach((dir, index) => {
            const row = document.createElement('div'); row.className = 'ws-project-folder';
            const name = document.createElement('span'); name.textContent = dir.split(/[\\/]/).filter(Boolean).pop() || dir;
            row.innerHTML = icon('folder'); row.appendChild(name); row.title = dir;
            const remove = button('ws-project-icon-button', '移除文件夹 ' + name.textContent, icon('close'));
            remove.onclick = () => { folders.splice(index, 1); paintFolders(); }; row.appendChild(remove); container.appendChild(row);
          });
          const pick = button('ws-project-folder-add', '添加文件夹', icon('folder') + '<span>添加文件夹</span>');
          if (!folders.length) pick.classList.add('is-empty');
          pick.onclick = async () => {
            pick.disabled = true;
            try {
              const api = global.soduWorkAPI?.conversationSession || global.soduWorkAPI?.piSession;
              if (!api?.pickCwd) throw Error('请在桌面客户端选择文件夹');
              const result = await api.pickCwd(); // This picker does not change the global work directory.
              if (!form.isConnected) return;
              if (result?.ok && result.dir) {
                if (!folders.some(p => p.replace(/\\/g, '/').toLowerCase() === result.dir.replace(/\\/g, '/').toLowerCase())) folders.push(result.dir);
                if (!input.value.trim()) input.value = result.name || result.dir.split(/[\\/]/).filter(Boolean).pop();
                paintFolders(); input.focus();
              } else if (!result?.canceled) throw Error(result?.reason || '未能选择文件夹，请重试');
            } catch (e) { if (form.isConnected) error(e.message); } finally { pick.disabled = false; }
          };
          container.appendChild(pick);
        }
        paintFolders();
        if (project) {
          const archive = button('ws-project-archive', '归档项目'); archive.textContent = '归档项目';
          archive.onclick = async () => {
            if (!global.confirm || global.confirm(global.SoduWorkI18n?.t('archive.project.confirm', '归档项目“{name}”？项目和其中的会话会从主列表隐藏，可在“归档会话”中恢复。', { name: project.name }) || ('归档项目“' + project.name + '”？项目和其中的会话会从主列表隐藏，可在“归档会话”中恢复。')) !== false) {
              archive.disabled = true;
              let preserving;
              try {
                const archiveStore = state();
                if (scope !== currentScope) throw Error('账号已切换，请重新打开项目');
                const api = global.soduWorkAPI?.conversationSession || global.soduWorkAPI?.piSession;
                if (!api?.archiveHistory || !api?.restoreHistory) throw Error('归档会话接口暂不可用，请重试');
                const ids = archiveStore.get().projects.find(item => item.id === id)?.chatIds || [];
                // Individual archive receipts can arrive before the whole group
                // moves to archivedProjects. Retain its members for restoration.
                preserving = { id, scope: currentScope }; archivingProjects.add(preserving);
                const archived = [];
                for (const chatId of ids) {
                  let result;
                  try { result = await api.archiveHistory(chatId); }
                  catch (error) { result = { ok: false, reason: String(error?.message || error) }; }
                  if (result?.ok) { archived.push(chatId); continue; }
                  if (result?.notFound || result?.alreadyDeleted) continue;
                  for (const restoredId of archived.reverse()) {
                    try { await api.restoreHistory(restoredId); } catch (_) { /* best effort rollback */ }
                  }
                  throw Error(result?.reason || '项目中的会话还不能归档，请完成或停止后重试');
                }
                archiveStore.archiveProject(id); finish(); render();
                if (ids.includes(global.WorkspaceShell?.activeChatId)) {
                  global.WorkspaceShell.setActiveChat('');
                  global.WorkspaceHost?.open('create', { newSession: true });
                }
                global.WorkspaceShell?.refreshConversationHistory?.();
              } catch (e) { archive.disabled = false; error(e.message); }
              finally { if (preserving) archivingProjects.delete(preserving); }
            }
          };
          footer.appendChild(archive);
          const remove = button('ws-project-remove', '移除项目'); remove.textContent = '移除项目';
          remove.onclick = () => {
            remove.disabled = true;
            const question = document.createElement('p'); question.className = 'ws-project-remove-confirm';
            question.textContent = '仅移除分组，会话将回到最近聊天。不会删除文件。';
            const confirm = button('ws-project-remove', '确认移除项目'); confirm.textContent = '确认移除';
            confirm.onclick = () => { try {
              if (state() && scope !== currentScope) throw Error('账号已切换，请重新打开项目');
              state().removeProject(id); finish(); render();
            } catch (e) { error(e.message); } };
            question.appendChild(confirm); form.insertBefore(question, footer);
          };
          footer.appendChild(remove);
        }
        const cancel = button('ws-project-cancel', '取消'); cancel.textContent = '取消'; cancel.onclick = finish;
        const save = button('ws-project-save', project ? '保存' : '创建项目');
        save.textContent = project ? '保存' : '创建项目'; save.type = 'submit'; footer.append(cancel, save);
        form.onsubmit = event => {
          event.preventDefault();
          try {
            state(); if (scope !== currentScope) throw Error('账号已切换，请重新打开项目');
            const projectId = state().saveProject({ id, name: input.value, folders, businessProjectId });
            finish(); render(); if (chatId) move(chatId, projectId);
          } catch (e) { error(e.message || '未能保存，请重试'); }
        };
        document.body.appendChild(dialog); dialog.showModal(); input.focus(); input.select();
      });
    }
    function moveMenu(id) {
      if (dialog) return;
      safe(() => {
        const previous = document.activeElement;
        dialog = document.createElement('dialog'); dialog.className = 'ws-project-dialog ws-project-move-dialog';
        dialog.setAttribute('aria-label', '移动会话');
        dialog.innerHTML = '<h2>移动会话</h2><div class="ws-move-options"></div>';
        const finish = () => { const el = dialog; dialog = null; el.close(); el.remove(); if (previous?.isConnected) previous.focus(); };
        const close = button('ws-project-dialog-close', '关闭', icon('close')); close.onclick = finish; dialog.appendChild(close);
        dialog.oncancel = event => { event.preventDefault(); finish(); };
        const current = state().get();
        const choices = [['pinned', '置顶'], ...current.projects.map(p => [p.id, p.name, p]), ['recent', '最近聊天']];
        choices.forEach(([target, label, project]) => {
          const option = button('ws-move-option', '移到' + label, groupIcon(project).markup);
          const text = document.createElement('span'); text.textContent = label; option.appendChild(text);
          option.dataset.moveTo = target;
          option.onclick = () => { finish(); move(id, target); }; dialog.querySelector('.ws-move-options').appendChild(option);
        });
        const create = button('ws-move-option', '创建项目并移入', icon('plus') + '<span>创建项目并移入</span>');
        create.onclick = () => { finish(); openDialog('', id); }; dialog.querySelector('.ws-move-options').appendChild(create);
        document.body.appendChild(dialog); dialog.showModal(); dialog.querySelector('.ws-move-option').focus();
      });
    }
    function openProjectSession(project) {
      /*
       * An optional source folder controls execution cwd; absent folders use the default
       * workspace. Preserve sidebarProjectId and business associations independently.
       */
      const folder = String(project?.folders?.[0] || '').trim();
      if (!global.WorkspaceHost || typeof global.WorkspaceHost.open !== 'function') {
        notify(Error('新建会话入口暂不可用，请重试'));
        return;
      }
      global.WorkspaceHost.open('create', {
        newSession: true,
        cwd: folder,
        workspaceLabel: project.name,
        projectId: project.businessProjectId || '',
        sidebarProjectId: project.id,
        sidebarProjectName: project.name,
      });
    }
    toggle.onclick = () => safe(() => { state().collapse(); render(); });
    add.onclick = () => safe(() => { state(); openDialog(); });
    global.addEventListener('storage', event => { if (event.key === scope) render(); });
    const refreshAccount = () => { if (root.isConnected) render(); };
    global.addEventListener('soduwork-device-auth', refreshAccount);
    global.addEventListener('soduwork-data-scope-changed', refreshAccount);
    global.WorkspaceSidebarDrag.install({ root, find: id => allItems().find(row => String(row.id) === id), move });
    return {
      searchProjects: () => state().get().projects.map(project => ({ ...project, folders: project.folders.slice(), chatIds: project.chatIds.slice() })),
      openSearchProject(id) {
        const data = state().get(), project = data.projects.find(item => item.id === id);
        if (!project) throw Error('SEARCH_PROJECT_UNAVAILABLE');
        if (data.collapsed) state().collapse();
        if (project.collapsed) state().collapse(id);
        if (global.WorkspaceShell?.mode === 'settings') global.WorkspaceHost.open('create', {});
        render();
        const node = [...list.children].find(item => item.dataset.projectId === id);
        node?.scrollIntoView({ block: 'nearest' }); node?.querySelector('.ws-project-toggle')?.focus();
      },
      pins: () => new Set(state().get().pins),
      projectForChat(id) {
        const wanted = String(id || '');
        if (!wanted) return null;
        const project = state().get().projects.find(item => item.chatIds.includes(wanted));
        return project ? { id: project.id, name: project.name, businessProjectId: project.businessProjectId || '', folders: project.folders.slice() } : null;
      },
      /* Pinning uses togglePin independently of drag-based project moves. */
      togglePin(id) { safe(() => {
        const wanted = String(id || '');
        const item = allItems().find(row => String(row.id) === wanted);
        if (!item) throw Error('会话已不在列表中，请刷新后重试');
        if (item.pending) throw Error('会话建立后即可置顶');
        state().togglePin(wanted, item);
        const pinned = state().get().pins.includes(wanted);
        if (pinned) {
          const body = root.querySelector('#wsPinnedChats');
          if (body.hidden) root.querySelector('#wsPinnedToggle').click();
        }
        render();
        status.textContent = pinned ? '已置顶' : '已取消置顶';
      }); },
      openMoveMenu: id => moveMenu(id),
      forget: id => safe(() => state().forget(id)),
      forgetMany: ids => safe(() => { state().forgetMany(ids); return true; }),
      forgetArchived: ids => safe(() => {
        const current = state();
        current.forgetMany(ids, { preserveArchivedProjects: true,
          preserveProjectIds: [...archivingProjects].filter(project => project.scope === scope).map(project => project.id) });
        return true;
      }),
      file: (id, projectId, row) => file(id, projectId, row),
      remember: items => safe(() => state().remember(items)),
      enhanceRow(row, item) {
        row.draggable = !!item.id && !item.pending;
        const action = row.querySelector('.ws-chat-move');
        if (!action) return;
        action.disabled = !item.id || !!item.pending;
      },
      partition(items) {
        const data = state().view(items);
        list.hidden = data.collapsed; toggle.setAttribute('aria-expanded', String(!data.collapsed));
        toggle.title = (data.collapsed ? '展开' : '收起') + '项目';
        const wanted = new Set(data.projects.map(p => p.id));
        list.querySelectorAll('.ws-project').forEach(el => { if (!wanted.has(el.dataset.projectId)) el.remove(); });
        list.querySelector('.ws-project-empty')?.remove();
        for (const p of data.projects) {
          let el = [...list.children].find(el => el.dataset.projectId === p.id);
          if (!el) {
            el = document.createElement('section'); el.className = 'ws-project'; el.dataset.projectId = p.id;
            el.dataset.sidebarSection = p.id;
            el.innerHTML = '<div class="ws-project-heading"><button type="button" class="ws-project-toggle">' + groupIcon(p).markup +
              '<span></span></button></div><div class="ws-project-chats ws-list-body"></div>';
            const edit = button('ws-project-icon-button ws-project-edit', '编辑项目', icon('more'));
            edit.onclick = () => openDialog(p.id); el.querySelector('.ws-project-heading').appendChild(edit);
            const create = button('ws-project-icon-button ws-project-create', '在此目录创建会话', icon('createChat'));
            create.onclick = event => {
              event.stopPropagation();
              const current = state().get().projects.find(item => item.id === el.dataset.projectId);
              if (!current) return;
              openProjectSession(current);
            };
            el.querySelector('.ws-project-heading').appendChild(create);
            el.querySelector('.ws-project-toggle').onclick = () => safe(() => { state().collapse(p.id); render(); });
            list.appendChild(el);
          }
          const head = el.querySelector('.ws-project-toggle'), body = el.querySelector('.ws-project-chats');
          const currentIcon = head.querySelector('svg,img');
          const { markup, key: iconKey } = groupIcon(p);
          if (head.__groupIcon !== iconKey) {
            currentIcon?.remove(); head.insertAdjacentHTML('afterbegin', markup);
            head.__groupIcon = iconKey;
          }
          head.querySelector('span').textContent = p.name;
    head.setAttribute('data-user-content', ''); head.title = p.name;
          head.setAttribute('aria-expanded', String(!p.collapsed));
          body.id = 'ws-' + p.id; head.setAttribute('aria-controls', body.id); body.hidden = p.collapsed;
          el.querySelector('.ws-project-edit').setAttribute('aria-label', '编辑项目 ' + p.name);
          const create = el.querySelector('.ws-project-create');
          create.disabled = false;
          create.title = p.folders.length ? '在此目录创建会话：' + p.folders[0] : '在默认工作区新建会话';
          create.setAttribute('aria-label', create.title);
          p.target = body;
        }
        if (!data.projects.length) {
          const empty = button('ws-project-empty', '创建第一个项目'); empty.textContent = '创建项目，整理会话';
          empty.onclick = () => openDialog(); list.appendChild(empty);
        }
        return data;
      },
    };
  }
  global.WorkspaceSidebarProjects = { create };
})(window);
