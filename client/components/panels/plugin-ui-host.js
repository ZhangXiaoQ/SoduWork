/* SoduWork plugin UI host.
   Built-in and enterprise actions register a command, then render through one
   controlled surface. Plugins never append arbitrary overlays to document.body. */
(function (global) {
  'use strict';

  const registry = new Map();
  let current = null;
  let catalogCache = null;
  let catalogLoadedAt = 0;
  let catalogRevision = 0;
  let accessRevision = 0;
  const policyRevisions = new Map();
  let activeContribution = null;
  const CATALOG_TTL = 30000;
  /* Workspace navigation is intentionally a small, presentation-only slot. */
  const MAX_SIDEBAR_APPS = 3;

  const text = (value, max) => String(value == null ? '' : value).trim().slice(0, max || 160);
  // Keep all declared aliases that fit the bounded action contract.  The
  // previous twelve-item cap silently dropped the historical `/task` alias
  // from the unified requirement action, so the same action behaved
  // differently depending on which localized command a user typed.
  const names = (value) => [...new Set((Array.isArray(value) ? value : [])
    .map(item => text(item, 40)).filter(Boolean))].slice(0, 24);

  function normalize(definition) {
    const source = definition || {};
    const id = text(source.id || source.actionId, 100);
    const command = text(source.command, 40).replace(/^\/+/, '');
    if (!id || !command || typeof source.open !== 'function') return null;
    return {
      id,
      actionId: id,
      command,
      aliases: names(source.aliases),
      name: text(source.name || command, 80),
      description: text(source.description, 180),
      icon: text(source.icon || command.slice(0, 1), 4),
      badge: text(source.badge || '内置表单', 30),
      surface: source.surface === 'dialog' ? 'dialog' : 'inline',
      priority: Number.isFinite(Number(source.priority)) ? Number(source.priority) : 100,
      open: source.open,
    };
  }

  function registerAction(definition) {
    const action = normalize(definition);
    if (!action) throw new Error('插件动作缺少 id、command 或 open');
    registry.set(action.id, action);
    return () => registry.delete(action.id);
  }

  function actions() {
    return [...registry.values()].sort((left, right) => left.priority - right.priority)
      .map(({ open, ...safe }) => safe);
  }

  function commandFromText(value) {
    const source = String(value || '').trim();
    const match = source.match(/^\/([^\s/]{1,40})(?:\s+([\s\S]*))?$/u);
    if (!match) return null;
    const token = String(match[1] || '').toLocaleLowerCase();
    const action = [...registry.values()].find((item) =>
      item.command.toLocaleLowerCase() === token ||
      item.aliases.some(alias => alias.toLocaleLowerCase() === token));
    if (!action) return null;
    return {
      id: action.id, actionId: action.id, command: action.command,
      name: action.name, text: String(match[2] || '').trim(),
    };
  }

  // Text is user content. Only a picker-selected registered action may route
  // this submission; slash characters inside the body never select an action.
  function commandFromSelection(selection, value) {
    const action = selection && registry.get(text(selection.actionId || selection.id, 100));
    if (!action) return null;
    return { id: action.id, actionId: action.id, command: action.command,
      name: action.name, text: String(value || '') };
  }

  // Preserve explicit picker/session identities across attachment/catalog awaits.
  // Never infer bindings from body text, paths, sidebar groups or device seats.
  function captureBindingContext(value, selections) {
    const source = value && typeof value === 'object' ? value : {};
    const result = {};
    const identity = value => typeof value === 'string' ? value.trim() : '';
    for (const key of ['repoId', 'projectId', 'adapterId', 'assigneeId', 'personalPluginKey']) {
      const id = identity(source[key]);
      if (id) result[key] = id;
    }
    const selected = Array.isArray(selections) ? selections : source.plugins;
    const plugins = (Array.isArray(selected) ? selected : []).map(item => {
      if (!item || typeof item !== 'object') return null;
      const plugin = {};
      for (const key of ['pluginId', 'key', 'qualifiedKey', 'name', 'version']) {
        const id = identity(item[key]);
        if (id) plugin[key] = id;
      }
      if (!plugin.pluginId && !plugin.key && !plugin.qualifiedKey) return null;
      plugin.personal = item.personal === true;
      return plugin;
    }).filter(Boolean);
    if (plugins.length) result.plugins = plugins;
    if (!result.personalPluginKey && plugins.length === 1 && plugins[0].personal && plugins[0].key) {
      result.personalPluginKey = plugins[0].key;
    }
    return result;
  }

  function resolveElement(value) {
    try { return typeof value === 'function' ? value() : value; } catch (_) { return null; }
  }

  function turnPrompt(root, value) {
    const prompt = String(value || '').trim();
    if (!prompt || !root || !root.parentElement) return null;
    const node = document.createElement('div');
    node.className = 'pui-turn-prompt';
    const bubble = document.createElement('div');
    bubble.className = 'pui-turn-prompt-bubble';
    bubble.setAttribute('role', 'note');
    bubble.setAttribute('aria-label', '你的补充');
    const isLong = global.WorkIntent?.longMessage ? global.WorkIntent.longMessage(prompt)
      : prompt.length > 320 || prompt.split('\n').length > 6;
    if (isLong) {
      const details = document.createElement('details'); details.className = 'pui-prompt-long';
      const summary = document.createElement('summary');
      const label = (className, value) => {
        const node = document.createElement('span'); node.className = className; node.textContent = value;
        summary.appendChild(node); return node;
      };
      const compact = prompt.replace(/\s+/g, ' ');
      label('pui-prompt-preview', compact.length > 116 ? compact.slice(0, 116).trimEnd() + '…' : compact)
        .setAttribute('data-user-content', '');
      label('pui-prompt-heading', '完整内容');
      label('pui-prompt-more', '展开全文'); label('pui-prompt-less', '收起');
      const full = document.createElement('div'); full.className = 'pui-prompt-full'; full.textContent = prompt;
      full.setAttribute('data-user-content', '');
      details.appendChild(summary); details.appendChild(full); bubble.appendChild(details);
    } else { bubble.textContent = prompt; bubble.setAttribute('data-user-content', ''); }
    node.appendChild(bubble);
    root.parentElement.insertBefore(node, root);
    return node;
  }

  function revisionClone(root, meta, revision) {
    const clone = root.cloneNode(true);
    const sourceControls = root.querySelectorAll('input,textarea,select');
    const clonedControls = clone.querySelectorAll('input,textarea,select');
    sourceControls.forEach((source, index) => {
      const copy = clonedControls[index];
      if (!copy) return;
      if (String(source.type || '').toLowerCase() !== 'file') copy.value = source.value;
      if ('checked' in source) copy.checked = source.checked;
      if (copy.tagName === 'TEXTAREA') copy.textContent = source.value;
    });
    clone.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
    clone.querySelectorAll('[aria-labelledby]').forEach(node => node.removeAttribute('aria-labelledby'));
    clone.querySelectorAll('[aria-modal]').forEach(node => node.removeAttribute('aria-modal'));
    clone.querySelectorAll('[role="dialog"]').forEach(node => node.setAttribute('role', 'group'));
    clone.querySelectorAll('label[for]').forEach(node => node.removeAttribute('for'));
    clone.querySelectorAll('input,textarea,select,button').forEach(node => {
      node.disabled = true;
      node.removeAttribute('name');
      node.removeAttribute('autofocus');
    });
    clone.querySelectorAll('[contenteditable]').forEach(node => node.setAttribute('contenteditable', 'false'));
    clone.querySelectorAll('a[href]').forEach(node => {
      node.removeAttribute('href');
      node.setAttribute('aria-disabled', 'true');
    });
    clone.querySelectorAll('*').forEach(node => {
      [...node.attributes].forEach(attribute => {
        if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
      });
    });
    clone.classList.add('is-archived');
    clone.removeAttribute('aria-live');
    clone.dataset.pluginRevision = String(revision);

    const bar = document.createElement('button');
    bar.type = 'button';
    bar.className = 'pui-revision-bar';
    bar.setAttribute('aria-expanded', 'false');
    const copy = document.createElement('span');
    const label = document.createElement('b');
    label.textContent = text(meta && meta.label || '工作表单', 50) + ' · 第 ' + revision + ' 版';
    const title = document.createElement('i');
    title.textContent = text(meta && meta.title || '已被下一版更新', 120);
    copy.append(label, title);
    const action = document.createElement('em');
    action.textContent = '展开';
    bar.append(copy, action);
    const body = document.createElement('div');
    body.className = 'pui-revision-body';
    body.hidden = true;
    while (clone.firstChild) body.appendChild(clone.firstChild);
    bar.addEventListener('click', () => {
      const expanded = clone.classList.toggle('is-expanded');
      bar.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      action.textContent = expanded ? '收起' : '展开';
      body.hidden = !expanded;
    });
    clone.append(bar, body);
    root.parentElement.insertBefore(clone, root);
    return clone;
  }

  function mount(options) {
    const o = options || {};
    if (current && typeof current.destroy === 'function') current.destroy();
    const host = resolveElement(o.host);
    const anchor = resolveElement(o.anchor);
    const inline = Boolean(host && host.isConnected);
    const root = document.createElement(inline ? 'section' : 'div');
    root.className = inline ? 'pui-surface pui-surface-inline' : 'pui-layer';
    if (o.className) root.classList.add(...String(o.className).split(/\s+/).filter(Boolean));
    root.dataset.pluginSurface = text(o.id || 'plugin-ui', 100);
    root.dataset.pluginRevision = '1';
    const trail = [];

    let content = root;
    if (inline) {
      root.setAttribute('aria-live', 'polite');
      if (anchor && anchor.parentElement === host) host.insertBefore(root, anchor);
      else host.prepend(root);
      host.classList.add('has-plugin-surface');
    } else {
      root.innerHTML = '<div class="pui-backdrop" aria-hidden="true"></div>' +
        '<section class="pui-dialog"><div class="pui-dialog-content"></div></section>';
      content = root.querySelector('.pui-dialog-content');
      document.body.appendChild(root);
      requestAnimationFrame(() => root.classList.add('is-visible'));
    }
    if (inline && o.prompt) {
      const prompt = turnPrompt(root, o.prompt);
      if (prompt) trail.push(prompt);
    }

    let destroyed = false;
    const handle = {
      root, content, inline, revision: 1,
      checkpoint(meta) {
        if (destroyed || !inline || !root.parentElement) return null;
        const clone = revisionClone(root, meta, handle.revision);
        trail.push(clone);
        const prompt = turnPrompt(root, meta && meta.prompt);
        if (prompt) trail.push(prompt);
        handle.revision += 1;
        root.dataset.pluginRevision = String(handle.revision);
        return clone;
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        if (typeof o.onDestroy === 'function') {
          try { o.onDestroy(); } catch (_) { /* Cleanup failures must not block closing. */ }
        }
        if (!inline) root.classList.remove('is-visible');
        trail.splice(0).forEach(node => node.remove());
        root.remove();
        if (inline && host && !host.querySelector('.pui-surface')) {
          host.classList.remove('has-plugin-surface');
        }
        if (current === handle) current = null;
      },
    };
    current = handle;
    return handle;
  }

  async function invoke(id, context) {
    // Existing plugin manifests/checkpoints may carry the retired action id.
    // Route it to the single registered Task form without a second entrypoint.
    const actionId = String(id || '') === 'work.task.create' ? 'work.requirement.create' : String(id || '');
    const action = registry.get(actionId);
    if (!action) throw new Error('这个工作动作当前不可用');
    return action.open(Object.assign({
      surface: action.surface, actionId: action.id, command: action.command,
    }, context || {}, { actionId: action.id }));
  }

  function closeCurrent() {
    if (current && typeof current.destroy === 'function') current.destroy();
  }

  function checkpointCurrent(meta) {
    return current && typeof current.checkpoint === 'function'
      ? current.checkpoint(meta || {}) : null;
  }

  async function catalogItems(force) {
    if (!force && catalogCache && Date.now() - catalogLoadedAt < CATALOG_TTL) {
      return catalogCache;
    }
    if (!global.SoduWorkAPI || typeof SoduWorkAPI.pluginCatalog !== 'function') return [];
    const request = catalogRevision;
    const result = await SoduWorkAPI.pluginCatalog();
    if (request !== catalogRevision) return [];
    catalogCache = Array.isArray(result && result.items) ? result.items : [];
    catalogLoadedAt = Date.now();
    return catalogCache;
  }

  function invalidateCatalog() {
    ++catalogRevision;
    catalogCache = null;
    catalogLoadedAt = 0;
  }

  function usable(item) {
    if (!item || item.enabled === false) return false;
    return item.personal ? true : Boolean(item.installed) && item.permissions?.canUse !== false;
  }

  function accessVersion(pluginId) {
    return accessRevision + ':' + (policyRevisions.get(pluginId) || 0);
  }

  async function assertUse(pluginId) {
    const id = text(pluginId, 120);
    if (id.startsWith('local:')) return;
    const request = accessVersion(id);
    if (!id || !global.SoduWorkAPI?.enterprisePluginPermissions) throw new Error('无法校验插件使用权限，请连接后台后重试');
    const permissions = await global.SoduWorkAPI.enterprisePluginPermissions(id);
    if (request !== accessVersion(id)) throw new Error('账号身份或插件权限已变化，请重新打开界面');
    if (permissions?.canUse !== true) throw new Error('你没有这个插件的使用权限，或权限已被管理员收回');
  }

  function inScope(item, context) {
    if (item.personal || item.organizationWide) return true;
    const task = context && context.task || {};
    const projectId = text(task.projectId || context && context.projectId, 100);
    return Boolean(projectId && Array.isArray(item.projectIds) &&
      item.projectIds.some(id => String(id) === projectId));
  }

  function normalizedContribution(raw, item) {
    if (!raw || typeof raw !== 'object') return null;
    const source = raw.source && typeof raw.source === 'object' ? raw.source : {};
    const sourceType = source.type || source.kind;
    const kind = ['builtin', 'external', 'package'].includes(sourceType) ? sourceType : '';
    const id = text(raw.id, 80);
    const slot = text(raw.slot, 60);
    if (!id || !slot || !kind) return null;
    const bridge = source.bridge && typeof source.bridge === 'object' ? source.bridge : null;
    const bridgeCapabilities = bridge && Array.isArray(bridge.capabilities)
      ? bridge.capabilities.map(value => text(value, 80)).filter(Boolean).slice(0, 16)
      : null;
    return {
      id, slot, title: text(raw.title || item && item.name || '插件页面', 80),
      description: text(raw.description, 180), icon: text(raw.icon || 'panel', 30),
      source: { kind, entry: text(source.entry, 240), url: text(source.url, 2000), actionId: text(source.actionId, 100),
        openMode: source.openMode === 'external' ? 'external' : 'workspace',
        /* Preserve declared bridge capabilities as metadata only. */
        ...(bridgeCapabilities ? { bridge: { capabilities: bridgeCapabilities } } : {}) },
      pluginId: text(item && item.pluginId || raw.pluginId, 120), pluginName: text(item && item.name || raw.pluginName, 100),
      setupConfig: item && item.setupConfig && typeof item.setupConfig === 'object'
        ? item.setupConfig : raw.setupConfig || {},
      appWindow: item && item.appWindow != null ? item.appWindow : raw.appWindow,
    };
  }

  async function contributions(slot, context) {
    const items = await catalogItems(false);
    const result = [];
    items.filter(usable).filter(item => inScope(item, context || {})).forEach(item => {
      const rows = item.ui && Array.isArray(item.ui.contributions) ? item.ui.contributions : [];
      rows.forEach(raw => {
        const row = normalizedContribution(raw, item);
        if (row && row.slot === slot) result.push(row);
      });
    });
    return result.slice(0, slot === 'workspace.navigation' ? MAX_SIDEBAR_APPS : 12);
  }

  function contextValue(key, contribution, context) {
    const c = context || {};
    const task = c.task || {};
    const maps = {
      'task.id': task.id, 'task.projectId': task.projectId, 'task.repoId': task.repoId,
      'task.status': task.status, 'requirement.id': c.requirement && c.requirement.id,
      'approval.id': c.approval && c.approval.id, 'automation.id': c.automation && c.automation.id,
      'project.id': c.projectId || task.projectId, 'user.id': c.userId || global.User && User.id,
    };
    if (Object.prototype.hasOwnProperty.call(maps, key)) return maps[key];
    if (key.startsWith('setup.')) return contribution.setupConfig[key.slice(6)];
    return '';
  }

  function resolveUrl(contribution, context) {
    const source = contribution && contribution.source || {};
    let missing = '';
    const value = String(source.url || '').replace(/\{\{\s*([A-Za-z][\w.-]*)\s*\}\}/g,
      (_all, key) => {
        const raw = contextValue(key, contribution, context);
        if (raw == null || raw === '') { missing = key; return ''; }
        return key.startsWith('setup.') ? String(raw).replace(/\/$/, '')
          : encodeURIComponent(String(raw));
      });
    if (missing) throw new Error('还缺少页面参数：' + missing);
    let parsed;
    try { parsed = new URL(value); } catch (_) { throw new Error('插件页面地址无效'); }
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('插件页面只允许安全的 HTTP(S) 地址');
    }
    return parsed.href;
  }

  function node(tag, className, label) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (label != null) el.textContent = label;
    return el;
  }

  function previewBounds(canvas) {
    const rect = canvas.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }

  function previewBridge(contribution, url) {
    const bridge = contribution && contribution.source && contribution.source.bridge;
    if (!bridge || !Array.isArray(bridge.capabilities) || !bridge.capabilities.length) return null;
    let origin = '';
    try { origin = new URL(url).origin; } catch (_) { return null; }
    return {
      appId: 'plugin:' + text(contribution.pluginId, 120),
      contributionId: text(contribution.id, 100), origin,
      version: Number(bridge.version) || 1,
      capabilities: bridge.capabilities.slice(0, 9).map(value => text(value, 80)).filter(Boolean),
    };
  }

  function externalSurface(container, contribution, context, tabId) {
    const preview = global.soduWorkAPI && soduWorkAPI.workPreview;
    if (!preview) throw new Error('当前窗口不支持插件页面');
    const url = resolveUrl(contribution, context);
    const shell = node('section', 'pui-external');
    const toolbar = node('header', 'pui-external-toolbar');
    const copy = node('div', 'pui-external-copy');
    const title = node('b', '', contribution.title);
    const host = node('small', '', new URL(url).host);
    copy.append(title, host);
    const actions = node('div', 'pui-external-actions');
    const reload = node('button', '', '刷新'); reload.type = 'button';
    const outside = node('button', '', '在浏览器打开'); outside.type = 'button';
    actions.append(reload, outside); toolbar.append(copy, actions);
    const status = node('div', 'pui-external-status', '正在打开安全页面…');
    const canvas = node('div', 'pui-external-canvas');
    canvas.setAttribute('data-native-preview-tab', tabId);
    canvas.setAttribute('aria-label', contribution.title);
    shell.append(toolbar, status, canvas); container.replaceChildren(shell);

    let stopped = false;
    const authorized = async action => {
      const request = accessVersion(contribution.pluginId);
      try {
        await assertUse(contribution.pluginId);
        if (!stopped) return await action();
      } catch (error) {
        if (!stopped && request === accessVersion(contribution.pluginId)) {
          status.hidden = false; status.classList.add('has-error'); status.textContent = error.message;
          preview.destroy(tabId);
        }
      }
    };
    const update = () => {
      if (!stopped && canvas.isConnected) preview.updateBounds(tabId, previewBounds(canvas));
    };
    const observer = new ResizeObserver(update);
    observer.observe(canvas);
    const off = preview.onState(state => {
      if (!state || state.tabId !== tabId) return;
      title.textContent = state.title || contribution.title;
      status.textContent = state.error || (state.loading ? '正在加载…' : '');
      status.classList.toggle('has-error', Boolean(state.error));
      status.hidden = !status.textContent;
    });
    reload.addEventListener('click', () => authorized(() => preview.command(tabId, 'reload')));
    outside.addEventListener('click', () => authorized(() => preview.command(tabId, 'external')));
    requestAnimationFrame(() => authorized(async () => {
      const result = await preview.show({ tabId, url, label: contribution.title,
        bounds: previewBounds(canvas), appBridge: previewBridge(contribution, url) });
      if (!result || !result.ok) {
        status.hidden = false;
        status.classList.add('has-error');
        status.textContent = result && result.reason || '页面没有打开成功';
      }
    }));
    return {
      url,
      show() { return authorized(() => preview.show({ tabId, url, label: contribution.title,
        bounds: previewBounds(canvas), appBridge: previewBridge(contribution, url) })); },
      destroy() {
        if (stopped) return;
        stopped = true; observer.disconnect(); off(); preview.destroy(tabId); shell.remove();
      },
    };
  }

  async function openContribution(contribution, context) {
    contribution = normalizedContribution(contribution, context && context.item) || contribution;
    if (!contribution) throw new Error('插件页面不存在');
    await assertUse(contribution.pluginId);
    if (contribution.source.kind === 'builtin') {
      const result = await invoke(contribution.source.actionId, context || {});
      if (current) activeContribution = { pluginId: contribution.pluginId, handle: current };
      return result;
    }
    const packaged = contribution.source.kind === 'package';
    const url = packaged ? '' : resolveUrl(contribution, context || {});
    if (contribution.source.openMode === 'external') {
      return global.soduWorkAPI.openExternal(url);
    }
    if (context?.isCurrent && !context.isCurrent()) return null;
    if (packaged || context && (context.detached || context.embedded)) {
      /*
       * Open applications in independent native windows. Reuse workspace preview assertions, URL
       * rules, and bridge declarations; the main process enforces isolation and navigation
       * guards.
       */
      const preview = global.soduWorkAPI && soduWorkAPI.workPreview;
      const open = context?.embedded ? preview?.showEmbedded : preview?.showDetached;
      if (typeof open !== 'function') {
        throw new Error('当前窗口不支持独立即用窗口');
      }
      const result = await open({
        /* Derive tabId from application identity so repeated opens focus the existing window and preserve its state. */
        tabId: (context?.embedded ? 'sidebar-app-' : 'app-') + String(contribution.pluginId || 'x').replace(/[^a-zA-Z0-9_-]+/g, '-')
          + '-' + String(contribution.id || '0').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60),
        url, label: contribution.title,
        appVersion: String(context?.item?.installedVersion || context?.item?.version || '').trim(),
        icon: global.SoduWorkPluginIcon ? global.SoduWorkPluginIcon.source(context && context.item) : '',
        ...(packaged ? { package: { pluginId: contribution.pluginId, contributionId: contribution.id } }
          : { appBridge: previewBridge(contribution, url) }),
        windowSettings: contribution.appWindow,
        ...(context?.embedded ? { bounds: context.bounds } : {}),
      });
      if (!result || !result.ok) {
        throw new Error((result && result.reason) || '即用窗口没有打开成功');
      }
      return { detached: !context?.embedded, embedded: !!context?.embedded, tabId: result.tabId, url };
    }
    let surface = null;
    const handle = mount({ id: 'plugin:' + contribution.pluginId + ':' + contribution.id,
      className: 'pui-layer-external', onDestroy: () => surface && surface.destroy() });
    const head = node('header', 'pui-dialog-head');
    const copy = node('div'); copy.append(node('b', '', contribution.title),
      node('small', '', contribution.pluginName || '企业插件'));
    const close = node('button', '', '关闭'); close.type = 'button';
    close.addEventListener('click', () => handle.destroy());
    head.append(copy, close); handle.content.append(head);
    const body = node('div', 'pui-dialog-web'); handle.content.append(body);
    surface = externalSurface(body, contribution, context || {},
      'plugin-' + Date.now().toString(36));
    activeContribution = { pluginId: contribution.pluginId, handle };
    return handle;
  }

  function catalogPresentation(item, icon) {
    const rows = item && item.ui && Array.isArray(item.ui.contributions)
      ? item.ui.contributions : [];
    const interactive = rows.length > 0;
    return {
      rows,
      badge: interactive
        ? '<em class="cap-plugin-quality is-interactive" title="需要在可见页面中使用，不进入后台自动化">交互插件</em>' : '',
      notice: interactive
        ? '<div class="cap-interactive-note"><span>' + (icon || '') + '</span><div><b>交互插件</b>' +
          '<em>页面需要有人看见并操作，因此不会出现在定时或无人值守自动化的选择器中。</em></div></div>' : '',
      action: interactive && usable(item)
        ? '<button class="btn-mini" id="capPluginOpenUI">打开界面</button>' : '',
      descriptions: rows.map((row) => {
        const source = row.source || {};
        const sourceType = source.type || source.kind;
        return (row.title || '插件页面') + ' · ' + (sourceType === 'builtin'
          ? 'SoduWork 原生页面' : source.openMode === 'external' ? '外部浏览器' : 'SoduWork 安全工作区');
      }),
    };
  }

  global.addEventListener?.('soduwork-plugin-policy', function (event) {
    const pluginId = text(event.detail?.pluginId, 120);
    if (pluginId) policyRevisions.set(pluginId, (policyRevisions.get(pluginId) || 0) + 1);
    else ++accessRevision;
    invalidateCatalog();
    const active = activeContribution;
    if (!active || pluginId && pluginId !== active.pluginId) return;
    const request = accessVersion(active.pluginId);
    assertUse(active.pluginId).catch(() => {
      if (request === accessVersion(active.pluginId) && activeContribution === active) {
        active.handle.destroy(); activeContribution = null;
      }
    });
  });
  global.addEventListener?.('soduwork-data-scope-changed', function () {
    ++accessRevision; policyRevisions.clear(); invalidateCatalog();
    activeContribution?.handle.destroy(); activeContribution = null;
    // Account/Hub/device changes end the old scope, including detached apps.
    try { void global.soduWorkAPI?.workPreview?.destroy(''); } catch (_) {}
  });

  function bindCatalogDetail(layer, item, ctx) {
    const button = layer && layer.querySelector('#capPluginOpenUI');
    if (!button) return;
    button.addEventListener('click', async () => {
      try {
        const row = catalogPresentation(item).rows[0];
        if (!row) throw new Error('插件没有可打开的页面');
        await openContribution(row, { item });
      } catch (error) {
        ctx.say(ctx.errorText(error, '插件界面没有打开成功'));
      }
    });
  }

  global.PluginUIHost = {
    registerAction, actions, commandFromText, commandFromSelection, captureBindingContext, invoke, mount, closeCurrent, checkpointCurrent,
    contributions, openContribution, assertUse,
    invalidateCatalog, resolveUrl, catalogPresentation, bindCatalogDetail,
    MAX_SIDEBAR_APPS,
    unregisterAction: id => registry.delete(String(id || '')),
  };
})(window);
