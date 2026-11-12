/* Renderer behavior extracted without copying its owner's state. */
(function (global) {
  'use strict';
  function create(ctx) {
function _awaitBounded(promise, timeoutMs, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(label);
        error.code = 'SODUWORK_OPEN_TIMEOUT';
        reject(error);
      }, timeoutMs);
    });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

async function _ensure(chatId) {
    // Form-only conversations have persistent archives; the first ordinary message continues that session.
    chatId = chatId || ctx._sessionId || undefined;
    if (ctx._ref) {
      if (chatId && String(chatId) !== String(ctx._sessionId)) return false;
      return true;
    }
    const epoch = ctx._viewEpoch;
    if (ctx._openingTask && ctx._openingEpoch === epoch) return ctx._openingTask;
    // Recovery must use this attempt's structured result, never a prior error.
    if (ctx._snap) { delete ctx._snap.sessionOpenCode; delete ctx._snap.sessionNotFound; }
    ctx._busy = true;
    ctx._openingEpoch = epoch;
    const task = (async () => {
      if (ctx._snap?.workOnly && ctx._workCards?.ensureDraftSelectionSaved) {
        // Models can change while plugins or attachments are being prepared.
        // Confirm the latest draft choice immediately before opening its Agent.
        const draftId = ctx._sessionId;
        // A newly created task receipt is normally debounced. Persist it before
        // the main process verifies the draft's first task binding.
        if (ctx._sessionOptions.taskRef) {
          const saved = await ctx._workCards.flush?.({sessionId:draftId, taskId:ctx._sessionOptions.taskRef});
          if (saved?.stale || epoch !== ctx._viewEpoch || draftId !== ctx._sessionId) return false;
          if (saved?.ok === false) {
            ctx._fail('需求回执尚未保存', saved.reason || '工作卡片尚未确认写入会话，请重试');
            return false;
          }
        }
        if (!await ctx._workCards.ensureDraftSelectionSaved() || epoch !== ctx._viewEpoch || draftId !== ctx._sessionId) return false;
      }
      return _ensureOnce(chatId, epoch);
    })();
    ctx._openingTask = task;
    try { return await task; }
    catch (error) {
      /* A native open can reject before it returns a structured {ok:false}
         reply (for example when IPC or a runner adapter fails).  The loading
         skeleton must never be the terminal state in that case.  Keep stale
         opens silent after a navigation, but turn a current failure into the
         same explicit, retryable UI used by structured open errors. */
      if (epoch === ctx._viewEpoch) {
        const reason = String((error && error.message) || error || '');
        if (chatId) {
          const previousSnapshot = ctx._snap || {};
          ctx._snap = { ...previousSnapshot, sessionNotFound: false,
            sessionOpenCode: typeof error?.code === 'string' ? error.code : '',
            execution: previousSnapshot.execution ? { ...previousSnapshot.execution, modelRecovery: null } : previousSnapshot.execution };
        }
        ctx._fail('打不开对话', reason, null, error);
      }
      return false;
    }
    finally {
      if (ctx._openingTask === task) {
        ctx._openingTask = null;
        if (ctx._openingEpoch === epoch) { ctx._busy = false; ctx._openingEpoch = -1; }
      }
    }
  }

