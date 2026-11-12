/* Existing first-message composer surface; state is owned by NativeChat, never copied. */
(function (global) {
  'use strict';
  function _uiText(value) {
    return (typeof window !== 'undefined' && window.SoduWorkI18n &&
      typeof window.SoduWorkI18n.translateText === 'function')
      ? window.SoduWorkI18n.translateText(value) : value;
  }
  function create(ctx) {
  function _composeDraftControls() {
    return { input: document.getElementById('cpInput'), attachments: ctx._attachments,
      plugins: ctx._pluginMention, skills: ctx._skillPicker };
  }
  function _rememberComposeDraft() {
    // Retired starter controls must not recreate a draft already consumed by a chat.
    if (document.getElementById('composePanel')?.dataset?.stage === 'chat') return;
    const controls = _composeDraftControls(), chat = global.NativeChat;
    if (!controls.input || !chat) return;
    if (chat.rememberComposerDraft) chat.rememberComposerDraft('new', controls);
    else chat.rememberDraft?.('new', controls.input.value, controls.skills?.selected() || []);
  }
  function _restoreComposeDraft() {
    const controls = _composeDraftControls(), chat = global.NativeChat;
    if (!controls.input || !chat) return;
    if (chat.restoreComposerDraft) chat.restoreComposerDraft('new', controls);
    else {
      controls.input.value = chat.getDraft?.('new') || '';
      controls.skills?.restore?.(chat.getDraftSkills?.('new') || []);
      controls.input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  function _clearComposeDraft() { global.NativeChat?.clearDraft?.('new'); }
  /* UI strings go through the shared translate-text bridge; Chinese source text is the
     catalog key and falls back verbatim when the bridge or locale pack is missing. */

  function _refreshDisclaimer(root) {
    const node = root?.querySelector?.('.ai-disclaimer [data-i18n]');
    if (!node) return;
    const source = node.getAttribute('data-i18n') || '内容由 AI 生成，请核实重要信息';
    node.textContent = _uiText(source);
  }
  function _bindDisclaimerLocale(root) {
    if (!root || root.dataset.disclaimerLocaleBound === 'true') return;
    const refresh = () => _refreshDisclaimer(root);
    root.dataset.disclaimerLocaleBound = 'true';
    global.addEventListener('soduwork-locale-change', refresh);
    refresh();
  }
  function _upgradeStartComposer(p) {
    const old = p.querySelector('.cp-box');
    if (!old || !global.WorkComposer) return;
    const context =
      `<div class='wc-context' id='cpContext'>` +
        (global.ComposeRuntime ? ComposeRuntime.controls(WorkComposer.icons.ability) : '') +
        WorkComposer.contextButton({ id: 'cpWorkspace', valueId: 'cpWorkspaceName', icon: 'folder',
          label: '工作位置', value: '默认工作区', title: '选择本次会话的工作位置', popup: true }) +
        WorkComposer.contextButton({ id: 'cpPermission', valueId: 'cpPermissionName', icon: 'shield',
          label: '权限', value: '默认权限', title: '设置本次会话的权限', popup: true, chevron: false }) +
        WorkComposer.contextButton({ id: 'cpAbility', valueId: 'cpAbilityName', icon: 'ability',
          label: '能力', value: '检查中', title: '选择本次会话使用的能力', popup: true }) +
        `<div class='wc-popover' id='cpWorkspacePop'><div class='wc-pop-title'>本次会话在哪儿工作</div>` +
          `<button class='wc-pop-row on' data-workspace='temp'>` + WorkComposer.icons.folder +
            `<span><b>默认工作区</b><i>在你设置的 SoduWork 工作根目录下隔离存放</i></span><b class='wc-check'>✓</b></button>` +
          `<button class='wc-pop-row' data-workspace='pick'>` + WorkComposer.icons.folder +
            `<span><b>选择现有文件夹</b><i>让 SoduWork 直接读取和修改这个文件夹</i></span></button></div>` +
        `<div class='wc-popover align-center' id='cpPermissionPop'><div class='wc-pop-title'>本次会话权限</div>` +
          `<div class='cp-permission-state' id='cpPermissionState' hidden><p id='cpPermissionStatus' role='status'></p>` +
            `<button type='button' id='cpPermissionRetry'>重新检查</button></div>` +
          `<button class='wc-pop-row on' data-mode='standard'>` + WorkComposer.icons.shield +
            `<span><b>默认权限</b><i>常规操作自动执行，敏感操作询问</i></span><b class='wc-check'>✓</b></button>` +
          `<button class='wc-pop-row' data-mode='full'>` + WorkComposer.icons.shieldAlert +
            `<span><b>完全访问</b><i>读写文件、运行命令、访问网络</i></span></button>` +
          `<button class='wc-pop-row' data-mode='readonly'>` + WorkComposer.icons.shield +
            `<span><b>只读</b><i>仅分析和读取，不修改文件</i></span></button></div>` +
        `<div class='wc-popover wc-cap-pop align-right' id='cpAbilityPop'><div class='wc-pop-title'>按需启用本次会话能力</div>` +
          `<div class='cp-caplist' id='cpCapList'><span class='cp-capwait'>正在检查这台电脑…</span></div>` +
          `<span class='wc-cap-note' id='cpCapNote'></span></div></div>`;
    const intentTools = global.WorkIntent ? WorkIntent.controls('cp', { goalOnly: true }) : '';
    const intentSurface = global.WorkIntent ? WorkIntent.surface('cp', { goalOnly: true }) : '';
    const composer = WorkComposer.replace(old, {
      className: 'cp-box', inputId: 'cpInput', rows: 3,
      placeholder: '告诉 SoduWork 你想完成什么…',
      beforeInput: '<div class="cp-atts catt-tray" id="cpAtts"></div>',
      afterInput: WorkComposer.syntaxHint() + intentSurface + '<div class="wc-execution-notice" role="status" hidden><span></span><button type="button" data-execution-configure>配置云端电脑</button></div>',
      tools: '<input type="file" id="cpFile" multiple hidden>' + intentTools,
      sendId: 'cpGo', sendClass: 'cp-go', sendTitle: '开始',
      context,
      actions: '<button type="button" class="wc-voice" id="cpMic" title="语音输入" aria-label="语音输入">' +
        WorkComposer.icons.mic + '</button>',
    });
    if (composer && global.ChatSendQueue?.addDock) {
      const dock = document.createElement('div');
      dock.className = 'nqueue-stack is-empty cp-requirement-dock';
      dock.innerHTML = '<div class="nqueue-toolbar"><div></div>' + ChatSendQueue.addDock() + '</div>';
      composer.before(dock);
    }
    /* Composer controls: add, permissions, workspace, model, Agent, voice, and send. */
    const toolbarContext = composer && composer.querySelector('#cpContext');
    const intent = composer && composer.querySelector('.wi-tools');
    const model = old.querySelector('.cp-modelwrap');
    const runtime = composer && composer.querySelector('#cpRuntime');
    const workspace = composer && composer.querySelector('#cpWorkspace');
    const actions = composer && composer.querySelector('.wc-actions');
    const voice = composer && composer.querySelector('#cpMic');
    if (model && actions) actions.insertBefore(model, voice || actions.firstChild);
    if (runtime && actions) {
      const runtimeWrap = document.createElement('span');
      runtimeWrap.className = 'cp-runtimewrap';
      actions.insertBefore(runtimeWrap, voice || null);
      runtimeWrap.appendChild(runtime);
      const runtimePop = composer.querySelector('#cpRuntimePop');
      const runtimeAvailability = composer.querySelector('#cpRuntimeAvailability');
      // The missing-runtime management entry lives in the picker footer. Keep
      // it there instead of pulling it back into the compact composer toolbar.
      if (runtimeAvailability && !runtimePop?.contains(runtimeAvailability)) {
        runtimeWrap.appendChild(runtimeAvailability);
      }
      if (runtimePop) runtimeWrap.appendChild(runtimePop);
    }
    if (toolbarContext && workspace) {
      toolbarContext.classList.add('cp-toolbar-context');
      const more = document.createElement('span');
      more.className = 'cp-more';
      more.innerHTML = '<button type="button" class="cp-more-button" id="cpMore" aria-haspopup="menu" ' +
        'aria-expanded="false" title="添加内容与插件" aria-label="添加内容与插件">' +
        '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>' +
        '<div class="cp-more-pop" id="cpMorePop" role="menu" aria-label="添加业务能力或调整运行设置" hidden></div>';
      composer.querySelector('.wc-tools').appendChild(more);
      composer.querySelector('.wc-tools').insertAdjacentHTML('beforeend', WorkComposer.executionMode('data-execution'));
      const morePop = more.querySelector('#cpMorePop');
      morePop.insertAdjacentHTML('beforeend', '<div class="cp-more-title">添加与设置</div>');
      morePop.insertAdjacentHTML('beforeend', '<button type="button" class="wc-more-row" id="cpMoreFile">' +
        WorkComposer.icons.attach + '<span><b>文件和图片</b><i>选择文件，或直接粘贴到输入框</i></span></button>');
      morePop.insertAdjacentHTML('beforeend', WorkComposer.screenshotRow('cpScreenshot'));
      if (intent) morePop.appendChild(intent);
      const permission = composer.querySelector('#cpPermission');
      const ability = composer.querySelector('#cpAbility');
      const permissionPop = composer.querySelector('#cpPermissionPop');
      const abilityPop = composer.querySelector('#cpAbilityPop');

      if (permission) toolbarContext.insertBefore(permission, workspace);
      if (permissionPop) toolbarContext.appendChild(permissionPop);
      if (ability) morePop.appendChild(ability);
      if (abilityPop) morePop.appendChild(abilityPop);
      morePop.insertAdjacentHTML('beforeend', WorkComposer.pluginSection('cpMorePlugins', 'cpMoreAllPlugins'));
    }
  }

  function _panel() {
    let p = document.getElementById('composePanel');
    if (p) return p;
    p = document.createElement('div');
    p.id = 'composePanel';
    p.className = 'desk-panel compose-panel';
    /* Keep one stable starter input; Enter creates a real conversation and sends its text. */
    p.innerHTML =
      '<div class="cp-body">' +
        '<div class="cp-task" id="cpTask">' +
          '<div class="cp-mid">' +
            '<div class="cp-hero">想让 SoduWork 做什么？</div>' +
            '<div class="cp-hero-note">直接对话；需要持续推进时设为目标，需要协作时创建需求。</div>' +
            '<div class="cp-box">' +
              '<textarea id="cpInput" rows="3" placeholder="告诉 SoduWork 你想完成什么…"></textarea>' +
              '<div class="cp-atts" id="cpAtts"></div>' +
              '<div class="cp-bar">' +
                '<div class="cp-tools">' +
                  '<input type="file" id="cpFile" multiple hidden>' +
                  '<button class="cp-tool" id="cpAtt" title="添加附件">' +
                    '<svg viewBox="0 0 24 24"><path d="M21 12.5l-8.4 8.4a5 5 0 0 1-7.1-7.1l9-9a3.4 3.4 0 0 1 4.8 4.8l-9 9a1.8 1.8 0 0 1-2.5-2.5l8.3-8.3"/></svg>' +
                  '</button>' +
                  '<button class="cp-tool" id="cpMic" title="说话输入">' +
                    '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>' +
                  '</button>' +
                  /*
                   * Reuse the conversation's compact model button/menu rather than a native Windows select
                   * with incompatible styling.
                   */
                  '<div class="cp-modelwrap">' +
                    '<button class="cp-modelbtn" id="cpModelBtn" title="用哪个模型">' +
                      '<svg viewBox="0 0 24 24"><path d="M12 3l1.6 4.6L18 9.2l-4.4 1.6L12 15.4l-1.6-4.6L6 9.2l4.4-1.6z"/>' +
                        '<path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z"/></svg>' +
                      '<span id="cpModelName">选择模型</span>' +
                    '</button>' +
                    '<div class="cp-modelpop" id="cpModelPop"></div>' +
                  '</div>' +
                '</div>' +
                '<div class="cp-bar-right"><span class="cp-tip">回车开始 · Shift+回车换行</span>' +
                  '<button class="cp-go" id="cpGo" title="创建">' +
                  '<svg viewBox="0 0 24 24"><path d="M12 19V6M6.5 11.5 12 6l5.5 5.5"/></svg></button></div>' +
                '</div>' +
              '<div class="cp-capbar"><span class="cp-caplabel">本次会话能力</span>' +
                '<div class="cp-caplist" id="cpCapList"><span class="cp-capwait">正在检查这台电脑…</span></div>' +
                '<span class="cp-capnote" id="cpCapNote"></span></div>' +
            '</div>' +
            '<p class="ai-disclaimer"><span data-i18n="内容由 AI 生成，请核实重要信息">内容由 AI 生成，请核实重要信息</span></p>' +
          '</div>' +
        '</div>' +
        /* NativeChat mounts the conversation content; see panels-chat.js. */
        '<div class="cp-chat" id="cpChat"></div>' +
      '</div>';
    _upgradeStartComposer(p);
    document.body.appendChild(p);
    _bindDisclaimerLocale(p);
    // Fresh empty controls must not overwrite a pending new-conversation draft.
    if (global.NativeChat?.withDraftRestore) NativeChat.withDraftRestore(() => ctx._bind(p));
    else ctx._bind(p);
    return p;
  }
    function _bind(p) {
    const input = p.querySelector('#cpInput');
    // A file or history entry can mount this hidden start composer first.
    // Hydrate it before navigation saves it, so an empty mount cannot erase
    // an existing new-conversation draft.
    input.value = global.NativeChat?.getDraft?.('new') || '';
    input.addEventListener('input', ctx._rememberComposeDraft);
    if (global.WorkIntent) {
      ctx._intent = WorkIntent.mount(p.querySelector('.cp-box'), {
        prefix: 'cp', input, goalOnly: true,
        automationMethods: () => (typeof _schmLoad === 'function' ? _schmLoad() : []),
      });
    }
    if (global.ComposeSkills) {
      ctx._skillPicker = ComposeSkills.create({
        host: p.querySelector('.cp-box'), input,
        onChange: () => ctx._rememberComposeDraft(),
        say: (message) => { if (typeof petSay === 'function') petSay(message); },
      });
      ctx._skillPicker?.restore?.(global.NativeChat?.getDraftSkills?.('new') || []);
    }
    if (global.ChatPluginMention && global.SoduWorkAPI) {
      ctx._pluginMention = ChatPluginMention.create({
        host: p.querySelector('.cp-box'), input,
        formHost: () => p.querySelector('.cp-mid'),
        formAnchor: () => p.querySelector('.cp-box'),
        inputText: () => ctx._attachments?.submissionText?.(input.value) ?? input.value,
        inputContext: () => ({ attachmentNames: ctx._attachments ? ctx._attachments.names() : [] }),
        catalog: () => SoduWorkAPI.pluginCatalog(),
        actions: () => global.PluginUIHost ? PluginUIHost.actions() : [],
        createPlugin: (seed, context) => PluginBuilderEntry.open(seed, context),
        onChange: () => ctx._rememberComposeDraft(),
        say: (message) => { if (typeof petSay === 'function') petSay(message); },
      });
    }
    if (global.ChatMateMention) {
      ChatMateMention.create({
        host: p.querySelector('.cp-box'), input,
        mates: () => SoduWorkAPI.listTeammates(),
        send: (uid, text, outputs) => SoduWorkAPI.sendMateMessage(uid, text, outputs),
        context: () => ({ ref: '', api: (window.soduWorkAPI && (window.soduWorkAPI.conversationSession || window.soduWorkAPI.piSession)) || null, taskIds: [] }),
        progress: () => ({ text: ChatMateMention.progressDraft(null), source: 'empty' }),
        say: (message) => { if (typeof petSay === 'function') petSay(message); },
      });
    }
    input.addEventListener('keydown', (e) => {
      // Modified combinations belong to ShortcutSettings; pickers may consume Enter first.
      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey &&
          !e.isComposing && !e.defaultPrevented) { e.preventDefault(); ctx.makeDraft(); }
    });
    p.querySelector('#cpGo').addEventListener('click', ctx.makeDraft);
    p.querySelector('.cp-requirement-dock [data-queue-action="add"]')?.addEventListener('click', () => {
      void ctx._openRequirementPicker();
    });
    if (global.ConversationAttachments) ctx._attachments = ConversationAttachments.create({
      host: p.querySelector('.cp-box'), input, fileInput: p.querySelector('#cpFile'),
      button: null, tray: p.querySelector('#cpAtts'),
      say: (message) => { if (typeof petSay === 'function') petSay(message); },
      onChange: () => { ctx._pluginMention?.refresh?.(); ctx._rememberComposeDraft(); },
    });
    _restoreComposeDraft();
    p.querySelector('#cpMic').addEventListener('click', (event) => {
      if (global.ComposeVoice) ComposeVoice.toggle(event.currentTarget, input,
        (message) => { if (typeof petSay === 'function') petSay(message); });
    });
    if (global.ComposeModelPicker) {
      ComposeModelPicker.bind({
        api: ctx._setupApi,
        escape: ctx.esc,
        onChange: (selection) => {
          const previousKey = ctx._capabilityKey();
          ctx._pickedModel = String(selection && selection.modelName || '');
          // The model picker also notifies when it repaints a cached
          // catalogue.  Re-probe only when the effective capability key
          // changed; otherwise every paint can start another probe forever.
          if (ctx._capabilityKey() !== previousKey) void ctx._loadCapabilities(true);
        },
      });
    } else {
      ctx._loadModels();
      p.querySelector('#cpModelBtn').addEventListener('click', (e) => {
        e.stopPropagation(); ctx._toggleModelPop();
      });
    }
    ctx._loadCapabilities();
    ctx._loadSetup();
    ctx._bindSetup(p);
    void ctx._loadMorePlugins();
    void _loadComposeRecommendations(p);
    p.querySelector('#cpMore').addEventListener('click', (e) => {
      e.stopPropagation();
      const button = e.currentTarget;
      const pop = p.querySelector('#cpMorePop');
      const show = pop.hidden;
      ctx._closeSetupPops();
      pop.hidden = !show;
      pop.classList.toggle('show', show);
      button.setAttribute('aria-expanded', String(show));
      if (show) { ctx._loadMorePlugins(); WorkComposer.placeMore(button, pop); }
    });
    p.querySelector('#cpMorePop').addEventListener('click', (e) => e.stopPropagation());
    p.querySelector('#cpMoreFile').addEventListener('click', () => {
      ctx._closeMore(); p.querySelector('#cpFile').click();
    });
    WorkComposer.bindScreenshot(p.querySelector('#cpScreenshot'), ctx._closeMore);
    p.querySelector('#cpIntentMenu')?.addEventListener('click', ctx._closeMore);
    p.querySelector('#cpMoreAllPlugins').addEventListener('click', () => {
      ctx._closeMore();
      WorkComposer.openPlugins();
    });
    p.querySelector('#cpMorePlugins').addEventListener('click', async (event) => {
      if (event.target.closest('[data-more-retry]')) return ctx._loadMorePlugins(true);
      const button = event.target.closest('[data-more-plugin]');
      if (!button || button.disabled || !ctx._pluginMention) return;
      const current = ctx.menuSelectionGuard();
      button.disabled = true; button.setAttribute('aria-busy', 'true');
      try {
        await ctx._pluginMention.select(button.dataset.morePlugin, current, { keepText: true });
        if (current()) ctx._closeMore();
      } catch (error) {
        if (current() && typeof petSay === 'function') petSay('插件暂时无法选择，请刷新目录后重试。');
      } finally {
        if (current()) {
          button.disabled = false; button.removeAttribute('aria-busy'); _renderMorePlugins();
        }
      }
    });
    WorkComposer.bindMoreKeyboard(p.querySelector('#cpMore'), p.querySelector('#cpMorePop'), ctx._closeMore);
    p.querySelector('#cpCapList').addEventListener('click', async (e) => {
      const retry = e.target.closest('[data-capability-retry]');
      if (retry) {
        e.stopPropagation();
        ctx._loadCapabilities(true);
        return;
      }
      const button = e.target.closest('[data-capability]');
      if (!button) return;
      e.stopPropagation();
      const id = button.getAttribute('data-capability') || '';
      const changed = await ComposeCapabilities.toggle({
        id, items: ctx._capabilities, selected: ctx._pickedCapabilities,
        grant: global.soduWorkAPI && typeof global.soduWorkAPI.setRunnerCapability === 'function'
          ? global.soduWorkAPI.setRunnerCapability : null,
        say: (message) => { if (typeof petSay === 'function') petSay(message); },
      });
      if (changed) ctx._renderCapabilities();
    });
    document.addEventListener('click', (e) => {
      const pop = document.getElementById('cpModelPop');
      if (pop && pop.classList.contains('show') && !e.target.closest('.cp-modelwrap')) {
        if (global.ComposeModelPicker) ComposeModelPicker.close(); else pop.classList.remove('show');
      }
      if (!e.target.closest('.cp-more')) ctx._closeMore();
      if (!e.target.closest('.wc-context,.cp-runtimewrap,.cp-more')) ctx._closeSetupPops();
    });
  }

function _renderMorePlugins() {
    const list = document.getElementById('cpMorePlugins');
    if (!list) return;
    list.innerHTML = WorkComposer.pluginRows(ctx._plugins, ctx._pluginMention?.selected() || []);
  }

  /* ── Composer-page starter recommendations: input-width, one horizontal row, max 3 ──
     The server only provides placement rows (targetId+sort); display material
     (icon/name/description) derives live from the existing catalog with no copy stored;
     empty state renders nothing at all. Failures stay silent: recommendations are an
     enhancement, not a dependency. */
  let _composeRecsLoadedAt = 0;
  function _composeRecHost(p) {
    const mid = p.querySelector('.cp-mid');
    const box = mid && mid.querySelector('.cp-box');
    if (!mid || !box) return null;
    let host = mid.querySelector('.cp-recs');
    if (!host) {
      host = document.createElement('div');
      host.className = 'cp-recs';
      host.id = 'cpRecs';
      mid.insertBefore(host, box.nextSibling);
    }
    return host;
  }
  async function _loadComposeRecommendations(p, attempt) {
    const host = _composeRecHost(p);
    if (!host) return;
    try {
      const [recs, catalog] = await Promise.all([
        SoduWorkAPI.composeRecommendations(), SoduWorkAPI.pluginCatalog()]);
      _composeRecsLoadedAt = Date.now();
      const byId = {};
      (catalog && catalog.items || []).forEach((item) => {
        if (!item || !item.pluginId) return;
        /* Recommendation slots show apps (same semantics as the apps page "Mine"):
           disabled, unauthorized, or UI-less targets stay out of recommendations. */
        if (item.enabled === false) return;
        if (!item.personal && item.permissions && item.permissions.canUse === false) return;
        const rows = item.ui && Array.isArray(item.ui.contributions) ? item.ui.contributions : [];
        if (!rows.some((row) => row && row.slot === 'workspace.navigation')) return;
        byId[item.pluginId] = item;
      });
      const picks = [];
      const seen = new Set();
      (recs && recs.items || []).forEach((row) => {
        const item = byId[row.targetId];
        if (!item || seen.has(row.targetId)) return;
        seen.add(row.targetId);
        picks.push({ row, item });
      });
      _renderComposeRecs(host, picks.slice(0, 3), p);
    } catch (_) {
      /* When the catalog/recommendations are unavailable, render no slot; right after mount
         the device session may not be ready yet, and giving up silently would miss
         recommendations forever, so retry a few times with backoff. */
      const next = (attempt || 0) + 1;
      if (next <= 3) setTimeout(() => {
        if (host.isConnected && !host.querySelector('.cp-recs-list')) {
          void _loadComposeRecommendations(p, next);
        }
      }, 2000 * next);
    }
  }
  /* Refetch on every panel open (newly published admin apps do not wait for a page reopen). */
  function refreshComposeRecommendations(p) {
    if (Date.now() - _composeRecsLoadedAt < 30000) return;
    void _loadComposeRecommendations(p);
  }
  /* Composer-page recommendation rows: the same row cards as the apps page "Mine"
     (appsx-card), one row per line; click = the apps-page behavior (sync first when not
     installed, then open in a standalone window). */
  function _renderComposeRecs(host, picks, p) {
    host.textContent = '';
    if (!picks.length || !global.SoduWorkApps || !global.PluginUIHost) { host.remove(); return; }
    const module = document.createElement('section');
    module.className = 'cp-recs-module';
    const head = document.createElement('header');
    head.className = 'cp-recs-head';
    const headTitle = document.createElement('b');
    headTitle.textContent = _uiText('推荐');
    head.appendChild(headTitle);
    module.appendChild(head);
    const list = document.createElement('div');
    list.className = 'cp-recs-list';
    picks.forEach(({ item }) => {
      const card = document.createElement('div');
      card.className = 'appsx-card';
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      const iconWrap = document.createElement('span');
      /* Same source as the apps page: use the artwork data-url when present, else the app
         four-grid glyph — never the plugin fallback (skill star), keeping icon semantics consistent. */
      const customIcon = global.SoduWorkPluginIcon && SoduWorkPluginIcon.imageFor ? SoduWorkPluginIcon.imageFor(item) : '';
      iconWrap.className = 'appsx-app-ico' + (customIcon ? ' has-img' : '');
      iconWrap.setAttribute('aria-hidden', 'true');
      /* markup output only comes from SoduWorkPluginIcon's whitelisted data-urls or built-in SVGs. */
      iconWrap.innerHTML = customIcon ? SoduWorkPluginIcon.markup(item) : global.SoduWorkApps.glyph;
      const copy = document.createElement('span');
      copy.className = 'appsx-card-txt';
      const title = document.createElement('b');
      title.textContent = item.name || '';
      const sub = document.createElement('small');
      sub.textContent = item.description || _uiText('打开即用工作界面');
      copy.appendChild(title); copy.appendChild(sub);
      card.appendChild(iconWrap); card.appendChild(copy);
      /* Single visible action per row: a black pill that floats in on hover/focus and
         bubbles to the card's open chain (sync-install first, then a standalone window). */
      const open = document.createElement('span');
      open.className = 'cp-recs-open';
      open.setAttribute('aria-hidden', 'true');
      open.textContent = _uiText('打开即用');
      card.appendChild(open);
      card.addEventListener('click', () => {
        card.classList.add('is-opening');
        card.setAttribute('aria-busy', 'true');
        global.SoduWorkApps.openAppFromItem(item)
          .then(() => { void _loadComposeRecommendations(p, 0); })
          .catch((error) => {
            if (typeof petSay === 'function') petSay('应用没能打开：' + String(error && error.message || error));
          })
          .finally(() => { card.classList.remove('is-opening'); card.removeAttribute('aria-busy'); });
      });
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); card.click(); }
      });
      list.appendChild(card);
    });
    module.appendChild(list);
    host.appendChild(module);
  }
  async function _composeRecInstall(pluginId, item, input) {
    try {
      await SoduWorkAPI.setEnterprisePluginInstalled(pluginId, true, item.versionId || '');
      try { await ctx._pluginMention?.refresh?.(); } catch (_) {}
      try {
        await ctx._pluginMention?.select(pluginId, () => true, { keepText: true });
      } catch (_) { /* selection failure does not affect the install result */ }
      if (typeof petSay === 'function') {
        petSay('已安装「' + (item.name || '应用') + '」，可以直接发起对话。');
      }
      input && input.focus();
    } catch (_) {
      try { if (global.WorkComposer) WorkComposer.openPlugins(); } catch (_e) {}
      if (typeof petSay === 'function') {
        petSay('「' + (item.name || '应用') + '」需要在插件中心完成安装。');
      }
    }
  }

