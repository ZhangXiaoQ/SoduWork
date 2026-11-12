'use strict';

const JOURNAL_SNAPSHOT_TIMEOUT_MS = 10 * 1000;
const toolProgress = require('./tool-progress');

function snapshotWithTimeout(fileChangeJournal, cwd, timeoutMs) {
  const configured = Number(timeoutMs);
  const limit = Number.isFinite(configured) && configured > 0
    ? configured : JOURNAL_SNAPSHOT_TIMEOUT_MS;
  const controller = new AbortController();
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Workspace file snapshot timed out after ' + limit + ' ms');
      error.code = 'SODUWORK_JOURNAL_SNAPSHOT_TIMEOUT';
      reject(error);
      controller.abort();
    }, limit);
  });
  const snapshot = Promise.resolve().then(() =>
    fileChangeJournal.snapshot(cwd, { signal: controller.signal }));
  return Promise.race([snapshot, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// State remains owned by the session; accessors keep async transitions live.
function create(ctx) {
  const stampUsage = require('./usage-attribution').create(() => ctx.prep);
  const {
    SCOPE_ENTRY_TYPE, fileChangeJournal, goalLoop, goalQuality, goalToolStages,
    mediaArtifacts, messageTime, protocolGuard, runControl, stream,
    thinkingCapabilities, toolGuard,
  } = ctx.shared;
function _persistScope(scope) {
    if (!scope || ctx.persistedScope === scope) return;
    ctx.persistedScope = scope;
    try {
      ctx.piSession.sessionManager.appendCustomEntry(SCOPE_ENTRY_TYPE, {
        schemaVersion: 1, scope, at: Date.now(),
      });
    } catch (e) { /* The in-memory turn retains its scope even if persistence for later restoration fails. */ }
  }

function _beginGoalTurn() {
    ctx.acc.beginGoalTurn();
    _persistScope(stream.SCOPES.GOAL_EXECUTION);
  }

function _beginAudit() {
    ctx.acc.beginAudit();
    _persistScope(stream.SCOPES.GOAL_REVIEW);
  }

function _beginFinalAnswer() {
    ctx.acc.beginFinalAnswer();
    _persistScope(stream.SCOPES.GOAL_FINAL);
  }

function _endGoalTurn() {
    if (typeof ctx.acc.endGoalTurn === 'function') ctx.acc.endGoalTurn();
    _persistScope(stream.SCOPES.NORMAL);
  }

function _checkpoint(type, payload) {
    if (ctx.goal.intent !== 'goal') return;
    ctx.harnessEventSeq += 1;
    const checkpointPayload = { ...(payload || {}), toolCount: ctx.acc.state.tools.length };
    const evt = goalLoop.event(type, checkpointPayload, ctx.ref + ':' + ctx.harnessEventSeq + ':' + Date.now());
    ctx.harness = goalLoop.reduce(ctx.harness, evt);
    ctx.piSession.sessionManager.appendCustomEntry(goalLoop.ENTRY_TYPE, ctx.harness);
  }

function _setHarness(phase, state, reason) {
    if (ctx.goal.intent !== 'goal') return;
    let type = 'action.started';
    if (state === 'paused') type = 'run.paused';
    else if (phase === 'understand') type = 'run.started';
    else if (phase === 'plan') type = 'plan.ready';
    else if (phase === 'verify') type = 'verification.started';
    else if (phase === 'execute' && state === 'repairing') type = 'verification.failed';
    else if (phase === 'deliver' && state === 'completed') type = 'run.completed';
    else if (phase === 'deliver' && state === 'blocked') type = 'run.blocked';
    _checkpoint(type, { reason });
  }

function _captureDirectDelivery(turn, result) {
    // Queued turns freeze once in onCompleted, including their internal
    // recovery chain. Explicit goal continuation/direct sends have no queue
    // owner, so freeze here while inFlight still fences the next instruction.
    if (ctx.closed || turn.fromQueue || ctx.turnQueue.active() ||
        require('./task-turn').resultState(result) !== 'completed') return;
    // No async boundary for skipped captures: a protocol recovery is queued
    // for the end of this turn and must see inFlight cleared when it runs.
    // Real captures still fence the next instruction until files are frozen.
    return Promise.resolve().then(() => ctx.handle.captureDelivery?.())
      .catch(() => { /* Optional delivery capture cannot change model success. */ });
  }

function _runContext() {
    return {
      configured: ctx.goal.intent === 'goal', goalIntent: ctx.goal.intent,
      goal: ctx.goal, goalQuality: goalQuality, goalBudgetMinutes: ctx.goal.budgetMinutes,
      budgetMs: ctx.budgetMs, maxSteps: ctx.maxSteps, maxToolSteps: ctx.maxToolSteps, toolGuard: toolGuard, protocolGuard: protocolGuard, acc: ctx.acc,
      get piSession() { return ctx.piSession; },
      visible: () => ctx.goalVisible,
      goalEnabled: () => ctx.goalEnabled,
      setGoalEnabled: (value) => { ctx.goalEnabled = value; },
      status: () => ctx.access?.broker.pending().length ? 'waiting-user' : ctx.acc.status(),
      waitingPermission: () => Boolean(ctx.access?.broker.pending().length),
      limitRequest: () => ctx.limitRequest,
      setLimitRequest: (value) => { ctx.limitRequest = value; },
      qualityPhase: () => ctx.qualityPhase,
      qualityReason: () => ctx.qualityReason,
      qualityRounds: () => ctx.qualityRounds,
      setQuality: (phase, reason) => { ctx.qualityPhase = phase; ctx.qualityReason = reason; },
      inFlight: () => ctx.inFlight,
      closed: () => ctx.closed,
      queueView: () => ctx.turnQueue.view(),
      queueSize: () => ctx.turnQueue.size(),
      harnessView: () => goalLoop.view(ctx.harness),
      checkpoint: _checkpoint,
      emit: ctx._emit,
      setFailedLastTurn: (value) => { ctx.failedLastTurn = value; },
      endGoalTurn: _endGoalTurn,
      drainTurns: ctx._drainTurns,
      send: (text, attachments, options) => ctx.handle.send(text, attachments,
        { ...options, fromQueue: Boolean(ctx.turnQueue.active()) }),
      goalPluginIds: () => ctx.goalPluginIds.slice(),
      goalPluginProjectId: () => ctx.goalPluginProjectId,
    };
  }

function _execution() {
    return runControl.execution(ctx.run, _runContext());
  }

function _thinkingView() { return thinkingCapabilities.view(ctx.piSession); }

function _snapshot(options) {
    // taskBinding is updated whenever a binding is appended. Re-scanning the
    // complete JSONL entry list for every streamed token made long sessions
    // increasingly expensive and could block the Electron main process.
    const binding = ctx.taskBinding;
    const active = ctx.turnQueue.active();
    const controlled = active && active.options.controlled && (active.options.pluginDebug ? ctx.handle.pluginDebug : ctx.taskExecutions.get(active.options.taskId));
    const controlledView = !active?.options.pluginDebug &&
      require('./controlled-execution-snapshot.cjs').project(controlled, active?.id);
    const transcript = ctx.liveAccess.view(options && typeof ctx.acc.uiSnapshot === 'function'
      ? ctx.acc.uiSnapshot(options) : ctx.acc.snapshot());
    const queue = ctx.turnQueue.state();
    // A failed preflight has no SDK message to update the transcript status.
    // Project its queue receipt on every snapshot, including refresh/reopen,
    // without changing an actual provider failure or pending user decision.
    const failedBeforeOutput = queue.failure && !active && !ctx.inFlight && !controlled && !transcript.pendingUi &&
      ['idle', 'streaming', 'compacting'].includes(transcript.status);
    return { ...transcript,
      ...(failedBeforeOutput ? { status: 'unreachable', statusText: queue.failure.reason } : {}),
      ...(controlled ? { status: ['waiting', 'failed', 'blocked'].includes(controlled.status) ? 'waiting-user' :
      controlled.status === 'running' ? 'streaming' : 'idle', statusText: controlled.reason || '' } : {}),
      ...(ctx.skillSelectionFailure ? { status: 'unreachable', statusText: ctx.skillSelectionFailure.reason } : {}),
      modelSelection: ctx.modelSelection.view(),
      thinking: _thinkingView(),
      execution: { ..._execution(), ...(failedBeforeOutput ? { running: false } : {}),
        ...controlledView?.execution,
        turnQueue: queue, taskExecutions: Array.from(ctx.taskExecutions.values()),
        queueImmediate: ctx.immediate.view(),
        modelRecovery: !ctx.inFlight && !ctx.turnQueue.active() ? ctx.modelRecovery.view() : null },
      taskId: binding.taskId, taskTitle: binding.taskTitle, taskIds: binding.taskIds,
      taskBindings: binding.taskBindings, activeTaskId: binding.activeTaskId,
      activePlugins: ctx.activePluginIds.slice(),
      collaboration: Boolean(binding.taskIds.length), ...(ctx.access ? ctx.access.snapshot() : {}),
      fileChanges: ctx.handle.fileChanges || null,
      adapterId: 'pi', displayName: 'Pi', nextAccessPolicy: ctx.accessChanges.pending(),
      accessControl: { ...require('../agent-runtime/runtime-catalog').runtime('pi').accessControl,
        supported: typeof ctx.piSession.agent?.beforeToolCall === 'function',
        canChangeDuringSession: typeof ctx.piSession.agent?.beforeToolCall === 'function', changeTakesEffect: 'current-turn' } };
  }

function _stopForLimit(kind, reason) {
    runControl.stopForLimit(ctx.run, kind, reason, _runContext());
  }

function _stopProtocolIssue(issue) {
    runControl.stopProtocolIssue(ctx.run, issue, _runContext());
  }

const onPiEvent = (ev) => {
    // Stamp the SDK-owned message before provenance projection creates a copy.
    // The SDK persists the original object after notifying its subscribers.
    stampUsage(ev);
    const activeTurn = ctx.turnQueue.active();
    messageTime.stampPiEvent(ev, activeTurn?.options?.sentAt, activeTurn?.options?.submissionId);
    ev = require('../conversation/native-agent-source.cjs').event(ev, 'pi');
    if (ev?.type === 'agent_start') void ctx.turnQueue.markStarted?.();
    const isToolStart = ev && ev.type === 'tool_execution_start';
    const toolId = isToolStart ? String(ev.toolCallId || '') : '';
    const duplicateToolStart = Boolean(toolId && ctx.run.toolIds.has(toolId));
    // Check before recording a new start so a burst of parallel calls cannot
    // overshoot the limit by the number of calls already queued by the SDK.
    if (isToolStart && ctx.maxToolSteps && !duplicateToolStart &&
        ctx.run.toolSteps >= ctx.maxToolSteps) {
      _stopForLimit('steps', '本轮已达到 ' + ctx.maxToolSteps +
        ' 次工具调用安全上限。为避免失败重试持续增加，SoduWork 已停止本轮；已有进度和文件都已保留。');
      return;
    }
    if (isToolStart && !duplicateToolStart && toolProgress.blocked(ctx.run.toolProgress)) {
      _stopForLimit('tool-loop', '工具已连续 ' + toolProgress.MAX_NO_PROGRESS +
        ' 次失败、返回空结果或重复相同操作与结果。已停止本轮以避免无效循环，已有进度和文件都已保留。');
      return;
    }
    runControl.observeEvent(ctx.run, ev, toolGuard.executionPolicy);
    let touched;
    try {
      touched = ctx.acc.push(ev);
    } catch (e) { return; }
    if (touched && touched.kind === 'protocol-leak') {
      _stopProtocolIssue(touched.issue);
      return;
    }
    if (ctx.goalEnabled && ev && ev.type === 'tool_execution_start' && touched && touched.tool) {
      goalToolStages.mark(touched.tool, ctx.harness);
    }
    ctx._emit(touched);
    // soduwork-media returns a signed Hub attachment.  Download it in the main
    // process into the session's outputs directory so the ordinary output
    // index renders a playable video card in the current conversation.
    const artifact = mediaArtifacts.fromToolEvent(ev);
    if (artifact && !ctx.closed) {
      const mediaKey = String(artifact.attachmentId || artifact.url || '');
      if (mediaKey && !ctx.materializedMedia.has(mediaKey)) {
        ctx.materializedMedia.add(mediaKey);
        mediaArtifacts.materialize(artifact, ctx.identity, ctx.effectiveCwd)
          .then((file) => {
            if (!ctx.closed) ctx._emit({ kind: 'settled', mediaArtifact: file });
          })
          .catch((error) => {
            ctx.materializedMedia.delete(mediaKey);
            if (!ctx.closed) ctx._emit({
              kind: 'media-artifact-error',
              reason: String((error && error.message) || error).slice(0, 300),
            });
          });
      }
    }
    // The SDK emits start before invoking the tool. Admission above permits
    // exactly N calls; aborting here would cancel the Nth call and its answer.
  };

async function beginTurnJournal(turn) {
    ctx.completedOutputJournal = null;
    const turnId = String(turn?.submissionId || '') ||
      `${ctx.ref}:${++ctx.turnJournalSeq}:${Date.now()}`;
    const startedAt = ctx.run.startedAt;
    const cwd = ctx.effectiveCwd;
    try {
      ctx.activeTurnJournal = {
        turnId, startedAt, cwd,
        before: await snapshotWithTimeout(fileChangeJournal, cwd, ctx.journalSnapshotTimeoutMs),
      };
    } catch (_) {
      // Capture is supplementary; never block a model turn on a file scan.
      ctx.activeTurnJournal = { turnId, startedAt, cwd, before: null };
    }
  }

async function finishTurnJournal() {
    const journal = ctx.activeTurnJournal;
    ctx.activeTurnJournal = null;
    if (!journal) return;
    try {
      const after = await snapshotWithTimeout(fileChangeJournal, journal.cwd, ctx.journalSnapshotTimeoutMs);
      ctx.handle.fileChanges = journal.before
        ? fileChangeJournal.compare(journal.before, after, { turnId: journal.turnId })
        : {
          schemaVersion: fileChangeJournal.SCHEMA_VERSION,
          turnId: journal.turnId,
          capturedAt: Date.now(),
          truncated: true,
          files: [],
          stats: { created: 0, modified: 0, deleted: 0, renamed: 0, total: 0 },
        };
    } catch (_) {
      ctx.handle.fileChanges = {
        schemaVersion: fileChangeJournal.SCHEMA_VERSION,
        turnId: journal.turnId,
        capturedAt: Date.now(),
        truncated: true,
        files: [],
        stats: { created: 0, modified: 0, deleted: 0, total: 0 },
      };
    }
    ctx.completedOutputJournal = { startedAt: journal.startedAt, changes: ctx.handle.fileChanges };
    ctx._emit({ kind: 'file-changes', turnId: journal.turnId });
  }
  return { _persistScope, _beginGoalTurn, _beginAudit, _beginFinalAnswer, _endGoalTurn, _checkpoint, _setHarness, _captureDirectDelivery, _runContext, _execution, _thinkingView, _snapshot, _stopForLimit, _stopProtocolIssue, beginTurnJournal, finishTurnJournal, onPiEvent };
}
module.exports = { create, JOURNAL_SNAPSHOT_TIMEOUT_MS, _snapshotWithTimeout: snapshotWithTimeout };
