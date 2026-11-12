'use strict';
const agentSource = require('../conversation/agent-source.cjs');

// State remains owned by the session; accessors keep async transitions live.
function create(ctx) {
  const recoveredTasks = new Map();
  // A stop request can wait for a remote controlled task to acknowledge. Keep
  // the promise at the session boundary so repeated UI clicks are idempotent.
  let stopPromise = null;
  const {
    _appendTaskBinding, _messageTitle, _presenceState, _sessions, attachmentContract,
    goalContract, goalQuality, messageTime, runControl, skillTurn,
    snapshotWindow, stream, thinkingCapabilities,
  } = ctx.shared;
  const taskStream = require('../conversation/task-message-stream.cjs');
  const taskMessages = taskStream.create(ctx.acc.state, row => {
    const message = taskStream.nativeMessage(row, ctx.prep.model);
    ctx.piSession.sessionManager.appendMessage(message);
    ctx.piSession.agent.state.messages.push(message);
  });
  /*
   * Use the conversation's original time boundary when resuming, including manifest or cloud
   * resumes without resumePath. Using reopen time would hide earlier outputs and drafts.
   */
  function outputsSince() {
    if (ctx.opts?.resumePath) return 0;
    if (ctx.opts?.resumedConversation) return ctx.pluginOutputSince || 0;
    return ctx.startedAt;
  }
  function completedOutputs(scanned) {
    const journal = ctx.completedOutputJournal;
    return journal && journal.startedAt === ctx.run.startedAt && journal.changes === ctx.handle.fileChanges
      ? require('./outputs').withJournal(scanned, journal.changes) : scanned;
  }
  return {
ref: ctx.ref,
resumeLocation() { return ctx.piSession.sessionManager.getSessionFile(); },
deliveryCaptureAtTurnBoundary: true,
adapterId: 'pi',
displayName: 'Pi',
setAccessPolicy(policy, expectedRevision) { return ctx.liveAccess.change(policy, expectedRevision); },
sessionId: ctx.piSession.sessionId || ctx.piSession.sessionManager.getSessionId(),
get title() { return ctx.displayTitle || ctx.taskTitle || ''; },
taskRef: ctx.taskRef,
taskTitle: ctx.taskTitle,
taskIds: ctx.taskBinding.taskIds.slice(),
taskBindings: ctx.taskBinding.taskBindings.slice(),
activeTaskId: ctx.taskBinding.activeTaskId || ctx.taskRef,
intent: ctx.goal.intent,
goal: ctx.goal,
cwd: ctx.effectiveCwd,
get desktopControlScope() { return ctx.desktopControlScope; },
get skills() { return ctx.resources.skills; },
get skillWarnings() { return ctx.resources.skillWarnings || []; },
startedAt: ctx.startedAt,
outputSince: outputsSince(),
outputs() {
      return require('./outputs').list(ctx.effectiveCwd, outputsSince());
    },
outputSnapshot() {
      const since = outputsSince();
      return { ...completedOutputs(require('./outputs').scan(ctx.effectiveCwd, since, ctx.run.startedAt || 0)),
        pluginSince: ctx.pluginOutputSince, fileChanges: ctx.handle.fileChanges || null };
    },
async outputSnapshotAsync() {
      const since = outputsSince();
      const turnSince = ctx.run.startedAt || 0, fileChanges = ctx.handle.fileChanges || null;
      const scanned = await require('./outputs').scanAsync(ctx.effectiveCwd, since, turnSince);
      if ((ctx.run.startedAt || 0) !== turnSince || (ctx.handle.fileChanges || null) !== fileChanges)
        throw Error('当前轮次的成果已变化，请刷新后重试');
      return { ...completedOutputs(scanned), pluginSince: ctx.pluginOutputSince, fileChanges };
    },
fileChanges: null,
model: ctx.prep.model,
on(fn) { ctx.listeners.add(fn); return () => ctx.listeners.delete(fn); },
snapshot() { return ctx._snapshot(); },
toolDetail(id) { return require('./tool-detail').find(ctx.acc.state.tools, id); },
uiSnapshot(options) { const opts = options || { messageLimit: 80, toolLimit: 160 }; return typeof ctx.acc.uiSnapshot === 'function' ? ctx._snapshot(opts) : snapshotWindow.limitSnapshot(ctx._snapshot(), opts); },
appendTaskMessage(role, text, files, taskId, taskOutputKey, sourceModel, sourceAgent, plugins) {
      if (taskOutputKey && ctx.acc.state.messages.some(m => m.taskOutputKey === taskOutputKey)) return;
      const content = role === 'user' ? attachmentContract.augment(text, files || []) : text;
      const now = Date.now();
      const source = role === 'assistant' ? agentSource.fields(sourceAgent) : {};
      const message = { role, content: [{ type: 'text', text: content }], timestamp: now, ...source,
        ...(role === 'user' && Array.isArray(plugins) ? { plugins: require('../conversation/plugin-badges').publicBadges(plugins) } : {}),
        ...(role === 'user' ? { sentAt: messageTime.epoch(ctx.turnQueue.active()?.options?.sentAt) || now } : { completedAt: now }),
        ...(taskId ? { taskId: String(taskId) } : {}),
        ...(taskOutputKey ? { taskOutputKey } : {}),
        ...(role === 'assistant' ? { api: ctx.prep.model.api || 'openai-completions', provider: 'soduwork', model: 'task-executor',
          ...(sourceModel ? { model: sourceModel } : {}),
          stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } : {}) };
      ctx.piSession.sessionManager.appendMessage(message);
      // The installed Pi SDK exposes transcript mutation through state (the
      // same path used by its non-triggering custom messages), not appendMessage.
      ctx.piSession.agent.state.messages.push(message);
      if (role === 'user') ctx.acc.push({ type: 'message_end', message });
      else Object.assign(ctx.acc.appendAssistant(text, stream.SCOPES.NORMAL, message.completedAt), { taskId, taskOutputKey, ...source });
      ctx._emit({ kind: 'task-message' });
    },
taskMessageStreaming: true,
appendTaskRuntimeEvent(item, taskId) {
      if (item.kind === 'task-stream-end') { taskMessages.finish(item.streamPrefix); ctx._emit({ kind: 'task-message' }); return; }
      if (taskMessages.apply(item, taskId)) { ctx._emit({ kind: 'task-message' }); return; }
      if (require('./tool-preparation').runtime(ctx.acc.state, item)) ctx._emit({ kind: 'tool-preparing', taskId });
    },
appendTaskTool(event, taskId) {
      const source = agentSource.fields(event.sourceAgent);
      event = { ...event, sourceAgent: source.sourceAgent };
      const messages = ctx.piSession.agent.state.messages;
      const id = String(event.toolCallId);
      const toolName = event.toolName || 'tool';
      const callExists = messages.some(m => m.role === 'assistant' && Array.isArray(m.content) &&
        m.content.some(b => b.type === 'toolCall' && b.id === id));
      const persist = message => {
        ctx.piSession.sessionManager.appendMessage(message);
        messages.push(message);
      };
      // Persist a valid call/result pair, not a UI-only custom entry: otherwise
      // the next model turn can mistake an older task's tool output for this one.
      if (!callExists) persist({ role: 'assistant', taskId, timestamp: Date.now(), ...source,
        api: ctx.prep.model.api, provider: ctx.prep.model.provider, model: ctx.prep.model.id,
        stopReason: 'toolUse', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        content: [{ type: 'toolCall', id, name: toolName, arguments: event.args || {} }] });
      if (event.type === 'tool_execution_end' && !messages.some(m => m.role === 'toolResult' && m.toolCallId === id)) {
        persist({ role: 'toolResult', taskId, timestamp: Date.now(), toolCallId: id, ...source,
          toolName, content: event.result.content, isError: Boolean(event.isError) });
      }
      ctx.acc.push(event);
      ctx._emit({ kind: 'tool', taskId });
    },
rememberWorkflowPlugin(id) { ctx.persistPluginSelection([id]); },
pluginDebugChanged(value) {
      ctx.handle.pluginDebug = value;
      ctx._emit({ kind: 'plugin-debug' });
    },
taskExecutionChanged(value) {
      require('./tool-preparation').finishTask(ctx.acc.state, value);
      ctx.taskExecutions.set(value.taskId, { ...ctx.taskExecutions.get(value.taskId), ...value });
      ctx._emit({ kind: 'task-execution', taskId: value.taskId });
    },
status() { return ctx.acc.status(); },
inFlight() { return Boolean(ctx.inFlight || ctx.turnQueue.size() || ctx.turnQueue.active()); },
claimInterruptedTask(taskId) {
      if (!ctx.opts?.resumePath || ctx.handle.inFlight() || ctx.taskExecutions.has(taskId) ||
          recoveredTasks.has(taskId) || !ctx.taskBinding.taskIds.includes(taskId)) return null;
      const token = require('node:crypto').randomUUID();
      recoveredTasks.set(taskId, token);
      return token;
    },
releaseInterruptedTask(taskId, token) {
      if (recoveredTasks.get(taskId) !== token) return false;
      return recoveredTasks.delete(taskId);
    },
goalView() {
      return ctx.goalVisible ? { ...ctx.goal, mode: 'goal' }
        : { intent: '', mode: 'chat', goal: '', acceptance: '' };
    },
async bindTask(taskId, title) {
      const id = String(taskId || '').trim().slice(0, 120);
      if (!id) return { ok: false, reason: "没有指定需求" };
      const bound = _appendTaskBinding(ctx.piSession.sessionManager, id, title || '');
      if (!bound.ok) return bound;
      ctx.taskBinding = bound;
      ctx.taskRef = bound.activeTaskId || id;
      ctx.taskTitle = bound.taskTitle || title || ctx.taskTitle;
      ctx.handle.taskRef = ctx.taskRef;
      ctx.handle.taskTitle = ctx.taskTitle;
      ctx.handle.taskIds = bound.taskIds.slice();
      ctx.handle.taskBindings = bound.taskBindings.slice();
      ctx.handle.activeTaskId = bound.activeTaskId;
      ctx.displayTitle = require('../conversation/automatic-title').resolve(ctx.displayTitle, ctx._snapshot()) || ctx.taskTitle;
      ctx.updatedAt = Date.now();
      ctx._emit({ kind: 'task-bound', taskId: id, taskTitle: ctx.taskTitle,
        taskIds: bound.taskIds, taskBindings: bound.taskBindings, activeTaskId: bound.activeTaskId });
      return { ok: true, taskId: id, taskTitle: ctx.taskTitle, taskIds: bound.taskIds,
        taskBindings: bound.taskBindings, activeTaskId: bound.activeTaskId, snapshot: ctx._snapshot() };
    },
historyRow(existingSnapshot) {
      // Internal node sessions are execution handles, not user conversations.
      // In-memory SDK storage alone does not exclude them from live history.
      if (ctx.opts?.ephemeral === true) return null;
      const snap = existingSnapshot || ctx._snapshot();
      // A task title is navigation context, not evidence of a submitted turn.
      if (!(snap.messages || []).length && !ctx.inFlight && !ctx.turnQueue.size()) return null;
      const title = ctx.displayTitle || ctx.taskTitle || _messageTitle(snap) ||
        (ctx.handle.taskRef ? "协作需求" : '');
      if (!title) return null; // Do not add empty, never-used conversations to history.
      return {
        id: ctx.handle.sessionId, ref: ctx.ref, cwd: ctx.effectiveCwd, title, adapterId: 'pi',
        usedHarnesses: require('../conversation/used-harnesses').fromSnapshot(ctx.acc.state, 'pi'),
        taskId: ctx.handle.taskRef, taskTitle: ctx.taskTitle, taskIds: (ctx.handle.taskIds || []).slice(),
        taskBindings: (ctx.handle.taskBindings || []).slice(),
        activeTaskId: ctx.handle.activeTaskId || ctx.handle.taskRef,
        collaboration: Boolean((ctx.handle.taskIds || []).length || ctx.handle.taskRef),
        at: ctx.updatedAt, count: (snap.messages || []).length,
        state: ctx.failedLastTurn || ctx.qualityPhase === 'blocked' ? 'failed' :
          ((ctx.inFlight || ctx.turnQueue.size()) && snap.status !== 'waiting-user' ? 'running' : _presenceState(snap.status)),
        status: snap.status, live: true,
      };
    },
selectModel(name) {
      if (require('./image-model').imageChoice(name) && (ctx.goalVisible || ctx.handle.taskRef)) {
        return { ok: false, reason: '直接生图请使用普通对话；目标和需求可通过图片插件生成图片' };
      }
      return ctx.modelSelection.select(name);
    },
setThinkingMode(enabled) { const result = thinkingCapabilities.set(ctx.piSession, enabled); if (result.ok) ctx._emit({ kind: 'thinking-level', level: result.thinking.level }); return result; },
submit(text, turnAttachments, sendOptions) {
      const rawText = String(text || '');
      if (!rawText.trim()) {
        return { accepted: false, result: { ok: false, reason: '空消息' } };
      }
      // An automatic pause belongs to the previous turn. Once that turn has
      // settled and no recovery/permission/goal state is waiting, a new user
      // message starts a fresh turn instead of inheriting the old queue stop.
      // Explicit pauses remain untouched by resetIfIdle().
      if (!ctx.inFlight && !ctx.turnQueue.active() && !ctx.turnQueue.size() && !ctx.limitRequest &&
          !ctx.run.stallPending && !ctx.modelRecovery.view() && !ctx.acc.state.pendingUi &&
          ctx.acc.status() !== 'waiting-user') ctx.turnQueue.resetIfIdle();
      const resumeAfterTerminalAt = !sendOptions?.internal && !ctx.limitRequest &&
        ctx.run.stopKind === 'agent-stall' ? Number(ctx.run.terminalAt || 0) : 0;
      const turn = { ...sendOptions, modelName: sendOptions?.taskId && !sendOptions.controlled && typeof sendOptions.modelName === 'string'
        ? sendOptions.modelName : ctx.modelSelection.capture(),
        sentAt: messageTime.epoch(sendOptions?.sentAt) || Date.now() };
      // This queue override is derived from main-process run state. Never let
      // renderer-supplied options manufacture a terminal-stall recovery.
      delete turn.resumeAfterTerminalAt;
      if (resumeAfterTerminalAt > 0) turn.resumeAfterTerminalAt = resumeAfterTerminalAt;
      if (!turn.internal) {
        const queued = Boolean(ctx.inFlight || ctx.turnQueue.size() || ctx.turnQueue.blocked());
        const item = ctx._enqueueTurn(rawText, turnAttachments, turn, { announceQueued: false });
        // add() returns null for a requirement already active or queued; report that rejection explicitly.
        // Never substitute the old turn's receipt for a new message that was not queued.
        if (!item) return { accepted: false, result: { ok: false,
          reason: '这条需求已有一轮在执行或排队中，请等它结束后再发送新指令' } };
        const retryingSkill = skillTurn.resumeRetry(ctx.turnQueue, item, ctx.skillSelectionFailure);
        if (queued && !retryingSkill) ctx._emit({ kind: 'turn-queued', queueId: item.id });
        ctx._drainTurns();
        return {
          accepted: true, queued: queued && !retryingSkill, queueId: item.id,
          position: ctx.turnQueue.size(), completion: item.completion,
        };
      }
      return { accepted: true, queued: false, completion: ctx.handle.send(rawText, turnAttachments, turn) };
    },
continueGoal() {
      const paused = runControl.continuation(ctx._runContext());
      if (!paused) return { ok: false, reason: '当前没有等待继续的目标' };
      if (ctx.inFlight || ctx.run.stallPending || ctx.turnQueue.size() || ctx.acc.status() === 'waiting-user') {
        return { ok: false, reason: '当前还有消息正在执行、排队或等待确认' };
      }
      ctx.turnQueue.resume();
      runControl.resetRecoveries(ctx.run);
      ctx.limitRequest = null;
      ctx.run.stopReason = '';
      ctx.goalEnabled = true;
      ctx.failedLastTurn = false;
      ctx.updatedAt = Date.now();
      ctx.qualityPhase = 'implementing';
      ctx.qualityReason = '已继续执行，正在完成剩余工作';
      ctx._checkpoint('run.resumed', { reason: ctx.qualityReason });
      const completion = ctx.handle.send(goalQuality.continuationPrompt(ctx.goal, paused), [], {
        internal: true, continuing: true, goalMode: true,
        pluginIds: ctx.goalPluginIds.slice(), projectId: ctx.goalPluginProjectId,
      });
      return { ok: true, accepted: true, completion };
    },
pauseGoal() {
      if (!ctx.goalVisible) return { ok: false, reason: '当前没有正在运行的目标' };
      if (ctx.qualityPhase === 'paused' && ctx.limitRequest) {
        return { ok: true, snapshot: ctx._snapshot() };
      }
      ctx.qualityReason = '已停止当前执行，已有进度、上下文和工作区均已保留';
      ctx.limitRequest = {
        kind: 'user',
        reason: ctx.qualityReason,
        used: ctx.run.toolSteps,
        limit: ctx.maxSteps,
        unit: '次工具调用',
      };
      ctx.run.stopReason = ctx.qualityReason;
      ctx._cancelPendingStallRecovery();
      ctx.goalEnabled = false;
      ctx.qualityPhase = 'paused';
      ctx._checkpoint('run.paused', ctx.limitRequest);
      if (ctx.inFlight) {
        try {
          ctx.acc.abort();
          if (typeof ctx.piSession.abort === 'function') Promise.resolve(require('./interrupt').interrupt(ctx.piSession, ctx.turnQueue.active()?.completion)).catch(() => {});
        } catch (e) { /* The current tool may already have finished. */ }
        ctx.run.activeTools.clear();
      } else ctx._endGoalTurn();
      ctx._emit({ kind: 'goal-paused-by-user' });
      return { ok: true, snapshot: ctx._snapshot() };
    },
disableGoal() {
      ctx._cancelPendingStallRecovery();
      ctx.goalVisible = false;
      ctx.goalEnabled = false;
      ctx.limitRequest = null;
      ctx.run.stopReason = '';
      if (ctx.inFlight) {
        ctx.goalCancelled = true;
        try {
          ctx.acc.abort();
          if (typeof ctx.piSession.abort === 'function') Promise.resolve(require('./interrupt').interrupt(ctx.piSession, ctx.turnQueue.active()?.completion)).catch(() => {});
        } catch (e) { /* No further stop is needed after completion. */ }
      } else ctx._endGoalTurn();
      try {
        ctx.piSession.sessionManager.appendCustomEntry(goalContract.MODE_ENTRY_TYPE,
          { visible: false, at: Date.now() });
      } catch (e) { /* Apply the change in memory even if the archive is closing. */ }
      ctx._emit({ kind: 'goal-disabled' });
      return { ok: true, snapshot: ctx._snapshot() };
    },
cancel() {
      if (stopPromise) return stopPromise;
      ctx.resourceActivation.cancel();
      ctx.immediate.cancel();
      ctx.liveAccess.cancel();
      ctx.access?.broker.cancel();
      if (ctx.imageController) ctx.imageController.abort();
      ctx.modelRecovery.clear();
      const active = ctx.turnQueue.active();
      if (active && active.options.controlled) {
        ctx.turnQueue.stopActive();
        ctx.turnQueue.clear({ ok: true, cancelled: true, queued: true, manualStop: true });
        ctx.turnQueue.pause('正在停止当前工作');
        stopPromise = Promise.resolve().then(() => active.options.controlled.cancel()).then(() => {
          ctx.turnQueue.resume();
          ctx._emit({ kind: 'queue-changed' });
          return { ok: true, accepted: true, stopping: false, stopped: true, controlled: true };
        }).catch((error) => {
          ctx.turnQueue.pause('停止尚未确认，请重试');
          ctx.handle.taskExecutionChanged({ taskId: active.options.taskId, status: 'waiting', reason: '停止尚未确认，请重试' });
          return { ok: false, accepted: false, stopping: false, stopped: false,
            reason: '停止尚未确认，请重试', error: String(error && error.message || error) };
        }).finally(() => { stopPromise = null; });
        return stopPromise;
      }
      ctx.turnQueue.stopActive();
      ctx.turnQueue.clear({ ok: true, cancelled: true, queued: true, manualStop: true });
      ctx.turnQueue.resume();
      ctx._cancelPendingStallRecovery();
      try {
        ctx.acc.abort();
        // Handle abort() rejection so it cannot escape into the hosting process.
        if (typeof ctx.piSession.abort === 'function') Promise.resolve(require('./interrupt').interrupt(ctx.piSession, active?.completion)).catch(() => {});
      } catch (e) { /* Ignore an already-stopped session. */ }
      const receipt = { ok: true, accepted: true, stopping: false, stopped: true };
      // Do not resolve the IPC request while the active turn is still settling.
      // The renderer uses this receipt to leave the spinner state, so resolving
      // here made a slow abort look complete and invited another click.
      const completion = active && active.completion;
      if (!completion || typeof completion.then !== 'function') {
        ctx._emit({ kind: 'aborted' });
        return Promise.resolve(receipt);
      }
      stopPromise = Promise.resolve(completion).catch(() => null).then(() => {
        ctx._emit({ kind: 'aborted' });
        return receipt;
      }).finally(() => { stopPromise = null; });
      return stopPromise;
    },
cancelQueued(id) {
      if (ctx.immediate.locked(id)) return { ok: false, reason: '这条消息正在引导，请稍候' };
      const item = ctx.turnQueue.cancel(id, { ok: true, cancelled: true, queued: true });
      if (!item) return { ok: false, reason: '这条排队消息已经开始执行或已被取消' };
      ctx._emit({ kind: 'turn-queue-cancelled', queueId: item.id });
      return { ok: true, cancelled: true, snapshot: ctx._snapshot() };
    },
updateQueue(id, action, value) {
      if (action === 'send-now') return ctx.immediate.send(id).then(result => ({ ...result, snapshot: ctx._snapshot() }));
      if (action === 'resume' && ctx.immediate.blocked()) {
        const result = ctx.immediate.resume(); if (!result.ok) return result;
      }
      if (ctx.immediate.locked(id) || ctx.immediate.blocked() && action === 'retry-model')
        return { ok: false, reason: '这条消息正在引导，请稍候' };
      if (action === 'retry-model') {
        if (ctx.closed || ctx.inFlight || ctx.turnQueue.active() || ctx.acc.state.pendingUi) return { ok: false, reason: '当前执行尚未结束，请稍后重试' };
        const recovery = ctx.modelRecovery.view();
        if (recovery?.id !== id) return { ok: false, reason: '这轮状态已变化，请刷新后确认' };
        if (recovery?.requiresModelChange && recovery.failedModelName === ctx.modelSelection.capture()) {
          return { ok: false, reason: '当前模型仍不可用，请先切换到可用模型后再恢复这一轮' };
        }
        let item;
        ctx.modelRecovery.take(id, value => {
          value.options.modelName = ctx.modelSelection.capture();
          item = ctx.turnQueue.add(value);
          return Boolean(item);
        });
        if (!item) return { ok: false, reason: '这条需求已有一轮在执行或排队中，请先处理当前轮次再恢复' };
        ctx._drainTurns();
        return { ok: true, queueId: item.id, snapshot: ctx._snapshot() };
      }
      if (action === 'resume' && ctx.modelRecovery.view()) return { ok: false, reason: '请先恢复中断的这一轮，后续消息仍在排队' };
      const ok = action === 'resume' ? (ctx.turnQueue.resume(), true)
        : action === 'edit' ? ctx.turnQueue.edit(id, value)
          : action === 'before' ? ctx.turnQueue.moveBefore(id, value)
          : action === 'up' || action === 'down' ? ctx.turnQueue.move(id, action === 'up' ? -1 : 1) : false;
      if (!ok) return { ok: false, reason: '只能调整尚未发送的消息' };
      ctx._emit({ kind: 'queue-changed' });
      queueMicrotask(ctx._drainTurns);
      return { ok: true, snapshot: ctx._snapshot() };
    },
answerUi(res) {
      if (res && res.requestId) return ctx.access ? ctx.access.broker.answer(res) : { ok: false, reason: '权限请求已失效' };
      ctx.acc.answerUi();
      try {
        if (typeof ctx.piSession.respondToUiRequest === 'function') ctx.piSession.respondToUiRequest(res);
      } catch (e) { /* The extension also enforces its own timeout. */ }
      ctx._emit({ kind: 'ui-answered' });
    },
close() {
      ctx.resourceActivation.cancel();
      ctx.immediate.cancel();
      ctx.liveAccess.close();
      ctx.accessChanges.close();
      ctx.access?.broker.close();
      if (ctx.imageController) ctx.imageController.abort();
      ctx.closed = true;
      // Optional conversation services (memory, telemetry, etc.) may attach
      // listeners to the public handle. Release them before disposing Pi so a
      // long-lived desktop cannot retain closed sessions or debounce timers.
      try {
        if (typeof ctx.handle.ui?.memorySubscription === 'function') {
          ctx.handle.ui.memorySubscription();
          ctx.handle.ui.memorySubscription = null;
        }
      } catch (_) { /* cleanup continues even if an optional service fails */ }
      ctx.snapshotEmitter.dispose();
      ctx.turnQueue.clear({ ok: false, reason: '会话已关闭' });
      runControl.dispose(ctx.run);
      ctx.listeners.clear();
      try { if (typeof ctx.unsub === 'function') ctx.unsub(); } catch (e) { /* ignore */ }
      try { ctx.piSession.dispose(); } catch (e) { /* Attempt disposal without allowing its failure to skip remaining cleanup. */ }
      _sessions.delete(ctx.ref);
    },
    send: require('./session-send').create(ctx).send,
  };
}
module.exports = { create };
