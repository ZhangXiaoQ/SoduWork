/* Renderer behavior extracted without copying its owner's state. */
(function (global) {
  'use strict';
  const nextMessageWindowSize = current => Math.min(2000, Math.max(80, Number(current) || 80) + 80);
  // Empty and form-only conversations use new-session options; selecting an option does not initialize an Agent.
  function createDraftControls(ctx) {
    let destroyed = false, loaded = false, loading = null, loadGeneration = 0, catalog = [], missing = [], defaultMode = 'standard', error = '';
    let choiceScope = null, preferenceVersion = 0;
    const active = () => !destroyed && !ctx._ref && (!ctx._sessionId || ctx._snap?.workOnly === true);
    const scope = () => ({epoch:ctx._viewEpoch, sessionId:ctx._sessionId});
    const matches = value => active() && value?.epoch === ctx._viewEpoch && value.sessionId === ctx._sessionId;
    const api = () => ctx._api?.() || global.soduWorkAPI?.conversationSession;
    const paint = () => { if (active()) ctx._paintBar?.(); };
    const say = message => { if (active()) global.petSay?.(message); };
    const consent = global.ComposeSurface?.createAccessConsent({api, select: mode => { if (matches(choiceScope)) ctx._sessionOptions.accessMode = mode; }, paint, say});
    const discardStaleChoice = () => { if (choiceScope && !matches(choiceScope)) { consent?.reset(); choiceScope = null; } };
    const off = global.soduWorkAPI?.accessPreferences?.onChange?.(value => {
      if (['standard', 'readonly', 'full'].includes(value?.mode)) { preferenceVersion++; defaultMode = value.mode; paint(); }
    });
    async function load(force = false) {
      if (loading && !force) return loading;
      if (force) { loaded = false; error = ''; loadGeneration++; }
      const generation = loadGeneration;
      const requested = scope(), preferenceAt = preferenceVersion;
      const job = Promise.all([api()?.runtimes?.(force ? { force: true } : undefined), global.soduWorkAPI?.accessPreferences?.get?.()]).then(([runtimes, preference]) => {
        if (generation !== loadGeneration || !matches(requested)) return;
        if (!runtimes?.ok) throw Error(runtimes?.reason || 'Agent 列表暂不可用，请重新打开选择器');
        const declared = Array.isArray(runtimes.runtimes) ? runtimes.runtimes : [];
        // New bridges expose an explicit availableRuntimes list. Older
        // declaration-only responses cannot prove that a Runner is installed,
        // so keep only the resident Pi fallback in the conversation picker.
        catalog = Array.isArray(runtimes.availableRuntimes)
          ? runtimes.availableRuntimes
          : declared.filter(item => item && item.id === 'pi');
        const declaredPi = declared.find(item => item && item.id === 'pi');
        if (declaredPi && !catalog.some(item => item && item.id === 'pi')) catalog = [declaredPi, ...catalog];
        missing = Array.isArray(runtimes.missing) ? runtimes.missing : [];
        loaded = true; error = '';
        if (preferenceAt === preferenceVersion && ['standard', 'readonly', 'full'].includes(preference?.mode)) defaultMode = preference.mode;
      }).catch(reason => { if (generation === loadGeneration && matches(requested)) { error = String(reason.message || reason); loaded = true; } })
        .finally(() => { if (loading === job) loading = null; paint(); });
      loading = job;
      return job;
    }
    const offRuntimes = api()?.onRuntimesChanged?.(() => { void load(true); });
    function state() {
      discardStaleChoice();
      if (!active()) return {};
      if (!loaded && !loading) void load();
      const adapterId = ctx._sessionOptions.adapterId || 'pi', runtime = catalog.find(item => item.id === adapterId);
      const mode = ctx._sessionOptions.accessMode || (ctx._sessionOptions.mode === 'readonly' ? 'readonly' : defaultMode);
      return {draftOnly:true, draftId:ctx._sessionId || 'new:' + ctx._viewEpoch, adapterId, displayName:runtime?.displayName || ctx._sessionOptions.displayName,
        accessPolicy:runtime?.accessControl?.supported && runtime.accessControl.modes?.includes(mode) ? {mode} : null,
        nextAccessPolicy:null, accessControl:runtime?.accessControl || null,
        draftAccessHint:ctx._workCards?.draftSelectionError?.() || error || (!loaded ? '正在读取执行选项…' : ''),
        selection:ctx._snap?.modelSelection || {name:ctx._sessionOptions.modelName || '',
          model:ctx._sessionOptions.modelName ? {id:ctx._sessionOptions.modelName,
            label:ctx._sessionOptions.modelLabel || ctx._sessionOptions.modelName} : null},
        ...(adapterId === 'codex' ? {thinking:{level:ctx._sessionOptions.reasoningEffort || ''}} : {})};
    }
    return {active, state, async runtimes(force = false) { await load(force === true); return {ok:!error, reason:error, runtimes:catalog,
        availableRuntimes:catalog, missing}; },
      selectRuntime(id) {
        const runtime = catalog.find(item => item.id === id);
        if (!active() || !runtime) return {ok:false, reason:'请选择当前可用的 Agent'};
        const mode = ctx._sessionOptions.accessMode;
        if (mode && !runtime.accessControl?.modes?.includes(mode)) return {ok:false, reason:'该 Agent 不支持所选权限，请先调整权限'};
        return {ok:true, adapterId:id, displayName:runtime.displayName, snapshot:{...ctx._snap, adapterId:id,
          displayName:runtime.displayName, modelSelection:null, accessControl:runtime.accessControl}};
      },
      selectModel(name, label) { return active() ? {ok:true, selection:{name, model:{id:name, label:label || name}}}
        : {ok:false, reason:'会话已变化，请重新选择模型'}; },
      selectThinking(level) { return active() && ctx._sessionOptions.adapterId === 'codex'
        ? {ok:true,thinking:{level,enabled:true,supported:true}} : {ok:false,reason:'会话已变化，请重新选择推理强度'}; },
      async chooseAccess(mode, adapterId, anchor) {
        if (!active() || !consent) return false;
        discardStaleChoice();
        const requested = choiceScope = scope(), oldDraft = ctx._sessionOptions.accessDraftId;
        if (mode === 'full' && ctx._sessionOptions.accessMode === 'full' && ctx._sessionOptions.accessConsentId) return true;
        const accepted = await consent.choose(mode, adapterId, anchor);
        if (!accepted || !matches(requested)) return false;
        if (oldDraft) void api()?.revokeNewChatAccess?.({draftId:oldDraft});
        delete ctx._sessionOptions.accessDraftId; delete ctx._sessionOptions.accessConsentId;
        Object.assign(ctx._sessionOptions, consent.options()); paint(); return true;
      },
      async ready() {
        discardStaleChoice();
        if (!active()) return true;
        const requested = scope();
        if (!await (consent?.ready() || true) || !matches(requested)) return false;
        const saved = await (ctx._workCards?.ensureDraftSelectionSaved?.() ?? true);
        return saved && matches(requested);
      },
      destroy() { destroyed = true; consent?.reset(); off?.(); offRuntimes?.(); },
    };
  }
  function create(ctx) {
  function _refreshDisclaimer(root) {
    const node = root?.querySelector?.('.ai-disclaimer [data-i18n]');
    if (!node) return;
    const source = node.getAttribute('data-i18n') || '内容由 AI 生成，请核实重要信息';
    node.textContent = global.SoduWorkI18n?.translateText?.(source) || source;
  }
  function _bindDisclaimerLocale(root) {
    if (!root || root.dataset.disclaimerLocaleBound === 'true') return;
    const refresh = () => _refreshDisclaimer(root);
    root.dataset.disclaimerLocaleBound = 'true';
    global.addEventListener('soduwork-locale-change', refresh);
    refresh();
  }
function _mount() {
    ctx._ensureHlCss();
    // Global keyboard/outside-click behavior of the chain popover binds once; binding failure must not affect the message flow.
    try { global.ChatCrew?.bind(); } catch (error) { /* popover degrades to title */ }
    if (!document.getElementById('cpChat')) global.prepareComposePanel?.();
    const host = document.getElementById('cpChat');
    if (!host) return null;
    let el = host.querySelector('.nchat');
    if (el) { ctx._ensureCollabView(el); _bindDisclaimerLocale(el); return el; }
    host.innerHTML =
      '<div class="nchat">' +
        '<div class="nchat-stage"><div class="nchat-main">' +
        (global.ChatChrome ? ChatChrome.header() : '') +
        '<div class="nchat-content-area">' +
          '<div class="nchat-scroll" id="nchatScroll" tabindex="0">' +
            '<div class="nchat-inner" id="nchatList"></div>' +
            '<div class="nchat-inner nchat-draft">' +
              '<div class="nchat-task-suggest" id="nchatTaskSuggest"></div>' +
              '<div class="cp-draft" id="cpDraft"></div>' +
            '</div>' +
          '</div>' +
          '<div class="nchat-collab-slot" id="nchatCollab"></div>' +
        '</div>' +
        '<div class="nchat-foot"><div class="nchat-footin"><div class="nchat-entry-dock">' +
          '<div class="nchat-queue" id="nchatQueue" aria-live="polite"></div>' +
          '<div class="nbox">' +
            '<textarea id="nchatInput" rows="1" placeholder="接着说…"></textarea>' +
            '<div class="nbar">' +
              '<div class="nbar-left">' +
                '<button type="button" class="nmeta" id="nchatMeta" title="查看上下文用量" aria-label="查看上下文用量"></button>' +
                '<span class="nwd" id="nchatWd" title="工作位置">' +
                  '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8' +
                    'a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><span>…</span></span>' +
                '<button class="nmode" id="nchatMode" title="只读＝只让它看，不许写文件、不许跑命令">' +
                  '<span></span></button>' +
              '</div>' +
              '<button class="nsend" id="nchatSend" title="发送">' +
                '<svg viewBox="0 0 24 24"><path d="M12 19V6M6.5 11.5 12 6l5.5 5.5"/></svg></button>' +
            '</div>' +
          '</div>' +
          '<p class="ai-disclaimer"><span data-i18n="内容由 AI 生成，请核实重要信息">内容由 AI 生成，请核实重要信息</span></p>' +
        '</div></div></div>' +
        '</div></div>' +
      '</div>';
    if (global.WorkComposer) {
      WorkComposer.upgradeChat(host.querySelector('.nbox'), {
        picker: () => ctx._pluginMention,
        scope: () => JSON.stringify([ctx._viewEpoch, ctx._ref, ctx._draftScopeEpoch,
          ctx._draftOwnerScope(), ctx._pluginResolveSeq]),
        state: () => ({ cloudHandoff: ctx._snap?.cloudHandoff,
          goal: ctx._sessionOptions.intent === 'goal' || ctx._sessionOptions.mode === 'goal' }),
        changed: () => ctx._rememberConversationDraft(),
      });
      // WorkComposer owns the single nchatSend action. It changes between
      // send and stop in place, so a running turn never renders two primary
      // actions beside the composer.
    }
    const composer = host.querySelector('.nbox.work-composer');
    const rail = composer && composer.querySelector('#nchatIntentRail');
    const dock = composer && composer.closest('.nchat-entry-dock');
    const shell = dock && dock.parentElement;
    if (rail && shell) {
      shell.classList.add('nchat-compose-shell');
      dock.insertBefore(rail, dock.firstChild);
    }
    el = host.querySelector('.nchat');
    _bindDisclaimerLocale(el);
    ctx._ensureCollabView(el);
    // Binding annotations emits input synchronously; seed the saved draft first.
    el.querySelector('#nchatInput').value = ctx._conversationDraftText();
    if (ctx._withConversationDraftRestore) ctx._withConversationDraftRestore(() => _bind(el));
    else _bind(el);
    return el;
  }

function _openPluginBuilder(seed, context) {
    /*
     * Within an existing conversation, treat the plugin-development helper as this turn's
     * personal plugin. Do not create another WorkspaceHost session and lose context.
     */
    if (ctx._ref && ctx._pluginMention && typeof ctx._pluginMention.select === 'function') {
      const payload = global.PluginBuilderEntry.buildPayload(seed, context);
      const input = document.getElementById('nchatInput');
      if (typeof ctx._pluginMention.clearAction === 'function') ctx._pluginMention.clearAction();
      return Promise.resolve(ctx._pluginMention.select('local:plugin-builder', () => Boolean(ctx._ref)))
        .then((item) => {
          const selected = typeof ctx._pluginMention.selected === 'function'
            ? ctx._pluginMention.selected() : [];
          if (!item || !ctx._ref || !selected.some((row) => row && row.pluginId === 'local:plugin-builder')) return false;
          if (input) {
            input.value = payload.prefill;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.focus();
          }
          return true;
        })
        .catch((error) => {
          if (typeof petSay === 'function') petSay(String(error && error.message || error || '插件开发助手暂不可用'));
          return false;
        });
    }
    return global.PluginBuilderEntry.open(seed, context);
  }

async function _loadChatSkills(force) {
    const picker = ctx._skillPicker;
    const api = global.soduWorkAPI && (global.soduWorkAPI.conversationSession || global.soduWorkAPI.piSession);
    if (!picker) return;
    if (!api || typeof api.capabilities !== 'function') {
      picker.setError('\u5f53\u524d\u5ba2\u6237\u7aef\u6682\u4e0d\u652f\u6301\u56e2\u961f Skill');
      return;
    }
    const seq = ++ctx._skillLoadSeq;
    picker.setLoading(true, '\u6b63\u5728\u52a0\u8f7d\u56e2\u961f Skill\u2026');
    let timer;
    try {
      const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('capability timeout')), 12000);
      });
      const result = await Promise.race([api.capabilities({ force: force === true,
        adapterId: ctx._snap?.adapterId || ctx._sessionOptions.adapterId || '',
        executionLocation: ctx._snap?.cloudHandoff?.phase === 'committed' ? 'cloud' : ctx._sessionOptions.executionLocation,
        modelName: ctx._sessionOptions.modelName || '' }), timeout]);
      if (seq !== ctx._skillLoadSeq) return;
      if (!result || result.ok === false || result.policyOk === false) {
        picker.setError((result && (result.policyReason || result.reason)) || '\u56e2\u961f Skill \u6682\u65f6\u4e0d\u53ef\u7528');
        return;
      }
      const skills = Array.isArray(result && result.skills) ? result.skills.slice() : [];
      // The capability response is authoritative for availability. Render it
      // before asking the network for optional plugin icons, otherwise a slow or
      // offline catalog leaves the palette stuck on its loading spinner.
      picker.setItems(skills);
      if (global.ComposeSkills && typeof ComposeSkills.withPluginIcons === 'function' &&
          global.SoduWorkAPI && typeof SoduWorkAPI.pluginCatalog === 'function') {
        Promise.resolve().then(() => SoduWorkAPI.pluginCatalog()).then((catalog) => {
          if (seq !== ctx._skillLoadSeq) return;
          picker.setItems(ComposeSkills.withPluginIcons(skills, catalog));
        }).catch(() => { /* catalog is optional */ });
      }
    } catch (_) {
      if (seq === ctx._skillLoadSeq) picker.setError('\u56e2\u961f Skill \u6682\u65f6\u4e0d\u53ef\u7528\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

function _canStop() {
    const snap = ctx._snap || {}, execution = snap.execution || {}, phase = execution.quality?.phase || '';
    return snap.status === 'streaming' || execution.running === true ||
      ['executing', 'implementing', 'reviewing', 'repairing'].includes(phase);
  }

/* Build a bounded, output-only context for explicit plugin follow-up references. */
function _pluginConversationContext(ctx) {
  const snapshot = ctx && ctx._snap;
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  const rows = [];
  const clean = value => String(value || '')
    .replace(/<soduwork-internal-[^>]+>[\s\S]*?<\/soduwork-internal-[^>]+>/gi, '')
    .replace(/<soduwork-internal-[^>]+>[\s\S]*/gi, '')
    .replace(/(["']?\b(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret|password|passwd|authorization|private[ _-]?key|token|session(?:[_-]?id)?|cookie(?:s)?|jwt|signing[_-]?key)\b["']?\s*[:=]\s*["']?)([^"'`\s,;}\]]+)/gi, (_match, prefix) => prefix + '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .trim();
  const redact = value => clean(value);
  const textOf = value => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n');
    if (!value || typeof value !== 'object') return '';
    if ((value.kind && value.kind !== 'text') ||
        (value.type && !['text', 'input_text', 'output_text'].includes(value.type))) return '';
    if (typeof value.text === 'string') return value.text;
    if (typeof value.output === 'string') return value.output;
    if (typeof value.result === 'string') return value.result;
    if (Array.isArray(value.content)) return textOf(value.content);
    if (Array.isArray(value.blocks)) return textOf(value.blocks);
    return '';
  };
  const seen = new Set();
  const append = (label, value) => {
    const text = redact(value);
    if (!text || seen.has(text)) return;
    seen.add(text);
    rows.push(label + text);
  };
  messages.forEach(message => {
    if (!message || message.hidden || !['assistant', 'toolResult'].includes(String(message.role || ''))) return;
    append(message.role === 'toolResult' ? 'Previous tool result:\n' : 'Previous assistant result:\n',
      textOf(message.text || message.content || message.blocks));
  });
  (Array.isArray(snapshot?.tools) ? snapshot.tools : []).forEach(tool => {
    if (!tool || !['done', 'error', 'cancelled'].includes(String(tool.state || ''))) return;
    append('Previous tool result:\n', textOf(tool.result || tool.output || tool.content));
  });
  const selected = rows.slice(-6).map(row => row.slice(-2400));
  const priorConversationText = selected.join('\n\n').slice(-12000).trim();
  return priorConversationText ? { priorConversationText } : {};
}

function _bind(el) {
    const input = el.querySelector('#nchatInput');
    if (global.ComposeSkills) {
      ctx._skillPicker = ComposeSkills.create({
        host: el.querySelector('.nbox'), input,
        onChange: names => {
          el.dataset.skillCount = String(names.length);
          ChatTools.paintSendButton(el, ctx._runtimeBusy(), ctx._messageAttachments, ctx._stopState, _canStop(), ctx._sendState);
          ctx._rememberConversationDraft();
        },
        say: (message) => { if (typeof petSay === 'function') petSay(message); },
      });
      void _loadChatSkills(false);
    }
    if (global.ChatPluginMention) {
      ctx._pluginMention = ChatPluginMention.create({
        input, host: el.querySelector('.nbox'),
        formHost: () => el.querySelector('.nchat-draft'),
        formAnchor: () => el.querySelector('#nchatTaskSuggest'),
        inputText: () => ctx._messageAttachments?.submissionText?.(input.value) ?? input.value,
        inputContext: () => ({
          attachmentNames: ctx._messageAttachments ? ctx._messageAttachments.names() : [],
          ..._pluginConversationContext(ctx),
        }),
        catalog: async () => {
          if (!global.SoduWorkAPI || typeof SoduWorkAPI.pluginCatalog !== 'function') throw new Error('Plugin service unavailable');
          return SoduWorkAPI.pluginCatalog();
        },
        actions: () => global.PluginUIHost ? PluginUIHost.actions() : [],
        createPlugin: (seed, context) => _openPluginBuilder(seed, context),
        debugPlugin: item => ctx._openPluginDebug({ pluginId: item.pluginId,
          text: ctx._messageAttachments?.submissionText?.(input.value) ?? input.value }),
        onChange: () => ctx._rememberConversationDraft(),
        say: (message) => { if (typeof petSay === 'function') petSay(message); },
      });
    }
    if (global.ChatMateMention) {
      ctx._mateMention = ChatMateMention.create({
        input, host: el.querySelector('.nbox'),
        mates: () => SoduWorkAPI.listTeammates(),
        send: (uid, text, outputs) => SoduWorkAPI.sendMateMessage(uid, text, outputs),
        context: () => ({ ref: ctx._ref, api: ctx._api(), hub: SoduWorkAPI,
          taskIds: [...new Set(((ctx._snap || {}).messages || []).map(m => m.taskId).filter(Boolean))] }),
        progress: files => SoduWorkAPI.draftMateMessage(ChatMateMention.progressContext(ctx._snap, {
          topic: (ctx._sessionOptions.goal || '').trim(), files,
        })),
        say: (message) => { if (typeof petSay === 'function') petSay(message); },
      });
    }
    input.addEventListener('keydown', (e) => {
      // Modified combinations belong to ShortcutSettings; pickers may consume Enter first.
      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey &&
          !e.isComposing && !e.defaultPrevented) {
        e.preventDefault();
        const hasPayload = global.ChatTools?.composerHasPayload
          ? global.ChatTools.composerHasPayload(el, ctx._messageAttachments)
          : Boolean(String(input.value || '').trim());
        if ((ctx._sendState === 'sending' && !_canStop()) || ctx._stopState === 'requested') return;
        if (ctx._stopState === 'timeout' && _canStop()) { ctx._cancel(); return; }
        if (_canStop() && !hasPayload) { ctx._cancel(); return; }
        ctx._send();
      }
    });
    input.addEventListener('input', () => {
      ctx._rememberConversationDraft();
      // CSS caps growth to the viewport and scrolls internally, including restored drafts.
      input.style.height = 'auto';
      ChatTools.paintSendButton(el, ctx._runtimeBusy(), ctx._messageAttachments, ctx._stopState, _canStop(), ctx._sendState);
    });
    el.querySelector('#nchatSend').addEventListener('click', () => {
      if ((ctx._sendState === 'sending' && !_canStop()) || ctx._stopState === 'requested') return;
      if (ctx._stopState === 'timeout' && _canStop()) { ctx._cancel(); return; }
      if (_canStop()) { ctx._cancel(); return; }
      ctx._send();
    });
    const mic = el.querySelector('#nchatMic');
    if (mic) mic.addEventListener('click', _toggleChatMic);
    const draftControls = createDraftControls(ctx);
    if (global.ChatComposerControls) ctx._composerControls = ChatComposerControls.create(el, {
      draft: draftControls,
      state: () => ({ ref: ctx._ref, adapterId: ctx._snap?.adapterId || ctx._sessionOptions.adapterId || 'pi', displayName: ctx._snap?.displayName || ctx._sessionOptions.displayName, model: ctx._model,
        mode: ctx._mode, accessPolicy: ctx._snap?.accessPolicy, nextAccessPolicy: ctx._snap?.nextAccessPolicy, accessControl: ctx._snap?.accessControl || ctx._sessionOptions.accessControl,
        selection: ctx._snap && ctx._snap.modelSelection, thinking: ctx._snap && ctx._snap.thinking,
        taskRuntime: ctx._activeCollabTaskId && !(ctx._sessionOptions.acceptanceSession || ctx._sessionOptions.acceptanceExecutionSession) &&
          global.RequirementSessionContext?.executionRuntime(ctx._collabTasks?.get(ctx._activeCollabTaskId)?.task ||
            (ctx._collaborationTask?.id === ctx._activeCollabTaskId ? ctx._collaborationTask : null),
          ctx._sessionId, ctx._snap?.execution?.taskExecutions),
        cloudHandoff: ctx._snap?.cloudHandoff, busy: ctx._runtimeBusy(), runtimeSwitching: ctx._snap?.runtimeSwitching,
        recoveryRequired: ctx._snap?.execution?.recoveryRequired, recoveryReason: ctx._snap?.statusText, ...draftControls.state() }),
      say: message => { if (typeof petSay === 'function') petSay(message); },
      accessChanged: result => {
        const value = result.snapshot || result;
        if (ctx._snap) ctx._snap = { ...ctx._snap, accessPolicy: value.accessPolicy, nextAccessPolicy: value.nextAccessPolicy || null,
          ...(value.accessControl ? { accessControl: value.accessControl } : {}) };
        ctx._paintBar();
      },
      renderQueue: () => ctx._renderQueue(el),
      updateQueue: ctx._updateQueueOrder,
      runtimeSelected: result => { const draft = draftControls.active();
        if (result.snapshot) ctx._snap = result.snapshot;
        ctx._sessionOptions.adapterId = result.snapshot?.adapterId || result.adapterId;
        ctx._sessionOptions.displayName = result.snapshot?.displayName || result.displayName;
        ctx._sessionOptions.modelName = result.snapshot?.modelSelection?.name || '';
        ctx._sessionOptions.modelLabel = result.snapshot?.modelSelection?.model?.label || ctx._sessionOptions.modelName;
        if (draft) { ctx._sessionOptions.reasoningEffort = ''; ctx._sessionOptions.thinkingLevel = ''; }
        ctx._model = result.snapshot?.modelSelection?.model || null;
        if (draft) void ctx._workCards?.saveDraftSelection?.(); ctx._render(); },
      modelSelected: selection => { const draft = draftControls.active();
        if (draft && ctx._sessionOptions.modelName !== selection.name) {
          ctx._sessionOptions.reasoningEffort = ''; ctx._sessionOptions.thinkingLevel = '';
        }
        if (ctx._snap) ctx._snap.modelSelection = selection;
        ctx._sessionOptions.modelName = selection.name;
        ctx._sessionOptions.modelLabel = selection.model?.label || selection.name;
        if (draft) void ctx._workCards?.saveDraftSelection?.(); ctx._render(); },
      thinkingChanged: thinking => { if (ctx._snap) ctx._snap.thinking = thinking;
        if (draftControls.active()) {
          if (ctx._sessionOptions.adapterId === 'codex') ctx._sessionOptions.reasoningEffort = thinking.level || '';
          else ctx._sessionOptions.thinkingLevel = thinking.level || '';
          void ctx._workCards?.saveDraftSelection?.(); }
        if (ctx._composerControls && typeof ctx._composerControls.render === 'function') ctx._composerControls.render(); },
    });
    el.querySelector('[data-chat-requirement]')?.addEventListener('click', () => { void ctx._openTaskPicker(); });
    el.querySelector('#nchatQueue').addEventListener('click', (event) => {
      const rework = event.target.closest('[data-task-rework]');
      if (rework) { void ctx._collabAction('rework-task', { taskId: rework.getAttribute('data-task-rework') }); return; }
      const receipt = event.target.closest('[data-task-receipt]');
      if (receipt) { ctx._collabAction('open-task', { taskId: receipt.dataset.taskReceipt }); return; }
      const button = event.target.closest('[data-queue-cancel]');
      if (button) { ctx._cancelQueued(button.getAttribute('data-queue-cancel')); return; }
      const action = event.target.closest('[data-queue-action]');
      if (action) void ctx._queueAction(action.dataset.queueAction, action.dataset.queueId || '', action.dataset.taskId || '');
    });
    el.querySelector('#nchatTaskSuggest').addEventListener('click', async (event) => {
      if (event.target.closest('[data-acceptance-plugin-picker]')) {
        if (ctx._pluginMention && typeof ctx._pluginMention.open === 'function') {
          ctx._pluginMention.open();
        } else if (typeof petSay === 'function') {
          petSay('插件选择器暂时不可用，请稍后重试');
        }
        return;
      }
      if (event.target.closest('[data-task-start-cancel]')) {
        ctx._taskStartPrompt = null; ctx._renderTaskStartPrompt(); return;
      }
      const dispatch = event.target.closest('[data-task-start-dispatch]');
      if (dispatch) {
        const select = document.getElementById('nchatTaskAgent');
        const candidate = (ctx._taskStartPrompt && ctx._taskStartPrompt.agents || []).find((row) =>
          String(row && row.id) === String(select && select.value));
        if (candidate) await ctx._startTask(ctx._taskStartPrompt.task, { candidate, retry: ctx._taskStartPrompt.retry });
        return;
      }
      if (event.target.closest('[data-task-start-confirm]')) {
        if (ctx._collaborationTask) await ctx._startTask(ctx._collaborationTask, {fromComposer:true});
        return;
      }
      const choice = event.target.closest('[data-task-start-id]');
      if (choice) {
        const item = (ctx._taskStartPrompt && ctx._taskStartPrompt.tasks || []).find((task) => String(task.id) === choice.getAttribute('data-task-start-id'));
        if (item) {
          ctx._bindCollaborationTask(item.id, item.title);
          ctx._taskStartPrompt = { kind: 'confirm', title: item.title };
          ctx._renderTaskStartPrompt();
        }
        return;
      }
      ctx._proposalAction(event);
    });
    ctx._paintBar();
    if (global.ChatChrome) ChatChrome.bind(el, () => ({ ref: ctx._ref, snapshot: ctx._snap }));
    if (global.LibraryTransfer?.bindSession) global.LibraryTransfer.bindSession(() => ({
      ref: ctx._ref, sessionId: ctx._sessionId,
      conversationTitle: (global.ChatChrome?.sessionTitle || '').trim(),
    }));
    if (global.ConversationAttachments) {
      ctx._messageAttachments = ConversationAttachments.create({
        host: el.querySelector('.nbox'), input, fileInput: el.querySelector('#nchatFile'),
        button: null, tray: el.querySelector('#nchatAtts'),
        librarySource: () => ({ sessionId: ctx._sessionId, conversationTitle: (global.ChatChrome?.sessionTitle || '').trim() }),
        say: (message) => { if (typeof petSay === 'function') petSay(message); },
        onChange: () => {
          ctx._pluginMention?.refresh?.();
          ctx._rememberConversationDraft();
          ChatTools.paintSendButton(el, ctx._runtimeBusy(), ctx._messageAttachments, ctx._stopState, _canStop(), ctx._sendState);
        },
      });
    }
    if (global.ChatWorkbench) ChatWorkbench.bind(el, () => ({
      ref: ctx._ref, cwd: ctx._wd?.dir, intent: ctx._sessionOptions, pending: ctx._pending,
    }));
    if (global.ChatWorkbenchAnnotations) ChatWorkbenchAnnotations.bind(el, {
      scope: () => ctx._sessionId || ctx._ref || 'draft:' + ctx._viewEpoch,
      ref: () => ctx._ref, send: batch => ctx._sendCore(null, { annotationBatch: batch }),
      changed: () => { if (global.ChatWorkbench) ChatWorkbench.syncAnnotations(); },
    });
    el.addEventListener('soduwork-workbench-reference', (event) => {
      const detail = event.detail || {}, value = String(detail.text || '').trim();
      const target = el.querySelector('#nchatInput');
      if (!value || !target) return;
      const current = String(target.value || '').trimEnd();
      target.value = current ? current + '\n' + value : value;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.focus();
      if (typeof petSay === 'function') petSay(detail.kind === 'browser-element'
        ? '网页元素已引用到对话输入框'
        : detail.kind === 'browser' ? '网页已引用到对话输入框' : '文件已引用到对话输入框');
    });
    el.addEventListener('soduwork-workbench-send-annotations', () => {
      if (global.ChatWorkbenchAnnotations) {
        void ChatWorkbenchAnnotations.submit(batch => ctx._sendCore(null, { annotationBatch: batch }));
      }
    });
    el.querySelector('#nchatList').addEventListener('keydown', (e) => {
      if (!e.target.matches('[data-chat-app]') || !['Enter', ' '].includes(e.key)) return;
      e.preventDefault(); e.target.click();
    });
    el.querySelector('#nchatList').addEventListener('click', (e) => {
      const crewAnchor = e.target.closest('[data-crew-run]');
      if (crewAnchor) {
        const taskId = crewAnchor.getAttribute('data-crew-task');
        if (taskId) {
          const entry = ctx._collabEntries().find((row) => row.taskId === taskId);
          global.ChatCrew?.open({ taskId, runId: crewAnchor.getAttribute('data-crew-run'),
            taskTitle: (entry && entry.title) || crewAnchor.getAttribute('data-crew-title') || '',
            anchor: crewAnchor,
            loadTrace: (id) => {
              const live = ctx._collabEntries().find((row) => row.taskId === id);
              if (live && live.trace) return live.trace;
              return SoduWorkAPI.taskTrace(id);
            } });
        }
        return;
      }
      const rework = e.target.closest('[data-task-rework]');
      if (rework) { void ctx._collabAction('rework-task', { taskId: rework.getAttribute('data-task-rework') }); return; }
      const receipt = e.target.closest('[data-task-receipt]');
      if (receipt) { ctx._collabAction('open-task', { taskId: receipt.getAttribute('data-task-receipt') }); return; }
      const detailRetry = e.target.closest('[data-tool-detail-retry]');
      if (detailRetry) { global.ChatToolDetails?.activate(ctx, detailRetry.dataset.toolDetailRetry, true); return; }
      const read = e.target.closest('[data-dks-read]');
      if (read) { global.TaskExecutionStream?.openRead(read, ctx._collabEntries()); return; }
      const taskTool = e.target.closest('[data-dks-tool]');
      if (taskTool) {
        const card = taskTool.closest('.ntool,.nthink');
        const open = taskTool.getAttribute('aria-expanded') !== 'true';
        taskTool.setAttribute('aria-expanded', String(open));
        if (card) {
          card.classList.toggle('open', open);
          if (card.classList.contains('nthink')) card.dataset.dksUserOpen = String(open);
          if (open) global.TaskExecutionStream?.hydrateTool(taskTool, ctx._collabEntries());
        }
        return;
      }
      const attachmentImage = e.target.closest('[data-catt-message-image]');
      if (attachmentImage) {
        if (global.ConversationAttachments && typeof ConversationAttachments.openMessageImage === 'function') {
          ConversationAttachments.openMessageImage(attachmentImage, {
            ref: ctx._ref, api: ctx._api(), say: typeof petSay === 'function' ? petSay : null,
          });
        }
        return;
      }
      const copyMessage = e.target.closest('[data-copy-message]');
      if (copyMessage) {
        const afterBlock = Number(copyMessage.getAttribute('data-copy-after-block') ?? -1);
        const sources = Array.from(copyMessage.closest('.nmsg.ai')?.querySelectorAll('.ntext .nmd') || [])
          .filter(source => afterBlock < 0 || Number(source.closest('.ntext')?.dataset.block) > afterBlock);
        const value = sources.length ? sources.map(source => source.innerText).join('\n\n') : (copyMessage.getAttribute('data-copy-message') || '');
        const html = sources.map(source => source.innerHTML).join('<br><br>');
        copyMessage.disabled = true;
        (async () => {
          let ok = false;
          try {
            if (html && navigator.clipboard?.write && global.ClipboardItem) {
              await navigator.clipboard.write([new ClipboardItem({
                'text/html': new Blob([html], { type: 'text/html' }),
                'text/plain': new Blob([value], { type: 'text/plain' }),
              })]);
              ok = true;
            } else if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); ok = true; }
          } catch (_) {}
          if (!ok) {
            try {
              const area = document.createElement('textarea'); area.value = value; area.setAttribute('readonly', '');
              area.style.cssText = 'position:fixed;opacity:0;pointer-events:none'; document.body.appendChild(area);
              area.select(); ok = document.execCommand('copy'); area.remove();
            } catch (_) {}
          }
          copyMessage.disabled = false;
          copyMessage.classList.toggle('is-copied', ok);
          copyMessage.setAttribute('aria-label', ok ? '已复制' : '复制失败');
          copyMessage.title = ok ? '已复制' : '复制失败';
          if (ok) setTimeout(() => { if (copyMessage.isConnected) { copyMessage.classList.remove('is-copied'); copyMessage.title = '\u590d\u5236\u5185\u5bb9'; copyMessage.setAttribute('aria-label', copyMessage.title); } }, 1200);
          if (!ok && typeof petSay === 'function') petSay('暂时没能复制，请选中文字后按 Ctrl+C');
        })();
        return;
      }
      const older = e.target.closest('[data-load-older]');
      if (older) {
        if (ctx._loadingOlder || !ctx._ref) return;
        const api = ctx._api(); if (!api || typeof api.snapshot !== 'function') return;
        const scroll = el.querySelector('#nchatScroll'); const height = scroll ? scroll.scrollHeight : 0;
        const top = scroll ? scroll.scrollTop : 0; const requestedRef = ctx._ref;
        // Explicit history reads keep the backend's existing 2000-message limit.
        const nextSize = nextMessageWindowSize(ctx._messageWindowSize);
        if (nextSize <= Number(ctx._messageWindowSize)) {
          older.disabled = true; older.textContent = '已显示最近 2000 条消息'; return;
        }
        ctx._loadingOlder = true; older.disabled = true; older.textContent = '\u6b63\u5728\u52a0\u8f7d\u66f4\u65e9\u8bb0\u5f55\u2026';
        Promise.resolve(api.snapshot(requestedRef, { messageLimit: nextSize, toolLimit: nextSize * 2 })).then((got) => {
          if (requestedRef !== ctx._ref || !got || !got.ok || !got.snapshot) return;
          ctx._messageWindowSize = nextSize; ctx._snap = got.snapshot; ctx._render();
          if (scroll) requestAnimationFrame(() => { scroll.scrollTop = top + scroll.scrollHeight - height; });
        }).catch(() => { if (typeof petSay === 'function') petSay('\u66f4\u65e9\u7684\u5bf9\u8bdd\u6682\u65f6\u52a0\u8f7d\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5'); }).finally(() => { ctx._loadingOlder = false; });
        return;
      }
      const appCard = e.target.closest('[data-chat-app]');
      if (appCard && e.target.closest('.appsx-set')) {
        void global.SoduWorkApps.settingsById(appCard.dataset.chatApp)
          .catch(error => global.petSay?.(String(error.message || error)));
        return;
      }
      if (appCard && e.target.closest('.appsx-fav')) {
        const active = global.SoduWorkApps.toggleFavoriteApp(appCard.dataset.chatApp);
        el.querySelectorAll('[data-chat-app]').forEach(card => {
          if (card.dataset.chatApp !== appCard.dataset.chatApp) return;
          const button = card.querySelector('.appsx-fav');
          button.classList.toggle('is-fav', active); button.setAttribute('aria-pressed', String(active));
          button.title = active ? '取消常用' : '收藏为常用'; button.setAttribute('aria-label', button.title);
        });
        global.SoduWorkApps.render(false);
        return;
      }
      const openApp = e.target.closest('[data-chat-open-app]') || appCard;
      if (openApp) {
        if (openApp.disabled || appCard?.getAttribute('aria-busy') === 'true') return;
        const button = appCard?.querySelector('[data-chat-open-app]') || openApp;
        button.disabled = true; appCard?.setAttribute('aria-busy', 'true');
        void Promise.resolve().then(() => {
          if (!global.SoduWorkApps?.openById) throw Error('应用打开入口暂不可用，请从应用列表打开');
          return global.SoduWorkApps.openById(appCard?.dataset.chatApp || openApp.dataset.chatOpenApp);
        }).catch(error => { global.petSay?.(String(error.message || error)); })
          .finally(() => { if (button.isConnected) button.disabled = false; appCard?.removeAttribute('aria-busy'); });
        return;
      }
      const pluginRetry = e.target.closest('[data-plugin-retry]');
      const pluginNewSession = e.target.closest('[data-plugin-new-session]');
      const sessionRetry = e.target.closest('[data-session-retry]');
      const modelRetry = e.target.closest('[data-model-retry]');
      if (sessionRetry) { sessionRetry.disabled = true; void Promise.resolve(ctx._retryOpenChat?.()).finally(() => {
        if (sessionRetry.isConnected) sessionRetry.disabled = false;
      }); return; }
      if (modelRetry) { void ctx._queueAction('retry-model', modelRetry.dataset.modelRetry); return; }
      if (pluginNewSession) { void ctx._openPluginAuthRecovery(); return; }
      if (pluginRetry) {
        ctx._restoreRetryDraft();
        return;
      }
      const goalAction = e.target.closest('[data-goal-action]');
      if (goalAction) {
        ctx._goalAction(goalAction.getAttribute('data-goal-action'));
        return;
      }
      const link = e.target.closest('.nmd a[href]');
      if (link) {
        e.preventDefault();
        const href = link.getAttribute('href') || '';
        const opened = global.ChatWorkbench && typeof ChatWorkbench.openLink === 'function'
          ? ChatWorkbench.openLink(href) : false;
        if (!opened && /^https?:\/\//i.test(href) && global.soduWorkAPI &&
            typeof global.soduWorkAPI.openExternal === 'function') {
          global.soduWorkAPI.openExternal(href);
        }
        return;
      }
      const deliveryAction = e.target.closest('[data-delivery-reveal],[data-delivery-archive],[data-delivery-retry],[data-delivery-open],[data-delivery-local],[data-cloud-artifact-url]');
      if (deliveryAction) { void global.ChatDeliveries?.handle(deliveryAction, ctx._api()); return; }
      const librarySave = e.target.closest('[data-library-output]');
      const libraryBundle = e.target.closest('[data-library-bundle]');
      if (libraryBundle) { void global.LibraryTransfer?.downloadBundle(libraryBundle); return; }
      if (librarySave) { if (!librarySave.disabled) void global.LibraryTransfer?.saveDecorated(librarySave); return; }
      const preview = e.target.closest('[data-open-app]');
      const pluginDraft = e.target.closest('[data-install-plugin-draft]');
      if (pluginDraft) {
        if (typeof global.openConversationPluginDraft === 'function') {
          void global.openConversationPluginDraft(pluginDraft.dataset.pluginDraftRef,
            pluginDraft.dataset.installPluginDraft, pluginDraft);
        }
        return;
      }
      if (preview) {
        if (global.ChatWorkbench && typeof ChatWorkbench.openOutput === 'function') {
          ChatWorkbench.openOutput(preview.getAttribute('data-open-app'));
        }
        return;
      }
      const summary = e.target.closest('[data-chat-summary-open]');
      if (summary) {
        if (global.ChatChrome && typeof ChatChrome.openSummary === 'function') ChatChrome.openSummary();
        return;
      }
      const output = e.target.closest('[data-open-out]');
      if (output) {
        const api = ctx._api();
        if (api && typeof api.openOutput === 'function') api.openOutput(ctx._ref, output.getAttribute('data-open-out'));
        return;
      }
      const folder = e.target.closest('[data-open-output-folder]');
      if (folder) {
        const api = ctx._api();
        if (api && typeof api.openOutputFolder === 'function') api.openOutputFolder(ctx._ref);
        return;
      }
      const th = e.target.closest('[data-think]');
      if (th) {
        const k = th.getAttribute('data-think');
        const box = th.closest('.nthink');
        const on = box.classList.toggle('open');
        th.setAttribute('aria-expanded', on ? 'true' : 'false');
        if (on) { ctx._openThink.add(k); ctx._closedThink.delete(k); }
        else { ctx._openThink.delete(k); ctx._closedThink.add(k); }
        return;
      }
      if (ChatTools.toggleGroup(e.target, ctx._openToolGroup)) return;
      const tl = e.target.closest('[data-tool]');
      if (tl) {
        const k = tl.getAttribute('data-tool');
        if (global.ChatToolDetails?.activate(ctx, k)) return;
        const box = tl.closest('.ntool');
        /* Open write/edit details in the side pane instead of expanding them inline in the conversation. */
        if (box && box.hasAttribute('data-tool-side') && global.ChatTools && ChatTools.openSide) {
          const tool = (((ctx._snap || {}).tools) || []).find(x => x && String(x.id) === String(k));
          if (tool && (ChatTools.openSide(tool) || ChatTools.render(tool)?.readSnapshot)) return;
        }
        const on = box.classList.toggle('open');
        if (on) ctx._openTool.add(k); else ctx._openTool.delete(k);
        return;
      }
      const ans = e.target.closest('[data-ui-answer]');
      if (ans) ctx._answerUi(ans.getAttribute('data-ui-answer'), ans.getAttribute('data-ui-value') || '', ans);
    });
  }

function _toggleChatMic() {
    const button = document.getElementById('nchatMic');
    const SR = global.SpeechRecognition || global.webkitSpeechRecognition;
    if (!SR) { if (typeof petSay === 'function') petSay('这台机器上没有可用的语音识别'); return; }
    if (ctx._speech) { try { ctx._speech.stop(); } catch (e) {} ctx._speech = null; if (button) button.classList.remove('on'); return; }
    try {
      const rec = new SR();
      const input = document.getElementById('nchatInput');
      const base = input ? input.value : '';
      rec.lang = 'zh-CN'; rec.interimResults = true; rec.continuous = true;
      rec.onresult = (event) => {
        let text = ''; for (let i = 0; i < event.results.length; i += 1) text += event.results[i][0].transcript;
        if (input) { input.value = base + text; input.dispatchEvent(new Event('input', { bubbles: true })); }
      };
      rec.onerror = () => { if (typeof petSay === 'function') petSay('语音识别没有连上，请改用键盘输入'); };
      rec.onend = () => { ctx._speech = null; if (button) button.classList.remove('on'); };
      ctx._speech = rec; rec.start(); if (button) button.classList.add('on');
    } catch (error) { ctx._speech = null; if (button) button.classList.remove('on'); }
  }

  return { _bind, _mount, _loadChatSkills, _openPluginBuilder, _toggleChatMic };
  }
  global.ChatComposerBindings = { create, createDraftControls, _nextMessageWindowSize: nextMessageWindowSize };
})(window);
