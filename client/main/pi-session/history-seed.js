'use strict';
// Replay archived messages through the same accumulator used by live output.
const stream = require('./event-stream');
const messageTime = require('../conversation/message-time');
const snapshotWindow = require('./snapshot-window');
const goalFinalizer = require('../conversation/goal-finalizer');
const agentSource = require('../conversation/agent-source.cjs');
const SCOPE_ENTRY_TYPE = 'soduwork.message.scope';

// Keep financial facts independently of the bounded presentation replay. Do
// not retain old content/tool payloads just to reconstruct cumulative usage.
function accountingReceipt(entry, nativeAgentId) {
  const message = messageTime.storedMessage(entry);
  if (message?.role !== 'assistant' || !message.usage || typeof message.usage !== 'object') return null;
  const values = require('../agent-runtime/usage-values');
  const usage = values.empty();
  const raw = message.usage.cost?.total === 0 && message.usage.costKnown === undefined
    ? { ...message.usage, costKnown: false } : message.usage;
  values.add(usage, raw);
  const source = require('../conversation/native-agent-source.cjs').fields(message, nativeAgentId);
  return { usage, at: messageTime.epoch(message.completedAt) || messageTime.epoch(message.timestamp),
    model: String(message.model || ''), provider: String(message.usageProvider || message.provider || ''),
    agent: source.sourceAgent?.agentId || '',
    ...(typeof message.quotaUsageToken === 'string' && message.quotaUsageToken
      ? { quotaUsageToken: message.quotaUsageToken } : {}) };
}