async function _ensureOnce(chatId, epoch) {
    const api = ctx._api();
    if (!api) { ctx._fail('这个版本的客户端还没接上本机 AI 内核'); return false; }
    try {
      // Opening validates the selected runtime and permissions in the main
      // process. A separate serial probe delays model/policy preparation and
      // repeats CLI discovery; use the authoritative open result instead.
      const resumeAsOrdinary = ctx._sessionOptions.resumeAsOrdinary === true;
      const openOptions = chatId
        ? { ...ctx._sessionOptions, chatId, requireTaskBinding: !resumeAsOrdinary && Boolean(ctx._sessionOptions.taskRef) }
        : { ...ctx._sessionOptions };
      let openTimedOut = false;
      const openPromise = Promise.resolve().then(() => api.open(openOptions));
      // If the main process eventually finishes after the renderer has shown a
      // timeout, release the late handle instead of leaking a detached runtime.
      openPromise.then((late) => {
        if (!openTimedOut || !late || !late.ok || !late.ref || typeof api.release !== 'function') return;
        Promise.resolve(api.release(late.ref)).catch(() => {});
      }).catch(() => {});
      let got;
      try {
        got = await _awaitBounded(openPromise, !chatId && openOptions.accessMode === 'full' ? 10 * 60 * 1000 : ctx.OPEN_TIMEOUT_MS, '执行底座响应超时');
      } catch (error) {
        openTimedOut = error && error.code === 'SODUWORK_OPEN_TIMEOUT';
        if (openTimedOut) {
          if (epoch === ctx._viewEpoch) {
            if (chatId) {
              const previousSnapshot = ctx._snap || {};
              ctx._snap = { ...previousSnapshot, sessionNotFound: false, sessionOpenCode: 'SODUWORK_OPEN_TIMEOUT',
                execution: previousSnapshot.execution ? { ...previousSnapshot.execution, modelRecovery: null } : previousSnapshot.execution };
            }
            ctx._fail('打开对话超时', '执行底座超过 30 秒没有响应，请重试');
          }
          return false;
        }
        throw error;
      }
      if (epoch !== ctx._viewEpoch) {
        if (got && got.ok && got.ref && typeof api.release === 'function') await api.release(got.ref);
        return false;
      }
      if (!got || !got.ok) {
        const reason = String(got && got.reason || '');
        const missing = Boolean(got && got.notFound === true);
        if (chatId && missing) {
          // A deleted archive must not remain as a clickable stale sidebar row,
          // and its requirement bindings must not hijack the next open attempt.
          if (global.WorkspaceShell && typeof WorkspaceShell.removeChat === 'function') {
            WorkspaceShell.removeChat(chatId);
          }
          if (global.ChatCollaborationStore) {
            const boundTaskId = String(ctx._sessionOptions.taskRef || '').trim();
            if (boundTaskId && typeof ChatCollaborationStore.removeTask === 'function') {
              ChatCollaborationStore.removeTask(chatId, boundTaskId);
            } else if (typeof ChatCollaborationStore.remove === 'function') {
              ChatCollaborationStore.remove(chatId);
            }
          }
        }
        /* A failed archive open is a navigation failure, not a model-turn
         * failure.  Older snapshots may still contain modelRecovery from the
         * last live turn; leaving it in place renders a misleading
         * "恢复这一轮" button which has no runtime ref to act on.  Mark the
         * open failure before _fail() paints so the renderer can expose the
         * explicit session-reopen action instead. */
        if (chatId) {
          const previousSnapshot = ctx._snap || {};
          ctx._snap = { ...previousSnapshot,
            sessionNotFound: Boolean(got && got.notFound === true),
            sessionOpenCode: typeof got?.code === 'string' ? got.code : '',
            execution: previousSnapshot.execution ? { ...previousSnapshot.execution, modelRecovery: null } : previousSnapshot.execution };
        }
        ctx._fail('\u5f00\u4e0d\u4e86\u5bf9\u8bdd', reason, null, got);
        return false;
      }
      const openedRef = String(got.ref || '').trim();
      const openedSessionId = String(got.sessionId || chatId || '').trim();
      if (!openedRef || !openedSessionId) {
        if (openedRef && typeof api.release === 'function') await api.release(openedRef);
        ctx._fail('开不了对话', '执行底座没有返回有效的会话标识');
        return false;
      }
      ctx._ref = openedRef;
      ctx._sessionId = openedSessionId;
      if (ctx._draftKey === 'new' || ctx._draftKey === 'file-input' || !ctx._draftKey) ctx._draftKey = openedSessionId;
      if (!chatId) {
        const draftIds = Array.isArray(ctx._pendingLibraryIds) ? ctx._pendingLibraryIds.slice() : [];
        ctx._pendingLibraryIds = [];
        if (draftIds.length && typeof ctx._associateDraftLibrarySources === 'function') {
          ctx._associateDraftLibrarySources(draftIds);
        }
      }
      /* Associate project-created conversations immediately with that project. */
      if (!chatId && ctx._sessionOptions.sidebarProjectId && global.WorkspaceShell?.fileChatInProject) {
        try {
          WorkspaceShell.fileChatInProject(openedSessionId, String(ctx._sessionOptions.sidebarProjectId),
            { id: openedSessionId });
        } catch (_) { /* Sidebar grouping failure must not invalidate the conversation. */ }
      }
      if (global.ChatWorkbenchAnnotations) ChatWorkbenchAnnotations.render();
      if (global.PluginDebugCard) PluginDebugCard.restore({ ref: ctx._ref });
      // A failed historical task attach can still return persisted task bindings.
      // A user clicking “重新打开会话” asked to continue the transcript as an
      // ordinary chat; do not silently reactivate those bindings on this retry.
      const expectedTaskId = resumeAsOrdinary ? '' : String(ctx._sessionOptions.taskRef || '').trim();
      const serverTaskRows = resumeAsOrdinary ? [] : (Array.isArray(got.taskBindings) ? got.taskBindings :
        (Array.isArray(got.taskIds) ? got.taskIds.map((taskId) => ({ taskId })) :
          (got.taskId ? [{ taskId: got.taskId, title: got.taskTitle }] : [])));
      const serverTaskIds = new Set(serverTaskRows.map((row) =>
        String(row && (row.taskId || row.id) || '').trim()).filter(Boolean));
      if (expectedTaskId && chatId && !serverTaskIds.has(expectedTaskId) && !ctx._sessionOptions.attachTask) {
        if (got.ref && typeof api.release === 'function') await api.release(got.ref);
        const reason = '\u627e\u5230\u7684\u4f1a\u8bdd\u6ca1\u6709\u7ed1\u5b9a\u8fd9\u9879\u4efb\u52a1';
        ctx._taskOpenError = reason;
        // _paintOpening() has already replaced the transcript while an archive
        // is being resumed. Always switch that placeholder to a terminal error;
        // returning here without a snapshot leaves the UI loading forever.
        ctx._fail('\u6253\u5f00\u4e0d\u4e86\u5bf9\u8bdd', reason);
        return false;
      }
      let openedSnapshot = { ...(got.snapshot || {}), ...(got.requirementContext ? {requirementContext: got.requirementContext} : {}) };
      if (chatId && ctx._isEmptyStalledSnapshot(openedSnapshot)) {
        if (got.ref && typeof api.release === 'function') await api.release(got.ref);
        const reason = '\u539f\u534f\u4f5c\u4f1a\u8bdd\u5df2\u5931\u53bb\u54cd\u5e94';
        ctx._taskOpenError = reason;
        // A stale task archive can return an empty running snapshot. Do not
        // leave the opening skeleton mounted after releasing the runtime.
        ctx._fail('\u6253\u5f00\u4e0d\u4e86\u5bf9\u8bdd', reason);
        return false;
      }
      ctx._boundFromServer = expectedTaskId ? serverTaskIds.has(expectedTaskId) : serverTaskIds.size > 0;
      ctx._model = got.model;
      ctx._snap = openedSnapshot;
      global.SoduWorkQuotaNotice?.modelChanged?.(openedSnapshot.modelSelection?.model || got.model,
        got.adapterId || openedSnapshot.adapterId || ctx._sessionOptions.adapterId || 'pi', ctx._mount?.());
      ctx._rememberConversationSnapshot(ctx._sessionId || chatId, ctx._snap);
      if (chatId && String(chatId) !== String(ctx._sessionId || '')) ctx._rememberConversationSnapshot(chatId, ctx._snap);
      if (got.goal) ctx._sessionOptions = { ...ctx._sessionOptions, ...got.goal };
      // Restore the session purpose persisted by the main process rather than reverting acceptance sessions to execution mode.
      ctx._sessionOptions = { ...ctx._sessionOptions, acceptanceSession: Boolean(got.acceptanceSession),
        /*
         * Same-person acceptance temporarily borrows an execution session without persisting it as
         * a dedicated acceptance session. Clear the temporary marker once a fallback session
         * receives persistent acceptance context.
         */
        acceptanceExecutionSession: got.acceptanceSession ? false : ctx._sessionOptions.acceptanceExecutionSession === true,
        acceptanceMode: got.acceptanceSession?.acceptanceMode || ctx._sessionOptions.acceptanceMode || 'manual',
        approvalId: got.acceptanceSession?.approvalId || ctx._sessionOptions.approvalId || '',
        acceptanceAttachmentIds: got.acceptanceSession?.acceptanceAttachmentIds
          ? got.acceptanceSession.acceptanceAttachmentIds.slice()
          : (ctx._sessionOptions.acceptanceExecutionSession ? (ctx._sessionOptions.acceptanceAttachmentIds || []).slice() : []) };
      if (got.snapshot?.cloudHandoff?.phase === 'committed') ctx._sessionOptions = { ...ctx._sessionOptions, intent: '', goal: '' };
      ctx._sessionOptions = { ...ctx._sessionOptions, adapterId: got.adapterId || openedSnapshot.adapterId || ctx._sessionOptions.adapterId || 'pi',
        displayName: got.displayName || openedSnapshot.displayName || '', accessControl: got.accessControl || openedSnapshot.accessControl };
      if (resumeAsOrdinary) {
        // The marker is renderer-only and must never leak into the persisted
        // goal/task session options after the ordinary archive is reopened.
        const ordinaryOptions = { ...ctx._sessionOptions };
        delete ordinaryOptions.resumeAsOrdinary;
        delete ordinaryOptions.taskSession;
        delete ordinaryOptions.taskRef;
        delete ordinaryOptions.taskTitle;
        delete ordinaryOptions.requireTaskBinding;
        ctx._sessionOptions = ordinaryOptions;
      }
      ctx._wd = { dir: got.cwd || '', name: got.workspaceName || ctx._sessionOptions.workspaceLabel || '工作区' };
      ctx._mode = got.mode || ctx._mode;
      ctx._sessionCaps = got.capabilities || ctx._sessionCaps;
      ctx._sessionInputs = got.inputAttachments || ctx._sessionInputs;
      serverTaskRows.forEach((row) => {
        const id = String(row && (row.taskId || row.id) || '').trim();
        if (id) ctx._bindCollaborationTask(id, row.title || row.taskTitle || (id === expectedTaskId ? ctx._sessionOptions.taskTitle : '当前协作需求'), { persist: false });
      });
      const serverActive = resumeAsOrdinary ? '' : String(got.activeTaskId || expectedTaskId || got.taskId || '').trim();
      if (serverActive && ctx._collabTasks.has(serverActive)) ctx._selectCollabTask(serverActive, { keepPicker: true });
      const shouldRestoreCollaboration = !resumeAsOrdinary && Boolean(
        ctx._sessionOptions.taskSession || expectedTaskId || serverTaskIds.size || serverActive,
      );
      if (shouldRestoreCollaboration) ctx._restoreCollaboration(ctx._sessionId, expectedTaskId || serverActive);
      const activeRef = ctx._ref;
      if (global.ChatChrome) {
        if (got.title) ChatChrome.resume(got.title);
        else if (ctx._pending) ChatChrome.begin(ctx._pending);
      }
      if (global.ChatChrome) ChatChrome.identify(got.sessionId);
      if (global.WorkIntent) WorkIntent.showGoal(ctx._mount(), got.goal || ctx._sessionOptions, 'nchat');
      ctx._paintBar();
      const handleEvent = (p, effects) => {
        if (!p || p.ref !== activeRef || activeRef !== ctx._ref || epoch !== ctx._viewEpoch) return;
        if (Array.isArray(p?.events)) {
          const batchEffects = {};
          for (const event of p.events) {
            try { handleEvent({ ...p, ...event, events: undefined }, batchEffects); } catch (_) {}
          }
          if (batchEffects.proposal) ctx._maybeProposal(ctx._snap);
          if (batchEffects.outputs) ctx._pullOuts();
          if (batchEffects.history) ctx.refreshHistory();
          return;
        }
        const eventTaskId = String(p.taskId || p.task_id || (p.scope || {}).taskId || '').trim();
        let eventEntry = eventTaskId ? ctx._collabTasks.get(eventTaskId) : null;
        if (eventTaskId && !eventEntry) {
          ctx._bindCollaborationTask(eventTaskId, p.taskTitle || '当前协作需求', { persist: false });
          eventEntry = ctx._collabTasks.get(eventTaskId);
        }
        const eventController = eventEntry && eventEntry.controller;
        if (eventController && !eventEntry.nativeTurn) {
          eventController.applyEvent(Object.assign({}, p, {
            conversationId: ctx._sessionId, taskId: eventTaskId,
            runId: p.runId || p.run_id || (ctx._snap && ctx._snap.execution &&
              (ctx._snap.execution.runId || ctx._snap.execution.run_id)),
          }));
          const taskState = eventController.snapshot ? eventController.snapshot() : {};
          const taskStatus = ctx._collabStatus(taskState.status || (taskState.execution || {}).status);
          if (eventEntry && ctx._collabTerminal.has(taskStatus)) {
            ctx._setCollabEntryStatus(eventEntry, taskStatus, taskStatus === 'completed' ? 'complete' : 'failed');
          }
        }
        if (!p.snapshot) return;
        if (p.kind === 'media-artifact-error') {
          if (typeof petSay === 'function') {
            petSay('视频已由模型生成，但保存到本机失败：' + String(p.reason || '请稍后重试'));
          }
          if (effects) effects.outputs = true; else ctx._pullOuts();
        }
        if (p.kind === 'error') {
          if (p.snapshot) {
            ctx._snap = p.snapshot;
            ctx._rememberConversationSnapshot(ctx._sessionId, ctx._snap);
          }
          if (eventEntry) ctx._setCollabEntryStatus(eventEntry, 'failed', 'failed');
          const canRestore = p.retrySafe === true || Boolean(global.SoduWorkQuota?.detail(p)) || global.ChatPluginMention &&
            ChatPluginMention.retryableGrantFailure(p);
          const submittedDraft = ctx._submissionDrafts.get(p.submissionId);
          const permanentPluginAuthorization = Boolean(p.pluginAuthorization &&
            ['missing', 'readOnlyConflicts', 'unsupported'].some(key =>
              Array.isArray(p.pluginAuthorization[key]) && p.pluginAuthorization[key].length));
          const retryDraft = canRestore || submittedDraft?.requirement || permanentPluginAuthorization
            ? (submittedDraft || null) : null;
          if (retryDraft?.requirement) {
            retryDraft.requirement.deliveryState = 'failed';
            ctx._retainFailedConversationDraft(ctx._draftKeyForCurrentSession(), retryDraft, p.reason || '需求执行失败');
          }
          if (p.submissionId) ctx._submissionDrafts.delete(p.submissionId);
          ctx._fail('这一轮没跑成', p.reason || '执行底座返回错误', retryDraft, p);
          if (effects) effects.history = true; else ctx.refreshHistory();
          return;
        }
        if (p.submissionId && (p.kind === 'settled' || p.kind === 'turn-queue-cancelled')) {
          ctx._submissionDrafts.delete(p.submissionId);
        }
        const before = ctx._snap;
        const was = ctx._lastStatus;
        ctx._snap = p.snapshot;
        ctx._rememberConversationSnapshot(ctx._sessionId, ctx._snap);
        ctx._lastStatus = ctx._snap && ctx._snap.status;
        if (p.kind === 'settled' || was === 'streaming' && ctx._lastStatus === 'idle') {
          global.ChatDeliveries?.settled(ctx._ref);
          if (ctx._lastStatus === 'idle' && !ctx._snap.execution?.turnQueue?.failure) global.SoduWorkQuotaNotice?.refreshIfBlocked();
        }
        if (ctx._snap.execution && ctx._snap.execution.visible === false) {
          ctx._sessionOptions = { ...ctx._sessionOptions, intent: '', mode: 'chat', goal: '', acceptance: '' };
        }
        ctx._scheduleRender();
        if (effects) effects.proposal = true; else ctx._maybeProposal(ctx._snap);
        if (global.ChatOutputLinks ? ChatOutputLinks.shouldRefresh(p, before) :
            was === 'streaming' && ctx._lastStatus !== 'streaming') {
          if (effects) { effects.outputs = true; effects.history = true; }
          else { ctx._pullOuts(); ctx.refreshHistory(); }
        }
      };
      ctx._off = (api.onEventBatch || api.onEvent)(handleEvent);
      ctx._render();
      if (typeof api.snapshot === 'function') {
        const initialSnapshot = ctx._snap;
        (async () => {
          try {
            const latest = await api.snapshot(activeRef);
            if (epoch !== ctx._viewEpoch || activeRef !== ctx._ref || ctx._snap !== initialSnapshot) return;
            if (latest && latest.ok && latest.snapshot) {
              ctx._snap = latest.snapshot;
              ctx._rememberConversationSnapshot(ctx._sessionId, ctx._snap);
              ctx._render();
            }
          } catch (e) { /* Live events continue; a failed refresh must not hide history. */ }
        })();
      }
      if ((got.capabilityWarnings || []).length && typeof petSay === 'function') {
        petSay(got.capabilityWarnings[0]);
      }
      if ((got.attachmentWarnings || []).length && typeof petSay === 'function') {
        petSay(got.attachmentWarnings[0]);
      }
      ctx._pullOuts();                      // Restore files created earlier in a resumed conversation.
      ctx.refreshHistory();                 // Show newly opened or resumed conversations in the sidebar immediately.
      return true;
    } catch (e) {
      if (epoch === ctx._viewEpoch) ctx._fail('开对话时出错', String((e && e.message) || e), null, e);
      return false;
    }
  }

