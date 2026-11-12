(function (global) {
  'use strict';
  const context = {
    get _rememberComposeDraft() { return _rememberComposeDraft; },
    get makeDraft() { return makeDraft; },
    get _openRequirementPicker() { return _openRequirementPicker; },
    get _attachments() { return _attachments; }, set _attachments(value) { _attachments = value; },
    get _loadCapabilities() { return _loadCapabilities; },
    get _loadSetup() { return _loadSetup; },
    get _bindSetup() { return _bindSetup; },
    get _closeMore() { return _closeMore; },
    get _intent() { return _intent; }, set _intent(value) { _intent = value; },
    get _skillPicker() { return _skillPicker; }, set _skillPicker(value) { _skillPicker = value; },
    get _pluginMention() { return _pluginMention; }, set _pluginMention(value) { _pluginMention = value; },
    get _setupApi() { return _setupApi; },
    get esc() { return esc; },
    get _capabilityKey() { return _capabilityKey; },
    get _pickedModel() { return _pickedModel; }, set _pickedModel(value) { _pickedModel = value; },
    get _loadModels() { return _loadModels; },
    get _toggleModelPop() { return _toggleModelPop; },
    get _closeSetupPops() { return _closeSetupPops; },
    get _loadMorePlugins() { return _loadMorePlugins; },
    get _capabilities() { return _capabilities; },
    get _pickedCapabilities() { return _pickedCapabilities; },
    get _renderCapabilities() { return _renderCapabilities; },
    get _plugins() { return _plugins; },
    get _workspace() { return _workspace; },
    get _mode() { return _mode; },
    get _capLoading() { return _capLoading; },
    get _accessConsent() { return _accessConsent; },
    get _bind() { return _bind; },
    menuSelectionGuard() {
      const view = _composeViewSeq, selection = ++_menuSelectionSeq, revision = WorkComposer.menuPluginRevision();
      return () => view === _composeViewSeq && selection === _menuSelectionSeq &&
        revision === WorkComposer.menuPluginRevision();
    },
  };
  const { _rememberComposeDraft, _restoreComposeDraft, _clearComposeDraft,
    _upgradeStartComposer, _panel, _bind, _renderMorePlugins, _paintSetup, refreshComposeRecommendations } = global.ComposeSurface.create(context);
  let _attachments = null;    // Shared starter and clipboard attachment controller.
  let _usedAtts = [];         // Materials already attached to this conversation remain attached when creating a requirement.
  let _pickedModel = '';      // Selected conversation model; empty until the catalog loads.
  let _capabilities = [];     // Base session capabilities detected by the main process.
  let _pickedCapabilities = new Set();
  let _requestedCapabilities = null;
  let _skills = [];           // Discoverable enterprise Skills with actual local installation state.
  let _skillPicker = null;    // Explicit session selection; the main process still loads personal defaults.
  let _capLoading = false;
  // The capability request also warms the local Pi SDK and model config.
  // Keep its promise so Send cannot race that work and show a dead-looking
  // cursor while the first session is still being prepared.
  let _capabilityPromise = Promise.resolve();
  let _capabilityRequestKey = '';
  // A model/runtime change can happen while the first capability probe is
  // still warming the local runner.  Keep that change as a single coalesced
  // retry instead of chaining promises.  Chaining here made the UI keep the
  // loading state alive when model discovery and capability discovery
  // completed in a different order.
  let _capabilityRetryKey = '';
  let _skillIconSeq = 0;
  const CAPABILITY_REQUEST_TIMEOUT_MS = 12000;
  let _plugins = [];
  let _pluginsRequest = 0;
  let _workspace = { dir: '', name: '默认工作区', rootDir: '', direct: false };
  let _mode = 'standard';
  let _accessExplicit = false, _legacyMode = 'full';
  const _accessConsent = global.ComposeSurface.createAccessConsent?.({ api: _setupApi,
    select: mode => { _mode = mode; _accessExplicit = true; },
    remember: mode => global.AccessPreferences?.remember?.(mode), paint: _paintSetup,
    say: message => { if (typeof petSay === 'function') petSay(message); } });
  global.AccessPreferences?.subscribe?.(value => {
    if (!_accessExplicit && !_accessConsent?.busy()) { _mode = value.mode; _paintSetup(); }
  });
  let _setupRevision = 0;
  let _intent = null;
  let _pluginMention = null;  // The starter supports slash work actions and published enterprise plugins on the first turn.
  let _pluginResolveBusy = false;
  let _pluginResolveSeq = 0;
  let _pluginSelectSeq = 0;
  let _menuSelectionSeq = 0;
  let _composeViewSeq = 0;
  let _closeRequirementPicker = () => {};
  // Every navigation from the history list gets its own ticket.  A user can
  // click A and then B before the first IPC open has returned; the native
  // runtime fences the old handle, but this layer also has to prevent the
  // late A promise from running task-focus/toast work against B's view.
  let _chatOpenSeq = 0;
  let _pluginSelectTask = Promise.resolve();
  let _pluginSelectError = '';
  let _entryPluginEditId = "";
  let _entryContextPrompts = []; _entryPluginEditId = ""; // Entry-point materials go to the Agent without filling the user's composer.
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function _setupApi() {
    return global.soduWorkAPI && (global.soduWorkAPI.conversationSession || global.soduWorkAPI.piSession);
  }
  /* Synchronize manual directory selection/clearing with recent workspace storage; failure does not invalidate the current choice. */
  function _syncRecentWorkspace(action) {
    const args = Array.prototype.slice.call(arguments, 1);
    try {
      const bridge = global.soduWorkAPI;
      if (bridge && bridge.recentWorkspace && typeof bridge.recentWorkspace[action] === 'function') {
        void Promise.resolve(bridge.recentWorkspace[action](...args)).catch(() => {});
      }
    } catch (_) { /* Persistence failure does not invalidate this selection. */ }
    if (global.WorkspaceShell && typeof global.WorkspaceShell.refreshRecentWorkspace === 'function') {
      global.WorkspaceShell.refreshRecentWorkspace();
    }
  }
  function _bindSetup(p) {
    global.ComposeExecution?.bind(p, _paintSetup);
    const open = (buttonId, popId) => {
      const button = p.querySelector('#' + buttonId);
      if (!button) return;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const pop = p.querySelector('#' + popId);
        const show = pop && !pop.classList.contains('show');
        _closeSetupPops();
        if (pop && show) {
          pop.classList.add('show');
          button.setAttribute('aria-expanded', 'true');
          if (popId === 'cpPermissionPop') WorkComposer.placeMore(button, pop);
          if (popId === 'cpRuntimePop') WorkComposer.placeRuntime(button, pop);
        }
      });
    };
    open('cpRuntime', 'cpRuntimePop');
    open('cpWorkspace', 'cpWorkspacePop');
    open('cpPermission', 'cpPermissionPop');
    open('cpAbility', 'cpAbilityPop');
    p.querySelectorAll('.wc-popover').forEach((pop) => pop.addEventListener('click', (event) => event.stopPropagation()));
    if (global.ComposeRuntime) ComposeRuntime.bind(p, {
      api: _setupApi,
      say: (message) => { if (typeof petSay === 'function') petSay(message); },
      close: _closeSetupPops,
      refresh: _paintSetup,
    });
    p.querySelector('#cpWorkspacePop').addEventListener('click', async (event) => {
      const row = event.target.closest('[data-workspace]');
      if (!row) return;
      if (row.dataset.workspace === 'temp') {
        _setupRevision += 1;
        _workspace = { ..._workspace, dir: '', name: '默认工作区', direct: false, workspaceSource: '' };
        /* Explicitly clearing the inherited directory also clears recent selection so later conversations do not restore it. */
        _syncRecentWorkspace('clear');
        _paintSetup();
        _closeSetupPops();
        return;
      }
      await _pickWorkspace();
    });
    p.querySelector('#cpPermissionRetry').addEventListener('click', () => {
      void global.ComposeRuntime?.refreshAccess?.();
    });
    p.querySelector('#cpPermissionPop').addEventListener('click', (event) => {
      const row = event.target.closest('[data-mode]');
      if (!row || row.disabled || !global.ComposeRuntime?.accessSupported?.()) return;
      _setupRevision += 1;
      _closeSetupPops();
      const mode = ['standard', 'readonly', 'full'].includes(row.dataset.mode) ? row.dataset.mode : 'standard';
      if (_accessConsent) return _accessConsent.choose(mode, global.ComposeRuntime.value(), (() => {
        const rect = p.querySelector('#cpPermission')?.getBoundingClientRect();
        return rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height,
          screenX: Number(global.screenX) + rect.left, screenY: Number(global.screenY) + rect.top } : undefined;
      })());
      if (mode !== 'full') { _mode = mode; _accessExplicit = true; void global.AccessPreferences?.remember?.(mode); _paintSetup(); }
    });
  }
  function _closeSetupPops() {
    document.querySelectorAll('#composePanel .wc-popover.show').forEach((pop) => pop.classList.remove('show'));
    document.querySelectorAll('#cpContext [aria-expanded],#cpRuntime,#cpAbility').forEach((button) => button.setAttribute('aria-expanded', 'false'));
  }
  function _closeMore() {
    const pop = document.getElementById('cpMorePop'), button = document.getElementById('cpMore');
    if (pop) {
      pop.querySelectorAll('.show').forEach((node) => node.classList.remove('show'));
      pop.classList.remove('show'); pop.hidden = true;
    }
    if (button) button.setAttribute('aria-expanded', 'false');
  }
  async function _loadMorePlugins(force) {
    const list = document.getElementById('cpMorePlugins');
    const request = ++_pluginsRequest, revision = WorkComposer.menuPluginRevision();
    const current = () => request === _pluginsRequest && revision === WorkComposer.menuPluginRevision();
    const cached = WorkComposer.peekMenuPlugins();
    if (cached) {
      _plugins = ChatPluginMention.normalizeCatalog(cached).filter(item => item.installed || item.personal);
      _renderMorePlugins();
    } else if (list) list.innerHTML = '<span>正在加载插件…</span>';
    try {
      const result = await WorkComposer.loadMenuPlugins(force);
      if (!current()) return;
      _plugins = global.ChatPluginMention ? ChatPluginMention.normalizeCatalog(result)
        .filter(item => item.installed || item.personal) : [];
    } catch (error) {
      if (!current()) return;
      _plugins = [];
      if (list) list.innerHTML = '<span>插件目录暂时无法加载</span>' +
        '<button type="button" class="wc-more-retry" data-more-retry>重新加载</button>';
      return;
    }
    _renderMorePlugins();
  }
  async function _loadSetup() {
    const api = _setupApi();
    if (!api) return;
    const revision = _setupRevision;
    const viewSeq = _composeViewSeq;
    try {
      const preference = await global.AccessPreferences?.ready?.();
      if (viewSeq === _composeViewSeq && !_accessExplicit && !_accessConsent?.busy() && preference) _mode = preference.mode;
      const root = await api.workdir();
      if (revision === _setupRevision && root && root.ok) {
        _workspace = _workspace.direct
          ? { ..._workspace, rootDir: root.dir || '' }
          /*
           * Default-workspace sessions retain project and other context; reset only
           * directory-related fields.
           */
          : { ..._workspace, dir: '', name: '默认工作区', rootDir: root.dir || '', direct: false };
      }
      const mode = await api.setMode('');
      if (revision === _setupRevision && mode) _legacyMode = mode.mode === 'readonly' ? 'readonly' : 'full';
    } catch (error) { /* Use safe defaults if startup settings cannot be read. */ }
    _paintSetup();
  }
  async function _pickWorkspace() {
    const api = _setupApi();
    if (!api) return;
    _setupRevision += 1;
    try {
      const picker = typeof api.pickCwd === 'function' ? api.pickCwd : api.pickWorkdir;
      /* Re-opening the picker starts from the user's previous choice — the current
         session folder first, then the last hand-picked workspace — never the root. */
      let startDir = _workspace.direct ? _workspace.dir : '';
      if (!startDir) {
        try {
          const recent = await Promise.resolve(global.soduWorkAPI?.recentWorkspace?.get?.());
          if (recent && recent.ok && recent.dir) startDir = recent.dir;
        } catch (_) { /* root fallback is fine */ }
      }
      const result = await picker(startDir ? { defaultPath: startDir } : {});
      if (result && result.ok) {
        _workspace = { ..._workspace, dir: result.dir || '', name: result.name || '所选文件夹', direct: true, workspaceSource: '' };
        /* The main process validates and persists manually selected directories for future cold-start conversations. */
        if (result.dir) _syncRecentWorkspace('set', result.dir, _workspace.name);
      }
    } catch (error) { /* Canceling selection is not an error. */ }
    _paintSetup();
    _closeSetupPops();
  }
  function _capabilityKey() {
    return [global.ComposeRuntime?.value?.() || 'pi', _pickedModel,
      global.ComposeExecution?.value?.() || 'local'].join('\u0000');
  }
  function _awaitCapability(value, timeoutMs = CAPABILITY_REQUEST_TIMEOUT_MS) {
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error('conversation capabilities timed out');
        error.code = 'CAPABILITY_TIMEOUT';
        reject(error);
      }, timeoutMs);
    });
    return Promise.race([Promise.resolve(value), timeout]).finally(() => clearTimeout(timer));
  }
  function _enrichSkillIcons(skills, requestKey) {
    if (!global.ComposeSkills || typeof ComposeSkills.withPluginIcons !== 'function' ||
        !global.SoduWorkAPI || typeof SoduWorkAPI.pluginCatalog !== 'function') return;
    const iconSeq = ++_skillIconSeq;
    Promise.resolve().then(() => SoduWorkAPI.pluginCatalog()).then((catalog) => {
      if (iconSeq !== _skillIconSeq || requestKey !== _capabilityRequestKey) return;
      const decorated = ComposeSkills.withPluginIcons(skills, catalog);
      _skills = decorated;
      if (_skillPicker) _skillPicker.setItems(decorated);
    }).catch(() => { /* plugin icons are optional; the Skill list is already usable */ });
  }
  function _loadCapabilities(force) {
    const api = global.soduWorkAPI && (global.soduWorkAPI.conversationSession || global.soduWorkAPI.piSession);
    if (_capLoading) {
      // Model discovery can finish after the initial capability request. If it
      // selected a concrete default model, request one replacement after the
      // active probe settles so model-config.prepare is keyed to exactly the
      // model that Send will use.  Do not make the public promise depend on a
      // recursively chained request: that chain can be replaced by a later
      // render and leave the button permanently marked as busy.
      const key = _capabilityKey();
      if (force === true && key !== _capabilityRequestKey) {
        _capabilityRetryKey = key;
      }
      return _capabilityPromise;
    }
    if (_skillPicker && typeof _skillPicker.setLoading === 'function') {
      _skillPicker.setLoading(true, '\u6b63\u5728\u52a0\u8f7d\u56e2\u961f Skill\u2026');
    }
    if (!api || typeof api.capabilities !== 'function') {
      _capabilities = [];
      const note = document.getElementById('cpCapNote');
      if (note) note.textContent = '\u5f53\u524d\u5ba2\u6237\u7aef\u7248\u672c\u4e0d\u652f\u6301\u4f1a\u8bdd\u80fd\u529b\u68c0\u67e5';
      if (_skillPicker && typeof _skillPicker.setError === 'function') {
        _skillPicker.setError('\u5f53\u524d\u5ba2\u6237\u7aef\u7248\u672c\u4e0d\u652f\u6301\u56e2\u961f Skill');
      }
      _renderCapabilities();
      _capabilityPromise = Promise.resolve();
      return _capabilityPromise;
    }
    _capLoading = true;
    _capabilityRequestKey = _capabilityKey();
    const requestKey = _capabilityRequestKey;
    _skillIconSeq += 1;
    _renderCapabilities();
    const task = (async () => {
      try {
        const result = await _awaitCapability(api.capabilities({ force: force === true,
          adapterId: global.ComposeRuntime?.value?.() || 'pi', modelName: _pickedModel,
          executionLocation: global.ComposeExecution?.value?.() || 'local' }));
        if (!result || result.ok === false) {
          _capabilities = [];
          const note = document.getElementById('cpCapNote');
          if (note) note.textContent = (result && result.reason) || '\u80fd\u529b\u72b6\u6001\u6682\u65f6\u6ca1\u6709\u53d6\u5230';
          _skills = [];
          if (_skillPicker && typeof _skillPicker.setError === 'function') {
            _skillPicker.setError((result && result.reason) || '\u56e2\u961f Skill \u6682\u65f6\u4e0d\u53ef\u7528');
          }
          return;
        }
        _capabilities = (result && result.items) || [];
        _skills = Array.isArray(result && result.skills) ? result.skills.slice() : [];
        const requested = Array.isArray(_requestedCapabilities) ? new Set(_requestedCapabilities.map(String)) : null;
        _pickedCapabilities = new Set(_capabilities.filter((item) =>
          item.selectable && item.deviceGranted && (requested ? requested.has(item.id) : item.selected)).map((item) => item.id));
        if (_skillPicker) {
          if (result.policyOk === false && typeof _skillPicker.setError === 'function') {
            _skillPicker.setError(result.policyReason || '\u56e2\u961f Skill \u6682\u65f6\u4e0d\u53ef\u7528');
          } else {
            // End the loading state as soon as the capability response arrives.
            // Catalog/icon enrichment is optional and must never block selection.
            _skillPicker.setItems(_skills);
            _enrichSkillIcons(_skills, requestKey);
          }
        }
        const note = document.getElementById('cpCapNote');
        if (note) note.textContent = result && result.policyOk === false
          ? '\u56e2\u961f Skill \u6682\u65f6\u4e0d\u53ef\u7528\uff1b\u57fa\u7840\u80fd\u529b\u4ecd\u6309\u672c\u673a\u72b6\u6001\u63d0\u4f9b' : '';
      } catch (error) {
        _capabilities = [];
        _skills = [];
        if (_skillPicker && typeof _skillPicker.setError === 'function') {
          _skillPicker.setError('\u56e2\u961f Skill \u6682\u65f6\u4e0d\u53ef\u7528\uff0c\u8bf7\u68c0\u67e5\u670d\u52a1\u8fde\u63a5');
        }
        const note = document.getElementById('cpCapNote');
        if (note) note.textContent = '\u80fd\u529b\u72b6\u6001\u6682\u65f6\u6ca1\u6709\u53d6\u5230';
      } finally {
        _capLoading = false;
        _renderCapabilities();
        const retryKey = _capabilityRetryKey;
        _capabilityRetryKey = '';
        // Re-probe once with the latest model/runtime selection.  Schedule it
        // after the current turn so callers awaiting the completed probe can
        // observe the settled loading state first.
        if (retryKey) Promise.resolve().then(() => { void _loadCapabilities(true); });
      }
    })();
    _capabilityPromise = task;
    return task;
  }
  function _renderCapabilities() {
    _paintSetup();
    ComposeCapabilities.render(document.getElementById('cpCapList'),
      _capabilities, _pickedCapabilities, _capLoading, esc);
  }
  let _models = [];
  async function _loadModels() {
    if (!(global.SoduWorkAPI && SoduWorkAPI.myModels)) return;
    try {
      const r = await SoduWorkAPI.myModels();
      _models = (r && r.usable) || [];
      if (!_models.some(m => m.name === _pickedModel)) {
        const name = r?.defaultModels?.pi ?? r?.defaultModel;
        _pickedModel = _models.find(m => m.name === name)?.name || '';
      }
    } catch (e) { _models = []; }
    const wrap = document.querySelector('.cp-modelwrap');
    if (wrap) wrap.style.display = _models.length ? '' : 'none';
    _renderModelPop();
  }
  function _renderModelPop() { ComposeSurface.renderLegacyModelPicker(_models, _pickedModel, esc, value => { _pickedModel = value; }); }
  function _toggleModelPop() {
    const pop = document.getElementById('cpModelPop');
    if (pop) pop.classList.toggle('show');
  }
  function setTab() {
    const p = _panel();
    p.dataset.tab = 'one';
    setTimeout(() => {
      const input = p.dataset.stage === 'chat'
        ? p.querySelector('#nchatInput') || p.querySelector('#cpInput')
        : p.querySelector('#cpInput') || p.querySelector('#nchatInput');
      if (input) input.focus();
    }, 40);
  }
  async function _enterChat(text, chatId, intentOptions) {
    const p = _panel();
    if (chatId) {
      _accessConsent?.reset();
      if (global.SessionMemoryEntry) SessionMemoryEntry.clear();
      _composeViewSeq += 1;
      _pluginResolveSeq += 1;
      _pluginSelectSeq += 1;
      _pluginResolveBusy = false;
      _pluginSelectError = '';
      _pluginSelectTask = Promise.resolve();
      p.dataset.stage = 'chat';
      return global.NativeChat
        ? NativeChat.enter('', String(chatId), { ...(intentOptions || {}),
          sidebarProjectId: (intentOptions && intentOptions.sidebarProjectId) || '',
          sidebarProjectName: (intentOptions && intentOptions.sidebarProjectName) || '',
          chatTitle: (intentOptions && intentOptions.chatTitle) || '' }) : false;
    }
    if (_pluginResolveBusy) return false;
    const selectedSkills = [...new Set(_skillPicker?.selected() || [])];
    if (global.ComposeExecution?.value() === 'cloud') {
      const cloudViewSeq = _composeViewSeq;
      const accepted = await global.ComposeExecution.start({ text, isCurrent: () => cloudViewSeq === _composeViewSeq,
        inputPreparation: intentOptions?.inputPreparation,
        prepare: async () => {
          await _pluginSelectTask;
          if (cloudViewSeq !== _composeViewSeq) return {};
          if (_pluginSelectError) throw Error(_pluginSelectError);
          return { attachments: _attachments ? await _attachments.refs(_setupApi()) : [],
            skills: selectedSkills.slice(),
            plugins: _pluginMention?.selected() || [], intent: intentOptions?.intent,
            inputPreparation: intentOptions?.inputPreparation,
            pluginEditId: _entryPluginEditId, contextPrompts: _entryContextPrompts.slice() };
        } });
      if (cloudViewSeq !== _composeViewSeq) return false;
      if (accepted) {
        p.dataset.stage = 'chat'; _attachments?.clear(); _entryContextPrompts = []; _entryPluginEditId = "";
        _pluginMention?.clear?.();
        _skillPicker?.consume(selectedSkills);
        _accessConsent?.reset(); global.SessionMemoryEntry?.clear();
      }
      return accepted;
    }
    // Capabilities are loaded as soon as the composer opens. Let model
    // discovery settle first so the warmup uses the concrete default model,
    // then fence NativeChat on that same request before entering the chat.
    await global.ComposeModelPicker?.ready?.();
    await _capabilityPromise.catch(() => {});
    const viewSeq = _composeViewSeq;
    const adapterId = global.ComposeRuntime?.value?.() || 'pi';
    const executionRevision = global.ComposeExecution?.revision?.();
    // Preparation can await permission, plugins and models. Changing location
    // or Agent invalidates this send; keep its draft instead of starting the
    // previously selected local runtime under the new visible controls.
    const current = () => viewSeq === _composeViewSeq && global.ComposeExecution?.value?.() !== 'cloud' &&
      global.ComposeExecution?.revision?.() === executionRevision && (global.ComposeRuntime?.value?.() || 'pi') === adapterId;
    if (_accessConsent && !await _accessConsent.ready()) return false;
    await _pluginSelectTask;
    await global.ComposeRuntime?.ready?.();
    if (!current()) return false;
    if (intentOptions?.intent === 'goal' && global.ComposeRuntime?.goalSupported?.() === false) {
      if (typeof petSay === 'function') petSay('当前 Agent 暂不支持目标模式，请选择其他 Agent 或取消目标后发送');
      return false;
    }
    const accessPreference = await global.AccessPreferences?.ready?.();
    if (!current()) return false;
    if (!_accessExplicit && accessPreference) _mode = accessPreference.mode;
    if (_pluginSelectError) return false;
    const selectedPlugins = _pluginMention ? _pluginMention.selected() : [];
    const resolveSeq = ++_pluginResolveSeq;
    let initialPlugins = [];
    try {
      if (selectedPlugins.length) {
        _pluginResolveBusy = true;
        const prepared = await _pluginMention.resolve(
          chatId || '', (intentOptions && intentOptions.projectId) || '', text, {
            attachmentNames: _attachments ? _attachments.names() : [],
          });
        if (!prepared) return false;
        if (!current()) return false;
        initialPlugins = prepared.items;
        text = prepared.text || text;
      }
    } catch (error) {
      if (typeof petSay === 'function') petSay(String((error && error.message) || error));
      return false;
    } finally {
      if (resolveSeq === _pluginResolveSeq) _pluginResolveBusy = false;
    }
    if (resolveSeq !== _pluginResolveSeq) return false;
    if (!current()) return false;
    const attachmentRefs = _attachments ? await _attachments.refs(_setupApi()) : [];
    const libraryItemIds = _attachments ? _attachments.libraryItems() : [];
    await global.ComposeRuntime?.ready?.();
    if (await global.ComposeModelPicker?.ready?.() === false) {
      if (typeof petSay === 'function') petSay('默认模型暂不可用，请选择其他模型');
      return false;
    }
    if (!current()) return false;
    if (_accessConsent && !await _accessConsent.ready()) return false;
    if (!current()) return false;
    if (intentOptions?.intent === 'goal' && global.ComposeRuntime?.goalSupported?.() === false) {
      if (typeof petSay === 'function') petSay('当前 Agent 暂不支持目标模式，请选择其他 Agent 或取消目标后发送');
      return false;
    }
    p.dataset.stage = 'chat';
    const modelSelection = global.ComposeModelPicker
      ? ComposeModelPicker.value() : { modelName: _pickedModel, reasoningEffort: '', thinkingLevel: '' };
    const accepted = global.NativeChat ? await NativeChat.enter(text || '', chatId || '', Object.assign({
      adapterId,
      modelName: modelSelection.modelName,
      reasoningEffort: modelSelection.reasoningEffort,
      thinkingLevel: modelSelection.thinkingLevel || '',
      capabilities: [..._pickedCapabilities],
      skills: selectedSkills,
      cwd: _workspace.direct ? _workspace.dir : '',
      workspaceLabel: _workspace.direct ? _workspace.name : '默认工作区',
      mode: global.ComposeRuntime?.accessSupported?.() ? (_mode === 'readonly' ? 'readonly' : 'full') : _legacyMode,
      accessMode: global.ComposeRuntime?.accessSupported?.() ? _mode : '',
      ...(global.ComposeRuntime?.accessSupported?.() && _mode === 'full' ? _accessConsent?.options() : {}),
      attachments: attachmentRefs,
      libraryItemIds,
      initialPlugins,
      pluginEditId: _entryPluginEditId, contextPrompts: _entryContextPrompts.slice(),
      sidebarProjectId: _workspace.sidebarProjectId || '',
      sidebarProjectName: _workspace.sidebarProjectName || '',
      projectId: _workspace.projectId || '',
      ...(global.SessionMemoryEntry ? SessionMemoryEntry.options() : {}),
    }, intentOptions || {})) : false;
    if (!accepted) return false;
    if (viewSeq !== _composeViewSeq) return false;
    // A selected Skill belongs to this first message only.  Keep the
    // composer state clean after a successful new-session send so the next
    // turn does not silently inherit the previous Skill chip.
    if (_skillPicker) _skillPicker.consume(selectedSkills);
    _accessConsent?.reset();
    _entryContextPrompts = []; _entryPluginEditId = "";
    if (global.SessionMemoryEntry) SessionMemoryEntry.clear();
    _usedAtts = _attachments ? _attachments.files() : [];
    if (_attachments) _attachments.clear();
    if (_pluginMention) _pluginMention.clear();
    return true;
  }
  async function _openRequirementPicker() {
    const p = _panel(), button = p.querySelector('.cp-requirement-dock [data-queue-action="add"]');
    if (button?.disabled || p.dataset.stage !== 'compose' || !global.NativeChat?.openTaskPicker) return;
    if (global.ComposeExecution?.value?.() === 'cloud') {
      global.petSay?.('云端需求请在需求池安排执行'); return;
    }
    const view = _composeViewSeq, owner = global.SoduWorkAPI?.taskStorageKey?.('ops') || '';
    const revision = global.ComposeExecution?.revision?.(), setup = _setupRevision;
    const adapterId = global.ComposeRuntime?.value?.() || 'pi';
    const current = () => view === _composeViewSeq && owner === (global.SoduWorkAPI?.taskStorageKey?.('ops') || '') &&
      p.classList.contains('show');
    const ready = () => current() && p.dataset.stage === 'compose' && setup === _setupRevision &&
      revision === global.ComposeExecution?.revision?.() && global.ComposeExecution?.value?.() !== 'cloud' &&
      adapterId === (global.ComposeRuntime?.value?.() || 'pi');
    if (button) button.disabled = true;
    try {
      await global.ComposeRuntime?.ready?.();
      if (!ready()) return;
      const modelReady = await global.ComposeModelPicker?.ready?.();
      if (!ready()) return;
      if (modelReady === false) { global.petSay?.('默认模型暂不可用，请选择其他模型'); return; }
      if (_accessConsent && !await _accessConsent.ready()) return;
      if (!ready()) return;
      _closeSetupPops(); _rememberComposeDraft();
      const selection = () => {
        const model = global.ComposeModelPicker?.value?.() || { modelName: _pickedModel };
        const accessSupported = global.ComposeRuntime?.accessSupported?.();
        return {
          adapterId: global.ComposeRuntime?.value?.() || 'pi', ...model,
          modelLabel: global.ComposeModelPicker?.label?.() || model.modelName || '',
          cwd: _workspace.direct ? _workspace.dir : '', workspaceLabel: _workspace.name,
          projectId: _workspace.projectId || '', repoId: _workspace.repoId || '',
          sidebarProjectId: _workspace.sidebarProjectId || '', sidebarProjectName: _workspace.sidebarProjectName || '',
          capabilities: [..._pickedCapabilities], pluginEditId: _entryPluginEditId, contextPrompts: _entryContextPrompts.slice(),
          mode: accessSupported ? (_mode === 'readonly' ? 'readonly' : 'full') : _legacyMode,
          accessMode: accessSupported ? _mode : '',
          ...(accessSupported && _mode === 'full' ? _accessConsent?.options() : {}),
          ...(global.SessionMemoryEntry?.options?.() || {}),
        };
      };
      const sessionOptions = selection(), selectionKey = JSON.stringify(sessionOptions);
      // Reuse the task picker above the untouched starter; mount the chat only after explicit confirmation.
      _closeRequirementPicker();
      const surface = ComposeSurface.requirementPickerHost(p, button);
      const remove = () => { surface.destroy(); _closeRequirementPicker = () => {}; };
      _closeRequirementPicker = () => { NativeChat.closeTaskPicker(surface.host); remove(); };
      const canConfirm = isCurrent => {
        if (!isCurrent() || !ready() || JSON.stringify(selection()) !== selectionKey) {
          _closeRequirementPicker();
          if (current()) global.petSay?.('执行设置已变化，请重新添加需求');
          return false;
        }
        return true;
      };
      const opening = NativeChat.openTaskPicker({ sessionOptions, host: surface.host,
        onClose: remove, canConfirm,
        onConfirm: isCurrent => {
          if (!canConfirm(isCurrent)) return false;
          _rememberComposeDraft(); remove(); p.dataset.stage = 'chat'; return true;
        },
      });
      if (button) button.disabled = false;
      if (await opening === false) remove();
    } catch (error) {
      if (current()) {
        _closeRequirementPicker();
        global.petSay?.('暂时无法打开需求选择，请重试');
      }
    } finally { if (button) button.disabled = false; }
  }
  async function makeDraft() {
    const input = document.getElementById('cpInput');
    const originalText = _attachments?.submissionText?.(input?.value) ?? String(input?.value || '');
    const submittedFiles = _attachments?.files?.().slice() || [];
    const fileIdentity = file => global.ConversationAttachments?.fileIdentity?.(file) ?? file;
    const submittedIdentities = submittedFiles.map(fileIdentity);
    const typed = global.ComposeSkills?.submission?.(originalText, _skillPicker?.selected())?.text || originalText;
    const hasAttachments = Boolean(_attachments && _attachments.has());
    if (!typed.trim() && !hasAttachments) return;
    _menuSelectionSeq++;
    const text = typed.trim() ? typed : '请查看并处理我附上的文件。';
    const inputPreparation = {
      userText: typed,
      ...( !typed.trim() && submittedFiles.length ? { fallback: true } : {}),
    };
    if (global.ComposeExecution?.value() === 'cloud') {
      const mode = _intent?.current(text);
      const accepted = await _enterChat(text, '', { ...(mode?.mode === 'goal' ? { intent: 'goal' } : {}), inputPreparation });
      if (accepted) { _clearComposeDraft(); if (input) { input.value = ''; input.style.height = ''; } }
      return;
    }
    const submittedBridge = draftBridge(global.ComposeRuntime?.accessSupported?.() ? _mode : undefined);
    const submitViewSeq = _composeViewSeq;
    const submitOwner = global.SoduWorkAPI?.taskStorageKey?.('ops') || '';
    const submitAdapter = global.ComposeRuntime?.value?.() || 'pi';
    const submitExecution = global.ComposeExecution?.revision?.();
    const currentWorkEntry = () => submitViewSeq === _composeViewSeq &&
      submitOwner === (global.SoduWorkAPI?.taskStorageKey?.('ops') || '') &&
      submitAdapter === (global.ComposeRuntime?.value?.() || 'pi') &&
      submitExecution === global.ComposeExecution?.revision?.() && global.ComposeExecution?.value?.() !== 'cloud';
    const routed = await ComposeWorkActions.route({
      text, hasAttachments, attachments: _attachments, pluginMention: _pluginMention,
      bindingContext: { repoId: _workspace.repoId, projectId: _workspace.projectId,
        adapterId: global.ComposeRuntime?.value?.() },
      input, panel: _panel(), model: () => _pickedModel, bridge: submittedBridge,
      prepareSession: async () => {
        await global.ComposeRuntime?.ready?.();
        if (!currentWorkEntry()) return false;
        const ready = await global.ComposeModelPicker?.ready?.();
        if (!currentWorkEntry()) return false;
        if (ready === false) { global.petSay?.('默认模型暂不可用，请选择其他模型'); return false; }
        const selection = global.ComposeModelPicker?.value?.() || { modelName: _pickedModel };
        return { adapterId: submitAdapter, modelName: selection.modelName || '',
          modelLabel: global.ComposeModelPicker?.label?.() || selection.modelName || '',
          reasoningEffort: selection.reasoningEffort || '', thinkingLevel: selection.thinkingLevel || '' };
      },
      isCurrent: currentWorkEntry,
    });
    if (routed.handled) return; // The route owns early clearing and failure recovery.
    const attachmentContext = routed.attachmentContext;
    const intent = _intent ? _intent.current(text) : { mode: 'chat' };
    let accepted = true;
    if (intent.mode === 'schedule') {
      /* Schedule creation does not go through ComposeWorkActions.prepareSession
       * (there is no plugin command), so capture the current runtime/model here
       * before the asynchronous agent catalog request starts. */
      const scheduleSelection = global.ComposeModelPicker?.value?.() || { modelName: _pickedModel };
      const scheduleInput = input?.value;
      accepted = await _createAutomation(text, intent, {
        adapterId: submitAdapter,
        modelName: scheduleSelection.modelName || '',
        repoId: _workspace.repoId || '',
        isCurrent: () => submitViewSeq === _composeViewSeq &&
        submitOwner === (global.SoduWorkAPI?.taskStorageKey?.('ops') || '') && input?.value === scheduleInput &&
        submitAdapter === (global.ComposeRuntime?.value?.() || 'pi') &&
        (!_attachments?.files || (() => { const current = _attachments.files();
          return current.length === submittedIdentities.length && current.every((file, index) => fileIdentity(file) === submittedIdentities[index]); })()) });
      if (accepted && _intent) _intent.reset();
    } else if (intent.mode === 'task') {
      const p = _panel();
      p.dataset.stage = 'chat';
      if (global.NativeChat && typeof NativeChat.prepare === 'function') NativeChat.prepare();
      if (global.ComposeDraft) {
        ComposeDraft.open(text, Object.assign(submittedBridge, { workIntent: intent, attachmentContext }));
      }
    } else {
      accepted = await _enterChat(text, '', {
        inputPreparation,
        ...(intent.mode === 'goal' ? {
        intent: 'goal', goal: intent.goal, acceptance: intent.acceptance,
        } : {}),
      });
      if (accepted && _intent) _intent.reset();
    }
    if (!accepted) return;
    if (intent.mode === 'task' || intent.mode === 'schedule') _attachments?.consumeInputText?.(submittedFiles, { resetExpanded: true });
    _clearComposeDraft();
    if (input) { input.value = ''; input.style.height = ''; }
  }
  async function _createAutomation(text, intent, options) {
    if (typeof _schmCreateAutomation !== 'function') {
      if (typeof petSay === 'function') petSay('自动化模块没加载好，请刷新后重试');
      return false;
    }
    return _schmCreateAutomation(text, intent, options);
  }
  function _openCreatedTaskInCollaboration(taskId, title, accessMode) {
    return ComposeSurface.openCreatedTask(taskId, title, _panel(), accessMode);
  }
  function draftBridge(accessMode) {
    return global.ComposeSurface.taskBridge({
      model: () => _pickedModel,
      accessMode,
      atts: () => _usedAtts.length ? _usedAtts : (_attachments ? _attachments.files() : []),
      clearAtts: () => { _usedAtts = []; if (_attachments) _attachments.clear(); },
      openTask: _openCreatedTaskInCollaboration,
      clearInput: () => {
        const i = document.getElementById('cpInput');
        if (i) i.value = '';
        if (_intent) _intent.reset();
      },
      reset: () => { if (global.ComposeDraft) ComposeDraft.clear(); },
    });
  }
  function openComposePanel(payload) {
    _closeRequirementPicker();
    const p = _panel();
    p.classList.add('show');
    /* Starter recommendations refetch on every open (30s throttle): freshly published admin apps and startup-time not-ready fetches self-heal. */
    try { refreshComposeRecommendations(p); } catch (_) { /* recommendations are an enhancement; failure must not affect the panel */ }
    const q = payload || {};
    const chatOpenSeq = ++_chatOpenSeq;
    const taskSession = q.taskSession === true || q.taskSession === 1 || q.taskSession === '1';
    if (q.newSession && !q.chatId) {
      global.ComposeExecution?.reset();
      _accessConsent?.reset();
      _rememberComposeDraft();
      /*
       * Ownership and directory come only from explicit caller context.
       * New/continued-after-delete conversations use clean payloads; project entries provide
       * project context. Never infer ownership from the previous conversation.
       */
      const sessionOptions = { ...q };
      if (global.SessionMemoryEntry) SessionMemoryEntry.set(q);
      _composeViewSeq += 1;
      _pluginResolveSeq += 1;
      _pluginSelectSeq += 1;
      _pluginResolveBusy = false;
      _pluginSelectError = '';
      _pluginSelectTask = Promise.resolve();
      _requestedCapabilities = Array.isArray(q.capabilities) ? q.capabilities.slice(0, 20) : null;
      if (_requestedCapabilities) void _loadCapabilities(true);
      _entryPluginEditId = typeof q.pluginEditId === "string" ? q.pluginEditId : "";
      _entryContextPrompts = Array.isArray(q.contextPrompts)
        ? q.contextPrompts.map((item) => String(item || '').trim().slice(0, 16000))
          .filter(Boolean).slice(0, 4)
        : [];
      _setupRevision += 1;
      _accessExplicit = false;
      _mode = global.AccessPreferences?.snapshot?.().mode || 'standard';
      _workspace = { ...global.ComposeSurface.newSessionWorkspace(_workspace, sessionOptions),
        repoId: typeof sessionOptions.repoId === 'string' ? sessionOptions.repoId.trim() : '' };
      _usedAtts = [];
      if (_intent && q.prefill) _intent.reset();
      _loadSetup();
      if (global.NativeChat) NativeChat.reset();
      const input = p.querySelector('#cpInput');
      if (input && q.prefill) {
        _clearComposeDraft();
        _restoreComposeDraft();
        input.value = String(q.prefill).slice(0, 50000);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } else _restoreComposeDraft();
      if (Array.isArray(q.initialPlugins) && q.initialPlugins.length && _pluginMention?.restore) {
        _pluginMention.restore(q.initialPlugins);
      }
      if (Array.isArray(q.initialFiles) && q.initialFiles.length) _attachments?.add(q.initialFiles, 'library');
      if (!q.initialPlugins?.length && q.pluginId && _pluginMention && typeof _pluginMention.select === 'function') {
        const selectionSeq = _pluginSelectSeq;
        const selection = Promise.resolve().then(() => {
          if (selectionSeq !== _pluginSelectSeq) return null;
          return _pluginMention.select(String(q.pluginId), () => selectionSeq === _pluginSelectSeq, { keepText: true });
        }).then((item) => selectionSeq === _pluginSelectSeq ? item : null);
        _pluginSelectTask = selection.catch(function (error) {
          if (selectionSeq !== _pluginSelectSeq) return null;
          _pluginSelectError = String(error && error.message || '插件没有选中，请重试');
          if (typeof petSay === 'function') petSay(_pluginSelectError);
          return null;
        });
      }
    }
    if (global.NativeChat && typeof NativeChat.refreshHistory === 'function') NativeChat.refreshHistory();
    if (q.fileOpen?.file && global.NativeChat) {
      p.dataset.stage = 'chat'; setTab();
      const accessMode = global.AccessPreferences?.snapshot?.().mode === 'readonly' ? 'readonly' : 'standard';
      return NativeChat.enter('', '', {
        cwd: q.fileOpen.cwd || '', workspaceLabel: q.fileOpen.workspaceLabel || (q.fileOpen.cwd ? '文件所在位置' : '临时工作区'),
        adapterId: global.ComposeRuntime?.value?.() || 'pi',
        mode: accessMode === 'readonly' ? 'readonly' : 'full', accessMode,
        inputFiles: [q.fileOpen.file], previewInput: q.fileOpen.preview ? q.fileOpen.file : null,
        inputTitle: q.fileOpen.title,
      });
    }
    if (q.chatId) {
      _rememberComposeDraft();
      p.dataset.stage = 'chat';
      setTab();
      return Promise.resolve(_enterChat('', String(q.chatId), {
        taskSession, chatTitle: q.chatTitle || '', projectId: q.projectId || '', repoId: q.repoId || '',
        sidebarProjectId: q.sidebarProjectId || '', sidebarProjectName: q.sidebarProjectName || '',
        queueMode: q.queueMode || '', task: q.task || null,
      })).then((opened) => {
        if (chatOpenSeq !== _chatOpenSeq) return false;
        if (!opened) return false;
        if (q.taskId && taskSession && global.NativeChat && typeof NativeChat.openTask === 'function') {
          return Promise.resolve(NativeChat.openTask(
            q.taskId, q.taskTitle || "当前协作需求",
            { source: q.source || 'task-open', chatId: q.chatId || '',
          navigation: q.navigation === true, forceNew: Boolean(q.forceNew), reuseCurrent: Boolean(q.reuseCurrent),
          reuseExecutionSession: q.reuseExecutionSession === true,
          acceptanceSession: q.acceptanceSession === true,
          acceptanceExecutionSession: q.acceptanceExecutionSession === true,
          acceptanceAttachmentIds: Array.isArray(q.acceptanceAttachmentIds) ? q.acceptanceAttachmentIds.slice() : [],
          acceptanceMode: q.acceptanceMode, approvalId: q.approvalId || '', reworkSession: q.reworkSession === true,
            projectId: q.projectId || '', repoId: q.repoId || '',
            queueMode: q.queueMode || '', task: q.task || null },
          ));
        }
        return true;
      }).then(async (ok) => {
        if (chatOpenSeq !== _chatOpenSeq) return false;
        if (ok && q.focusApproval && global.NativeChat?.focusApproval) {
          const focused = await NativeChat.focusApproval(q.taskId, q.approvalId);
          if (!focused && typeof petSay === 'function') petSay('该确认已处理或状态已变化，请查看当前需求记录');
        }
        if (!ok && taskSession && typeof petSay === 'function') petSay("这项需求的协作会话暂时不可用，请重试");
        return Boolean(ok);
      }).catch((error) => {
        if (chatOpenSeq !== _chatOpenSeq) return false;
        if (typeof petSay === 'function') petSay((taskSession ? '打开需求失败：' : '打开对话失败：') + String((error && error.message) || error));
        return false;
      });
    }
    const taskSources = new Set(['task-create', 'task-list', 'incoming-task', 'task-open', 'task-retry', 'task-add']);
    if (q.taskId && (taskSession || taskSources.has(String(q.source || '')))) {
      if (chatOpenSeq !== _chatOpenSeq) return false;
      _accessConsent?.reset();
      p.dataset.stage = 'chat';
      setTab();
      if (!global.NativeChat || typeof NativeChat.openTask !== 'function') {
        if (typeof petSay === 'function') petSay('\u4efb\u52a1\u4f1a\u8bdd\u6a21\u5757\u8fd8\u6ca1\u6709\u52a0\u8f7d\u5b8c\u6210');
        return false;
      }
      return Promise.resolve(NativeChat.openTask(
        q.taskId, q.taskTitle || "当前协作需求",
        { source: q.source || 'task-open', chatId: q.chatId || '',
          navigation: q.navigation === true, forceNew: Boolean(q.forceNew), reuseCurrent: Boolean(q.reuseCurrent),
          reuseExecutionSession: q.reuseExecutionSession === true,
          acceptanceSession: q.acceptanceSession === true,
          acceptanceExecutionSession: q.acceptanceExecutionSession === true,
          acceptanceAttachmentIds: Array.isArray(q.acceptanceAttachmentIds) ? q.acceptanceAttachmentIds.slice() : [],
          acceptanceMode: q.acceptanceMode, approvalId: q.approvalId || '', reworkSession: q.reworkSession === true,
            projectId: q.projectId || '', repoId: q.repoId || '',
            queueMode: q.queueMode || '', task: q.task || null },
      )).then(async (ok) => {
        if (chatOpenSeq !== _chatOpenSeq) return false;
        if (ok && q.focusApproval && global.NativeChat?.focusApproval) {
          const focused = await NativeChat.focusApproval(q.taskId, q.approvalId);
          if (!focused && typeof petSay === 'function') petSay('该确认已处理或状态已变化，请查看当前需求记录');
        }
        if (!ok && typeof petSay === 'function') petSay("这项需求的协作会话暂时不可用，请重试");
        return Boolean(ok);
      }).catch((error) => {
        if (chatOpenSeq !== _chatOpenSeq) return false;
        if (typeof petSay === 'function') petSay('\u6253\u5f00\u4efb\u52a1\u5931\u8d25\uff1a' + String((error && error.message) || error));
        return false;
      });
    }
    if (q.taskMode === 'create' && global.NativeChat && global.WorkEntrySheet) {
      _accessConsent?.reset();
      p.dataset.stage = 'chat';
      NativeChat.prepare();
      setTab();
      return NativeChat.openWorkAction({ id: 'work.requirement.create', text: '' }, {
        source: 'task-list',
        host: () => p.querySelector('.nchat-draft'),
        anchor: () => p.querySelector('#nchatTaskSuggest'),
        proposal: { title: '', note: '', checklist: [], assigneeKind: 'me' },
        bridge: draftBridge(),
      });
    }
    if (global.NativeChat && NativeChat.hasSession()) {
      p.dataset.stage = 'chat';
      setTab();
      return NativeChat.enter('');
    }
    p.dataset.stage = 'compose';
    setTab();
    return true;
  }
  function closeComposePanel() {
    _closeRequirementPicker();
    if (_accessConsent?.busy()) { _accessConsent.reset(); _paintSetup(); }
    _rememberComposeDraft();
    _composeViewSeq += 1;
    _chatOpenSeq += 1;
    _pluginResolveSeq += 1;
    _pluginSelectSeq += 1;
    _pluginResolveBusy = false;
    const p = document.getElementById('composePanel');
    if (p) p.classList.remove('show');
  }
  function newChatSession() {
    _loadCapabilities();
    /* Use the shared new-conversation path with explicit context and an independent default workspace. */
    const payload = global.WorkspaceShell && typeof global.WorkspaceShell.newSessionPayload === 'function'
      ? { ...global.WorkspaceShell.newSessionPayload(), tab: 'chat' }
      : { tab: 'chat', newSession: true };
    return openComposePanel(payload);
  }
  global.addEventListener?.('soduwork-data-scope-changed', () => {
    _closeRequirementPicker();
    _pluginsRequest++; _plugins = [];
    _composeViewSeq += 1; _pluginResolveSeq += 1; _pluginSelectSeq += 1;
    _pluginResolveBusy = false; _pluginSelectError = ''; _pluginSelectTask = Promise.resolve();
    _entryContextPrompts = []; _entryPluginEditId = "";
    _restoreComposeDraft();
    _intent?.reset();
  });
  global.openComposePanel = openComposePanel;
  // Task dispatch can start before the conversation view has ever been opened.
  // Mount its host without navigating, resetting a draft, or opening a session.
  global.prepareComposePanel = _panel;
  global.closeComposePanel = closeComposePanel;
  global.newChatSession = newChatSession;
  global.composeDraftBridge = draftBridge;
  global.openChatPanel = (p) => openComposePanel(Object.assign({ tab: 'chat' }, p || {}));
  global.closeChatPanel = closeComposePanel;
})(window);