function _paintSetup() {
    if (global.ComposeRuntime) ComposeRuntime.paint(document);
    if (global.ComposeModelPicker) ComposeModelPicker.refresh();
    global.ComposeExecution?.paint();
    const workspaceName = document.getElementById('cpWorkspaceName');
    const workspaceButton = document.getElementById('cpWorkspace');
    const permissionButton = document.getElementById('cpPermission');
    const abilityButton = document.getElementById('cpAbility');
    const permissionName = document.getElementById('cpPermissionName');
    const abilityName = document.getElementById('cpAbilityName');
    if (workspaceName) {
      const sourceSuffix = ctx._workspace.direct && ctx._workspace.workspaceSource === 'last-session' ? '（沿用上一会话）'
        : ctx._workspace.direct && ctx._workspace.workspaceSource === 'recent' ? '（沿用上次选择）' : '';
      workspaceName.textContent = (ctx._workspace.direct ? ctx._workspace.name : '默认工作区') + sourceSuffix;
    }
    if (workspaceButton) {
      const sourceNote = ctx._workspace.direct && ctx._workspace.workspaceSource === 'last-session' ? '沿用上一会话'
        : ctx._workspace.direct && ctx._workspace.workspaceSource === 'recent' ? '沿用上次选择' : '';
      workspaceButton.title = ctx._workspace.direct
        ? '本次会话直接使用：' + ctx._workspace.dir +
          (sourceNote ? '（' + sourceNote + '；点开可改回默认工作区）' : '')
        : '本次会话会在工作根目录的 temp 下创建独立文件夹';
    }
    const accessSupported = Boolean(global.ComposeRuntime?.accessSupported?.());
    const accessState = global.ComposeRuntime?.accessState?.() || 'unsupported';
    if (permissionButton) {
      permissionButton.disabled = false;
      permissionButton.setAttribute('aria-controls', 'cpPermissionPop');
      permissionButton.setAttribute('aria-busy', String(Boolean(ctx._accessConsent?.busy())));
    }
    const status = document.getElementById('cpPermissionStatus');
    const statePanel = document.getElementById('cpPermissionState');
    const retry = document.getElementById('cpPermissionRetry');
    if (statePanel) statePanel.hidden = accessState === 'supported';
    if (status) status.textContent = accessState === 'checking' ? '正在检查权限支持…'
      : accessState === 'unavailable' ? '暂时无法检查此 Agent 的权限，请重新检查。'
        : '当前 Agent 尚不支持切换权限。请更新并重启客户端或执行机，或选择其他 Agent。';
    if (retry) retry.hidden = accessState === 'checking';
    const permissionLabel = accessState === 'checking' ? '检查权限中'
      : !accessSupported ? '兼容权限' : global.WorkComposer
      ? WorkComposer.permissionLabel(ctx._mode) : (ctx._mode === 'readonly' ? '只读' : '协作');
    if (permissionName) permissionName.textContent = permissionLabel;
    const abilityLabel = ComposeCapabilities.summary(ctx._capabilities, ctx._pickedCapabilities, ctx._capLoading);
    if (abilityName) abilityName.textContent = abilityLabel;
    if (permissionButton) {
      permissionButton.title = '权限：' + permissionLabel;
      permissionButton.setAttribute('aria-label', '本次会话权限：' + permissionLabel);
      global.WorkComposer?.permissionAppearance(permissionButton, { selectedMode: accessSupported ? ctx._mode : 'legacy' });
    }
    if (abilityButton) {
      abilityButton.title = '能力：' + abilityLabel;
      abilityButton.setAttribute('aria-busy', String(ctx._capLoading));
      abilityButton.setAttribute('aria-label', '本次会话能力：' + abilityLabel);
    }
    document.querySelectorAll('#cpWorkspacePop [data-workspace]').forEach((row) =>
      row.classList.toggle('on', (row.dataset.workspace === 'pick') === ctx._workspace.direct));
    document.querySelectorAll('#cpPermissionPop [data-mode]').forEach((row) => {
      row.disabled = !accessSupported || Boolean(ctx._accessConsent?.busy());
      row.classList.toggle('on', accessSupported && row.dataset.mode === ctx._mode);
    });
    const permissionPop = document.getElementById('cpPermissionPop');
    if (permissionPop?.classList.contains('show')) WorkComposer.placeMore(permissionButton, permissionPop);
  }
  return { _rememberComposeDraft, _restoreComposeDraft, _clearComposeDraft,
    _upgradeStartComposer, _panel , _bind, _renderMorePlugins, _paintSetup,
    refreshComposeRecommendations };
  }
  // Task upload/dispatch settles before opening a sender-side conversation.
  function taskBridge({ model, accessMode, atts, clearAtts, openTask, clearInput, reset }) {
    let openedTaskId = '';
    const openCreated = (id, title, outcome) => {
      if (outcome && outcome.handedOff) return;
      const key = String(id || '').trim();
      if (!key || openedTaskId === key) return;
      openedTaskId = key;
      // Keep the submitted choice while task persistence/dispatch awaits.
      // Ordinary new-chat consent receipts do not authorize a task session.
      openTask(key, title, accessMode);
    };
    return {
      model, atts, clearAtts, reset,
      onPersisted: (id, title, outcome) => openCreated(id, title, outcome),
      onCreated: (id, title, outcome) => { clearInput(); openCreated(id, title, outcome); },
      onOpen: (id, title, outcome) => openCreated(id, title, outcome),
    };
  }
  function newSessionWorkspace(current, options = {}) {
    const dir = String(options.cwd || '').trim();
    const name = dir
      ? String(options.workspaceLabel || dir.split(/[\\/]/).filter(Boolean).pop() || '所选文件夹')
      : '默认工作区';
    return { ...current, dir, name, direct: Boolean(dir),
      /*
       * Directory provenance is a renderer-only chip, not conversation history. Clear it when an
       * explicit entry omits provenance so current state cannot mislabel another directory.
       */
      workspaceSource: String(options.workspaceSource || '').trim(),
      projectId: String(options.projectId || '').trim(),
      /*
       * Project ownership must be explicit; inheriting current ownership would leak the previous
       * conversation's project into a new one.
       */
      sidebarProjectId: String(options.sidebarProjectId || '').trim(),
      sidebarProjectName: String(options.sidebarProjectName || '').trim() };
  }
  // A draft carries only a main-process consent receipt, never a trusted flag.
  function createAccessConsent({ api, select, paint, say, remember = () => {} }) {
    let draftId = '', consentId = '', pending = null, generation = 0;
    function revoke(id) {
      if (id) Promise.resolve().then(() => api()?.revokeNewChatAccess?.({ draftId: id })).catch(() => {});
    }
    function reset() {
      generation += 1;
      revoke(draftId);
      draftId = ''; consentId = ''; pending = null;
    }
    function choose(mode, adapterId, anchor) {
      if (mode !== 'full') {
        reset(); select(mode); paint();
        return Promise.resolve().then(() => remember(mode)).catch(() => {}).then(() => true);
      }
      if (pending) return pending;
      if (consentId) {
        select(mode); paint();
        return Promise.resolve().then(() => remember(mode)).catch(() => {}).then(() => true);
      }
      const version = ++generation;
      const id = global.crypto?.randomUUID?.() || 'draft-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      draftId = id;
      pending = Promise.resolve().then(async () => {
        const bridge = api();
        if (!bridge?.confirmNewChatAccess) throw Error('请重启客户端后再设置完全访问');
        const result = await bridge.confirmNewChatAccess({ draftId: id, adapterId, anchor });
        if (version !== generation) { revoke(id); return false; }
        if (!result?.ok || !result.consentId) {
          if (!result?.cancelled) say(result?.reason || '完全访问确认失败，请重试');
          return false;
        }
        consentId = result.consentId;
        select('full');
        await remember('full');
        return true;
      }).catch(error => {
        if (version === generation) say(String(error?.message || '完全访问确认失败，请重试'));
        return false;
      }).finally(() => {
        if (version === generation) { pending = null; paint(); }
      });
      paint();
      return pending;
    }
    return { choose, reset, busy: () => Boolean(pending),
      ready: () => pending || Promise.resolve(true),
      options: () => consentId ? { accessDraftId: draftId, accessConsentId: consentId } : {} };
  }
  function renderLegacyModelPicker(_models, _pickedModel, esc, select) {
    const pop = document.getElementById('cpModelPop');
    if (!pop) return;
    const currentModel = _models.find((m) => m.name === _pickedModel);
    const currentLabel = currentModel ? (currentModel.label || currentModel.name) : '选择模型';
    const currentName = document.getElementById('cpModelName');
    if (currentName) currentName.textContent = currentLabel;
    const modelButton = document.getElementById('cpModelBtn');
    if (modelButton) {
      modelButton.dataset.label = '\u6a21\u578b';
      modelButton.title = '模型：' + currentLabel;
      modelButton.setAttribute('aria-label', '本次会话模型：' + currentLabel);
    }
    const rows = _models.map((m) => ({ name: m.name, label: m.label || m.name,
      sub: [m.providerName ? _uiText(m.providerName) : '', m.keyFrom === 'mine' ? _uiText('自己的额度') : ''].filter(Boolean).join(' · ') }));
    pop.innerHTML = rows.map((r) =>
      '<button class="cp-mrow' + (r.name === _pickedModel ? ' on' : '') + '" data-m="' + esc(r.name) + '">' +
        '<span class="cp-mtick"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>' +
        "<span class=\"cp-mtxt\"><b>" + esc(r.label) + '</b>' + (r.sub ? '<i>' + esc(r.sub) + '</i>' : '') + '</span>' +
      '</button>').join('');
    pop.querySelectorAll('[data-m]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      _pickedModel = b.getAttribute('data-m') || '';
      select(_pickedModel);
      const cur = _models.find((m) => m.name === _pickedModel);
      const name = document.getElementById('cpModelName');
      const label = cur ? (cur.label || cur.name) : '选择模型';
      if (name) name.textContent = label;
      const button = document.getElementById('cpModelBtn');
      if (button) {
        button.title = '模型：' + label;
        button.setAttribute('aria-label', '本次会话模型：' + label);
      }
      pop.classList.remove('show');
      renderLegacyModelPicker(_models, _pickedModel, esc, select);
    }));
  }

  function openCreatedTask(taskId, title, panel, accessMode) {
    const id = String(taskId || '').trim();
    if (!id || !global.NativeChat || typeof NativeChat.openTask !== 'function') return Promise.resolve(false);
    const label = String(title || '当前协作需求');
    const p = panel;
    if (p) p.dataset.stage = 'chat';
    if (global.WorkEntrySheet && typeof WorkEntrySheet.close === 'function' &&
        typeof WorkEntrySheet.active === 'function' && WorkEntrySheet.active()) {
      WorkEntrySheet.close(true, true);
    }
    if (NativeChat.hasSession() && typeof NativeChat.bindTask === 'function') {
      NativeChat.bindTask(id, label);
      if (typeof NativeChat.enter === 'function') NativeChat.enter('');
      return Promise.resolve(true);
    }
    // Compatibility contract: NativeChat.openTask(id, label, { source: 'task-create' })
    return Promise.resolve(NativeChat.openTask(id, label, {
      source: 'task-create', reuseCurrent: true,
      ...(['standard', 'readonly', 'full'].includes(accessMode) ? { sessionOptions: { accessMode } } : {}),
    })).then((ok) => {
      if (!ok && typeof petSay === 'function') petSay('需求已创建，但协作会话未建立，可在需求详情里重试');
      return Boolean(ok);
    }).catch((error) => {
      if (typeof petSay === 'function') petSay('需求已创建，但协作会话未建立：' + String((error && error.message) || error));
      return false;
    });
  }

  function requirementPickerHost(panel, anchor) {
    const host = document.createElement('div');
    host.className = 'cp-requirement-picker';
    const position = () => {
      const composer = panel.querySelector('.cp-box').getBoundingClientRect();
      const top = Math.max(8, panel.getBoundingClientRect().top + 8);
      host.style.left = composer.left + 'px'; host.style.top = top + 'px';
      host.style.width = composer.width + 'px';
      host.style.height = Math.max(0, anchor.getBoundingClientRect().top - top - 8) + 'px';
    };
    document.body.appendChild(host); position();
    global.addEventListener('resize', position);
    panel.addEventListener('scroll', position, true);
    const resize = new ResizeObserver(position); resize.observe(panel.querySelector('.cp-box'));
    return { host, destroy() {
      resize.disconnect(); global.removeEventListener('resize', position);
      panel.removeEventListener('scroll', position, true); host.remove();
    } };
  }
  global.ComposeSurface = { openCreatedTask, renderLegacyModelPicker, create, taskBridge, newSessionWorkspace, createAccessConsent, requirementPickerHost };
})(window);