/* Retry a historical archive after a failed attach.  The archive is still
 * readable, but a stale taskRef/requireTaskBinding from the original entry can
 * block opening the ordinary conversation on the current device.  Retrying as
 * a normal chat keeps the persisted transcript and never dispatches the task;
 * any later task execution still goes through the normal server-side checks. */
async function _retryOpenChat() {
    const chatId = String(ctx._sessionId || '').trim();
    if (!chatId || ctx._ref) return Boolean(ctx._ref);
    if (ctx._openingTask) return Boolean(await ctx._openingTask);
    const previous = ctx._sessionOptions || {};
    // An unreadable archive may still be a work-only draft. Restore its cards
    // and saved selection before deciding whether an Agent needs to open.
    if (ctx._snap?.sessionOpenCode === 'WORK_CARDS_BLOCKED') {
      return Boolean(await ctx.enter('', chatId, { ...previous }));
    }
    const options = { ...previous, resumeAsOrdinary: true };
    delete options.taskSession;
    delete options.taskRef; delete options.taskTitle; delete options.requireTaskBinding;
    ctx._sessionOptions = options;
    // Prevent a stale collaboration selection from turning the first follow-up
    // message into an unauthorized task execution after the archive is reopened.
    ctx._activeCollabTaskId = '';
    ctx._collaborationTaskId = '';
    ctx._collaborationTask = null;
    ctx._taskSession = null;
    if (ctx._snap) {
      ctx._snap = { ...ctx._snap, status: 'starting', statusText: '', openBlocked: false,
        sessionOpenCode: '', sessionNotFound: false };
      ctx._render?.();
    }
    const opened = await _ensure(chatId);
    if (opened) {
      ctx._taskOpenError = '';
      ctx._render?.();
      return true;
    }
    return false;
  }

