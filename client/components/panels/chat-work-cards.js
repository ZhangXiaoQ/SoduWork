/* Work forms belong to the conversation. Persist structured fields and original attachments, never DOM nodes or callbacks. */
(function (global) {
  'use strict';
  const supported = id => ['work.requirement.create', 'work.task.create', 'work.automation.create'].includes(id);
  const json = value => JSON.parse(JSON.stringify(value));
  const actionId = id => id === 'work.task.create' ? 'work.requirement.create' : id;
  const selectionFields = ['adapterId', 'modelName', 'modelLabel', 'reasoningEffort', 'thinkingLevel'];
  const selectionOf = value => Object.fromEntries(selectionFields.map(name => [name,
    typeof value?.[name] === 'string' ? value[name] : (name === 'adapterId' ? 'pi' : '')]));
  const validSelection = value => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(name => selectionFields.includes(name)) && selectionFields.every(name => typeof value[name] === 'string');
  function create(ctx) {
    const sessions = new Map(), fileBytes = new WeakMap(), draftSelections = new Map();
    let active = null, viewSession = '', reserve = null, scopeEpoch = 0, navigation = 0;
    const scope = () => String(global.SoduWorkAPI?.taskStorageKey?.('ops') || '');
    const key = (owner, sessionId) => owner + '\n' + sessionId;
    const rows = (owner, sessionId) => {
      const name = key(owner, sessionId);
      if (!sessions.has(name)) sessions.set(name, new Map());
      return sessions.get(name);
    };
    const owned = record => record.owner === scope() && record.scopeEpoch === scopeEpoch;
    const current = record => owned(record) && record.sessionId === String(ctx._sessionId || '');
    const tell = message => global.petSay?.(message);
    const isRequirement = record => record.actionId === 'work.requirement.create';
    const isInline = record => isRequirement(record) || (record.actionId==='work.automation.create' && record.seed.source==='web-app');
    const messageOwner = (index) => ctx._snap?.history?.messageIndices?.[index] ??
      ((Number(ctx._snap?.history?.messageStart) || 0) + index);
    function transcriptAnchor() {
      const messages = ctx._snap?.messages || [], last = messages.at(-1);
      return { after: messages.length ? messageOwner(messages.length - 1) : -1,
        messageKey: String(last?.taskOutputKey || ''), at: Date.now() };
    }
    function timeline(messages = [], start = 0) {
      if (!viewSession || viewSession !== String(ctx._sessionId)) return [];
      const positions = [];
      for (const record of rows(scope(), viewSession).values()) {
        if (!isInline(record)) continue;
        const anchor = record.seed?.transcriptAnchor;
        let index = -1;
        if (anchor && Number.isSafeInteger(anchor.after) && anchor.after >= -1) {
          const matched = anchor.messageKey ? messages.findIndex(m => m.taskOutputKey === anchor.messageKey) : -1;
          index = matched >= 0 ? matched + 1 : messages.findIndex((_, i) => messageOwner(i) > anchor.after);
          if (index < 0) index = messages.length;
          // An anchor preceding the loaded native window belongs in older history.
          if (matched < 0 && index === 0 && messageOwner(0) > anchor.after + 1) continue;
        } else {
          const created = Number(record.createdAt) || 0;
          index = created ? messages.findIndex(m => (Number(m.sentAt || m.completedAt) || 0) > created) : 0;
          if (index < 0) index = messages.length;
          if (index === 0 && messageOwner(0) > 0) continue;
        }
        if (index >= start) positions.push({ id: record.id, index });
      }
      return positions;
    }
    function cardHost(record) {
      if (!current(record)) return null;
      const list = ctx._mount?.()?.querySelector('#nchatList');
      return list && [...list.children].find(node => node.dataset.workCardSlot === record.id) || null;
    }
    function hasCreatedTask(taskId, sessionId = ctx._sessionId) {
      if (!taskId || !sessionId || String(sessionId) !== String(ctx._sessionId)) return false;
      return [...rows(scope(), String(sessionId)).values()].some(record => current(record) && isRequirement(record) &&
        record.state?.phase === 'succeeded' && String(record.state.receipt?.id || '') === String(taskId) &&
        !record.state.receipt.gone && (!record.state.ownerScope || record.state.ownerScope === scope()));
    }
    const draftActive = () => !ctx._ref && !!ctx._sessionId && ctx._snap?.workOnly === true;
    function draftRecord(sessionId, selection, revision = 0, dirty = false) {
      const record = {owner:scope(), scopeEpoch, sessionId:String(sessionId), selection:selectionOf(selection),
        revision, dirty, version:0, pending:null, error:''};
      draftSelections.set(key(record.owner, record.sessionId), record); return record;
    }
    function captureSelection() {
      if (!draftActive()) return null;
      const record = draftSelections.get(key(scope(), String(ctx._sessionId))) ||
        draftRecord(ctx._sessionId, ctx._sessionOptions, 0, true);
      const selected = selectionOf(ctx._sessionOptions);
      if (JSON.stringify(selected) !== JSON.stringify(record.selection)) {
        record.selection = selected; record.version++; record.dirty = true;
      }
      return record;
    }
    async function persistSelection(record) {
      if (!owned(record)) return false;
      if (record.pending) {
        await record.pending;
        if (record.pending || (record.dirty && !record.error)) return persistSelection(record);
        return !record.error && !record.dirty && owned(record);
      }
      if (!record.dirty) return !record.error;
      const version = record.version, selection = {...record.selection};
      record.pending = (async () => {
        try {
          const api = ctx._api();
          if (!api?.saveWorkDraftSelection) throw Error('当前客户端无法保存会话模型选择，请重新启动更新后的客户端');
          const result = await api.saveWorkDraftSelection(record.sessionId, {selection, revision:record.revision});
          if (!owned(record)) return;
          if (!result?.ok || !validSelection(result.draftSelection) || !Number.isSafeInteger(result.draftSelectionRevision) ||
              result.draftSelectionRevision <= record.revision)
            throw Object.assign(Error(result?.reason || '会话模型选择没有确认写入'), {code:result?.code});
          record.revision = result.draftSelectionRevision; record.error = ''; record.errorCode = '';
          record.dirty = record.version !== version;
        } catch (error) {
          record.error = String(error?.message || error); record.errorCode = error?.code || ''; record.dirty = true;
          if (current(record)) { tell('会话模型选择尚未保存：' + record.error + '。原选择已保留，请重试发送。'); ctx._paintBar?.(); }
        }
      })();
      await record.pending; record.pending = null;
      if (record.dirty && !record.error) return persistSelection(record);
      return !record.error && !record.dirty && owned(record);
    }
    async function saveDraftSelection() {
      const record = captureSelection();
      if (!record) return true;
      record.error = ''; return persistSelection(record);
    }
    async function ensureDraftSelectionSaved() {
      if (!draftActive()) return true;
      const owner = scope(), epoch = ctx._viewEpoch, authEpoch = scopeEpoch, id = ctx._sessionId;
      const saved = await saveDraftSelection();
      return saved && owner === scope() && epoch === ctx._viewEpoch && authEpoch === scopeEpoch && id === ctx._sessionId;
    }
    const draftSelectionError = () => draftSelections.get(key(scope(), String(ctx._sessionId)))?.error || '';
    function fail(record, error) {
      record.error = String(error?.message || error || '写入会话失败');
      if (owned(record)) tell('工作卡片尚未写入会话：' + record.error + '。请重试保存后再关闭客户端。');
      paint();
    }
    async function fileData(file) {
      if (fileBytes.has(file)) return fileBytes.get(file);
      const pending = (async () => {
        if (typeof file.arrayBuffer !== 'function') throw Error('附件原件尚未准备好，请等待加载完成');
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let start = 0; start < bytes.length; start += 16384) binary += String.fromCharCode(...bytes.subarray(start, start + 16384));
        return {name: file.name, type: file.type || '', lastModified: file.lastModified || 0, data: btoa(binary)};
      })();
      fileBytes.set(file, pending);
      try { return await pending; } catch (error) { fileBytes.delete(file); throw error; }
    }
    function queue(record) {
      record.dirty = true;
      clearTimeout(record.timer);
      // Coalesce disk writes while typing; flush immediately on navigation and submission.
      record.timer = setTimeout(() => { record.timer = null; void persist(record); }, 180);
    }
    async function persist(record) {
      clearTimeout(record.timer); record.timer = null;
      if (!owned(record)) return;
      if (record.pending) {
        await record.pending;
        // A write continuation may start another write; wait until the latest submitted state reaches disk.
        if (record.pending || (record.dirty && !record.error)) return persist(record);
        return;
      }
      if (!record.dirty) return;
      const version = record.version, state = json(record.state || {}), files = record.files.slice();
      const draft = {id: record.id, actionId: record.actionId, prompt: record.prompt,
        seed: json(record.seed), state, closed: Boolean(record.closed), revision: record.revision || 0};
      record.dirty = false;
      record.pending = (async () => {
        try {
          draft.files = await Promise.all(files.map(fileData));
          if (!owned(record)) return;
          const result = await ctx._api().saveWorkCard(record.sessionId, draft);
          if (!owned(record)) return;
          if (!result?.ok) throw Error(result?.reason || '会话存储没有确认写入');
          record.revision = result.card?.revision || record.revision;
          record.createdAt = result.card?.createdAt || record.createdAt;
          record.persistedVersion = version;
          record.error = '';
          if (record.version !== version) record.dirty = true;
        } catch (error) { record.dirty = true; fail(record, error); }
      })();
      await record.pending; record.pending = null;
      if (record.dirty && !record.error) return persist(record);
      paint();
    }
    function update(record, snapshot) {
      if (!snapshot || !owned(record)) return;
      const {files, ...state} = snapshot;
      record.state = json(state);
      if (Array.isArray(files)) record.files = files.slice();
      record.version++; queue(record); paint();
    }
    function capture() {
      captureSelection();
      if (!active || !current(active)) return;
      const controller = active.actionId === 'work.automation.create' ? global.WorkAutomationSheet : global.WorkEntrySheet;
      const snapshot = controller?.capture?.();
      if (snapshot) update(active, snapshot);
    }
    function detach() {
      void saveDraftSelection();
      navigation++;
      capture();
      const previous = active;
      active = null; viewSession = '';
      if (previous) void persist(previous);
    }
    async function restoreRequirement(record) {
      const state = record.state || {}, receipt = state.receipt;
      const epoch = ctx._viewEpoch, nav = navigation;
      const eligible = () => current(record) && epoch === ctx._viewEpoch && nav === navigation &&
        record.actionId === 'work.requirement.create' && state.phase === 'succeeded' && receipt?.id && !receipt.gone &&
        (!state.ownerScope || state.ownerScope === scope()) && !ctx._collabTasks?.has(receipt.id) &&
        !global.ChatCollaborationStore?.isQueueRemoved?.(record.sessionId, receipt.id);
      if (!eligible() || !global.SoduWorkAPI?.getTask) return;
      // A historical success receipt can outlive the requirement or its access.
      // Verify Hub state before changing the active task or native binding.
      let task;
      try { task = await global.SoduWorkAPI.getTask(receipt.id); } catch (_) { return; }
      if (!eligible() || String(task?.id || '') !== String(receipt.id) ||
          task.readOnly || task.canViewExecution === false || task.archivedAt) return;
      const executionChat = String(task.workRouting?.conversationTurn?.conversationId || '');
      if (executionChat && executionChat !== String(ctx._sessionId)) return;
      // Once the runtime fixes its requirement scope, even empty/nonempty
      // changes are incompatible (the native binding API enforces the same).
      const established = ctx._snap?.requirementContext;
      if (established) {
        const context = task.executionContext || task.workRouting?.executionContext || {};
        const projectId = String(task.projectId || '');
        const repoId = String(task.repoId || task.repo?.id || context.repoId || context.repo?.id || '');
        if (projectId !== String(established.projectId || '') || repoId !== String(established.repoId || '')) return;
      }
      const session = {...ctx._sessionOptions, ...ctx.sessionInfo?.(), sessionId:ctx._sessionId,
        model:ctx._workModel?.() || ctx._sessionOptions?.modelName || '', ...ctx._snap?.requirementContext};
      if (global.RequirementSessionContext?.compatibility(task, session)) return;
      // A saved receipt supplies pending work, never an execution request. Live
      // conversations persist via the existing authorized bind API; drafts
      // acquire their native binding only when their first Agent opens.
      ctx._bindCollaborationTask?.(receipt.id, task.title || receipt.title || state.draft?.title || '',
        {persist:Boolean(ctx._ref), taskMeta:task});
    }
    async function restoreRequirements() {
      if (!ctx._sessionId) return;
      await Promise.all([...rows(scope(), String(ctx._sessionId)).values()].map(restoreRequirement));
    }
    function hooks(record, options) {
      const epoch = ctx._viewEpoch, originalBridge = options.bridge || ctx._chatDraftBridge?.() || {};
      const isView = () => current(record) && ctx._viewEpoch === epoch && active === record;
      const bridge = {...originalBridge};
      // Once the creation card belongs to this conversation, successful saving shows a receipt without opening another execution session.
      delete bridge.onPersisted; delete bridge.onCreated;
      // Capture the originating view in callbacks; after navigation, retain the receipt without binding the task to the new conversation.
      for (const name of ['onCreated', 'onPersisted', 'onTaskStored', 'onOpen', 'onOpenDetail', 'clearAtts']) {
        if (typeof bridge[name] === 'function') bridge[name] = (...args) => { if (isView()) return originalBridge[name](...args); };
      }
      const seed = {...record.seed, ...options, bridge, cardId: record.id,
        ...(isRequirement(record) ? { cardHost: () => {
          const host = cardHost(record);
          host?.replaceChildren();
          return host;
        } } : {}),
        onCardState: snapshot => update(record, snapshot),
        onBeforeSubmit: async snapshot => {
          if (!owned(record)) throw Error('账号或服务已变化，请重新打开工作卡片');
          update(record, snapshot);
          const submittingVersion = record.version;
          await persist(record);
          if (!owned(record) || record.error || record.dirty || (record.persistedVersion ?? -1) < submittingVersion) {
            throw Error(record.error || '工作卡片提交状态尚未写入会话，请重试');
          }
        },
        onCardClose: () => {
          if (!owned(record)) return;
          // Closing an inline requirement also clears the action picker. This
          // prevents the next ordinary chat turn from inheriting a stale
          // requirement-creation selection after the card is cancelled.
          ctx._pluginMention?.clearAction?.();
          record.closed = true; record.version++; queue(record);
          if (active === record) active = null;
          paint();
        },
        onCreated: (...args) => {
          if (!isView()) return;
          const restored = restoreRequirement(record);
          options.onCreated?.(...args);
          return restored;
        }};
      if (options.cardRecord) {
        seed.cardState = {...json(record.state), files: record.files.slice()};
        seed.restoreCard = true;
      }
      delete seed.cardRecord;
      return seed;
    }
    async function ensureConversation(title) {
      if (ctx._sessionId) return true;
      if (reserve) return reserve;
      const owner = scope(), epoch = ctx._viewEpoch, authEpoch = scopeEpoch, nav = navigation;
      const api = ctx._api();
      if (!api?.reserveWorkConversation || !api?.saveWorkCard) throw Error('当前客户端尚不支持保存工作卡片，请重新启动更新后的客户端');
      reserve = (async () => {
        const selected = selectionOf(ctx._sessionOptions);
        const result = await api.reserveWorkConversation({title: String(title || '工作记录').slice(0, 100),
          cwd: ctx._sessionOptions?.cwd || undefined, draftSelection:selected});
        if (owner !== scope() || epoch !== ctx._viewEpoch || authEpoch !== scopeEpoch || nav !== navigation) return false;
        if (!result?.ok || !result.sessionId) throw Error(result?.reason || '没有建立会话，内容已保留');
        ctx._sessionId = String(result.sessionId); ctx._draftKey = ctx._sessionId;
        ctx._snap ||= result.snapshot || {status: 'idle', messages: [], tools: [], workOnly: true};
        draftRecord(ctx._sessionId, selected, result.draftSelectionRevision || 0,
          !Number.isSafeInteger(result.draftSelectionRevision));
        if (result.presence?.cwd) ctx._wd = {dir: result.presence.cwd, name: '工作区'};
        global.ChatChrome?.resume(result.title || title); global.ChatChrome?.identify(ctx._sessionId);
        if (ctx._sessionOptions?.sidebarProjectId) global.WorkspaceShell?.fileChatInProject?.(ctx._sessionId,
          ctx._sessionOptions.sidebarProjectId, {id: ctx._sessionId});
        void ctx.refreshHistory?.(); ctx._render?.();
        return true;
      })();
      try { return await reserve; } finally { reserve = null; }
    }
    async function prepare(command, options = {}) {
      if (!supported(command?.id)) return options;
      const openingScope = scope(), openingEpoch = ctx._viewEpoch, authEpoch = scopeEpoch;
      if (!await ensureConversation(command.title || command.text)) return null;
      if (openingScope !== scope() || openingEpoch !== ctx._viewEpoch || authEpoch !== scopeEpoch) return null;
      const owner = scope(), sessionId = String(ctx._sessionId), id = actionId(command.id);
      if (!ctx._api()?.saveWorkCard) throw Error('会话卡片存储不可用，请重新启动客户端');
      if (!options.cardRecord && !options.proposal && !options.restoreCard && String(command.text || '').trim()
        && active && current(active) && active.actionId === id && global.WorkEntrySheet?.active?.()) {
        return hooks(active, options);
      }
      capture();
      if (active) void persist(active);
      let record = options.cardRecord;
      if (!record) {
        const seed = {};
        for (const name of ['source', 'attachmentContext', 'bindingContext', 'proposal', 'saveOnly', 'triageStage', 'projectId', 'visibility']) {
          if (options[name] !== undefined) seed[name] = json(options[name]);
        }
        if (options.conversationContext) {
          const {files, ...context} = options.conversationContext; seed.conversationContext = json(context);
        }
        seed.parseText = command.parseText || command.text || '';
        if (id === 'work.requirement.create' || (id==='work.automation.create' && options.source==='web-app')) seed.transcriptAnchor = transcriptAnchor();
        seed.model = typeof options.model === 'function' ? options.model() : options.model || ctx._workModel?.() || '';
        record = {id: 'card-' + crypto.randomUUID(), owner, scopeEpoch, sessionId, actionId: id, prompt: command.text || '',
          seed, state: {phase: 'loading'}, files: [], closed: false, version: 0, revision: 0};
        rows(owner, sessionId).set(record.id, record);
        queue(record);
      }
      if (record.owner !== owner || record.sessionId !== sessionId) return null;
      active = record; viewSession = sessionId; record.closed = false;
      if (isInline(record)) ctx._render?.();
      paint();
      return hooks(record, options);
    }
    // Direct app requests use the same durable work card as ordinary creation,
    // without sending a second AI turn or requiring a second Save click.
    async function runAutomation(params, authorize) {
      const seed=await prepare({id:'work.automation.create',text:params.text,title:'创建'+(params.context?.appName || '即用')+'的计划'},{source:'web-app'});
      if(!seed)throw Error('创建对话已变化，请重新发起');
      const record=active;
      active=null; paint();
      let creating=false;
      try {
        const result=await global.WorkAutomationDirect.create(params,{authorize,
          onBeforeCreate:async value=>{
            await seed.onBeforeSubmit({phase:'submitting',proposal:value});
            if(!owned(record))throw Error('账号已变化，请重新提交');
            creating=true;paint();
          }});
        update(record,{phase:result.ok?'succeeded':'error',proposal:record.state.proposal,
          receipt:result.schedule || null,createdId:result.schedule?.id || '',
          uncertain:!!result.uncertain,error:result.reason || ''});
        await persist(record);paint();
        return {...result,...(record.error?{historyWarning:record.error}:{})};
      }catch(error){
        update(record,{...record.state,phase:'error',uncertain:creating,error:String(error.message || error)});
        await persist(record);paint();throw error;
      }
    }
    async function activate(record) {
      if (!current(record)) return false;
      if (isRequirement(record) && ctx._mount?.()?.querySelector('#nchatList') && !cardHost(record)) return false;
      capture();
      global.WorkEntrySheet?.close?.(false, true);
      return ctx._openWorkAction({id: record.actionId, text: record.prompt, parseText: record.seed.parseText},
        {...record.seed, cardRecord: record});
    }
    async function restore(sessionId) {
      if (!sessionId || !ctx._api()?.workCards) return null;
      const owner = scope(), epoch = ctx._viewEpoch, authEpoch = scopeEpoch, nav = ++navigation;
      let expired = false, timer;
      const valid = () => !expired && owner === scope() && epoch === ctx._viewEpoch && authEpoch === scopeEpoch && nav === navigation;
      const load = async () => {
        const list = rows(owner, sessionId);
        await Promise.all([...list.values()].map(record => persist(record)));
        if (!valid()) return {stale: true};
        const pendingSelection = draftSelections.get(key(owner, String(sessionId)));
        if (pendingSelection) {
          pendingSelection.error = '';
          if (!await persistSelection(pendingSelection) &&
              !['STALE_DRAFT_SELECTION', 'WORK_CONVERSATION_STARTED'].includes(pendingSelection.errorCode)) {
            return valid() ? {blocked:true, reason:pendingSelection.error || '会话模型选择尚未保存，请重试'} : {stale:true};
          }
        }
        if (!valid()) return {stale: true};
        const readVersion = pendingSelection?.version;
        const result = await ctx._api().workCards(sessionId);
        if (!valid()) return {stale: true};
        if (!result?.ok) {
          const reason = String(result?.reason || '工作卡片暂时无法读取，请重新打开这条会话');
          tell('工作卡片读取失败：' + reason); return {blocked: true, reason};
        }
        if (result.workOnly && !ctx._ref && result.draftSelection != null &&
            (!validSelection(result.draftSelection) || !Number.isSafeInteger(result.draftSelectionRevision) || result.draftSelectionRevision < 0)) {
          return {blocked:true, reason:'会话模型选择格式异常，请重新打开会话后重试'};
        }
        for (const value of result.cards || []) {
          const existing = list.get(value.id);
          if (existing?.dirty || existing?.pending) continue;
          const files = (value.files || []).map(file => new File([Uint8Array.from(atob(file.data), c => c.charCodeAt(0))],
            file.name, {type: file.type, lastModified: file.lastModified}));
          // Preserve object identity so pending submission callbacks update the restored card.
          list.set(value.id, Object.assign(existing || {}, value, {files, owner, scopeEpoch, sessionId, version: existing?.version || 0}));
        }
        const retainedDraft = !ctx._ref && ctx._sessionId === String(sessionId) && ctx._snap?.workOnly === true;
        ctx._sessionId = String(sessionId); ctx._draftKey = ctx._sessionId; viewSession = ctx._sessionId;
        if (result.workOnly && !ctx._ref) {
          const selected = result.draftSelection || (retainedDraft ? ctx._sessionOptions : {});
          const latest = draftSelections.get(key(owner, String(sessionId)));
          // A user can select another model while this same form is being read.
          // Keep that newer choice and its pending write instead of the older reply.
          const record = latest && (latest !== pendingSelection || latest.version !== readVersion) ? latest
            : draftRecord(sessionId, selected, result.draftSelectionRevision || 0, !result.draftSelection);
          Object.assign(ctx._sessionOptions, record.selection);
          ctx._model = record.selection.modelName ? {id:record.selection.modelName,
            label:record.selection.modelLabel || record.selection.modelName} : null;
          ctx._snap = {status: 'idle', messages: [], tools: [], workOnly: true, adapterId:record.selection.adapterId,
            modelSelection:{name:record.selection.modelName, model:ctx._model}};
          global.ChatChrome?.resume(result.presence?.title || ctx._sessionOptions?.chatTitle || '工作记录');
          global.ChatChrome?.identify(sessionId);
          if (result.presence?.cwd) ctx._wd = {dir: result.presence.cwd, name: '工作区'};
          ctx._render?.();
        } else {
          draftSelections.delete(key(owner, String(sessionId)));
          if (result.workOnly === false && retainedDraft) {
            // Another window may already have initialized this archive. Its
            // runtime now owns the selection; pending draft options must neither
            // trigger another draft write nor override the authoritative resume.
            for (const name of selectionFields) delete ctx._sessionOptions[name];
            ctx._model = null; ctx._snap = {...ctx._snap, workOnly:false};
            for (const name of ['adapterId', 'displayName', 'modelSelection', 'thinking']) delete ctx._snap[name];
          }
        }
        ctx._render?.(); paint();
        // Successful requirement receipts are durable conversation content. Older
        // detail navigation marked them closed; still restore those receipts,
        // while keeping deliberately dismissed drafts and automation unchanged.
        if (result.workOnly) await restoreActive();
        return result;
      };
      // Card recovery precedes runtime opening, so the runtime watchdog cannot
      // bound this wait. Fence late replies without cancelling durable writes.
      try {
        return await Promise.race([load(), new Promise(resolve => {
          timer = setTimeout(() => {
            const current = valid();
            expired = true;
            resolve(current ? {blocked: true, reason: '工作卡片暂时无法读取，请重新打开这条会话'} : {stale: true});
          }, ctx.OPEN_TIMEOUT_MS || 30000);
        })]);
      } catch (_) {
        // Normalize rejected reads to the same recoverable archive result as
        // a timeout, while keeping obsolete navigation failures silent.
        return valid() ? {blocked: true, reason: '工作卡片暂时无法读取，请重新打开这条会话'} : {stale: true};
      } finally { clearTimeout(timer); }
    }
    async function restoreActive() {
      const last = [...rows(scope(), String(ctx._sessionId)).values()].filter(record =>
        !(record.actionId==='work.automation.create' && record.seed.source==='web-app') &&
        (!record.closed || (isRequirement(record) && record.state.phase === 'succeeded'))).at(-1);
      if (last) await activate(last);
    }
    function paint() {
      if (!viewSession || viewSession !== String(ctx._sessionId)) return;
      const host = ctx._mount?.()?.querySelector('.nchat-draft');
      if (!host) return;
      let history = host.querySelector('[data-work-card-history]');
      if (!history) { history = document.createElement('section'); history.dataset.workCardHistory = ''; history.className = 'nchat-work-history'; host.prepend(history); }
      history.replaceChildren();
      for (const record of rows(scope(), viewSession).values()) {
        if (record.error) {
          const error = document.createElement('div'); error.className = 'cp-warn'; error.setAttribute('role', 'status');
          error.textContent = '卡片尚未写入会话：' + record.error + ' ';
          const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重试保存';
          retry.onclick = () => { record.error = ''; void persist(record); }; error.appendChild(retry); history.appendChild(error);
        }
        // A requirement is prepared asynchronously. Keep its transcript slot empty
        // until the parsed draft is ready, otherwise the conversation briefly shows
        // an empty card before the form has any meaningful content.
        if (active === record && isRequirement(record) && record.state?.phase === 'loading' &&
            !cardHost(record)?.querySelector('.pui-surface')) continue;
        if (active === record && (!isRequirement(record) || cardHost(record)?.querySelector('.pui-surface'))) continue;
        const destination = isInline(record) ? cardHost(record) : history;
        if (!destination) continue;
        const version = String(record.version || 0) + ':' + String(record.revision || 0);
        if (isInline(record) && destination.dataset.workCardVersion === version &&
            destination.querySelector('.nchat-work-record')) continue;
        if (isInline(record)) destination.replaceChildren();
        destination.dataset.workCardVersion = version;
        const row = document.createElement('article'); row.className = 'cp-card nchat-work-record';
        const prompt = document.createElement('p'); prompt.className = 'nchat-work-prompt';
        prompt.textContent = (record.actionId === 'work.automation.create' ? '【自动化】：' : '【需求】：') + record.prompt;
        const title = document.createElement('strong'); title.textContent = record.state.receipt?.title || record.state.draft?.title || record.state.proposal?.title || record.prompt || '工作记录';
        const status = document.createElement('span');
        status.textContent = record.seed.source==='web-app' && record.state.phase==='loading'?'正在整理计划…':({succeeded:'已创建', submitting:'正在保存', loading:'待完善', error:'需要处理'})[record.state.phase] || '草稿 · 尚未创建';
        const open = document.createElement('button'); open.type = 'button'; open.className = 'cp-ghost';
        open.textContent = record.state.phase === 'succeeded' ? '查看创建结果' : '继续编辑';
        open.onclick = () => { void activate(record).catch(error => tell(error.message)); };
        row.append(prompt, status, title, open); destination.appendChild(row);
      }
      history.hidden = !history.childElementCount;
    }
    async function flush(options = {}) {
      const owner = scope(), authEpoch = scopeEpoch, epoch = ctx._viewEpoch;
      const sessionId = String(options.sessionId || ''), taskId = String(options.taskId || '');
      const valid = () => owner === scope() && authEpoch === scopeEpoch &&
        (!sessionId || epoch === ctx._viewEpoch && sessionId === String(ctx._sessionId));
      const selected = record => owned(record) && (!sessionId || record.sessionId === sessionId);
      const receiptMatches = record => record.state?.phase === 'succeeded' &&
        record.state.receipt?.id === taskId && !record.state.receipt.gone;
      let reason = '';
      captureSelection();
      for (const record of draftSelections.values()) if (selected(record)) {
        record.error = '';
        if (!await persistSelection(record)) reason ||= record.error || '会话模型选择尚未保存，请重试';
      }
      const receipts = [];
      for (const list of sessions.values()) for (const record of list.values()) {
        if (!selected(record) || taskId && !receiptMatches(record)) continue;
        receipts.push(record);
        record.error = ''; await persist(record);
        if (record.error || record.dirty || record.pending) reason ||= record.error || '工作卡片尚未确认写入会话，请重试';
      }
      if (!valid()) return {ok:false, stale:true, reason:'会话已切换，请在目标会话重试'};
      if (taskId && !receipts.some(receiptMatches)) reason ||= '这条需求的创建回执尚未准备好，请重试';
      return reason ? {ok:false, reason} : {ok:true};
    }
    function clearScope() {
      scopeEpoch++; navigation++;
      for (const list of sessions.values()) for (const record of list.values()) clearTimeout(record.timer);
      active = null; viewSession = ''; sessions.clear(); draftSelections.clear();
    }
    return {prepare, restore, restoreActive, restoreRequirements, capture, detach, flush, clearScope, paint, timeline, hasCreatedTask,
      saveDraftSelection, ensureDraftSelectionSaved, draftSelectionError, runAutomation};
  }
  global.ChatWorkCards = {create};
})(window);
