/* Viewing a task is navigation, never dispatch. Use the same native conversation
   as the recent-chat list; project affinity is only for explicitly attaching a task. */
(function (global) {
  'use strict';
  const pending = new Map();
  const acceptanceSessions = new Map();
  let generation = 0;
  const text = value => String(value || '').trim();
  function remoteExecutionId(payload, task) {
    const context = task?.workRouting?.executionContext || {};
    if (payload.navigation === false || payload.reuseCurrent || payload.forceNew ||
        payload.acceptanceSession || payload.acceptanceExecutionSession ||
        ['acceptance', 'rework', 'task-add', 'task-create', 'task-dispatch'].includes(payload.source)) return '';
    return ['requirement', 'bug', 'ticket', 'improvement', 'other'].includes(task?.kind) &&
      task.status !== 'todo' && context.location?.mode === 'remote' && text(context.runner?.runnerId)
      ? 'task-execution:' + text(task.id) : '';
  }
  function taskIds(row) {
    return [row.taskId, ...(row.taskIds || []), ...(row.taskBindings || []).map(x => x.taskId)].map(text);
  }
  async function preferredConversation(task) {
    const epoch = generation, owner = global.SoduWorkAPI?.taskStorageKey?.('ops');
    const capability = global.__teamCap?.meId ? global.__teamCap : await global.SoduWorkAPI?.getTeamCapability?.();
    const me = text(capability?.meId);
    if (epoch !== generation || owner !== global.SoduWorkAPI?.taskStorageKey?.('ops'))
      throw Error('账号或会话已变化，请重新打开需求');
    if (!me || text(task?.createdBy) !== me || text(task?.assigneeUserId || task?.executorUserId) !== me) return '';
    const execution = text(task?.workRouting?.conversationTurn?.conversationId);
    if (execution) return execution;
    const sessions = global.soduWorkAPI?.conversationSession || global.soduWorkAPI?.piSession;
    if (!sessions?.findTaskCreation) return '';
    const result = await sessions.findTaskCreation(task.id);
    if (epoch !== generation || owner !== global.SoduWorkAPI?.taskStorageKey?.('ops'))
      throw Error('账号或会话已变化，请重新打开需求');
    if (!result?.ok) throw Error(result?.reason || '原会话暂时无法读取，请重试');
    return text(result.sessionId);
  }
  function resolve(payload, task, info, history, store) {
    const out = Object.assign({}, payload), source = task || {};
    const id = text(out.taskId);
    const viewing = out.navigation !== false && !out.reuseCurrent &&
      !['task-add', 'task-create', 'task-dispatch'].includes(out.source);
    out.navigation = viewing;
    out.projectId = text(out.projectId || source.projectId || source.project?.id);
    out.repoId = text(out.repoId || source.repoId || source.repo?.id);
    if (source.id) out.task = source;
    if (!out.taskTitle) out.taskTitle = text(source.title);
    const remoteId = remoteExecutionId(out, source);
    if (remoteId) {
      out.chatId = remoteId;
      out.forceNew = false;
      return out;
    }
    /*
     * Create a bound review conversation once and reuse it on repeated opens. When execution
     * and review belong to the same user, prefer the execution conversation and fall back only
     * when it is unavailable.
     */
    const acceptance = out.acceptanceSession || out.source === 'acceptance';
    const requestedApproval = text(out.approvalId);
    const requestedExecutionAcceptance = out.reuseExecutionSession === true || out.acceptanceExecutionSession === true;
    const requestedStandaloneAcceptance = acceptance && !requestedExecutionAcceptance && out.acceptanceSession !== false;
    const currentExecutionAcceptance = info?.acceptanceExecutionSession === true;
    const currentStandaloneAcceptance = info?.acceptanceSession === true && !currentExecutionAcceptance;
    const activeModeCompatible = requestedExecutionAcceptance === currentExecutionAcceptance &&
      (requestedExecutionAcceptance || requestedStandaloneAcceptance === currentStandaloneAcceptance);
    const activeAcceptance = acceptance && activeModeCompatible && info?.acceptanceSession === true &&
      text(info.acceptanceTaskId || info.taskId) === id &&
      (!requestedApproval || text(info.acceptanceApprovalId) === requestedApproval) &&
      text(info.sessionId);
    if (activeAcceptance) {
      out.chatId = text(info.sessionId);
      out.forceNew = false;
      out.navigation = false;
      return out;
    }
    if (acceptance && out.reuseExecutionSession) {
      const executionId = text(out.chatId || source.workRouting?.conversationTurn?.conversationId);
      // History is paginated. Only an exact archive open can establish absence.
      if (executionId) {
        out.chatId = executionId;
        out.forceNew = false;
        out.navigation = false;
        /*
         * Do not permanently convert execution conversations into review conversations. Attach a
         * main-process-validated review marker to this turn only.
         */
        out.acceptanceSession = false;
        out.acceptanceExecutionSession = true;
        return out;
      }
      /*
       * Preserve review identity when the original archive is unavailable so the task controller
       * can create a review conversation.
       */
      out.chatId = '';
      out.forceNew = true;
      out.acceptanceSession = true;
      out.acceptanceExecutionSession = false;
      out.navigation = false;
      return out;
    }
    if (acceptance) {
      if (text(out.chatId) && out.forceNew !== true) {
        out.forceNew = false;
        out.navigation = false;
        return out;
      }
      out.chatId = '';
      out.forceNew = true;
      out.navigation = false;
      return out;
    }
    /*
     * Respect explicit rework choices between existing and new conversations; historical
     * mappings must not rebind a requested new conversation.
     */
    if (out.source === 'rework' && out.forceNew) {
      out.chatId = '';
      out.reworkSession = true;
      out.navigation = false;
      return out;
    }
    const receipt = source.workRouting?.conversationTurn || {};
    const released = chatId => Boolean(chatId && store?.isQueueRemoved?.(chatId, id));
    // Release only pending or canceled local mappings; active execution and delivery receipts retain their original conversation.
    const idle = value => ['', 'failed', 'cancelled', 'canceled', 'stopped', 'interrupted'].includes(String(value || '').toLowerCase());
    const canReopen = source.status === 'todo' && !source.readOnly && source.canViewExecution !== false &&
      !source.archivedAt && source.requirementStage !== 'reviewing' && !['intake', 'clarifying'].includes(source.triageStage) &&
      idle(receipt.state) && idle(source.ai?.state) && idle(source.ai?.executionState);
    /*
     * Use _ensure(chatId) to verify rework archives. A limited history list cannot prove
     * deletion; only main-process notFound should trigger new-conversation fallback.
     */
    const turnId = canReopen && released(receipt.conversationId) ? '' : text(receipt.conversationId);
    const durable = (history || []).find(row => taskIds(row).includes(id) && !(canReopen && released(row.id)));
    const mappedId = text(store?.findByTask?.(id)?.conversationId);
    const currentBound = (info.taskIds || []).map(text).includes(id) && !(canReopen && released(info.sessionId));
    /*
     * Deleted or never-archived mappings must not hijack ordinary navigation. Rework uses
     * _ensure(chatId) for authoritative existence checks instead of the limited history
     * window.
     */
    const mapped = mappedId && !(canReopen && released(mappedId)) && (out.source === 'rework' || history == null
      || (currentBound && mappedId === info.sessionId)
      || (history || []).some(row => row.id === mappedId)) ? mappedId : '';
    out.chatId = text(out.chatId || turnId || (currentBound && info.sessionId) || durable?.id || mapped);
    if (out.source === 'rework' && !out.chatId) {
      out.forceNew = true;
      out.reworkSession = true;
      out.navigation = false;
      return out;
    }
    if (!out.chatId && canReopen && !out.reuseCurrent && !out.reuseConversation) {
      out.forceNew = true;
      out.navigation = false;
      return out;
    }
    if (!viewing && out.reuseCurrent && info.sessionId) out.chatId = text(info.sessionId);
    /* When no local conversation is mapped to an active or completed task,
       let the controller create a conversation with requirement context. */
    if (!out.chatId && viewing && !out.reuseCurrent && source.status && source.status !== 'todo') {
      out.forceNew = true;
      out.navigation = false;
      return out;
    }
    if (!out.chatId && !viewing) {
      const sameProject = out.projectId && out.projectId === info.projectId &&
        (info.collaboration || info.hasSelectedAgent);
      out.chatId = text(sameProject ? info.sessionId : store?.findByProject?.(out.projectId)?.conversationId);
    }
    return out;
  }
  async function navigate(id, title, options, seq) {
    const payload = Object.assign({tab: 'chat', taskSession: true, taskId: id, taskTitle: text(title)}, options);
    const acceptanceKey = (payload.acceptanceSession || payload.source === 'acceptance')
      ? id + ':' + text(payload.approvalId)
      : '';
    if (acceptanceKey && !payload.forceNew) {
      const cached = acceptanceSessions.get(acceptanceKey);
      if (cached) {
        /* A cached fresh acceptance session must never be mistaken for the
           original execution archive on the next click. Keep the cache's
           purpose alongside its id so a fallback session remains reusable,
           while a cached continuation keeps its ordinary-session semantics. */
        const cachedId = typeof cached === 'string' ? cached : cached.sessionId;
        const cachedExecution = typeof cached === 'object' && cached.acceptanceExecutionSession === true;
        const cachedStandalone = typeof cached === 'object' && cached.acceptanceSession === true;
        const requestedExecution = payload.reuseExecutionSession === true || payload.acceptanceExecutionSession === true;
        const requestedStandalone = payload.acceptanceSession === true && !requestedExecution;
        const fallbackMatches = requestedExecution && text(payload.chatId) &&
          text(cached.acceptanceFallbackFrom) === text(payload.chatId);
        /*
         * Reuse cached resolution only within the same conversation mode; ownership and reviewer
         * assignments may change between opens.
         */
        const incompatible = (requestedExecution && cachedStandalone && !fallbackMatches) ||
          (requestedStandalone && cachedExecution);
        if (cachedId && !incompatible && (!text(payload.chatId) || fallbackMatches)) {
          payload.chatId = cachedId;
          if (typeof cached === 'object' && cached.acceptanceSession === true) {
            payload.acceptanceSession = true;
            payload.acceptanceExecutionSession = false;
            payload.reuseExecutionSession = false;
          } else if (typeof cached === 'object' && cached.acceptanceExecutionSession === true) {
            payload.acceptanceSession = false;
            payload.acceptanceExecutionSession = true;
            payload.reuseExecutionSession = true;
          }
        }
      }
    }
    // A failed lookup must not manufacture a replacement conversation.
    let task = await global.SoduWorkAPI.getTask(id);
    if (seq !== generation) return false;
    if (!task?.id) throw new Error('需求不存在或无权访问');
    if (payload.source === 'rework' && task.canContinueExecution !== true) {
      throw new Error('只有执行人可以继续修正这条需求');
    }
    if (task.canViewExecution === false) {
      if (global.RequirementsDetail && global.__deskPanel === 'workspace') return global.RequirementsDetail.open(id);
      return global.soduWorkAPI?.openDeskWindow?.({panel: 'workspace', view: 'history', requirementId: id}) || false;
    }
    const info = global.NativeChat?.sessionInfo?.() || {};
    // The main process verifies the exact Hub execution. Local review archives
    // and a paginated sidebar cannot establish the remote session's identity.
    const remoteId = remoteExecutionId(payload, task);
    if (remoteId) payload.chatId = remoteId;
    let history = payload.acceptanceSession && !payload.reuseExecutionSession ? [] : null; // null = archive not consulted (explicit chatId/turnId wins).
    if (payload.acceptanceSession && !payload.reuseExecutionSession && !payload.chatId && !payload.forceNew) {
      const sessions = global.soduWorkAPI?.conversationSession || global.soduWorkAPI?.piSession;
      if (sessions?.history) {
        const result = await sessions.history();
        if (seq !== generation) return false;
        if (result?.ok === false) throw new Error('无法读取验收会话，请重试');
        const matches = (result?.chats || []).filter(row => !row.archived && !row.deleted &&
          row.acceptanceReview?.taskRef === id && row.acceptanceReview?.approvalId === text(payload.approvalId) &&
          row.acceptanceReview?.acceptanceMode === (payload.acceptanceMode || 'manual'));
        matches.sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
        if (matches[0]) payload.chatId = matches[0].id;
      }
    }
    const hubTurnId = text(task?.workRouting?.conversationTurn?.conversationId);
    /*
     * The active execution archive can be absent from the history projection while the
     * native conversation is still open. Keep that authoritative active session instead of
     * treating a missing history row as deletion and creating a second review conversation.
     */
    const activeExecutionSession = Boolean(hubTurnId && text(info.sessionId) === hubTurnId);
    const probeExecution = payload.reuseExecutionSession === true;
    if ((!payload.acceptanceSession || probeExecution) && !payload.chatId && !task?.workRouting?.conversationTurn?.conversationId) {
      const sessions = global.soduWorkAPI?.conversationSession || global.soduWorkAPI?.piSession;
      if (sessions?.history) {
        const result = await sessions.history();
        if (result.ok === false) throw new Error('无法读取会话记录，请重试');
        history = result.chats || [];
      }
    } else if ((!payload.acceptanceSession || probeExecution) && !payload.chatId && hubTurnId) {
      /*
       * Hub conversation receipts do not guarantee a local archive. Probe locally before
       * opening; when absent, use the task-details approval card backed by Hub data.
       */
      const sessions = global.soduWorkAPI?.conversationSession || global.soduWorkAPI?.piSession;
      if (sessions?.history) {
        try {
          const result = await sessions.history();
          if (result && result.ok !== false) {
            history = result.chats || [];
            if (!(history || []).some(row => row.id === hubTurnId) && !activeExecutionSession) {
              payload.chatId = '';
              /*
               * For ordinary review fallback, remove both chatId and the Hub turn receipt so resolve
               * cannot restore an unavailable conversation ID. Preserve rework receipts for
               * controller-managed recovery.
               */
              if (payload.source !== 'rework' && !probeExecution) {
                task = { ...task, workRouting: { ...(task.workRouting || {}), conversationTurn: null } };
              }
            }
          }
        } catch (_) { /* Let normal navigation report the actual error when archive probing fails. */ }
      }
    }
    if (seq !== generation) return false;
    const resolved = resolve(payload, task, info, history, global.ChatCollaborationStore);
    /*
     * Cross-device reviewers can decide through the task-details card without access to the
     * execution archive.
     */
    if (!resolved.chatId && resolved.source === 'approval' && resolved.focusApproval) {
      if (global.__deskPanel === 'workspace' && global.RequirementsDetail) {
        void global.RequirementsDetail.open(id);
        if (typeof global.petSay === 'function')
          global.petSay('执行会话在另一台设备上；在这条需求的详情里核对证据并确认即可。');
        return true;
      }
      if (global.soduWorkAPI?.openDeskWindow)
        return global.soduWorkAPI.openDeskWindow({panel: 'workspace', view: 'history', requirementId: id});
    }
    let result;
    if (global.WorkspaceHost && global.__deskPanel === 'workspace') result = global.WorkspaceHost.open('create', resolved);
    else if (global.soduWorkAPI?.openDeskWindow) result = global.soduWorkAPI.openDeskWindow({...resolved, panel: 'workspace', view: 'create'});
    else result = global.NativeChat?.openTask?.(id, resolved.taskTitle, resolved) || false;
    result = await Promise.resolve(result);
    if (acceptanceKey && result) {
      const infoAfter = global.NativeChat?.sessionInfo?.() || {};
      const confirmedReview = text(infoAfter.acceptanceTaskId) === id &&
        text(infoAfter.acceptanceApprovalId) === text(resolved.approvalId) && infoAfter.acceptanceSession === true;
      const sessionId = text(confirmedReview ? infoAfter.sessionId : resolved.chatId);
      if (sessionId) acceptanceSessions.set(acceptanceKey, {
        sessionId,
        acceptanceSession: confirmedReview ? infoAfter.acceptanceExecutionSession !== true : resolved.acceptanceSession === true,
        acceptanceExecutionSession: confirmedReview ? infoAfter.acceptanceExecutionSession === true : resolved.acceptanceExecutionSession === true,
        acceptanceFallbackFrom: confirmedReview ? text(infoAfter.acceptanceFallbackFrom) : '',
      });
    } else if (acceptanceKey && payload.chatId) {
      /* The cached native archive may have been deleted. Drop it once and let
         the next attempt create the single replacement session. */
      const cached = acceptanceSessions.get(acceptanceKey);
      const cachedId = typeof cached === 'string' ? cached : cached?.sessionId;
      if (!cached || cachedId === payload.chatId) acceptanceSessions.delete(acceptanceKey);
    }
    return result;
  }
  function open(taskId, title, options) {
    const id = text(taskId);
    if (!id) return Promise.resolve(false);
    if (pending.has(id)) return pending.get(id);
    const seq = ++generation;
    // A different navigation supersedes earlier lookups. Keeping their entries
    // would swallow A → B → A: the last click would reuse A's cancelled request.
    pending.clear();
    const work = navigate(id, title, options || {}, seq).catch(() => {
      if (seq === generation && typeof global.petSay === 'function') global.petSay('会话暂时无法打开，请重试。需求和历史内容已保留。');
      return false;
    }).finally(() => { if (pending.get(id) === work) pending.delete(id); });
    pending.set(id, work);
    return work;
  }
  global.TaskConversationNavigation = {resolve, open, preferredConversation, forgetAcceptance(taskId, approvalId) {
    acceptanceSessions.delete(text(taskId) + ':' + text(approvalId));
  }};
  global.openTaskConversation = open;
  global.addEventListener?.('soduwork-data-scope-changed', () => { generation++; pending.clear(); acceptanceSessions.clear(); });
})(window);