async function _send(textOverride, sendOptions) {
    if (textOverride == null && global.ChatWorkbenchAnnotations) {
      return ChatWorkbenchAnnotations.submit(batch => _sendCore(textOverride, {
        ...(sendOptions || {}), annotationBatch: batch,
      }));
    }
    return _sendCore(textOverride, sendOptions);
  }

async function _sendCore(textOverride, sendOptions) {
    // A refused archive may have no native id yet. Never turn its retained
    // input into a new conversation; reopen it after resolving the error.
    if (ctx._snap?.openBlocked) return false;
    const el = ctx._mount();
    if (!el) return false;
    const accessEpoch = ctx._viewEpoch, sendScopeEpoch = ctx._draftScopeEpoch, sendOwnerScope = ctx._draftOwnerScope();
    if (ctx._composerControls?.waitForAccess && !await ctx._composerControls.waitForAccess()) return false;
    if (accessEpoch !== ctx._viewEpoch) return false;
    const input = el.querySelector('#nchatInput');
    const useComposer = textOverride == null || sendOptions?.useComposer === true;
    const pendingTask = ctx._collabTasks?.get(ctx._activeCollabTaskId);
    const pendingBrief = pendingTask && !pendingTask.queueRemoved && (!pendingTask.nativeTurn || pendingTask.queueState === 'failed') &&
      pendingTask.task?.status === 'todo' ? pendingTask.task.note || pendingTask.task.description || pendingTask.task.title : '';
    const composerInput = String(input?.value || '');
    const originalText = useComposer
      ? ctx._messageAttachments?.submissionText?.(composerInput) ?? composerInput : '';
    let typed = String(useComposer ? originalText || textOverride || pendingBrief || '' : textOverride || '');
    const selectedSkills = useComposer ? ctx._skillPicker?.selected() || [] : sendOptions?.skills || [];
    const skillSubmission = global.ComposeSkills?.submission?.(typed, selectedSkills) || { text: typed, skills: selectedSkills };
    typed = skillSubmission.text;
    const composerText = typed;
    const annotations = sendOptions && sendOptions.annotationBatch && sendOptions.annotationBatch.notes || [];
    if (annotations.length) typed = [typed, ChatWorkbenchAnnotations.format(annotations)].filter(Boolean).join('\n\n');
    const fromComposer = useComposer && ctx._messageAttachments, wasRunning = ctx._runtimeBusy();
    let retainedRef = String(ctx._ref || '').trim(), retainedApi = retainedRef ? ctx._api() : null;
    const appAttachments = !useComposer && Array.isArray(sendOptions?.attachments) ? sendOptions.attachments : [];
    const attachmentNames = fromComposer ? ctx._messageAttachments.names() : appAttachments.length ? appAttachments.map(file => file.name) : ctx._pendingAttachmentNames.slice();
    if (!typed.trim() && !attachmentNames.length) return false;
    if (fromComposer && !annotations.length && global.ChatWorkActions && typeof ChatWorkActions.route === 'function') {
      const routed = await ChatWorkActions.route({
        text: typed, attachmentNames, attachments: ctx._messageAttachments,
        input, mention: ctx._pluginMention,
        isCurrent: () => accessEpoch === ctx._viewEpoch && sendScopeEpoch === ctx._draftScopeEpoch && sendOwnerScope === ctx._draftOwnerScope(),
      }, { open: ctx._openWorkAction, model: ctx._workModel,
        conversationContext: ctx._workConversationContext });
      if (routed.handled) return routed.accepted;
    }
    if (accessEpoch !== ctx._viewEpoch || sendScopeEpoch !== ctx._draftScopeEpoch || sendOwnerScope !== ctx._draftOwnerScope() || ctx._pluginResolveBusy) return false;
    const sendEpoch = ctx._viewEpoch, resolveSeq = ++ctx._pluginResolveSeq;
    let sendDraftKey = ctx._draftKeyForCurrentSession();
    const sendProjectId = ctx._sessionOptions.projectId || '';
    // Attachment preparation and the submit queue may outlive this view.
    // Keep task ownership with the retained session, not the newly active tab.
    const activeTaskId = pendingTask?.queueRemoved ? '' : ctx._activeCollabTaskId;
    const sendTaskId = sendOptions?.taskId || activeTaskId || '';
    const reworkSession = ctx._sessionOptions?.reworkSession === true;
    const sendTaskExecution = sendOptions?.taskExecution ||
      ((ctx._sessionOptions?.acceptanceSession === true || ctx._sessionOptions?.acceptanceExecutionSession === true) && sendTaskId ? { acceptanceOnly: true,
        acceptanceMode: ctx._sessionOptions.acceptanceMode, approvalId: ctx._sessionOptions.approvalId,
        ...(ctx._sessionOptions?.acceptanceExecutionSession === true ? {acceptanceExecutionSession: true} : {}),
        ...(ctx._sessionOptions.acceptanceAttachmentIds ? {acceptanceAttachmentIds: ctx._sessionOptions.acceptanceAttachmentIds.slice()} : {}) } :
        activeTaskId ? { reuseConversation: true, followUp: !pendingBrief && !reworkSession,
          ...(reworkSession ? { reworkSession: true } : {}) } : undefined);
    const selectedPlugins = fromComposer && ctx._pluginMention ? ctx._pluginMention.selected() : []; let resolvedPlugins = Array.isArray(sendOptions && sendOptions.plugins) ? sendOptions.plugins.slice() : [];
    try {
      if (!resolvedPlugins.length && selectedPlugins.length) {
        ctx._pluginResolveBusy = true;
        const prepared = await ctx._pluginMention.resolve(
          ctx._sessionId || ctx._ref, ctx._sessionOptions.projectId || '', typed, { attachmentNames });
        if (!prepared) return false;
        resolvedPlugins = prepared.items;
        typed = prepared.text || typed;
      }
    } catch (error) {
      if (sendEpoch === ctx._viewEpoch && sendOwnerScope === ctx._draftOwnerScope() && typeof petSay === 'function') petSay(String((error && error.message) || error));
      return false;
    } finally {
      if (resolveSeq === ctx._pluginResolveSeq) ctx._pluginResolveBusy = false;
    }
    if (sendEpoch !== ctx._viewEpoch || sendScopeEpoch !== ctx._draftScopeEpoch || sendOwnerScope !== ctx._draftOwnerScope()) return false;
    const text = typed.trim() ? typed : '请查看并处理我附上的文件。';
    const sentAt = Date.now();
    const draftText = annotations.length || composerText.trim() ? composerText : text;
    const sentFiles = fromComposer ? ctx._messageAttachments.files() : []; const attachmentRefsPromise = fromComposer ? ctx._messageAttachments.refs(retainedApi || ctx._api()) : Promise.resolve(appAttachments);
    const pluginDraft = fromComposer ? (ctx._pluginMention?.draft?.() || selectedPlugins) : [];
    const failedDraft = { text: draftText, files: sentFiles.slice(), skills: skillSubmission.skills.slice(), plugins: resolvedPlugins.map(item =>
      ({ ...item, ...pluginDraft.find(draft => draft.pluginId === item.pluginId) })) };
    if (sendOptions?.taskId || (sendTaskId && pendingBrief)) failedDraft.requirement = {
      taskId: String(sendTaskId), taskExecution: JSON.parse(JSON.stringify(sendTaskExecution || {})),
      conversationId: String(ctx._sessionId || retainedRef || ''), ownerScope: sendOwnerScope,
      submissionId: '', deliveryState: 'not-sent',
    };
    const priorFailure = ctx._failedConversationDrafts.get(sendDraftKey);
    const currentSendScope = () => sendScopeEpoch === ctx._draftScopeEpoch && sendOwnerScope === ctx._draftOwnerScope();
    const retainFailure = reason => { if (currentSendScope()) ctx._retainFailedConversationDraft(sendDraftKey, failedDraft, reason); };
    const currentSendView = () => currentSendScope() && sendEpoch === ctx._viewEpoch && (!retainedRef || retainedRef === ctx._ref);
    const waitForPrior = ctx._submitTail; let releaseSubmit;
    ctx._submitTail = new Promise((resolve) => { releaseSubmit = resolve; });
    ctx._dismissProposal(true);
    ctx._workCards?.capture();
    if (global.ComposeDraft) ComposeDraft.clear({ preserveCreatedRequirement: true });
    if (global.ChatChrome && !wasRunning) ChatChrome.begin(text);
    let localQueue = null;
    if (wasRunning) {
      localQueue = {
        id: 'local-' + (++ctx._localQueueSeq), text,
        taskId: sendTaskId || '', taskTitle: sendOptions && sendOptions.taskTitle || '',
        attachments: attachmentNames.slice(), cancelled: false, serverId: '', visible: false,
      };
      ctx._localQueue.push(localQueue);
    } else {
      const baselineMessages = Array.isArray(ctx._snap?.messages) ? ctx._snap.messages : [];
      ctx._pendingBaseline = {
        messageCount: baselineMessages.length,
        historyTotal: Number.isFinite(Number(ctx._snap?.history?.totalMessages))
          ? Number(ctx._snap.history.totalMessages) : null,
      };
      ctx._pending = text;
      ctx._pendingSentAt = sentAt;
      ctx._pendingAttachmentNames = attachmentNames;
      ctx._pendingPlugins = resolvedPlugins.map((item) => ({
        pluginId: item.pluginId, name: item.name, version: item.version, scopeLabel: item.scopeLabel,
      }));
    }
    if (fromComposer) ctx._messageAttachments.clear();
    if (input && useComposer) { input.value = ''; input.style.height = 'auto'; }
    if (useComposer) ctx._clearConversationDraft(undefined, { preserveRequirement: true });
    const sendToken = typeof ctx._beginSendState === 'function' ? ctx._beginSendState() : null;
    // Consume the sent draft only; snapshots never refill it from runtime state.
    if (fromComposer) ctx._pluginMention?.consume?.(resolvedPlugins);
    if (fromComposer) ctx._skillPicker?.consume(selectedSkills);
    if (!ctx._snap) ctx._snap = { status: 'idle', statusText: '', messages: [], tools: [], usage: null, pendingUi: null };
    ctx._render();
    try {
      const attachmentRefs = await attachmentRefsPromise;
      if (!currentSendScope()) return false;
      if (!retainedRef && !currentSendView()) { retainFailure('会话已切换，这一轮尚未发送'); return false; }
      const ready = retainedRef ? true : await _ensure(); if (ready && !retainedRef && ctx._ref) { retainedRef = String(ctx._ref).trim(); retainedApi = ctx._api(); }
      if (currentSendView()) sendDraftKey = ctx._draftKeyForCurrentSession();
      if (!ready || (localQueue && localQueue.cancelled)) {
        if (!ready && ctx._snap?.sessionNotFound === true) sendOptions?.onAdmission?.({ notSent: true, code: 'SESSION_NOT_FOUND' });
        if (!ready) { retainFailure('会话尚未打开，这一轮未发送'); if (currentSendView()) ctx._restoreFailedDraft(failedDraft);
          // Remove the optimistic bubble when no send occurred.
          ctx._pending = ''; ctx._pendingAttachmentNames = []; ctx._pendingPlugins = []; ctx._pendingBaseline = null;
        }
        if (currentSendView() && localQueue && localQueue.cancelled && fromComposer && sentFiles.length) ctx._messageAttachments?.add(sentFiles, 'retry');
        return false;
      }
      await waitForPrior;
      if (!currentSendScope() || (!retainedRef && sendEpoch !== ctx._viewEpoch) || (localQueue && localQueue.cancelled)) return false;
      const api = retainedApi || ctx._api();
      const submissionId = sendOptions?.taskId && /^[a-zA-Z0-9_-]{1,64}$/.test(sendOptions.submissionId || '')
        ? sendOptions.submissionId : 'ui-' + Date.now().toString(36) + '-' + (++ctx._submissionSeq).toString(36);
      if (!wasRunning && ctx._pendingBaseline) ctx._pendingBaseline.submissionId = submissionId;
      if (failedDraft.requirement) {
        failedDraft.requirement.submissionId = submissionId;
        if (!failedDraft.requirement.conversationId && currentSendView())
          failedDraft.requirement.conversationId = String(ctx._sessionId || retainedRef || '');
      }
      if (localQueue) localQueue.submissionId = submissionId;
      if (currentSendView()) ctx._retryDraft = null;
      if (currentSendView()) ctx._rememberSubmission(submissionId, {
        ...failedDraft,
        files: sentFiles.slice(),
        plugins: (selectedPlugins.length ? selectedPlugins : resolvedPlugins).map((item) => ({
          pluginId: item.pluginId, name: item.name, version: item.version, scopeLabel: item.scopeLabel,
        })),
      });
      const submissionRef = retainedRef || ctx._ref; if (!api || !submissionRef) return false;
      const submissionSnapshot = ctx._snap;
      if (failedDraft.requirement) failedDraft.requirement.deliveryState = 'uncertain';
      const r = await api.send(submissionRef, text, attachmentRefs, {
        plugins: resolvedPlugins,
        sentAt,
        projectId: sendProjectId,
        inputPreparation: sendOptions?.inputPreparation || ctx._sessionOptions?.inputPreparation || {
          userText: composerText,
          ...( !composerText.trim() && attachmentRefs.length ? { fallback: true } : {}),
        },
        submissionId,
        // Ordinary follow-up messages in task sessions also retain task receipts and output collection;
        // corrections after a completed run can create additional task deliverables.
        taskId: sendTaskId,
        taskExecution: sendTaskExecution,
        retry: Boolean(sendOptions && sendOptions.retry),
        skills: skillSubmission.skills.slice(),
      });
      if (r?.ok === false && r.notSent === true && r.code === 'SESSION_NOT_FOUND' && !r.uncertain)
        sendOptions?.onAdmission?.({ notSent: true, code: r.code });
      // Do not show an optimistic queue row while a normal send is still
      // being acknowledged. The runtime can accept the turn immediately
      // even when the renderer briefly classified the previous snapshot as
      // busy; only a confirmed queued receipt should enter the queue UI.
      if (localQueue && r?.queued === true) {
        localQueue.visible = true;
        localQueue.serverId = r.queueId || localQueue.serverId;
      }
      if (failedDraft.requirement && r) failedDraft.requirement.deliveryState = r.ok ? 'accepted' : 'rejected';
      if (!currentSendScope()) return false;
      if (r?.ok && priorFailure?.draft.text === draftText &&
          (priorFailure.draft.requirement?.taskId || '') === (failedDraft.requirement?.taskId || '') &&
          ctx._failedConversationDrafts.get(sendDraftKey) === priorFailure) ctx._failedConversationDrafts.delete(sendDraftKey);
      if (sendEpoch !== ctx._viewEpoch || submissionRef !== ctx._ref) {
        if (!r?.ok) retainFailure(r?.reason || '发送未能确认，请重试');
        return Boolean(r && r.ok);
      }
      if (localQueue && r && r.queueId) localQueue.serverId = r.queueId;
      if (localQueue && localQueue.cancelled && r && r.queueId && typeof api.cancelQueued === 'function') {
        await api.cancelQueued(submissionRef, r.queueId);
        if (!currentSendView()) return false;
      }
      if (r?.ok && r.workflowRun && global.PluginDebugCard) void PluginDebugCard.open({ ref: submissionRef, mode: 'conversation' });
      if (r && r.snapshot && ctx._snap === submissionSnapshot) ctx._snap = r.snapshot;
      /*
       * The main process rewrites task messages with requirements or rework feedback, so
       * transcript text cannot reliably match optimistic text. Remove the optimistic bubble once
       * send is accepted and let server queue/transcript rows take over.
       */
      // Cloud ACKs can precede the transcript poll. Keep the submitted text
      // visible until its authoritative echo arrives; cloud sends do not
      // rewrite the user's text like requirement/workflow submissions do.
      const cloudEchoPending = submissionSnapshot?.cloudHandoff?.phase === 'committed' && !r?.workflowRun;
      if ((sendTaskId || r?.workflowRun) && r && r.ok && !cloudEchoPending) {
        ctx._pending = ''; ctx._pendingAttachmentNames = []; ctx._pendingPlugins = []; ctx._pendingBaseline = null;
        if (reworkSession && ctx._sessionOptions?.reworkSession) {
          /*
           * Load prior attachments fully for the first rework turn in a new session; later messages
           * use ordinary continuation without recreating runs or downloading materials again.
           */
          ctx._sessionOptions = { ...ctx._sessionOptions, reworkSession: false };
        }
      }
      if (!r || !r.ok) {
        retainFailure(r && r.reason || '发送未能确认，请重试');
        ctx._submissionDrafts.delete(submissionId);
        if (!wasRunning) ctx._fail('这一轮没发出去', r && r.reason, failedDraft, r);
        else if (!global.SoduWorkQuotaNotice?.show(r) && typeof petSay === 'function') petSay((r && r.reason) || '排队消息没有发出去');
      } else {
        // A late receipt must preserve new text/skills typed after this send.
        ctx._rememberConversationDraft();
        if (fromComposer) ctx._taskAttachments.push(...sentFiles);
        if (global.ChatChrome && !r.queued) ChatChrome.confirmHistory(ctx.refreshHistory);
      }
      return Boolean(r && r.ok && !(localQueue && localQueue.cancelled));
    } catch (error) {
      retainFailure(String(error && error.message || error));
      if (!currentSendView()) return false;
      if (!wasRunning) ctx._fail('这一轮没发出去', String((error && error.message) || error), failedDraft, error);
      else if (!global.SoduWorkQuotaNotice?.show(error) && typeof petSay === 'function') petSay('排队消息没有发出去');
      return false;
    } finally {
      if (typeof ctx._finishSendState === 'function') ctx._finishSendState(sendToken);
      if (currentSendView()) ctx._localQueue = ctx._localQueue.filter((row) => row !== localQueue);
      releaseSubmit();
      if (currentSendView() && ctx._snap) ctx._render();
    }
  }

function _paintOpening() {
    const el = ctx._mount();
    const list = el && el.querySelector('#nchatList');
    if (!list || list.childElementCount) return;   // Preserve existing user input.
    const label = global.SoduWorkI18n
      ? global.SoduWorkI18n.html('chat.opening', '正在打开对话…')
      : '<span>正在打开对话…</span>';
    list.innerHTML =
      '<div class="nchat-opening">' +
        '<div class="nchat-opening-status" role="status" aria-live="polite" aria-atomic="true">' +
          '<span class="nchat-opening-spinner" aria-hidden="true"></span>' + label + '</div>' +
        '<div class="nchat-opening-preview" aria-hidden="true">' +
          '<div class="nchat-opening-prompt"></div><div class="nchat-opening-reply">' +
            '<span class="nchat-opening-line"></span><span class="nchat-opening-line"></span>' +
            '<span class="nchat-opening-line"></span></div></div></div>';
  }
  return { _ensureOnce, _ensure, _retryOpenChat, _awaitBounded, _send, _sendCore, _paintOpening };
  }
  global.ChatSessionController = { create };
})(window);
