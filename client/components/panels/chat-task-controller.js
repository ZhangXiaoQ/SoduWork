/* Task binding, dispatch confirmation and task-state synchronization; state is owned by NativeChat, never copied. */
(function (global) {
  'use strict';
  // Only the pending business state is eligible for adding work. Execution
  // receipts can be ahead of that state, so also exclude claimed/delivered work.
  const { isPickableTask } = global.ChatTaskStart;

  function taskRecoveryScope(task) {
    const item = task || {}, routing = item.workRouting || {};
    const text = value => String(value == null ? '' : value).trim();
    // Compare routing constraints only. Titles, timestamps and display names
    // may refresh independently without changing the selected execution scope.
    return JSON.stringify([item, routing, item.executionContext, routing.executionContext].map(value => {
      const scope = value || {}, repo = scope.repo || {}, agent = scope.agent || {}, runner = scope.runner || {};
      return [scope.projectId, scope.project?.id, scope.repoId, repo.id, repo.projectId, repo.path, repo.branch, repo.gitUrl,
        scope.workflowBindingId, scope.selectedWorkflowBindingId, scope.workflowId, scope.bindingId,
        scope.plugin?.bindingId, scope.plugin?.version, scope.strategy, scope.selectedStrategy,
        scope.assigneeType, scope.squadId, scope.agentId, scope.agentKind, agent.id, agent.key, agent.cli,
        scope.model, scope.reasoningEffort, scope.accessMode, runner.mode, runner.id, runner.runnerId,
        runner.clientId, runner.machineKey, runner.host, runner.remote === true, scope.location?.mode].map(text);
    }));
  }

  function acceptanceDraft(task, mode) {
    const item = task || {};
    const title = String(item.title || item.name || '当前需求').trim();
    const note = String(item.note || item.description || item.goal || '').trim();
    const rawCriteria = item.acceptanceCriteria || item.acceptance || item.criteria || item.completionCriteria || [];
    const criteria = Array.isArray(rawCriteria)
      ? rawCriteria.map(value => typeof value === 'string' ? value : value && (value.label || value.text || value.name)).filter(Boolean)
      : String(rawCriteria || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    const rawFiles = item.attachments || item.materials || item.files || [];
    const files = Array.isArray(rawFiles)
      ? rawFiles.filter(file => !file || typeof file === 'string' ||
        !['rework_input', 'process', 'verification'].includes(String(file.role || ''))).map(file => {
        if (typeof file === 'string') return file;
        if (!file) return '';
        // Native acceptance preparation binds immutable identifiers outside the editable user message.
        return file.filename || file.name || file.title || '附件';
      }).filter(Boolean)
      : [];
    const lines = [mode === 'auto' ? '【自动验收】' : '【验收分析】',
      '请核对本次交付成果与需求目标，按验收标准逐项给出可复核结论。',
      '需求：' + title];
    if (note) lines.push('需求说明：' + note.slice(0, 900));
    if (criteria.length) lines.push('验收标准：\n' + criteria.slice(0, 20).map((value, index) => (index + 1) + '. ' + value).join('\n'));
    else lines.push('验收标准：请以需求中已保存的完成标准为准，缺少证据时明确指出。');
    lines.push('相关文件：' +
      (files.length ? '\n' + files.slice(0, 30).map(value => '- ' + value).join('\n') : '发送时自动载入需求附件与交付证据'));
    lines.push(mode === 'auto'
      ? '请完成核验后按自动验收约定输出审核结果；不要重新执行原需求。'
      : '请先分析并输出验收建议；本轮不改变需求状态，最终由我确认。');
    return lines.join('\n\n');
  }

  function reworkDraft(task, feedback) {
    const item = task || {};
    const title = String(item.title || item.name || '当前需求').trim();
    const note = String(feedback || item.workRouting?.reworkPending?.feedback || '').trim();
    const rawFiles = item.attachments || item.materials || item.files || [];
    const fileRows = Array.isArray(rawFiles) ? rawFiles
      .filter(file => file && typeof file === 'object' && String(file.role || '') !== 'rework_input') : [];
    const roundOf = file => Number((file?.evidenceMeta || {}).round || file?.round || 0) || 0;
    const batchOf = file => String(file?.sourceRef || file?.evidenceMeta?.identifier || file?.evidenceMeta?.conversationId || 'legacy');
    const stampOf = (file, index) => {
      const raw = file?.createdAt || file?.created_at || file?.updatedAt || file?.at || '';
      const parsed = typeof raw === 'number' ? raw : Date.parse(String(raw));
      return Number.isFinite(parsed) ? parsed : index;
    };
    const batches = new Map();
    fileRows.forEach((file, index) => {
      const key = batchOf(file), old = batches.get(key) || {key, stamp: -1, index: -1, round: 0};
      old.stamp = Math.max(old.stamp, stampOf(file, index)); old.index = Math.max(old.index, index); old.round = Math.max(old.round, roundOf(file));
      batches.set(key, old);
    });
    const latestBatch = [...batches.values()].sort((a, b) => a.stamp - b.stamp || a.index - b.index).at(-1)?.key || 'legacy';
    const latestRound = Math.max(0, ...fileRows.filter(file => batchOf(file) === latestBatch).map(roundOf));
    const hasVersionedBatch = fileRows.some(file => roundOf(file) > 0 || batchOf(file) !== 'legacy');
    const currentRows = fileRows.filter(file => !hasVersionedBatch ||
      (batchOf(file) === latestBatch && (roundOf(file) === latestRound || roundOf(file) === 0)));
    const files = currentRows.map(file => {
        const name = String(file.filename || file.name || file.title || '交付物').trim();
        const id = String(file.id || file.attachmentId || '').trim();
        const meta = file.evidenceMeta || {};
        const round = roundOf(file);
        const version = String(file.versionId || meta.versionId || '').trim();
        const batch = batchOf(file);
        const identity = [id ? '附件 ID: ' + id : '', round > 0 ? '第 ' + round + ' 轮' : '', version ? '版本: ' + version : '', batch !== 'legacy' ? '交付批次: ' + batch : '']
          .filter(Boolean).join('，');
        return name + (identity ? '（' + identity + '）' : '');
      }).filter(Boolean);
    const currentFiles = files;
    return [
      '请继续修复需求：' + title,
      currentFiles.length ? '上一轮交付物（必须先读取并在其基础上修改，禁止从头重做）：\n' +
        currentFiles.slice(0, 30).map(value => '- ' + value).join('\n') :
        '上一轮交付物：请先读取需求当前的最新交付和附件，再在其基础上修改，禁止从头重做。',
      note ? '请按以下验收意见修改现有交付：\n' + note : '请继续修改当前交付并重新提交验收。',
      '修改完成后请重新完整提交交付结果；修正版请沿用原文件语义并以新的交付轮次区分上一版。',
    ].join('\n\n');
  }

  function acceptanceResolution(task, trace) {
    const item = task || {};
    if (item.reviewedAt || item.reviewed_at) return true;
    const routing = item.workRouting || item.work_routing || {};
    if (routing.reworkPending || routing.rework_pending || item.reviewRejected || item.review_rejected) return true;
    const approvals = Array.isArray(trace?.approvals) ? trace.approvals : [];
    const reviews = approvals.filter(row => String(row?.action || '').toLowerCase() === 'review');
    const pending = reviews.some(row => String(row?.status || '').toLowerCase() === 'pending' && !row.myDecision);
    const resolved = reviews.some(row => ['approved', 'rejected', 'declined', 'cancelled', 'canceled']
      .includes(String(row?.status || '').toLowerCase()));
    return resolved && !pending;
  }

  function create(ctx) {
  const { _taskExecutionConfig, _renderTaskStartPrompt, _startTask, _startTaskCommand, enqueueTask } =
    global.ChatTaskStart.create(ctx, { _viewGuard, _sessionContext, _collabEntryStatus, _persistTaskBinding,
      _bindCollaborationTask, _setCollabEntryStatus, _openTaskPicker, _openTask });
  function _viewGuard(allowOpening = false) {
    const epoch = ctx._viewEpoch, ref = ctx._ref, sessionId = ctx._sessionId;
    const owner = () => String(global.SoduWorkAPI?.taskStorageKey?.('ops') || '');
    const scope = owner();
    return () => epoch === ctx._viewEpoch && scope === owner() &&
      (allowOpening && !ref || ref === ctx._ref && sessionId === ctx._sessionId);
  }
  function _sessionContext() {
    return { ...ctx._sessionOptions, ...ctx.sessionInfo?.(), sessionId: ctx._sessionId,
      model: ctx._workModel?.() || ctx._sessionOptions?.modelName || '',
      ...ctx._snap?.requirementContext };
  }
  /*
   * Clear temporary acceptance context after completion or rejection elsewhere so later
   * messages are not sent as acceptanceOnly. Use reviewedAt for approval and pending rework
   * or closed review records for rejection; retain context while another review remains
   * pending.
   */
  function _clearFinishedAcceptanceContext(taskId, task, trace) {
    const opts = ctx._sessionOptions || {};
    if (opts.acceptanceExecutionSession !== true) return false;
    const id = String(taskId || '').trim();
    const bound = String(opts.taskRef || ctx._activeCollabTaskId || '').trim();
    if (!id || !bound || id !== bound) return false;
    if (!acceptanceResolution(task, trace)) return false;
    ctx._sessionOptions = { ...opts, acceptanceExecutionSession: false,
      acceptanceSession: false, acceptanceMode: 'manual', approvalId: '', acceptanceAttachmentIds: [] };
    return true;
  }
  function _collabState() {
    const rows=Array.from(ctx._collabTasks.values()).map((x)=>{const c=x.controller;const q=c&&c.snapshot?c.snapshot():{};return Object.assign({},x,q,{task:x.task||q.task||{},taskId:x.taskId});});
    const active=rows.find((x)=>String(x.taskId)===String(ctx._activeCollabTaskId))||rows[rows.length-1]||{};
    const task=active.task||ctx._collaborationTask||{};const execution=active.execution||((ctx._snap||{}).execution)||{};
    return {collaboration:Boolean(rows.length||ctx._sessionOptions.intent==="goal"||ctx._sessionOptions.mode==="goal"),taskId:active.taskId||"",task, tasks:rows,activeTaskId:active.taskId||"",snapshot:active.snapshot||ctx._snap||{},execution,outputs:ctx._outs,sessionId:ctx._sessionId,ref:ctx._ref,taskOpenError:ctx._taskOpenError,taskOpenPending:ctx._taskOpenPending,trace:active.trace||ctx._collaborationTrace,sessionOptions:ctx._sessionOptions,model:ctx._model,adapterId:ctx._sessionOptions.adapterId||"pi",goalMode:ctx._sessionOptions.intent==="goal"||ctx._sessionOptions.mode==="goal",goal:ctx._sessionOptions.goal||"",status:active.status||execution.status||task.status||((ctx._snap||{}).status)||"starting",phase:active.phase||execution.phase||"",executionContext:task.executionContext||execution.executionContext||{},picker:ctx._collabPicker,eventScope: { conversationId:ctx._sessionId,taskId:active.taskId||"",runId:execution.runId||execution.run_id||""},events:global.ChatCollaboration&&ChatCollaboration.mergeEvents?ChatCollaboration.mergeEvents([],active.events||[]):[]};
  }

  function _ensureCollabView(el) {
    const host = el && el.querySelector('#nchatCollab');
    if (!host || !global.ChatCollaboration || typeof ChatCollaboration.create !== 'function') return;
    if (!ctx._collabView) ctx._collabView = ChatCollaboration.create({ host, onAction: _collabAction });
  }

  function _collabAction(action,state) {
    const id=String(state&&state.taskId||ctx._activeCollabTaskId||"");
    if(action==="add-task"){_openTaskPicker();return;}
    if(action==="picker-close"){
      const { onClose, render } = ctx._collabPicker;
      ctx._collabPicker={open:false,loading:false,tasks:[]};
      if (!render) ctx._render();
      onClose?.(); return;
    }
    if(action==="select-task"){return _addPickerTask(state&&state.taskId); }
    if(action==="open-task"){
      const taskId=String(state&&state.taskId||'');
      if(taskId) _selectCollabTask(taskId);
      if(ctx._collabView&&ctx._collabView.setPin)ctx._collabView.setPin('dossier');
      return;
    }
    if(action==="rework-task"){
      const taskId=String(state&&state.taskId||'');
      const entry=taskId ? ctx._collabTasks.get(taskId) : null;
      const task=entry&&entry.task || {};
      if(taskId && typeof global.openTaskConversation === 'function')
        return global.openTaskConversation(taskId, task.title || '当前协作需求', {
          source:'rework', navigation:true, forceNew:false, reworkSession:true,
        });
      if(taskId) return _openTask(taskId, task.title || '当前协作需求', {
        source:'rework', navigation:true, forceNew:false, reworkSession:true,
      });
      return false;
    }
    if(action==="pin"){if(ctx._collabView&&ctx._collabView.setPin)ctx._collabView.setPin(state&&state.pin);return;}
    if(action==="collapse"){if(ctx._collabView&&ctx._collabView.setCollapsed)ctx._collabView.setCollapsed(Boolean(state&&state.collapsed));return;}
    if(action==="focus"){const x=document.getElementById("nchatInput");if(x)x.focus();return;}
    if(action==="artifacts"){const x=document.getElementById("nchatList");const y=x&&x.querySelector(".nartifact,.nchat-artifact,[data-artifact]");if(y&&y.scrollIntoView)y.scrollIntoView({block:"center"});return;}
    if(action==="reopen"){const t=(state&&state.task)||ctx._collaborationTask||{};void _openTask(id,t.title||"",{source:"task-retry"});return;}
    if(action==="start"||action==="retry")_startTask((state&&state.task)||ctx._collaborationTask,{retry:action==="retry"});
  }

  function _pickerCandidates(rows) {
    const used = new Set(_collabEntries().filter(e => !e.queueRemoved &&
      !['failed', 'cancelled'].includes(_collabEntryStatus(e))).map(e => String(e.taskId)));
    const seen = new Set();
    return (Array.isArray(rows) ? rows : []).filter(task => {
      const id = String(task && task.id || '');
      // Claimable assignments are selectable, but remain read-only until Hub accepts an explicit confirmation.
      const eligible = isPickableTask(task?.canClaimExecution === true ? { ...task, readOnly: false } : task);
      if (!eligible || used.has(id) || seen.has(id) || ctx._collabStarts.has(id)) return false;
      seen.add(id); return true;
    });
  }

  function _paintPicker() {
    if (ctx._collabPicker.render) ctx._collabPicker.render(_collabState());
    else ctx._render();
  }
  async function _openTaskPicker(options) {
    const api = global.SoduWorkAPI;
    if (!api || ctx._collabPicker.submitting ||
        ctx._collabPicker.open && !ctx._collabPicker.error) return;
    const presentation = options || ctx._collabPicker;
    const context = presentation.context || _sessionContext();
    const request = { open: true, loading: true, tasks: [], context,
      onClose: presentation.onClose, onConfirm: presentation.onConfirm, canConfirm: presentation.canConfirm,
      render: presentation.render, host: presentation.host,
      scope: context.projectId || context.repoId ? 'related' : 'all' };
    const current = _viewGuard();
    ctx._collabPicker = request; _paintPicker();
    try {
      const snapshot = typeof api.getTasksSnapshot === 'function'
        ? await api.getTasksSnapshot() : { online: true, items: await api.getTasks() };
      if (ctx._collabPicker !== request || !current()) return;
      if (!snapshot || snapshot.online !== true || snapshot.stale) throw new Error('TASK_LIST_UNAVAILABLE');
      Object.assign(request, { loading: false, tasks: _pickerCandidates(snapshot.items) });
      const matching = request.tasks.find(task => task.projectId === context.projectId);
      request.context.projectName ||= matching?.projectName || '';
    } catch (_) {
      if (ctx._collabPicker !== request || !current()) return;
      Object.assign(request, { loading: false, error: '暂时无法读取待办需求，请检查连接后重试。' });
    }
    _paintPicker();
  }

  async function _addPickerTask(id) {
    const key = String(id || ''), request = ctx._collabPicker;
    if (!request.open || request.loading || request.submitting ||
        !_pickerCandidates(request.tasks).some(task => String(task.id) === key)) return false;
    let sessionId = ctx._sessionId;
    const epoch = ctx._viewEpoch;
    const sameView = _viewGuard(true);
    const current = () => sameView() && ctx._collabPicker === request && sessionId === ctx._sessionId && epoch === ctx._viewEpoch;
    request.submitting = true; request.error = ''; _paintPicker();
    try {
      // A task may have started in another window since this list was opened.
      let task = await global.SoduWorkAPI.getTask(key);
      if (!current()) return false;
      if (String(task && task.id || '') !== key || !_pickerCandidates([task]).length) {
        request.tasks = request.tasks.filter(row => String(row.id) !== key);
        request.error = '这项需求已不再是可添加的待办，请选择其他需求。';
        return false;
      }
      const reason = global.RequirementSessionContext?.compatibility(task, request.render ? request.context : _sessionContext());
      if (reason) { request.tasks = request.tasks.map(row => row.id === task.id ? task : row); request.error = reason; return false; }
      if (request.canConfirm && !request.canConfirm(current)) return false;
      if (task.readOnly && task.canClaimExecution === true) {
        try { task = await global.SoduWorkAPI.prepareRequirementExecution(key); }
        catch (error) {
          if (current()) request.error = String(error?.message || '暂时无法接手需求，请刷新后重试。');
          return false;
        }
        if (!current()) return false;
        // The claim response must grant execution for this exact task before any session binding or send.
        if (String(task?.id || '') !== key || !isPickableTask(task) || !_pickerCandidates([task]).length) {
          request.error = '接手未完成或需求状态已变化，请刷新后重试。';
          return false;
        }
        request.tasks = request.tasks.map(row => String(row.id) === key ? task : row);
        const claimedReason = global.RequirementSessionContext?.compatibility(task, request.render ? request.context : _sessionContext());
        if (claimedReason) { request.error = claimedReason; return false; }
      }
      const previous = ctx._collabTasks.get(key);
      const requeue = Boolean(previous && (previous.queueRemoved || ['failed', 'cancelled'].includes(_collabEntryStatus(previous))));
      if (request.onConfirm) {
        if (await request.onConfirm(current) === false || !current()) return false;
        delete request.render; delete request.onConfirm; delete request.onClose; delete request.canConfirm; delete request.host;
      }
      const ok = await _openTask(key, task.title || task.name || '', {
        task, reuseCurrent: true, source: 'task-add',
      });
      if (!ok) {
        if (current()) request.error = ctx._taskOpenError || '未能加入当前会话，请稍后重试。';
        return false;
      }
      // The first request can establish an empty conversation. An existing
      // conversation must still match exactly; a view change cancels either.
      if (!sessionId && epoch === ctx._viewEpoch) sessionId = ctx._sessionId;
      // Closing or switching while awaiting connection cancels the send.
      if (!current()) return false;
      const accepted = await _startTask(task, { retry: requeue, taskExecution: { reuseConversation: true } });
      if (current()) {
        if (accepted) ctx._collabPicker = { open: false, loading: false, tasks: [] };
        else request.error = ctx._taskOpenError || '需求未发送，检查原因后可重试';
        _paintPicker();
      }
      return accepted;
    } catch (_) {
      if (current()) request.error = '无法确认需求的最新状态，请重试；需求尚未加入队列。';
      return false;
    } finally {
      if (current()) { request.submitting = false; _paintPicker(); }
    }
  }

  function _selectCollabTask(id, options) {
    const key = String(id || '').trim();
    const x = ctx._collabTasks.get(key);
    if (!x) return;
    ctx._activeCollabTaskId = key;
    ctx._collaborationTask = x.task || ctx._collaborationTask;
    ctx._collaborationTaskId = key;
    ctx._taskSession = x.controller || ctx._taskSession;
    ctx._collaborationTrace = x.trace || null;
    if (global.ChatCollaborationStore && ctx._sessionId) ChatCollaborationStore.setActive(ctx._sessionId, key);
    // Automatic selection during restore must not close a requirement picker the user just opened.
    if (!(options && options.keepPicker)) ctx._collabPicker = { open: false, loading: false, tasks: [] };
    ctx._render();
  }

  function _prefillReworkInput(taskSnapshot, title) {
    const input = ctx._mount()?.querySelector('#nchatInput');
    if (!input || String(input.value || '').trim()) return;
    const task = taskSnapshot || ctx._collaborationTask || { title };
    const feedback = task?.workRouting?.reworkPending?.feedback || '';
    input.value = reworkDraft(task, feedback);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function _activateAcceptanceContext(opts, taskSnapshot, label) {
    if (!opts?.acceptanceSession && !opts?.acceptanceExecutionSession) return;
    ctx._sessionOptions = { ...ctx._sessionOptions,
      acceptanceSession: opts.acceptanceSession === true,
      acceptanceExecutionSession: opts.acceptanceExecutionSession === true,
      acceptanceMode: opts.acceptanceMode === 'auto' ? 'auto' : 'manual',
      approvalId: String(opts.approvalId || ''),
      acceptanceAttachmentIds: (opts.acceptanceSession || opts.acceptanceExecutionSession) && Array.isArray(opts.acceptanceAttachmentIds)
        ? [...new Set(opts.acceptanceAttachmentIds.map(String))].slice(0, 60) : [],
      taskRef: String(opts.taskId || taskSnapshot?.id || ctx._sessionOptions.taskRef || '').trim(),
      taskTitle: label || ctx._sessionOptions.taskTitle || '' };
    const input = ctx._mount()?.querySelector('#nchatInput');
    if (input && !String(input.value || '').trim()) {
      input.value = acceptanceDraft(taskSnapshot || ctx._collaborationTask || {title: label},
        opts.acceptanceMode === 'auto' ? 'auto' : 'manual');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  async function _loadCollabTask(taskId) {
    const id = String(taskId || '');
    const entry = ctx._collabTasks.get(id);
    if (!id || !entry || !global.SoduWorkAPI || typeof SoduWorkAPI.getTask !== 'function') return;
    const seq = Number(entry.loadSeq || 0) + 1;
    const current = _viewGuard();
    entry.loadSeq = seq;
    try {
      const task = await SoduWorkAPI.getTask(id);
      if (!current() || entry.loadSeq !== seq || ctx._collabTasks.get(id) !== entry) return;
      if (task && task.id) {
        entry.unavailable = false;
        entry.task = task;
        entry.projectId = String(task.projectId || (task.project && task.project.id) || entry.projectId || '').trim();
        entry.repoId = String(task.repoId || (task.repo && task.repo.id) || entry.repoId || '').trim();
        entry.queueMode = _collabQueueMode(entry, task);
        const receipt = (task.workRouting || {}).conversationTurn;
        entry.executionElsewhere = Boolean(receipt?.conversationId && receipt.conversationId !== ctx._sessionId);
        if (entry.executionElsewhere) {
          entry.nativeTurn = false;
          entry.controlledTurn = false;
          entry.controlledExecution = null;
          entry.controller?.clearExecution?.();
        }
        if (receipt && receipt.conversationId === ctx._sessionId) {
          entry.nativeTurn = true;
          entry.controlledTurn = receipt.executor && receipt.executor !== 'native';
          entry.queueState = receipt.state === 'queued' && !(((ctx._snap || {}).execution || {}).queue || []).some(row => row.taskId === id)
            ? 'waiting' : receipt.state;
        }
        const remoteStatus = entry.nativeTurn ? entry.queueState : _collabStatus(task.status);
        if (_collabTerminal.has(remoteStatus) || _collabRunning.has(remoteStatus)) {
          entry.queueState = remoteStatus;
        }
        if (entry.controller) entry.controller.attach(task, { conversationId: ctx._sessionId });
        if (global.ChatCollaborationStore) ChatCollaborationStore.upsertTask(ctx._sessionId || ctx._ref, {
          taskId: task.id, title: task.title, status: entry.nativeTurn ? entry.queueState : task.status,
          adapterId: entry.adapterId || ctx._sessionOptions.adapterId,
          projectId: entry.projectId || '',
          repoId: entry.repoId || '',
          workflowBindingId: task.workflowBindingId || task.bindingId || '',
          agentKind: task.agentKind || task.selectedAgentKind || '',
          queueMode: entry.queueMode || '',
        });
        if (id === ctx._activeCollabTaskId) {
          ctx._collaborationTask = task;
          ctx._taskSession = entry.controller;
          ctx._collaborationTrace = entry.trace || null;
        }
        /*
         * Check acceptance/rework completion from the task model first, then repeat after
         * taskTrace refresh because rejection evidence may arrive later.
         */
        _clearFinishedAcceptanceContext(id, task, entry.trace);
        ctx._render();
        if (typeof SoduWorkAPI.taskTrace === 'function') {
          await Promise.resolve(SoduWorkAPI.taskTrace(id)).then((traceResult) => {
            if (!current() || entry.loadSeq !== seq || ctx._collabTasks.get(id) !== entry) return;
            entry.trace = traceResult && traceResult.trace ? traceResult.trace : traceResult;
            if (id === ctx._activeCollabTaskId) ctx._collaborationTrace = entry.trace;
            _clearFinishedAcceptanceContext(id, task, entry.trace);
            ctx._render();
          }).catch(() => {});
        }
        await _restoreTaskTranscript(entry, () => current() && entry.loadSeq === seq && ctx._collabTasks.get(id) === entry);
        if (!entry.nativeTurn && !entry.executionElsewhere) _loadCollabRun(id);
      }
    } catch (error) {
      // An explicit single-task response can stop polling; a missing list row cannot.
      if (current() && [403, 404, 410].includes(Number(error?.status)) &&
          entry.loadSeq === seq && ctx._collabTasks.get(id) === entry) entry.unavailable = true;
    }
  }

  async function _restoreTaskTranscript(entry, current) {
    const api = global.SoduWorkAPI;
    if (!entry.controlledTurn || entry.executionElsewhere || !api?.aiSession ||
        entry.controlledExecution?.sameMessageStream ||
        ctx._snap?.messages?.some(message => message.taskId === entry.taskId && message.taskOutputKey)) return;
    const sessions = entry.trace?.execution?.sessions || [];
    if (!sessions.length || !current()) return;
    const transcripts = entry.transcripts || (entry.transcripts = new Map());
    entry.transcriptPending = true;
    let budget = 8;
    // Trace events are bounded excerpts. Restore from the authorized task/ref
    // endpoint; never display a tail excerpt as a complete conversation.
    for (const session of sessions) {
      const ref = String(session.ref || '');
      if (!ref) continue;
      let replay = transcripts.get(ref);
      if (!replay) {
        replay = { ...session, items: [], last: 0, hasMore: true };
        transcripts.set(ref, replay);
      }
      while (budget > 0 && current() && (replay.hasMore || Number(session.seq) > replay.last)) {
        budget--;
        const page = await api.aiSession(entry.taskId, replay.last, ref);
        if (!current()) return;
        if (!page || page.ok === false || page.ref !== ref ||
            (page.conversationId && page.conversationId !== ctx._sessionId)) break;
        const last = Number(page.last);
        if (!Number.isSafeInteger(last) || last < replay.last || !Array.isArray(page.items)) break;
        const additions = page.items.filter(item => {
          const owner = item.conversationId || item.conversation_id || item.scope?.conversationId || item.eventScope?.conversationId;
          return (!owner || owner === ctx._sessionId) && Number.isSafeInteger(item.seq) &&
            item.seq > replay.last && item.seq <= last;
        }).sort((a, b) => a.seq - b.seq);
        const advanced = last > replay.last;
        replay = { ...page, items: [...replay.items, ...additions],
          hasMore: page.hasMore === true || last < Number(page.seq || 0) };
        transcripts.set(ref, replay);
        ctx._render();
        if (!advanced) break;
      }
    }
    if (!current()) return;
    entry.transcriptPending = sessions.some(session => {
      const replay = transcripts.get(String(session.ref || ''));
      return replay && (replay.hasMore || Number(session.seq) > replay.last);
    });
    ctx._render();
    if (entry.transcriptPending) _scheduleCollabPoll();
  }

  async function _loadCollabRun(taskId) {
    const id = String(taskId || '');
    const entry = ctx._collabTasks.get(id);
    const api = global.SoduWorkAPI;
    if (!entry || entry.unavailable || !api || typeof api.aiSession !== 'function' || !entry.controller) return;
    const conversationId = ctx._sessionId;
    const ownsExecution = () => !entry.task?.workRouting?.conversationTurn?.conversationId ||
      entry.task.workRouting.conversationTurn.conversationId === conversationId;
    if (!ownsExecution()) return;
    try {
      const current = entry.controller.snapshot ? entry.controller.snapshot() : {};
      let run = await api.aiSession(id, current.eventCursor || 0);
      if (conversationId !== ctx._sessionId || ctx._collabTasks.get(id) !== entry || !ownsExecution()) return;
      if (!run || run.ok === false) {
        if ([403, 404, 410].includes(Number(run?.httpStatus))) entry.unavailable = true;
        return;
      }
      const runId = run.id || run.ref || run.workflowRunId;
      if (current.runId && runId && current.runId !== runId && current.eventCursor) {
        run = await api.aiSession(id, 0);
        if (!run || run.ok === false || conversationId !== ctx._sessionId || ctx._collabTasks.get(id) !== entry || !ownsExecution()) return;
      }
      if (run.conversationId && run.conversationId !== conversationId) return;
      entry.controller.setExecution(run, run.id || run.ref || run.workflowRunId);
      if (Array.isArray(run.items)) run.items.slice().sort((a,b) => Number(a.seq || 0)-Number(b.seq || 0)).forEach((item) => {
        const owner = item.conversationId || item.conversation_id || item.scope?.conversationId || item.eventScope?.conversationId;
        if (owner && owner !== conversationId) return;
        entry.controller.applyEvent(Object.assign({}, item, {
          conversationId: ctx._sessionId, taskId: id, runId: run.id || run.ref,
        }));
      });
      const previousStatus = entry.queueState;
      let status = _collabStatus(run.status);
      // aiSession is one Agent/node run. A completed node is not a completed
      // workflow: human input, review and later nodes may still be pending.
      if (run.workflowRunId || (_collabTerminal.has(status) && previousStatus !== status)) {
        const result = typeof api.taskTrace === 'function' ? await api.taskTrace(id) : null;
        if (conversationId !== ctx._sessionId || ctx._collabTasks.get(id) !== entry) return;
        const trace = result && (result.trace || result);
        if (trace) {
          entry.trace = trace;
          /* The session-head crew status bar reads the ctx mirror; plugin tasks executing on
             the runtime side take this path — without mirroring, the bar disappears for the
             whole round (fig-4 regression). */
          if (id === ctx._activeCollabTaskId) ctx._collaborationTrace = trace;
        }
        if (run.workflowRunId) {
          if (trace && trace.summary && trace.summary.currentState) {
            status = _collabStatus(trace.summary.currentState);
          } else if (_collabTerminal.has(status)) {
            status = previousStatus || 'running';
          }
          entry.controller.update({ status });
        }
      }
      entry.queueState = status;
      if (previousStatus !== status) {
        _setCollabEntryStatus(entry, status);
      }
      ctx._render();
    } catch (_) { /* runtime details remain optional until the first event */ }
  }

  function _scheduleCollabPoll() {
    if (ctx._collabPollTimer || !_collabEntries().some(entry => !entry.unavailable &&
        (entry.transcriptPending || !_collabTerminal.has(_collabEntryStatus(entry))))) return;
    const epoch = ctx._viewEpoch;
    ctx._collabPollTimer = setTimeout(async () => {
      try {
        const entries = _collabEntries().filter(entry => !entry.unavailable &&
          (entry.transcriptPending || !_collabTerminal.has(_collabEntryStatus(entry))));
        await Promise.all(entries.map(entry => entry.nativeTurn || entry.executionElsewhere ? _loadCollabTask(entry.taskId) : _loadCollabRun(entry.taskId)));
      } finally {
        if (epoch === ctx._viewEpoch) { ctx._collabPollTimer = null; _scheduleCollabPoll(); }
      }
    }, 2500);
  }

  function _taskSnapshotIsStale() {
    if (!ctx._ref || !ctx._snap) return false;
    const messages = Array.isArray(ctx._snap.messages) ? ctx._snap.messages : [];
    const tools = Array.isArray(ctx._snap.tools) ? ctx._snap.tools : [];
    if (messages.length || tools.length || ctx._pending) return false;
    const execution = ctx._snap.execution || {};
    const status = String(ctx._snap.status || '').toLowerCase();
    if (!['streaming', 'running', 'compacting'].includes(status) || execution.running) return false;
    const harness = execution.harness || {};
    const idleMs = Number(execution.idleMs || 0);
    const ageMs = Date.now() - Number(ctx._sessionOpenedAt || 0);
    return (idleMs >= 15000 || ageMs >= 30000) &&
      (harness.state === 'running' || harness.phase || idleMs >= 30000);
  }

  function _isEmptyStalledSnapshot(snapshot) {
    const value = snapshot || {};
    const messages = Array.isArray(value.messages) ? value.messages : [];
    const tools = Array.isArray(value.tools) ? value.tools : [];
    if (messages.length || tools.length) return false;
    const status = String(value.status || '').toLowerCase();
    if (!['streaming', 'running', 'compacting'].includes(status)) return false;
    const execution = value.execution || {};
    if (execution.running) return false;
    const idleMs = Number(execution.idleMs || 0);
    if (idleMs < 15000) return false;
    const harness = execution.harness || {};
    return harness.state === 'running' || Boolean(harness.phase) || status !== 'running';
  }

  const _collabTerminal = new Set([
    'completed', 'complete', 'done', 'delivered', 'failed', 'blocked',
    'unreachable', 'incomplete', 'stopped', 'cancelled', 'canceled', 'aborted',
  ]);

  const _collabRunning = new Set(['starting', 'dispatching', 'queued', 'doing', 'running', 'executing', 'streaming']);

  function _collabStatus(value) {
    const raw = String(value || '').trim().toLowerCase();
    return global.ChatTaskSession && typeof ChatTaskSession.normalizeStatus === 'function'
      ? ChatTaskSession.normalizeStatus(raw || 'todo') : (raw || 'todo');
  }

  function _collabEntryStatus(entry) {
    const live = entry && entry.controller && typeof entry.controller.snapshot === 'function'
      ? entry.controller.snapshot() : {};
    const execution = live.execution || {};
    return _collabStatus(entry && entry.queueState || live.status || execution.status ||
      entry && entry.task && entry.task.status || 'todo');
  }

  function _collabEntries() { return Array.from(ctx._collabTasks.values()); }

  function _collabQueueMode(entry, task) {
    const value = entry && entry.queueMode || task && task.queueMode || ctx._sessionOptions.queueMode || 'serial';
    return String(value).toLowerCase() === 'parallel' ? 'parallel' : 'serial';
  }

  function _collabProjectId(entry, task) {
    const value = entry && entry.projectId || task && task.projectId ||
      task && task.project && task.project.id || ctx._sessionOptions.projectId || '';
    return String(value || '').trim();
  }

  function _setCollabEntryStatus(entry, status, phase) {
    if (!entry) return;
    const next = _collabStatus(status);
    entry.queueState = next;
    // Queue/run state is not the authoritative business task status.
    if (entry.controller && typeof entry.controller.update === 'function') {
      entry.controller.update(Object.assign({ status: next }, phase ? { phase } : {}));
    }
    if (global.ChatCollaborationStore && ctx._sessionId) {
      ChatCollaborationStore.upsertTask(ctx._sessionId, {
        taskId: entry.taskId, title: entry.task && entry.task.title || '', status: next,
        adapterId: entry.adapterId || ctx._sessionOptions.adapterId,
        projectId: entry.projectId || '',
        repoId: entry.repoId || '',
        workflowBindingId: entry.task && (entry.task.workflowBindingId || entry.task.bindingId) || '',
        agentKind: entry.task && (entry.task.agentKind || entry.task.selectedAgentKind) || '',
        queueMode: entry.queueMode || '',
      }, { active: entry.taskId === ctx._activeCollabTaskId });
    }
  }

  function _nextCollabEntry() {
    for (const entry of _collabEntries()) {
      if (entry.queueRemoved) continue;
      const status = _collabEntryStatus(entry);
      if (_collabTerminal.has(status)) continue;
      if (_collabRunning.has(status)) return null;
      return entry;
    }
    return null;
  }

  async function _persistTaskBinding(taskId, title) {
    const api = ctx._api();
    const ref = ctx._ref;
    const current = _viewGuard();
    if (!ref) return false;
    if (!api || typeof api.bindTask !== 'function') {
      if (ref === ctx._ref) {
        ctx._taskOpenError = '\u5f53\u524d\u5ba2\u6237\u7aef\u4e0d\u652f\u6301\u9700\u6c42\u4f1a\u8bdd\u7ed1\u5b9a\uff0c\u8bf7\u91cd\u542f\u5ba2\u6237\u7aef\u540e\u91cd\u8bd5';
        ctx._taskOpenPending = false;
        ctx._render();
      }
      return false;
    }
    try {
      const result = await api.bindTask(ref, taskId, title);
      if (!current()) return false;
      if (!result || result.ok === false) {
        throw new Error((result && result.reason) || '需求会话绑定失败');
      }
      if (current()) {
        ctx._taskOpenError = '';
        ctx._render();
      }
      return true;
    } catch (error) {
      if (current()) {
        ctx._taskOpenError = '需求已创建，但协作会话没有绑定成功：' +
          String((error && error.message) || error);
        ctx._taskOpenPending = false;
        ctx._render();
      }
      return false;
    }
  }

  function _bindCollaborationTask(taskId, title, options) {
    const id=String(taskId||"").trim(); if(!id)return false;
    const opts=options||{}; const label=String(title||"当前协作需求").trim();
    const isNew = !ctx._collabTasks.has(id);
    const meta = opts.taskMeta && typeof opts.taskMeta === 'object' ? opts.taskMeta : {};
    const activate = opts.activate === true || ! ctx._collabTasks.size || ctx._activeCollabTaskId === id;
    const previous=ctx._collabTasks.get(id)||{};
    const queueRemoved = global.ChatCollaborationStore && typeof ChatCollaborationStore.isQueueRemoved === 'function'
      ? ChatCollaborationStore.isQueueRemoved(ctx._sessionId || ctx._ref, id) : Boolean(previous.queueRemoved);
    const seed=String(ctx._collaborationTaskId||"")===id?(ctx._collaborationTask||{}):{}; const task=Object.assign({},previous.task||{},seed,meta,{id,title:label});
    let controller=previous.controller;
    if(global.ChatTaskSession&&typeof ChatTaskSession.create==="function"){if(!controller||controller.conversationId!==ctx._sessionId)controller=ChatTaskSession.create({conversationId:ctx._sessionId});controller.attach(task,{conversationId:ctx._sessionId});}
    const projectId = String(opts.projectId || task.projectId || (task.project && task.project.id) || '').trim();
    const repoId = String(opts.repoId || task.repoId || (task.repo && task.repo.id) || '').trim();
    const queueMode = _collabQueueMode({ queueMode: opts.queueMode }, task);
    const initialStatus = _collabStatus(task.status) || (isNew ? 'todo' : 'starting');
    const hasRunning = _collabEntries().some((entry) => _collabRunning.has(_collabEntryStatus(entry)));
    const queueState = previous.queueState || (isNew && queueMode === 'serial' && hasRunning ? 'queued' : initialStatus);
    ctx._collabTasks.set(id,{...previous,taskId:id,task,controller,trace:previous.trace||null,queueState,projectId,repoId,queueMode,queueRemoved});
    if (activate) {
      ctx._activeCollabTaskId=id; ctx._collaborationTaskId=id; ctx._collaborationTask=task; ctx._taskSession=controller; ctx._collaborationTrace=previous.trace||null;
      ctx._sessionOptions={...ctx._sessionOptions,taskRef:id,taskTitle:label,
        projectId:projectId||ctx._sessionOptions.projectId||'',repoId:repoId||ctx._sessionOptions.repoId||'',queueMode};
    } else if (ctx._activeCollabTaskId) {
      const activeEntry = ctx._collabTasks.get(ctx._activeCollabTaskId);
      ctx._sessionOptions={...ctx._sessionOptions,taskRef:ctx._activeCollabTaskId,
        taskTitle:activeEntry&&activeEntry.task&&activeEntry.task.title||ctx._sessionOptions.taskTitle};
    }
    if(global.ChatCollaborationStore)ChatCollaborationStore.upsertTask(ctx._sessionId||ctx._ref,{taskId:id,title:label,status:queueState,adapterId:ctx._sessionOptions.adapterId||"pi",projectId,repoId,strategy:task.strategy||"",workflowBindingId:task.workflowBindingId||"",agentKind:task.agentKind||"",queueMode},{active:activate});
    const conversationTitle = global.ChatChrome?.sessionTitle || label;
    if(activate&&global.ChatChrome&&typeof ChatChrome.resume==="function")ChatChrome.resume(conversationTitle);
    if (ctx._sessionId && typeof global.WorkspaceShell?.upsertChat === 'function') {
      // Attaching a requirement does not start an Agent. Sidebar activity and
      // deletion follow the conversation runtime, independently of task state.
      const status = ctx._snap?.status || 'idle';
      WorkspaceShell.upsertChat({ id: ctx._sessionId, title: conversationTitle,
        adapterId: ctx._sessionOptions.adapterId || 'pi', taskId: ctx._activeCollabTaskId || id,
        taskIds: Array.from(ctx._collabTasks.keys()), collaboration: true,
        state: ctx._pending ? 'starting' : status, status, live: Boolean(ctx._ref) });
    }
    ctx._render(); _loadCollabTask(id); _scheduleCollabPoll(); if(opts.persist!==false&&ctx._ref)void _persistTaskBinding(id,label); return true;
  }

  function _restoreCollaboration(sessionId, expectedTaskId) {
    const record = global.ChatCollaborationStore && ChatCollaborationStore.get(sessionId);
    if (!record) return;
    const rows = Array.isArray(record.tasks) && record.tasks.length
      ? record.tasks : (record.taskId ? [{ taskId: record.taskId, title: record.title }] : []);
    rows.forEach((row) => {
      const id = String(row.taskId || row.id || '').trim();
      if (!id || (expectedTaskId && !rows.some((item) => String(item.taskId || item.id) === String(expectedTaskId)))) return;
      _bindCollaborationTask(id, row.title || row.taskTitle || '当前协作需求', {
        persist: false, taskMeta: row, projectId: row.projectId || '',
        repoId: row.repoId || '', queueMode: row.queueMode || '',
      });
    });
    const active = String(record.activeTaskId || expectedTaskId || (rows[rows.length - 1] || {}).taskId || '');
    if (active && ctx._collabTasks.has(active)) _selectCollabTask(active, { keepPicker: true });
  }

  async function _openTask(taskId, title, options) {
    const id = String(taskId || '').trim();
    if (!id) return false;
    let opts = options || {};
    const seq = ++ctx._taskOpenSeq;
    let current = _viewGuard();
    let taskSnapshot = opts.task && typeof opts.task === 'object' ? opts.task : null;
    if (!taskSnapshot && global.SoduWorkAPI && typeof SoduWorkAPI.getTask === 'function') {
      try { taskSnapshot = await SoduWorkAPI.getTask(id); } catch (_) { taskSnapshot = null; }
    }
    if (seq !== ctx._taskOpenSeq || !current()) return false;
    if (!taskSnapshot || taskSnapshot.canViewExecution === false) {
      if (taskSnapshot) global.RequirementsDetail?.open(id);
      else global.petSay?.('需求暂时无法读取，请重试');
      return false;
    }
    // Validate before changing project, active work or the native handle.
    if (opts.reuseCurrent && ctx._ref) {
      const reason = global.RequirementSessionContext?.compatibility(taskSnapshot, _sessionContext());
      if (reason) { ctx._taskOpenError = reason; return false; }
    }
    // Compare against the previous session before changing any task context.
    const currentProjectId = String(ctx._sessionOptions.projectId ||
      (ctx._collaborationTask && ctx._collaborationTask.projectId) || '').trim();
    const taskProjectId = String(opts.projectId || taskSnapshot && taskSnapshot.projectId ||
      taskSnapshot && taskSnapshot.project && taskSnapshot.project.id || '').trim();
    const taskRepoId = String(opts.repoId || taskSnapshot && taskSnapshot.repoId || taskSnapshot && taskSnapshot.repo && taskSnapshot.repo.id || '').trim();
    const queueMode = _collabQueueMode({ queueMode: opts.queueMode }, taskSnapshot || {});
    const mapped = global.ChatCollaborationStore && typeof ChatCollaborationStore.findByTask === 'function'
      ? ChatCollaborationStore.findByTask(id) : null;
    const projectMapped = taskProjectId && global.ChatCollaborationStore &&
      typeof ChatCollaborationStore.findByProject === 'function'
      ? ChatCollaborationStore.findByProject(taskProjectId) : null;
    const label = String(title || (taskSnapshot && taskSnapshot.title) ||
      (mapped && mapped.title) || '\u5f53\u524d\u534f\u4f5c\u9700\u6c42').trim();
    const selection = { adapterId: ctx._sessionOptions.adapterId,
      modelName: ctx._sessionOptions.modelName, reasoningEffort: ctx._sessionOptions.reasoningEffort,
      ...(opts.sessionOptions || {}) };
    const recoveryScope = taskRecoveryScope(taskSnapshot);
    ctx._taskOpenPending = true;
    ctx._taskOpenError = '';
    ctx._render();
    const exactChatId = opts.forceNew ? '' : String(opts.chatId || taskSnapshot?.workRouting?.conversationTurn?.conversationId ||
      (mapped && mapped.conversationId) || '');
    if (!opts.forceNew && ctx._ref && ctx._collaborationTaskId === id && ctx._snap && !_taskSnapshotIsStale() &&
        (!exactChatId || exactChatId === ctx._sessionId)) {
      // Restored collaboration cards are UI metadata. Confirm the native binding
      // before enabling a review turn, even when this requirement is already visible.
      if (opts.acceptanceExecutionSession === true || opts.preferredConversation === true) {
        const bound = await _persistTaskBinding(id, label);
        if (seq !== ctx._taskOpenSeq || !current()) return false;
        if (!bound) { ctx._taskOpenPending = false; ctx._render(); return false; }
      }
      _bindCollaborationTask(id, label, { persist: false, taskMeta: taskSnapshot || {},
        projectId: taskProjectId, repoId: taskRepoId, queueMode });
      _activateAcceptanceContext(opts, taskSnapshot, label);
      ctx._taskOpenPending = false;
      ctx._render();
      if (opts.reworkSession) _prefillReworkInput(taskSnapshot, label);
      return true;
    }
    const reuseCurrent = Boolean(opts.reuseCurrent || opts.source === 'task-add');
    const sameProject = Boolean(!opts.navigation && !exactChatId && ctx._ref && ctx._snap && !_taskSnapshotIsStale() && taskProjectId &&
      currentProjectId && taskProjectId === currentProjectId && (ctx._collabTasks.size || reuseCurrent));
    if (ctx._ref && ctx._snap && !_taskSnapshotIsStale() && !opts.forceNew && (reuseCurrent || sameProject)) {
      const bound = await _persistTaskBinding(id, label);
      if (seq !== ctx._taskOpenSeq || !current()) return false;
      if (!bound) { ctx._taskOpenPending = false; return false; }
      ctx._sessionOptions = {...ctx._sessionOptions, projectId: currentProjectId || taskProjectId,
        repoId: ctx._sessionOptions.repoId || taskRepoId, queueMode};
      _bindCollaborationTask(id, label, { persist: false, taskMeta: taskSnapshot || {},
        projectId: taskProjectId, repoId: taskRepoId, queueMode });
      ctx._taskOpenPending = false;
      ctx._render();
      return true;
    }
    const mappedChatId = opts.forceNew ? '' : String(exactChatId ||
      (!opts.navigation && projectMapped && projectMapped.conversationId) || '');
    // Viewing another archive restores that archive's own choice. An explicit
    // dispatch supplies sessionOptions, including an intentional empty default.
    if (mappedChatId) {
      if (!Object.hasOwn(opts.sessionOptions || {}, 'modelName')) delete selection.modelName;
      if (!Object.hasOwn(opts.sessionOptions || {}, 'reasoningEffort')) delete selection.reasoningEffort;
    }
    // A reserved or released archive can retain its id without a live handle.
    // Explicit new execution must clear it before _ensure falls back to that id.
    if ((ctx._ref || (opts.forceNew && ctx._sessionId)) &&
        (!ctx._sessionId || !mappedChatId || String(mappedChatId) !== String(ctx._sessionId))) ctx.reset();
    current = _viewGuard(true);
    // A task may already belong to this shared conversation. Its requested
    // runtime cannot relabel an existing native handle without opening it.
    const openingOptions = { ...(!ctx._ref ? selection : {}), taskRef: id, taskTitle: label, taskSession: true,
      projectId: taskProjectId || (reuseCurrent ? currentProjectId : ''),
      repoId: taskRepoId || (reuseCurrent ? ctx._sessionOptions.repoId || '' : ''), queueMode, attachTask: true,
      acceptanceSession: opts.acceptanceSession === true,
      acceptanceExecutionSession: opts.acceptanceExecutionSession === true,
      acceptanceMode: opts.acceptanceMode === 'auto' ? 'auto' : 'manual',
      approvalId: (opts.acceptanceSession || opts.acceptanceExecutionSession) ? String(opts.approvalId || '') : '',
      acceptanceAttachmentIds: (opts.acceptanceSession || opts.acceptanceExecutionSession) && Array.isArray(opts.acceptanceAttachmentIds)
        ? [...new Set(opts.acceptanceAttachmentIds.map(String))].slice(0, 60) : [],
      reworkSession: opts.reworkSession === true && opts.forceNew === true };
    // Adding an existing task to a never-started work draft is the same action
    // as adding it to an ordinary chat: open that archive, then use bindTask.
    // A task created here must retain the saved-receipt/native validation path.
    const draftId = String(ctx._sessionId || '');
    // A verified creation archive may contain ordinary messages without a task
    // binding. Open it normally, then use the existing authoritative bindTask
    // operation; do not replace that conversation on a binding mismatch.
    let bindAfterDraftOpen = Boolean(mappedChatId && !taskSnapshot?.workRouting?.conversationTurn?.conversationId &&
      (opts.preferredConversation === true || opts.acceptanceExecutionSession === true));
    if ((opts.source === 'task-add' || opts.reuseCurrent === true) && !opts.navigation && !opts.forceNew &&
        !opts.acceptanceSession && !opts.acceptanceExecutionSession && !opts.reworkSession &&
        !ctx._ref && ctx._snap?.workOnly === true && draftId && (!mappedChatId || mappedChatId === draftId) &&
        isPickableTask(taskSnapshot) && typeof ctx._workCards?.hasCreatedTask === 'function' &&
        !ctx._workCards.hasCreatedTask(id, draftId)) {
      let saved;
      try { saved = await ctx._workCards.flush?.({sessionId:draftId}); }
      catch (error) { saved = {ok:false, reason:String(error?.message || error)}; }
      if (seq !== ctx._taskOpenSeq || !current() || ctx._sessionId !== draftId || saved?.stale) return false;
      if (saved?.ok !== true) {
        ctx._taskOpenPending = false;
        ctx._taskOpenError = saved?.reason || '工作卡片尚未保存，请重试';
        ctx._render(); return false;
      }
      // Creation can finish while the draft save is pending. Never downgrade
      // that newly available receipt to the ordinary task-attachment path.
      bindAfterDraftOpen = !ctx._workCards.hasCreatedTask(id, draftId);
    }
    ctx._sessionOptions = { ...ctx._sessionOptions, ...openingOptions,
      ...(bindAfterDraftOpen ? {taskRef:'', taskTitle:'', taskSession:false, attachTask:false} : {}) };
    let opened = await ctx._ensure(mappedChatId);
    if (seq !== ctx._taskOpenSeq || !current()) return false;
    // An unstarted task can outlive an empty local draft discarded at shutdown.
    // A stale collaboration mapping (a conversation the user already deleted, or
    // a shell that never archived) must not lock the task out: fall back to a
    // fresh conversation and drop the dead binding, for any open/retry source.
    const recoverDeletedRework = opts.source === 'rework' && opts.reworkSession === true &&
      !opts.chatId && mappedChatId && ctx._snap?.sessionNotFound === true;
    const recoverMissingDraft = ['task-dispatch', 'task-open', 'task-retry'].includes(opts.source) &&
      taskSnapshot?.status === 'todo' && !opts.chatId &&
      !taskSnapshot?.workRouting?.conversationTurn?.conversationId &&
      mappedChatId && ctx._snap?.sessionNotFound === true;
    let recoverWeakBinding = false;
    // A creation receipt can point at the conversation where the task was
    // drafted, without that archive ever having an execution binding. Only an
    // explicit first dispatch may replace this local hint after the main
    // process rejects it with the exact binding code. Other failures stay put.
    if (!opened && opts.source === 'task-dispatch' && !opts.chatId && !reuseCurrent && !opts.reuseConversation &&
        !opts.acceptanceSession && !opts.acceptanceExecutionSession && !opts.reworkSession &&
        isPickableTask(taskSnapshot) && !taskSnapshot?.workRouting?.conversationTurn?.conversationId &&
        mappedChatId && String(mapped?.conversationId || '') === mappedChatId &&
        ctx._snap?.sessionOpenCode === 'TASK_BINDING_MISMATCH') {
      let latest = null;
      try { latest = await global.SoduWorkAPI.getTask(id); } catch (_) { /* fail closed */ }
      if (seq !== ctx._taskOpenSeq || !current()) return false;
      const latestMapping = global.ChatCollaborationStore?.findByTask?.(id);
      recoverWeakBinding = String(latest?.id || '') === id && isPickableTask(latest) &&
        !latest?.workRouting?.conversationTurn?.conversationId &&
        String(latestMapping?.conversationId || '') === mappedChatId;
      if (recoverWeakBinding && taskRecoveryScope(latest) !== recoveryScope) {
        ctx._taskOpenError = '需求的执行配置已更新，请刷新后重新安排';
        recoverWeakBinding = false;
      }
      if (recoverWeakBinding) taskSnapshot = latest;
    }
    /* The main process may confirm a deleted active archive after the history probe.
       Recover navigation with a new collaboration archive and retained task context.
       Explicit acceptance and rework retain their separate execution semantics. */
    const recoverMissingExecution = !opened && !reuseCurrent && !opts.reuseConversation &&
      !opts.acceptanceSession && !opts.acceptanceExecutionSession && !opts.reworkSession &&
      taskSnapshot?.status && taskSnapshot.status !== 'todo' &&
      ctx._snap?.sessionNotFound === true;
    const recoverMissingPreferred = !opened && opts.preferredConversation === true &&
      ctx._snap?.sessionNotFound === true;
    const recoverMissingReview = !opened && opts.acceptanceExecutionSession === true &&
      ctx._snap?.sessionNotFound === true;
    if (!opened && seq === ctx._taskOpenSeq && (recoverDeletedRework || recoverMissingDraft ||
        recoverWeakBinding || recoverMissingExecution || recoverMissingPreferred || recoverMissingReview)) {
      if (recoverWeakBinding && global.ChatCollaborationStore) {
        ChatCollaborationStore.removeTask(mappedChatId, id);
      }
      if (recoverMissingExecution && global.ChatCollaborationStore && mappedChatId) {
        ChatCollaborationStore.removeTask(mappedChatId, id);
      }
      // _ensure('') otherwise falls back to the retained _sessionId. Reset the
      // rejected archive first, then restore only this request's choices and
      // task context, so its old workspace/model cannot leak into the new chat.
      ctx.reset();
      current = _viewGuard(true);
      if (recoverMissingReview) {
        openingOptions.acceptanceSession = true;
        openingOptions.acceptanceExecutionSession = false;
        openingOptions.acceptanceFallbackFrom = mappedChatId;
        opts = {...opts, acceptanceSession:true, acceptanceExecutionSession:false};
      }
      ctx._sessionOptions = { ...openingOptions, ...(recoverDeletedRework ? {reworkSession: true} : {}) };
      ctx._taskOpenPending = true;
      opened = await ctx._ensure();
      if (seq !== ctx._taskOpenSeq || !current()) return false;
      if (opened && !recoverWeakBinding && !recoverMissingExecution && global.ChatCollaborationStore) {
        ChatCollaborationStore.removeTask(mappedChatId, id);
      }
    }
    // Explicit archive/reuse failures stay visible and retryable. Requirement
    // navigation with a confirmed missing archive has already taken the
    // guarded fresh-session path above.
    if (seq !== ctx._taskOpenSeq || !current()) return false;
    if (!opened) {
      ctx._taskOpenPending = false;
      if (!ctx._taskOpenError) ctx._taskOpenError = ctx._snap?.statusText || '无法建立这项需求的协作会话';
      ctx._render();
      return false;
    }
    if (bindAfterDraftOpen) {
      const bound = await _persistTaskBinding(id, label);
      if (seq !== ctx._taskOpenSeq || !current()) return false;
      if (!bound) { ctx._taskOpenPending = false; ctx._render(); return false; }
    }
    _bindCollaborationTask(id, label, { persist: false, taskMeta: taskSnapshot || {},
      projectId: taskProjectId, repoId: taskRepoId, queueMode });
    if (!bindAfterDraftOpen && (!ctx._boundFromServer || opts.acceptanceExecutionSession === true)) {
      const bound = await _persistTaskBinding(id, label);
      if (seq !== ctx._taskOpenSeq || !current()) return false;
      if (!bound) { ctx._taskOpenPending = false; ctx._render(); return false; }
    }
    ctx._taskOpenPending = false;
    ctx._render();
    if (opts.acceptanceSession || opts.acceptanceExecutionSession) {
      let acceptanceTask = taskSnapshot || {id, title: label};
      if (opts.forceNew && !acceptanceTask.attachments?.length && typeof global.SoduWorkAPI?.listAttachments === 'function') {
        try {
          const listed = await global.SoduWorkAPI.listAttachments(id);
          const rows = (Array.isArray(listed) ? listed : listed?.attachments || [])
            .filter(file => !file || typeof file === 'string' || String(file.role || '') !== 'rework_input');
          if (rows.length) acceptanceTask = {...acceptanceTask, attachments: rows};
        } catch (_) { /* attachment names are an enhancement; send-time loading remains authoritative */ }
      }
      if (seq !== ctx._taskOpenSeq || !current()) return false;
      const input = ctx._mount()?.querySelector('#nchatInput');
      if (input && !input.value) {
        input.value = acceptanceDraft(acceptanceTask, opts.acceptanceMode === 'auto' ? 'auto' : 'manual');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    const newReworkSession = opts.reworkSession === true && (opts.forceNew === true || recoverDeletedRework);
    if (newReworkSession) {
      const input = ctx._mount()?.querySelector('#nchatInput');
      const feedback = taskSnapshot?.workRouting?.reworkPending?.feedback || '';
      let reworkTask = taskSnapshot || {id, title: label};
      if (!reworkTask.attachments?.length && typeof global.SoduWorkAPI?.listAttachments === 'function') {
        try {
          const listed = await global.SoduWorkAPI.listAttachments(id);
          const rows = Array.isArray(listed) ? listed : listed?.attachments || [];
          if (rows.length) reworkTask = {...reworkTask, attachments: rows};
        } catch (_) { /* send-time task-input loading remains authoritative */ }
      }
      if (seq !== ctx._taskOpenSeq || !current()) return false;
      if (input && !input.value) {
        input.value = reworkDraft(reworkTask, feedback);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    if (opts.reworkSession && !newReworkSession) _prefillReworkInput(taskSnapshot, label);
    return true;
  }

    return { _taskExecutionConfig, _collabState, _ensureCollabView, _collabAction, _openTaskPicker, _selectCollabTask, _loadCollabTask, _restoreTaskTranscript, _clearFinishedAcceptanceContext, _loadCollabRun, _scheduleCollabPoll, _taskSnapshotIsStale, _isEmptyStalledSnapshot, _collabTerminal, _collabRunning, _collabStatus, _collabEntryStatus, _collabEntries, _collabQueueMode, _collabProjectId, _setCollabEntryStatus, _nextCollabEntry, _persistTaskBinding, _bindCollaborationTask, _restoreCollaboration, _openTask, _renderTaskStartPrompt, _startTask, _startTaskCommand, enqueueTask };
  }
  global.ChatTaskController = { create, isPickableTask, acceptanceDraft, reworkDraft, acceptanceResolution };
})(window);
