



(function (root, factory) {
  const commonJS = typeof module === 'object' && module.exports;
  const model = commonJS ? require('./chat-plugin-mention-model') : root.ChatPluginMentionModel;
  const navigation = commonJS ? require('./compose-candidate-navigation') : root.ComposeCandidateNavigation;
  const api = factory(model, navigation);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChatPluginMention = api;
})(typeof window !== 'undefined' ? window : null, function (model, navigation) {
  'use strict';

  /* Translate fallback label fragments before concatenation; DOM phrase lookup matches whole text nodes. */
  const _uiText = value => (typeof window !== 'undefined' && window.SoduWorkI18n &&
    typeof window.SoduWorkI18n.translateText === 'function' ? window.SoduWorkI18n.translateText(value) : value) || value;

  const MAX_SELECTED = 3;

  function appendPluginIcon(target, markup) {
    if (!target || !markup) return false;
    const doc = target.ownerDocument;
    if (!doc || typeof doc.createElement !== 'function') return false;
    const template = doc.createElement('template');
    template.innerHTML = String(markup);
    const node = template.content && template.content.firstElementChild;
    if (!node) return false;
    target.appendChild(node);
    return true;
  }

  function mentionQuery(value, caret) {
    const source = String(value || '');
    const end = Math.max(0, Math.min(Number(caret == null ? source.length : caret), source.length));
    const before = source.slice(0, end);
    const match = before.match(/(^|\s)\/([^\s/]{0,40})$/u);
    if (!match) return null;
    return {
      start: before.length - match[0].length + match[1].length,
      end,
      query: String(match[2] || '').toLocaleLowerCase(),
    };
  }

  const {
    normalizeActions, pluginBuilderAction, commandText, normalizePluginInputs,
    prepareConversationInputs, preparedConversationText, availability, pluginKind,
    normalizeCatalog, catalogWarning, retryableGrantFailure,
  } = model;

  function create(options) {
    const o = options || {};
    const input = o.input;
    const host = o.host;
    if (!input || !host) return null;
    const eventRoot = (input.ownerDocument && input.ownerDocument.defaultView) ||
      (typeof window !== 'undefined' ? window : null);

    const strip = document.createElement('div');
    strip.className = 'nplugin-strip';
    strip.setAttribute('aria-label', '本轮使用的插件');
    strip.hidden = true;
    host.insertBefore(strip, input);

    const menu = document.createElement('div');
    menu.className = 'nplugin-menu';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', '选择工作动作或企业插件');
    menu.hidden = true;
    host.appendChild(menu);

    let catalog = [];
    let actions = [];
    let selected = [];
    let selectedAction = null;
    let query = null;
    let active = 0;
    let menuItems = [];
    let loading = false;
    let loadTask = null;
    let loaded = false;
    let loadedAt = 0;
    let failed = '';
    let warning = '';
    let restoreToken = 0;
    const inputDrafts = new Map();
    const initialActions = typeof o.actions === 'function' ? o.actions() : o.actions;
    actions = normalizeActions(initialActions);

    const say = (message) => {
      if (typeof o.say === 'function') o.say(String(message || ''));
    };
    /* The picker stays inside the composer; structured inputs belong to the work surface. */
    const formHost = () => {
      const target = typeof o.formHost === 'function' ? o.formHost() : o.formHost;
      return target || host;
    };
    const formAnchor = () => {
      const target = typeof o.formAnchor === 'function' ? o.formAnchor() : o.formAnchor;
      return target || input;
    };
    const currentProjectId = () => typeof o.projectId === 'function' ? o.projectId() : '';
    const currentInputText = () => String((typeof o.inputText === 'function' ? o.inputText() : input.value) || '');
    const currentInputContext = () => {
      const value = typeof o.inputContext === 'function' ? o.inputContext() : o.inputContext;
      return value && typeof value === 'object' ? value : {};
    };
    const isAction = (item) => Boolean(item && item.kind === 'action' && item.actionId);
    const canInstall = (item) => {
      if (!item || isAction(item) || item.personal || item.installed) return false;
      const state = availability(item, currentProjectId());
      const policy = item.marketPolicy || {};
      return state.code === 'install_required' &&
        policy.installation !== 'not_available' &&
        (!item.entrypoints || item.entrypoints.conversation !== false);
    };
    const usable = (item) => {
      if (isAction(item)) return true;
      const state = availability(item, currentProjectId());
      return state.available || state.code === 'project_required' || canInstall(item);
    };
    const scope = (item) => item.personal ? '仅自己' : item.audienceLimited ? '企业授权' : item.organizationWide ? '全公司'
      : (item.projectCount === 1 ? '1 个项目' : item.projectCount + ' 个项目');
    const pluginIcon = (item) => {
      const icons = eventRoot && eventRoot.SoduWorkPluginIcon;
      if (icons && typeof icons.markup === 'function') return icons.markup(item);
      if (icons && typeof icons.imageFor === 'function') return icons.imageFor(item);
      const maker = icons && icons.image;
      return typeof maker === 'function' ? maker(item && item.icon) : '';
    };
    function openPluginForm(item, options) {
      const mode = options || {};
      if (!item || !item.inputs || !item.inputs.length || !eventRoot ||
          !eventRoot.PluginInputSheet || typeof eventRoot.PluginInputSheet.open !== 'function') return false;
      const seed = mode.seed == null ? currentInputText() : String(mode.seed);
      const plan = prepareConversationInputs(item.inputs, seed, inputDrafts.get(item.pluginId),
        mode.context || currentInputContext());
      const shownFields = mode.missingOnly ? plan.missing : plan.fields;
      if (!shownFields.length) return false;
      const sheet = eventRoot.PluginInputSheet.open({
        plugin: Object.assign({}, item, { inputs: shownFields }),
        host: formHost,
        anchor: formAnchor,
        seed,
        initialValues: plan.values,
        surfaceContext: 'conversation',
        sectionSubtitle: mode.missingOnly ? '只补充当前对话无法判断的必填信息' : '按需调整，本轮有效',
        footnote: '这些设置只用于本轮，不会修改插件默认配置',
        submitLabel: mode.missingOnly ? '补充并发送' : '保存本轮参数',
        onApply(_prompt, values) {
          // A missing-fields sheet does not show the inferred goal. Only its
          // displayed fields are confirmed; infer hidden goals again next send.
          const confirmed = mode.missingOnly ? Object.fromEntries(shownFields
            .filter(field => Object.prototype.hasOwnProperty.call(values, field.key))
            .map(field => [field.key, values[field.key]])) : { ...plan.values, ...values };
          inputDrafts.set(item.pluginId, { ...(inputDrafts.get(item.pluginId) || {}), ...confirmed });
          renderStrip();
          input.focus();
          if (typeof mode.onDone === 'function') mode.onDone(true);
        },
        onClose() {
          if (typeof mode.onDone === 'function') mode.onDone(false);
        },
      });
      return Boolean(sheet);
    }

    async function requestMissingInputs(item, seed, context) {
      const plan = prepareConversationInputs(item.inputs, seed, inputDrafts.get(item.pluginId), context);
      if (plan.ready) return true;
      return new Promise((resolve) => {
        let settled = false;
        const done = (accepted) => {
          if (settled) return;
          settled = true;
          resolve(Boolean(accepted));
        };
        if (!openPluginForm(item, {
          seed, context, missingOnly: true, onDone: done,
        })) done(false);
      });
    }

    function matches() {
      const text = query && query.query || '';
      return actions.concat(catalog).filter((item) => {
        if (!text) return true;
        return item.searchText.includes(text);
      }).sort((left, right) => Number(!isAction(left)) - Number(!isAction(right)) ||
        Number(canInstall(left)) - Number(canInstall(right)) ||
        Number(!usable(left)) - Number(!usable(right)));
    }

    function close() {
      menu.hidden = true;
      menu.replaceChildren();
      menuItems = [];
      query = null;
      input.removeAttribute('aria-activedescendant');
    }

    function positionMenu() {
      if (menu.hidden) return;
      const rect = host.getBoundingClientRect?.();
      if (!rect || !Number.isFinite(rect.left)) return;
      const gap = 8, viewportWidth = eventRoot?.innerWidth || window.innerWidth || 1024;
      const viewportHeight = eventRoot?.innerHeight || window.innerHeight || 768;
      const width = Math.min(410, Math.max(180, viewportWidth - 32), Math.max(180, rect.width - 32));
      const left = Math.max(8, Math.min(rect.left + 16, viewportWidth - width - 8));
      const below = viewportHeight - rect.bottom - gap;
      const above = rect.top - gap;
      const useAbove = above >= 150 && below < 220;
      const available = Math.max(120, Math.min(330, useAbove ? above : below));
      menu.style.setProperty('--nplugin-left', left + 'px');
      menu.style.width = width + 'px';
      menu.style.maxHeight = available + 'px';
      if (useAbove) {
        menu.style.setProperty('--nplugin-top', 'auto');
        menu.style.setProperty('--nplugin-bottom', Math.max(8, viewportHeight - rect.top + gap) + 'px');
      } else {
        menu.style.setProperty('--nplugin-bottom', 'auto');
        menu.style.setProperty('--nplugin-top', Math.min(viewportHeight - 120, rect.bottom + gap) + 'px');
      }
    }

    function renderStrip() {
      strip.replaceChildren();
      strip.hidden = !selectedAction && !selected.length;
      const rows = selectedAction ? [selectedAction].concat(selected) : selected;
      rows.forEach((item) => {
        const action = isAction(item);
        const chip = document.createElement('span');
        chip.className = 'nplugin-chip' + (action ? ' is-action' : '');
        chip.dataset.kind = action ? 'action' : 'plugin';
        if (!action && item.inputs && item.inputs.length) {
          chip.classList.add('has-form');
          chip.setAttribute('role', 'button');
          chip.tabIndex = 0;
          chip.title = '\u8c03\u6574\u201c' + item.name + '\u201d\u7684\u672c\u8f6e\u53c2\u6570';
          chip.addEventListener('click', () => openPluginForm(item));
          chip.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            openPluginForm(item);
          });
        }
        const mark = document.createElement('i');
        if (action) mark.textContent = item.icon || item.command.slice(0, 1);
        else {
          const custom = pluginIcon(item);
          if (!appendPluginIcon(mark, custom)) mark.textContent = item.name.slice(0, 1) || '✦';
        }
        const label = document.createElement('span');
        if (!action) label.setAttribute('data-user-content', '');
        label.textContent = model.displayText(item, 'name', _uiText);
        const hint = document.createElement('small');
        hint.textContent = action ? '工作表单' : '插件';
        if (!action && item.inputs && item.inputs.length) {
          const plan = prepareConversationInputs(item.inputs, currentInputText(), inputDrafts.get(item.pluginId),
            currentInputContext());
          hint.textContent = plan.missing.length ? '\u9700\u8865\u5145' :
            inputDrafts.has(item.pluginId) ? '\u5df2\u914d\u7f6e' : '\u53ef\u9009\u8bbe\u7f6e';
        }
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.setAttribute('aria-label', (action ? '退出' : '移除插件 ') + item.name);
        remove.title = action ? '退出这个录入模式' : '本轮不再使用';
        remove.textContent = '×';
        remove.addEventListener('click', (event) => {
          event.stopPropagation();
          if (!action && eventRoot && eventRoot.PluginInputSheet) eventRoot.PluginInputSheet.close(item.pluginId);
          if (action) selectedAction = null;
          else {
            selected = selected.filter((row) => row.pluginId !== item.pluginId);
            inputDrafts.delete(item.pluginId);
          }
          renderStrip();
          input.focus();
        });
        chip.append(mark, label, hint, remove);
        strip.appendChild(chip);
        if (!action && item.personal && (item.capabilities || {}).hasWorkflow && typeof o.debugPlugin === 'function') {
          const debug = document.createElement('button');
          debug.type = 'button'; debug.className = 'nplugin-debug-button';
          debug.textContent = '逐节点调试';
          debug.addEventListener('click', () => o.debugPlugin(item));
          strip.appendChild(debug);
        }
      });
      // Persist plugin selection, removal, and parameter edits immediately as draft changes.
      if (typeof o.onChange === 'function') o.onChange();
    }

    function row(item, index) {
      const button = document.createElement('button');
      button.type = 'button';
      const installable = canInstall(item);
      button.className = 'nplugin-option' + (isAction(item) ? ' is-action' : '') +
        (index === active ? ' is-active' : '');
      button.id = 'nplugin-option-' + index;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', index === active ? 'true' : 'false');
      button.dataset.installable = installable ? 'true' : 'false';
      button.disabled = !usable(item);
      const icon = document.createElement('i');
      icon.className = 'nplugin-option-icon';
      if (isAction(item)) icon.textContent = item.icon;
      else {
        const custom = pluginIcon(item);
        if (!appendPluginIcon(icon, custom)) icon.textContent = item.name.slice(0, 1) || '✦';
      }
      const copy = document.createElement('span');
      copy.className = 'nplugin-option-copy';
      const title = document.createElement('b');
      if (!isAction(item)) title.setAttribute('data-user-content', '');
      title.textContent = isAction(item) ? '/' + item.command + ' · ' + item.name :
        (item.process && item.process.enterprise
        ? '【' + (item.process.label || _uiText('企业流程')) + '】' : '') + model.displayText(item, 'name', _uiText);
      const description = document.createElement('span');
      if (item.description) description.setAttribute('data-user-content', '');
      description.textContent = model.displayText(item, 'description', _uiText) || (!isAction(item) &&
        item.workflow.length ? item.workflow.map((step) => step.name).filter(Boolean).slice(0, 3).join(' · ')
          : '企业已发布的工作方法');
      copy.append(title, description);
      const meta = document.createElement('em');
      const state = isAction(item) ? { available: true, label: item.badge } :
        availability(item, currentProjectId());
      meta.textContent = isAction(item) ? item.badge : installable ? '\u5b89\u88c5\u5e76\u4f7f\u7528' :
        item.updateAvailable ? '\u8bf7\u5148\u5347\u7ea7' : item.enabled === false ? '\u5df2\u505c\u7528' :
          state.label || (usable(item) ? scope(item) : '\u8bf7\u5728\u9879\u76ee\u4efb\u52a1\u4e2d\u4f7f\u7528');
      button.title = installable ? '\u70b9\u51fb\u5b89\u88c5\u5e76\u4f7f\u7528' : state.available ? item.name : state.label;
      button.append(icon, copy, meta);
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => choose(item));
      return button;
    }

    function renderMenu() {
      if (!query) return close();
      const scrollTop = menu.scrollTop;
      menu.replaceChildren();
      menuItems = [];
      input.removeAttribute('aria-activedescendant');
      menu.hidden = false;
      positionMenu();
      if (loading && !catalog.length && !actions.length) {
        const state = document.createElement('div');
        state.className = 'nplugin-state';
        state.textContent = '正在读取企业插件…';
        menu.appendChild(state);
        if (!actions.length && !catalog.length) return;
      }
      if (failed) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'nplugin-state retry';
        retry.textContent = '插件暂时没有加载出来 · 重试';
        retry.addEventListener('click', () => load(true));
        menu.appendChild(retry);
        if (!actions.length && !catalog.length) return;
      }
      if (warning) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'nplugin-state warning';
        retry.setAttribute('role', 'status');
        retry.title = warning;
        retry.textContent = '企业插件暂时不可用，个人插件仍可使用 · 重试';
        retry.addEventListener('click', () => load(true));
        menu.appendChild(retry);
      }
      const items = menuItems = matches();
      if (!items.length) {
        const state = document.createElement('div');
        state.className = 'nplugin-state';
        state.textContent = warning ? '没有匹配的内置动作或个人插件' : '没有匹配的工作动作或已发布插件';
        menu.appendChild(state);
        return;
      }
      active = navigation.normalize(items, active, usable);
      items.forEach((item, index) => menu.appendChild(row(item, index)));
      menu.scrollTop = scrollTop;
      navigation.highlight(menu, input, '.nplugin-option', 'is-active', active, false);
    }

    async function load(force) {
      if (loaded && !force) return;
      if (loading) return loadTask || undefined;
      loading = true;
      const task = Promise.resolve().then(async () => {
        failed = '';
        warning = '';
        renderMenu();
        try {
          const actionPayload = typeof o.actions === 'function' ? await o.actions() : o.actions;
          const actionRows = Array.isArray(actionPayload) ? actionPayload.slice() : [];
          if (!actionRows.some((item) => String(item && (item.actionId || item.id) || '') ===
              'work.plugin.create')) actionRows.push(pluginBuilderAction());
          actions = normalizeActions(actionRows);
          const payload = typeof o.catalog === 'function' ? await o.catalog() : { items: [] };
          catalog = normalizeCatalog(payload);
          warning = catalogWarning(payload);
          loaded = true;
          loadedAt = Date.now();
        } catch (error) {
          failed = String(error && error.message || error || '加载失败');
          if (catalog.length && failed) {
            warning = failed;
            failed = '';
          }
        } finally {
          loading = false;
          renderMenu();
        }
      });
      loadTask = task;
      try { await task; } finally {
        if (loadTask === task) loadTask = null;
      }
    }

    function consumeQuery() {
      if (!query) return;
      const value = input.value;
      input.value = value.slice(0, query.start) + value.slice(query.end).replace(/^\s+/, '');
      input.selectionStart = input.selectionEnd = query.start;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function selectAction(item) {
      if (!query) return;
      const value = input.value;
      const before = value.slice(0, query.start).trim();
      const after = value.slice(query.end).trim();
      const detail = [before, after].filter(Boolean).join(' ');
      selectedAction = item;
      input.value = detail;
      input.selectionStart = input.selectionEnd = input.value.length;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      renderStrip();
      return detail;
    }

    function openConversationInstall(item) {
      const source = input.value;
      const range = query ? { start: query.start, end: query.end } : null;
      close();
      const setup = eventRoot && eventRoot.SoduWorkPluginInstallSetup;
      const ui = eventRoot && eventRoot.PluginUIHost;
      if (!setup || typeof setup.openInline !== 'function' || !ui ||
          typeof ui.mount !== 'function') {
        say('\u5f53\u524d\u5ba2\u6237\u7aef\u8fd8\u6ca1\u6709\u52a0\u8f7d\u63d2\u4ef6\u5b89\u88c5\u5361\uff0c\u8bf7\u5237\u65b0\u540e\u91cd\u8bd5');
        return false;
      }
      const surface = setup.openInline(item, {
        openSurface: () => ui.mount({
          id: 'conversation-plugin-install:' + item.pluginId,
          host: formHost(),
          anchor: formAnchor(),
          className: 'pui-plugin-install',
        }),
        say,
        errorText: (error, fallback) => {
          if (typeof o.errorText === 'function') return o.errorText(error, fallback);
          return String(error && error.message || error || fallback || '\u64cd\u4f5c\u6ca1\u6709\u5b8c\u6210');
        },
        reload: () => load(true),
        onInstalled: async (installedItem) => {
          const fresh = catalog.find((row) => row.pluginId === item.pluginId);
          const chosen = fresh || Object.assign({}, item, {
            installed: true, enabled: true,
            conversationUse: { available: true, code: 'ready', label: '\u53ef\u5728\u5bf9\u8bdd\u4f7f\u7528' },
          });
          if (!selected.some((row) => row.pluginId === chosen.pluginId)) selected.push(chosen);
          if (range && input.value.slice(range.start, range.end) ===
              source.slice(range.start, range.end)) {
            input.value = source.slice(0, range.start) +
              source.slice(range.end).replace(/^\s+/, '');
            input.selectionStart = input.selectionEnd = range.start;
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
          renderStrip();
          input.focus();
          say('\u5df2\u5b89\u88c5\u300c' + (chosen.name || installedItem && installedItem.name || item.name) +
            '\u300d\uff0c\u53ef\u4ee5\u7ee7\u7eed\u53d1\u9001');
        },
      });
      if (surface && surface.root && typeof surface.root.scrollIntoView === 'function') {
        setTimeout(() => surface.root.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 0);
      }
      return Boolean(surface);
    }

    async function choose(item, keepText = false) {
      if (!item || !usable(item)) return;
      if (isAction(item)) {
        const detail = selectAction(item);
        close();
        input.focus();
        if (item.actionId === 'work.plugin.create') {
          if (typeof o.createPlugin === 'function') {
            try { await o.createPlugin(detail, currentInputContext()); } catch (error) {
              say(String(error && error.message || error || '\u63d2\u4ef6\u5236\u4f5c\u5165\u53e3\u6ca1\u6709\u6253\u5f00'));
            }
          } else {
            say('\u8bf7\u6253\u5f00\u300c\u65b0\u5efa\u300d\u540e\u4f7f\u7528\u63d2\u4ef6\u5236\u4f5c\u52a9\u624b');
          }
        }
        return;
      }
      if (canInstall(item)) {
        if (selected.length >= MAX_SELECTED) {
          say('\u4e00\u8f6e\u5bf9\u8bdd\u6700\u591a\u4f7f\u7528 ' + MAX_SELECTED + ' \u4e2a\u63d2\u4ef6\uff0c\u8bf7\u5148\u79fb\u9664\u4e00\u4e2a');
          return;
        }
        openConversationInstall(item);
        return;
      }
      if (!selected.some((row) => row.pluginId === item.pluginId)) {
        if (selected.length >= MAX_SELECTED) {
          say('\u4e00\u8f6e\u5bf9\u8bdd\u6700\u591a\u4f7f\u7528 ' + MAX_SELECTED + ' \u4e2a\u63d2\u4ef6');
          return;
        }
        selected.push(item);
      }
      if (!keepText) consumeQuery();
      close();
      renderStrip();
      input.focus();
    }

    function update() {
      if (selected.length) renderStrip();
      query = mentionQuery(input.value, input.selectionStart);
      active = 0;
      if (!query) return close();
      menu.scrollTop = 0;
      renderMenu();
      load(!loaded || Date.now() - loadedAt > 5000);
    }

    // The acceptance start card has an explicit plugin entry. Open the same
    // picker used by slash mentions without adding a stray slash to the draft.
    function openPicker() {
      input.focus();
      const caret = input.value.length;
      query = { start: caret, end: caret, query: '' };
      active = 0;
      menu.scrollTop = 0;
      renderMenu();
      void load(!loaded || Date.now() - loadedAt > 5000);
      return true;
    }

    function onKeydown(event) {
      if (event.isComposing || menu.hidden) return;
      const items = menuItems;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
        return;
      }
      if (!items.length) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopImmediatePropagation();
        active = navigation.move(items, active, event.key === 'ArrowDown' ? 1 : -1, usable);
        navigation.highlight(menu, input, '.nplugin-option', 'is-active', active, true);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        event.stopImmediatePropagation();
        choose(items[active]);
      }
    }

    const onDocumentMouseDown = (event) => {
      const target = event && event.target;
      if ((!target || typeof target.closest !== 'function' || !target.closest('.nplugin-menu'))
          && target !== input) close();
    };
    const onCatalogChanged = () => {
      loaded = false;
      loadedAt = 0;
      if (query) load(true);
    };
    const onLocaleChanged = () => { renderStrip(); renderMenu(); };

    input.addEventListener('input', update);
    input.addEventListener('click', update);
    input.addEventListener('keydown', onKeydown, true);
    eventRoot?.addEventListener('resize', positionMenu);
    document.addEventListener('mousedown', onDocumentMouseDown);
    if (eventRoot) eventRoot.addEventListener('soduwork:plugins-changed', onCatalogChanged);
    eventRoot?.addEventListener('soduwork-locale-change', onLocaleChanged);

    return {
      selected: () => selected.slice(),
      draft: () => selected.map(item => ({
        pluginId: item.pluginId, name: item.name, version: item.version,
        key: item.key, qualifiedKey: item.qualifiedKey, scopeLabel: scope(item),
        inputValues: { ...(inputDrafts.get(item.pluginId) || {}) },
      })),
      action: () => selectedAction,
      commandText: value => commandText(selectedAction, value),
      clearAction() {
        selectedAction = null;
        renderStrip();
        close();
      },
      open: openPicker,
      restoreAction(item) {
        selectedAction = item && isAction(item) ? item : null;
        renderStrip();
      },
      async select(pluginId, isCurrent, options) {
        // Explicit menu selection must preserve the draft, including any slash text.
        const current = typeof isCurrent === 'function' ? isCurrent : () => true;
        // Plus-menu/programmatic selection preserves edits made while the catalog loads.
        // Slash-menu selection still consumes its explicit query through choose().
        const keepText = Boolean(options && options.keepText);
        if (!current()) return null;
        close();
        const key = String(pluginId || '');
        let action = actions.find((row) => row.actionId === key);
        if (action) {
          if (!current()) return null;
          selectedAction = action;
          if (!keepText) {
            input.value = '';
            input.selectionStart = input.selectionEnd = 0;
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
          renderStrip();
          input.focus();
          return action;
        }
        await load(true);
        if (!current()) return null;
        action = actions.find((row) => row.actionId === key);
        if (action) {
          selectedAction = action;
          if (!keepText) {
            input.value = '';
            input.selectionStart = input.selectionEnd = 0;
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
          renderStrip();
          input.focus();
          return action;
        }
        const item = catalog.find((row) => row.pluginId === key);
        if (!item || !usable(item)) throw new Error('这个插件当前不可用');
        if (!current()) return null;
        await choose(item, keepText);
        return current() ? item : null;
      },
      restore(items) {
        const source = Array.isArray(items) ? items : [];
        const ids = new Set(source.map((item) => String(item && item.pluginId || '')).filter(Boolean));
        const token = ++restoreToken;
        source.forEach(item => {
          if (item?.pluginId && item.inputValues && typeof item.inputValues === 'object') {
            inputDrafts.set(item.pluginId, { ...item.inputValues });
          }
        });
        // Restore only saved/failed drafts, never the session's active plugins.
        const currentIds = new Set(selected.map((item) => String(item.pluginId || '')));
        const sameSet = ids.size === currentIds.size && [...ids].every((id) => currentIds.has(id));
        if (sameSet) return;
        /* A failed first turn may be restored before the chat picker's catalog
           has finished loading. Keep a display-safe placeholder so the retry
           still carries the plugin id; main process resolution remains the
           authority for the immutable version and capabilities. */
        const placeholders = source.map((item) => ({
          pluginId: String(item && item.pluginId || ''),
          key: String(item && item.key || ''),
          qualifiedKey: String(item && item.qualifiedKey || item && item.key || ''),
          name: String(item && item.name || item && item.pluginId || '个人插件'),
          version: String(item && item.version || ''),
          personal: true, installed: true, enabled: true,
          inputs: [], workflow: [], capabilities: { skills: [], mcpServers: [], runtime: [] },
          conversationUse: { available: true, code: 'restored', label: '已恢复本轮插件' },
        })).filter((item) => item.pluginId);
        selected = catalog.filter((item) => ids.has(item.pluginId)).slice(0, MAX_SELECTED);
        placeholders.forEach((item) => {
          if (selected.length >= MAX_SELECTED || selected.some((row) => row.pluginId === item.pluginId)) return;
          selected.push(item);
        });
        renderStrip();
        const catalogHasAll = [...ids].every((id) => catalog.some((item) => item.pluginId === id));
        if (!catalogHasAll && !loading) {
          void load(true).then(() => {
            if (token !== restoreToken) return;
            const fresh = catalog.filter((item) => ids.has(item.pluginId)).slice(0, MAX_SELECTED);
            if (fresh.length) { selected = fresh; renderStrip(); }
          }).catch(() => {});
        }
      },
      clear() {
        // Empty drafts need no repaint and must not close an open slash menu.
        if (!selected.length && !selectedAction) return;
        restoreToken += 1;
        selected = [];
        selectedAction = null;
        inputDrafts.clear();
        if (eventRoot && eventRoot.PluginInputSheet) eventRoot.PluginInputSheet.close();
        renderStrip();
        close();
      },
      consume(items) {
        const ids = new Set((items || []).map(item => item.pluginId).filter(Boolean));
        if (!selected.some(item => ids.has(item.pluginId))) return;
        /* Follow-up-turn semantics: after a successful send, workflow plugins stay in the
           composer so sending again in the same session starts a new round; plain plugins
           remain one-shot. kind is judged from the selected entry's full catalog data —
           resolvedPlugins handed back by the send chain is display data only, without capabilities/workflow. */
        const keepIds = new Set(selected
          .filter(item => ids.has(item.pluginId) && pluginKind(item) === 'workflow')
          .map(item => item.pluginId));
        const removable = [...ids].filter(id => !keepIds.has(id));
        if (!removable.length) { close(); return; }
        restoreToken += 1;
        selected = selected.filter(item => !removable.includes(item.pluginId));
        removable.forEach(id => inputDrafts.delete(id));
        renderStrip();
        close();
      },
      refresh() {
        if (selected.length) renderStrip();
      },
      async resolve(_conversationId, projectId, seed, context) {
        /* The picker returns display-safe selection data only. Electron main
           resolves ids, immutable versions, instructions and grants exactly
           once when the turn reaches the queue head. */
        const scopeProject = String(projectId || currentProjectId()).trim();
        const selectedForTurn = selected.slice();
        const blocked = selectedForTurn.map((item) => ({
          item, state: availability(item, scopeProject),
        })).find((row) => !row.state.available);
        if (blocked) throw new Error(blocked.item.name + '\uff1a' + blocked.state.label);
        const originalText = seed == null ? currentInputText() : String(seed);
        const inputContext = Object.assign({}, currentInputContext(),
          context && typeof context === 'object' ? context : {});
        for (const item of selectedForTurn) {
          if (!await requestMissingInputs(item, originalText, inputContext)) return null;
        }
        // Inferred goals belong to this submission, not the editable parameter
        // draft: retrying after an edit must infer from the current original.
        const turnValues = new Map(selectedForTurn.map(item => [item.pluginId,
          prepareConversationInputs(item.inputs, originalText, inputDrafts.get(item.pluginId), inputContext).values]));
        return {
          // Parameters travel as bounded turn data; the transcript keeps the user's text.
          text: originalText,
          items: selectedForTurn.map((item) => ({
            pluginId: item.pluginId,
            inputValues: { ...(turnValues.get(item.pluginId) || {}) },
            name: item.name,
            version: item.version,
            scopeLabel: scope(item),
          })),
        };
      },
      destroy() {
        input.removeEventListener('input', update);
        input.removeEventListener('click', update);
        input.removeEventListener('keydown', onKeydown, true);
        document.removeEventListener('mousedown', onDocumentMouseDown);
        if (eventRoot) eventRoot.removeEventListener('soduwork:plugins-changed', onCatalogChanged);
        eventRoot?.removeEventListener('soduwork-locale-change', onLocaleChanged);
        eventRoot?.removeEventListener('resize', positionMenu);
        if (eventRoot && eventRoot.PluginInputSheet) eventRoot.PluginInputSheet.close();
        close();
        strip.remove();
        menu.remove();
      },
    };
  }

  return {
    MAX_SELECTED, appendPluginIcon, mentionQuery, normalizeActions, pluginBuilderAction, normalizePluginInputs,
    normalizeCatalog, availability, pluginKind,
    catalogWarning, retryableGrantFailure, commandText, prepareConversationInputs,
    preparedConversationText, create,
  };
});