function _applyStoredScope(acc, data) {
  const scope = String(data && data.scope || '');
  if (scope === stream.SCOPES.GOAL_EXECUTION) acc.beginGoalTurn();
  else if (scope === stream.SCOPES.GOAL_REVIEW) acc.beginAudit();
  else if (scope === stream.SCOPES.GOAL_FINAL) acc.beginFinalAnswer();
  else if (scope === stream.SCOPES.NORMAL) acc.endGoalTurn();
  else if (scope) acc.setScope(scope);
}
function _seed(acc, piSession, options) {
  const opts = options || {};
  let msgs = [];
  try { msgs = (piSession.state && piSession.state.messages) || []; } catch (e) { return 0; }
  let entries = [];
  try { entries = piSession.sessionManager && piSession.sessionManager.getEntries() || []; } catch (e) { entries = []; }
  const hasEntryMessages = entries.some((item) => item && item.type === 'message' && item.message);
  const sequence = hasEntryMessages ? entries : msgs.map((message) => ({ type: 'message', message }));
  const { tailStart, lastFinalEntry } = snapshotWindow.seedBounds(sequence, opts.maxMessages, goalFinalizer.ENTRY_TYPE);
  const hasStoredScopes = entries.some((item) => item && item.type === 'custom' &&
    item.customType === SCOPE_ENTRY_TYPE);
  const legacyInternalGoal = !hasStoredScopes && Boolean(opts.internalGoal);
  let legacyGoalStarted = false;
  let finalRestored = false;
  let n = 0;
  const toolCalls = new Map(), accountingHistory = [];
  sequence.forEach((entry, sequenceIndex) => {
    if (entry?.type === 'message') {
      const receipt = accountingReceipt(entry, opts.nativeAgentId);
      if (receipt) accountingHistory.push(receipt);
    }
    const inTail = sequenceIndex >= tailStart;
    if (entry && entry.type === 'custom') {
      if (entry.customType === SCOPE_ENTRY_TYPE) {
        _applyStoredScope(acc, entry.data || {});
        return;
      }
      if (!inTail && sequenceIndex !== lastFinalEntry) return;
      if (entry.customType === 'soduwork.task.tool' && entry.data && entry.data.event) {
        acc.push(entry.data.event);
        return;
      }
      if (entry.customType === goalFinalizer.ENTRY_TYPE) {
        const stored = goalFinalizer.fromEntries([entry]);
        if (stored) {
          acc.beginFinalAnswer();
          acc.appendAssistant(stored.rendered, stream.SCOPES.GOAL_FINAL,
            messageTime.epoch(entry.data?.at) || messageTime.epoch(entry.timestamp));
          acc.endGoalTurn();
          finalRestored = true;
          n += 1;
        }
      }
      return;
    }
    if (!inTail) return;
    const stored = entry && entry.type === 'message' ? messageTime.storedMessage(entry) : null;
    const m = require('../conversation/native-agent-source.cjs').message(stored, opts.nativeAgentId);
    if (!m || !m.role) return;
    try {
      if (m.role === 'user') {
        acc.push({ type: 'message_end', message: m, replay: true });
        n += 1;
        /*
         * For legacy archives without scope checkpoints, display the initial goal request and hide
         * subsequent execution and review until soduwork.goal.final publishes delivery.
         */
        if (legacyInternalGoal && !legacyGoalStarted && !finalRestored) {
          acc.beginGoalTurn();
          legacyGoalStarted = true;
        }
        return;
      }
      if (m.role === 'toolResult') {
        const call = toolCalls.get(String(m.toolCallId || '')) || {};
        const source = agentSource.fields(m.sourceAgent || call.sourceAgent);
        // Reconstruct tool start and end events so history uses the live activity representation.
        acc.push({ type: 'tool_execution_start', toolCallId: m.toolCallId,
                   toolName: m.toolName || call.name, args: call.arguments || call.args || null, ...source });
        acc.push({ type: 'tool_execution_end', toolCallId: m.toolCallId, toolName: m.toolName,
                   result: { content: m.content || [] }, ...source,
                   ...(m.details?.soduWorkAccessChange?.state === 'cancelled' &&
                     m.details.soduWorkAccessChange.cancelReason === 'access-change'
                     ? { state: 'cancelled', cancelReason: 'access-change', isError: false }
                     : { isError: !!m.isError }) });
        return;
      }
      if (m.role !== 'assistant') return;
      /*
       * Reconstruct content-block end events from archived assistant content and reuse the
       * normalizer instead of adding a separate history renderer.
       */
      acc.push({ type: 'message_start', message: m });
      const blocks = Array.isArray(m.content) ? m.content : [];
      blocks.forEach((c, i) => {
        if (!c) return;
        if (c.type === 'text') {
          acc.push({ type: 'message_update',
                     assistantMessageEvent: { type: 'text_end', contentIndex: i, content: c.text || '' } });
        } else if (c.type === 'thinking') {
          acc.push({ type: 'message_update',
                     assistantMessageEvent: { type: 'thinking_end', contentIndex: i, content: c.thinking || '' } });
        } else if (c.type === 'toolCall') {
          toolCalls.set(String(c.id || c.toolCallId || ''), { ...c, ...agentSource.fields(m.sourceAgent) });
          acc.push({ type: 'message_update',
                     assistantMessageEvent: { type: 'toolcall_end', contentIndex: i, toolCall: c } });
        }
      });
      acc.push({ type: 'message_end', message: m, replay: true });
      n += 1;
    } catch (e) { /* Skip unreadable entries without discarding the entire history. */ }
  });
  // Replace rather than append on reseed; replayed tail messages already
  // belong to this full baseline and must not be counted a second time.
  acc.state.accountingHistory = accountingHistory;
  acc.state.accountingMessageFrom = acc.state.messages.length;
  acc.state.usageRevision = (acc.state.usageRevision || 0) + 1;
  // Display history may include other branches and imported task receipts.
  // Measurement belongs only to the active native branch after compaction.
  let branch = sequence;
  try { branch = piSession.sessionManager?.getBranch?.() || sequence; } catch (_) {}
  acc.state.contextUsage = null;
  let modelId = piSession.model?.id;
  let provider = piSession.model?.provider;
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i];
    if (entry?.type === 'compaction') break;
    const message = entry?.type === 'message' ? entry.message : null;
    const modelChange = entry?.type === 'model_change';
    if (!modelChange && (message?.role !== 'assistant' || message.taskOutputKey || message.model === 'task-executor')) continue;
    const id = modelChange ? entry.modelId : message.model;
    const source = modelChange ? entry.provider : message.provider;
    if ((modelId && id && id !== modelId) || (provider && source && source !== provider)) break;
    modelId ||= id;
    provider ||= source;
    if (message) {
      const usage = stream.reportedContextUsage(message);
      if (usage) {
        acc.state.contextUsage = usage;
        break;
      }
    }
  }
  if (acc.state && acc.state.protocolIssue && typeof acc.recoverProtocol === 'function') {
    // Keep the raw archive for audit, but do not reopen an old quarantined frame as a live failure.
    acc.recoverProtocol();
  }
  if (n) acc.push({ type: 'agent_settled' });      // Mark restored history as settled rather than actively thinking.
  return n;
}

module.exports = { seed: _seed, SCOPE_ENTRY_TYPE };
