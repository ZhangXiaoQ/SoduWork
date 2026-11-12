/* Dispatch reuses the original conversation state, view generation, and persistent binding without copying controller state. */
(function (global) {
  'use strict';
  function isPickableTask(task) {
    if (!task || !task.id || task.readOnly || task.canViewExecution === false || task.archivedAt ||
        task.requirementStage === 'reviewing' ||
        ['intake', 'clarifying'].includes(task.triageStage) || task.status !== 'todo') return false;
    const idle = new Set(['', 'failed', 'cancelled', 'canceled', 'stopped', 'interrupted']);
    const receipt = (task.workRouting || {}).conversationTurn || {};
    const ai = task.ai || {};
    return idle.has(String(receipt.state || '').toLowerCase()) &&
      idle.has(String(ai.state || '').toLowerCase()) &&
      idle.has(String(ai.executionState || '').toLowerCase());
  }

  function create(ctx, {
    _viewGuard, _sessionContext, _collabEntryStatus, _persistTaskBinding,
    _bindCollaborationTask, _setCollabEntryStatus, _openTaskPicker, _openTask,
  }) {
    function _taskExecutionConfig(task, requested) {
      const item = task || {}, opts = requested || {}, routing = item.workRouting || {};
      // Represent only the executor's explicit selection; the main process and Hub still validate permissions, directories, and pending state.
      if (opts.executionChoice === 'native') return {controlled:false, adapterId:'pi', config:{...opts,
        agentId:'local:pi', assigneeType:'agent', repo:{}, bindingId:'', model:'', reasoningEffort:'', reuseConversation:false,
        executionContext:{strategy:'direct',agent:{id:'local:pi',cli:'pi'},runner:{mode:'local'}}}};
      const context = { ...(item.executionContext || routing.executionContext || {}), ...(opts.executionContext || {}) };
      const agent = context.agent || {}, runner = context.runner || {};
      const agentId = String(opts.agentId || agent.id || agent.key || context.agentId ||
        item.agentId || context.agentKind || (agent.cli ? 'local:' + agent.cli : '') || '').trim();
      const repo = opts.repo || context.repo || item.repo || {};
      const bindingId = opts.bindingId || item.workflowBindingId || context.workflowId || context.workflowBindingId ||
        context.plugin?.bindingId || routing.workflowBindingId || routing.selectedWorkflowBindingId || '';
      const assigneeType = opts.assigneeType || context.assigneeType || 'agent';
      const controlled = !opts.reuseConversation && Boolean(bindingId || context.strategy === 'workflow' || routing.selectedStrategy === 'workflow' ||
        assigneeType === 'squad' || item.repoId || context.repoId || repo.id || repo.path ||
        runner.mode === 'remote' || runner.remote === true || context.location?.mode === 'remote' || /^runner:/.test(agentId));
      // A requested/context default is explicit. The index's normalized empty
      // top-level model is only missing metadata, not a new execution choice.
      const reuseDraft = !controlled && ctx._snap?.workOnly === true && ctx._sessionId &&
        !opts.forceNew && (!opts.chatId || opts.chatId === ctx._sessionId) &&
        (opts.source !== 'task-dispatch' || opts.reuseConversation);
      const model = String(opts.model !== undefined ? opts.model :
        context.model ?? (item.model || (reuseDraft ? ctx._sessionOptions.modelName : '')) ?? '').trim();
      return { controlled, adapterId: controlled ? '' : agentId.replace(/^local:/, ''),
        config: { ...opts, agentId, assigneeType, repo, bindingId, model,
          reasoningEffort: opts.reasoningEffort ?? context.reasoningEffort ??
            (reuseDraft ? ctx._sessionOptions.reasoningEffort : '') ?? '', executionContext: context } };
    }
    function _renderTaskStartPrompt() {
      const box = document.getElementById('nchatTaskSuggest');
      const prompt = ctx._taskStartPrompt;
      if (!box) return;
      if (ctx._sessionOptions.acceptanceSession || ctx._sessionOptions.acceptanceExecutionSession) {
        // Acceptance sessions populate task context in the editor. Users select plugins through
        // the existing editor entry point; avoid a duplicate card implying mandatory configuration.
        box.replaceChildren();
        box.classList.remove('show');
        return;
      }
      if (!prompt) {
        if (!ctx._pendingProposal) { box.classList.remove('show'); box.innerHTML = ''; }
        return;
      }
      if (prompt.kind === 'dispatch') {
        box.innerHTML = '<span class=nts-copy><b>选择执行 Agent</b><i>沿用需求已保存的工程、分支和模型配置</i></span>' +
          '<select id=nchatTaskAgent class=nts-agent-select>' +
          (prompt.agents || []).map((row) => '<option value=' + ctx.esc(row.id) + '>' +
            ctx.esc(row.name || row.label || row.id) + '</option>').join('') +
          '</select><button class=nts-create data-task-start-dispatch>开始执行</button>' +
          '<button class=nts-close data-task-start-cancel aria-label=取消>×</button>';
      } else if (prompt.kind === 'confirm') {
        box.innerHTML = '<span class="nts-mark"><svg viewBox="0 0 24 24"><path d="M12 4v16M4 12h16"/></svg></span>' +
          '<span class="nts-copy"><b>开始执行这个需求？</b><i>' + ctx.esc(prompt.title || '当前需求') +
          ' · 将沿用已保存的执行配置</i></span><button class="nts-create" data-task-start-confirm>开始</button>' +
          '<button class="nts-close" data-task-start-cancel aria-label="取消">×</button>';
      } else {
        box.innerHTML = '<span class="nts-copy"><b>选择要开始的需求</b><i>只显示你当前可以执行的需求</i></span>' +
          '<span class="nts-task-options">' + (prompt.tasks || []).map((task) =>
            '<button type="button" data-task-start-id="' + ctx.esc(task.id) + '">' +
            ctx.esc(task.title || '未命名需求') + '</button>').join('') + '</span>';
      }
      box.classList.add('show');
    }

    async function _startTask(task, options) {
      const api = global.SoduWorkAPI, opts = options || {};
      let item = task || {};
      const id = String(item.id || '');
      if (!api || !id || ctx._collabStarts.has(id)) return false;
      // Reserve the click before any authority read, and release only this
      // view's set so a late result cannot unlock a different conversation.
      const starts = ctx._collabStarts;
      starts.add(id);
      let current = _viewGuard(true);
      try {
        // The collaboration index has taskId and display fields only. Unlike
        // Hub tasks it has neither routing nor execution context; never start
        // from that partial snapshot while its background refresh is pending.
        const indexOnly = String(item.taskId || '') === id &&
          !Object.hasOwn(item, 'workRouting') && !Object.hasOwn(item, 'executionContext');
        if ((indexOnly || item.readOnly || item.canViewExecution === false || item.archivedAt ||
            ['intake', 'clarifying'].includes(item.triageStage)) && typeof api.getTask === 'function') {
          const reading = _viewGuard(), entry = ctx._collabTasks.get(id), removed = entry?.queueRemoved;
          const live = await api.getTask(id);
          if (!reading() || (entry && (ctx._collabTasks.get(id) !== entry || !removed && entry.queueRemoved))) return false;
          if (!live || String(live.id || '') !== id) throw new Error('需求不存在或已变化，请在需求池重新确认');
          // Replace instead of merging: synthesized empty index fields must
          // not survive when the authoritative task omits that choice.
          item = live;
          if (indexOnly && !isPickableTask(item))
            throw new Error('这条需求暂时不能开始，请先在需求池确认准备阶段和执行权限');
        } else if (indexOnly) throw new Error('需求详情暂时无法读取，请重新打开后重试');
        if (item.readOnly || item.canViewExecution === false || item.archivedAt ||
            ['intake', 'clarifying'].includes(item.triageStage)) {
          if (typeof global.petSay === 'function') global.petSay('这条需求暂时不能开始，请先在需求池确认准备阶段和执行权限');
          return false;
        }
        const existing = ctx._collabTasks.get(id);
        if (existing && /^(starting|dispatching|doing|running|executing|streaming|queued)$/.test(
          _collabEntryStatus(existing)) && existing.nativeTurn) return false;
        const reuseConversation = opts.taskExecution?.reuseConversation ?? existing?.reuseConversation ?? Boolean(ctx._snap?.requirementContext);
        if (reuseConversation) {
          const reason = global.RequirementSessionContext?.compatibility(item, _sessionContext());
          if (reason) throw new Error(reason);
        }
        const selection = _taskExecutionConfig(item, { ...(reuseConversation ? {reuseConversation:true} : {}), ...(opts.taskExecution || {}),
          ...(opts.candidate ? { agentId: opts.candidate.id || opts.candidate.cliName } : {}) });
        const config = selection.config;
        const context = config.executionContext;
        const routing = item.workRouting || {};
        let bindingId = config.executionChoice === 'native' ? '' : (config.bindingId || context.workflowId || context.workflowBindingId ||
          context.plugin && context.plugin.bindingId || item.workflowBindingId || routing.workflowBindingId || routing.selectedWorkflowBindingId || '');
        if (config.executionChoice !== 'native' && !bindingId && (routing.selectedStrategy === 'workflow' || context.strategy === 'workflow')) {
          const result = await api.taskExecutionOptions({ taskId: id, projectId: item.projectId || '', repoId: item.repoId || '' });
          if (!current()) return false;
          bindingId = (result.recommendation || {}).workflowBindingId || '';
          if (!bindingId) throw new Error('需求选择的工作流尚不可用，请补充执行配置');
        }
        config.bindingId = bindingId;
        if (!bindingId) {
          const controlled = selection.controlled;
          let wanted = config.agentId;
          if (controlled && !wanted) {
            const result = await api.listAIAgents();
            if (!current()) return false;
            const available = (result.agents || []).filter(row => row.online !== false && row.available !== false);
            if (available.length !== 1) {
              ctx._taskStartPrompt = { kind: 'dispatch', task: item, title: item.title, agents: available, retry: opts.retry };
              _renderTaskStartPrompt(); return false;
            }
            wanted = available[0].id;
          }
          config.agentId = wanted;
          if (!controlled && !ctx._ref) ctx._sessionOptions = { ...ctx._sessionOptions,
            adapterId: wanted.replace(/^local:/, '') || ctx._sessionOptions.adapterId || 'pi',
            modelName: config.model, reasoningEffort: config.reasoningEffort };
          if (!controlled && ctx._ref && wanted && wanted.replace(/^local:/, '') !== String(ctx._sessionOptions.adapterId || 'pi'))
            throw new Error('需求选择的 Agent 与当前对话不同，请确认执行配置，已有对话不会被更换底座');
        }
        const ready = await ctx._ensure();
        if (!current()) return false;
        current = _viewGuard();
        if (!ready) throw new Error('当前会话还没有准备好');
        if (!bindingId && !selection.controlled) {
          if (selection.adapterId && selection.adapterId !== String(ctx._sessionOptions.adapterId || 'pi'))
            throw new Error('需求选择的 Agent 与当前对话不同，请确认执行配置，已有对话不会被更换底座');
          if (config.model && config.model !== ctx._workModel())
            throw new Error('当前会话使用的模型与派活选择不同，请先在会话中确认模型，避免静默更换配置');
        }
        if (!(await _persistTaskBinding(id, item.title)) || !current()) return false;
        _bindCollaborationTask(id, item.title, { persist: false, taskMeta: item,
          projectId: item.projectId || '', repoId: item.repoId || '', queueMode: 'serial' });
        const entry = ctx._collabTasks.get(id);
        if (global.ChatCollaborationStore && typeof ChatCollaborationStore.setQueueRemoved === 'function' &&
            !ChatCollaborationStore.setQueueRemoved(ctx._sessionId || ctx._ref, id, false)) {
          throw new Error('需求队列未能保存，请重试');
        }
        entry.nativeTurn = true; entry.reuseConversation = reuseConversation; entry.queueRemoved = false; entry.queueState = 'queued';
        ctx._taskStartPrompt = null;
        const accepted = await ctx._send(opts.instruction || item.note || item.description || item.title, {
          taskId: id, taskTitle: item.title || '', retry: opts.retry === true, taskExecution: config,
          submissionId: opts.submissionId || '', useComposer: opts.fromComposer === true,
        });
        if (!current()) return Boolean(accepted);
        if (!accepted) _setCollabEntryStatus(entry, 'failed', 'failed');
        ctx._render(); ctx.refreshHistory(); return Boolean(accepted);
      } catch (error) {
        if (!current()) return false;
        _setCollabEntryStatus(ctx._collabTasks.get(id), 'failed', 'failed');
        ctx._taskOpenError = String(error && error.message || error);
        if (typeof petSay === 'function') petSay(ctx._taskOpenError);
        ctx._render(); return false;
      } finally { starts.delete(id); }
    }

    async function _startTaskCommand() {
      if (ctx._collaborationTaskId) {
        ctx._taskStartPrompt = { kind: 'confirm', title: ctx._collaborationTask && ctx._collaborationTask.title };
        ctx._dismissProposal(true); _renderTaskStartPrompt(); return true;
      }
      ctx._dismissProposal(true); await _openTaskPicker();
      return true;
    }

    async function enqueueTask(taskId, options) {
      let opts = options || {};
      const current = _viewGuard();
      const task = await global.SoduWorkAPI.getTask(taskId);
      if (!current()) return {ok:false,reason:'会话已切换，需求未发送，请在目标会话重试'};
      if (!task) return { ok: false, reason: '需求不存在' };
      if (!isPickableTask(task)) return { ok: false, reason: '需求尚未准备好、已开始执行或无执行权限，请在需求池查看当前状态' };
      if (opts.source === 'task-dispatch' && !opts.forceNew && !opts.chatId && !opts.reuseConversation) {
        const original = await global.TaskConversationNavigation?.preferredConversation?.(task);
        if (!current()) return {ok:false,reason:'会话已切换，需求未发送，请在目标会话重试'};
        if (original) opts = {...opts, chatId: original, preferredConversation: true};
      }
      const selection = _taskExecutionConfig(task, opts), config = selection.config;
      const ec = config.executionContext, controlled = selection.controlled, kind = selection.adapterId;
      const info = ctx.sessionInfo();
      const hasExecutionReceipt = Boolean(task.workRouting?.conversationTurn?.conversationId);
      // Same-owner dispatch reuses verified provenance; unrelated visible chats remain isolated.
      const firstDispatch = opts.source === 'task-dispatch' && task.status === 'todo' &&
        !hasExecutionReceipt && !opts.reuseConversation && !opts.chatId;
      const forceNew = opts.forceNew === true || firstDispatch;
      const taskNavigation = (forceNew || opts.source === 'task-dispatch') && !opts.reuseConversation;
      if (opts.reuseConversation && ctx._ref && (!opts.chatId || opts.chatId === ctx._sessionId)) {
        const reason = global.RequirementSessionContext?.compatibility(task, _sessionContext());
        if (reason) return {ok:false,reason};
      }
      const sessionOptions = !controlled ? { adapterId: kind || info.adapterId || 'pi',
        modelName: config.model, reasoningEffort: config.reasoningEffort } : {};
      if (!ctx._ref && !opts.reuseConversation) ctx._sessionOptions = { ...ctx._sessionOptions, ...sessionOptions };
      const validatingCurrent = !opts.chatId || opts.chatId === ctx._sessionId;
      if (!taskNavigation && validatingCurrent && ctx._ref && kind && kind !== info.adapterId) return { ok: false,
        reason: '当前会话使用 ' + info.adapterId + '，请先打开 ' + kind + ' 会话再派活，已有对话不会被更换底座' };
      if (!taskNavigation && validatingCurrent && ctx._ref && !controlled && config.model && config.model !== ctx._workModel()) return { ok: false,
        reason: '当前会话使用的模型与派活选择不同，请先在会话中确认模型，避免静默更换配置' };
      const opened = await _openTask(taskId, task.title, { source: 'task-dispatch',
        task, ...(opts.reuseConversation ? {} : {sessionOptions}), forceNew, chatId: opts.chatId || '', navigation: taskNavigation,
        preferredConversation: opts.preferredConversation === true,
        reuseCurrent: opts.reuseConversation ? (!opts.chatId || opts.chatId === ctx._sessionId) :
          !taskNavigation && (!task.projectId || !info.projectId || task.projectId === info.projectId) });
      if (!opened) return { ok: false, reason: ctx._taskOpenError || '需求会话未能打开' };
      if (opts.reuseConversation) {
        const reason = global.RequirementSessionContext?.compatibility(task, _sessionContext());
        if (reason) return {ok:false,reason};
      }
      const conversationId = ctx._sessionId;
      const accepted = await _startTask({ ...task, executionContext: ec }, { taskExecution: config, instruction: opts.brief });
      return { ok: accepted, task, conversationId, queued: accepted,
        ...(accepted ? {} : { reason: ctx._taskOpenError || '需求未能进入会话队列，请查看会话提示' }) };
    }
    return { _taskExecutionConfig, _renderTaskStartPrompt, _startTask, _startTaskCommand, enqueueTask };
  }
  global.ChatTaskStart = { create, isPickableTask };
})(window);
