'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const segments = require('../conversation/runtime-segments');
const windowed = require('../pi-session/snapshot-window');
const clone = value => JSON.parse(JSON.stringify(value));
const nativeSource = require('../conversation/native-agent-source.cjs');
const harnesses = require('../conversation/used-harnesses');
const BUSY = '请等待本轮和排队消息完成后切换 Agent';

function busy(handle) {
  const s = handle.snapshot();
  return handle.inFlight?.() || s.execution?.recoveryRequired ||
    s.status === 'unreachable' && s.execution?.terminalConfirmed !== true ||
    ['streaming', 'queued', 'compacting', 'waiting-user'].includes(s.status) ||
    s.pendingUi || s.pendingPermissions?.length || s.queue?.length || s.execution?.queue?.length ||
    s.execution?.turnQueue?.active || s.execution?.turnQueue?.pending?.length;
}
const TERMINAL_GOAL_STATES = new Set(['completed', 'done', 'failed', 'stopped', 'interrupted', 'cancelled', 'canceled']);
function goalSwitchBlocked(snapshot) {
  const execution = snapshot?.execution || {};
  if (!execution.configured) return false;
  if (execution.active || execution.running || execution.recoveryRequired || execution.paused ||
      execution.pendingPermissions?.length || execution.queue?.length ||
      execution.turnQueue?.active || execution.turnQueue?.pending?.length) return true;
  if (execution.terminalConfirmed) return false;
  const state = String(execution.harness?.state || '').toLowerCase();
  return !TERMINAL_GOAL_STATES.has(state);
}
function descriptor(raw, history = raw.historyRow?.()) {
  const nativeDispatchId = history?.nativeDispatchId;
  return { sessionId: raw.sessionId, adapterId: raw.adapterId, ref: raw.ref,
    ...(nativeDispatchId ? { nativeDispatchId } : {}),
    path: raw.resumeLocation?.() || (raw.adapterId !== 'pi' ? raw.sessionId : '') };
}
function resumeOptions(options) {
  const row = segments.read(options.app, options.runtimeConversationId);
  if (!row) return { options, row: null };
  segments.assertOwner(options.app, row, options.identity);
  const runner = row.active.adapterId !== 'pi';
  const canResume = runner ? row.active.path : row.active.path && fs.existsSync(row.active.path);
  return { row, options: { ...options, adapterId: row.active.adapterId, cwd: row.cwd,
    resumeCwd: row.cwd, resumePath: canResume ? row.active.path : '',
    ...(runner ? { nativeDispatchId: row.active.nativeDispatchId || '',
      nativeSessionStarted: row.active.nativeDispatchId ? row.active.started !== false : undefined,
      verifyLegacySegment: !row.active.nativeDispatchId } : {}),
    // A switched conversation still has historical context even when its active
    // native archive was removed or moved. Mark it as resumed so session-open can
    // recover an unavailable saved model from the current default instead of
    // treating the stale selection as a new-chat explicit choice.
    resumedConversation: true, sessionTitle: segments.title(row),
    modelName: row.active.modelName,
    reasoningEffort: row.active.reasoningEffort ?? options.reasoningEffort,
    accessPolicy: row.accessPolicy, readOnly: row.readOnly, activePluginIds: row.activePluginIds,
    contextPrompts: [...(options.contextPrompts || []), segments.brief(row.prefix)] } };
}
function create({ raw: initial, options, restored, openNative, disposeNative, probe, catalog, changed }) {
  let raw = initial, record = restored, switching = false, closed = false, unsub = null, switchingCompletion = null, pendingModel = null;
  let prefix = restored?.prefix || { messages: [], tools: [] }, persistError = '';
  const listeners = new Set(), overlays = Object.create(null), methods = new Map();
  const publicId = restored?.id || initial.sessionId, publicRef = options.ref || initial.ref;
  // UI/service decorations live on the conversation, not the disposable native segment.
  overlays.ui = initial.ui || {};
  const originAdapter = restored?.originAdapter || initial.adapterId;
  // Fix account ownership when opening the conversation; do not first resolve expired historical credentials during a later runtime switch.
  // Validate current credentials for each operation and retain only the identity fingerprint, not a login token.
  let owner = '';
  try { if (options.identity?.session) owner = segments.scope(options.identity); }
  catch (_) { /* Expired credentials permit local history viewing but cannot authorize runtime switching. */ }
  const environment = { hub: options.identity?.hub, clientId: options.identity?.clientId };
  function switchIdentity(selection) {
    const current = selection.identity || options.identity;
    if (!owner || segments.scope(current) !== owner || current.hub !== environment.hub || current.clientId !== environment.clientId)
      throw Error('账号或服务已变化，请重新打开这条会话');
    return current;
  }
  function snapshot(value) {
    const s = nativeSource.snapshot(value || raw.snapshot(), raw.adapterId);
    if (!record) return { ...s, runtimeSwitching: switching };
    return { ...s, runtimeSwitching: switching,
      usageReceipts: [...(prefix.usageReceipts || []), ...(s.usageReceipts || [])],
      turnMetrics: [...(prefix.turnMetrics || []), ...(s.turnMetrics || []).map(metric => ({ ...metric,
        fromMessage: metric.fromMessage + prefix.messages.length, toMessage: metric.toMessage + prefix.messages.length }))],
      messages: [...prefix.messages, ...(s.messages || [])],
      tools: [...prefix.tools, ...(s.tools || []).map(t => ({ ...t, after: Number(t.after || 0) + prefix.messages.length }))] };
  }
  function emit(event, value) {
    const snap = snapshot(value);
    for (const fn of listeners) { try { fn(event, snap); } catch (_) { /* independent observers */ } }
  }
  function subscribe() {
    unsub?.(); unsub = raw.on?.((event, value) => {
      if (closed) return;
      // A newly-created Runner segment has no archive until the first dispatch.
      // Persist admission immediately, then recovery can load its native journal.
      if (record && event.kind !== 'block') {
        const snap = value || raw.snapshot();
        const current = raw.historyRow?.();
        const next = { ...record, title: segments.title(record) || current?.title || '', accessPolicy: snap.nextAccessPolicy || snap.accessPolicy || record.accessPolicy,
          activePluginIds: snap.activePlugins || record.activePluginIds,
          active: { ...record.active, ...descriptor(raw, current),
            modelName: snap.modelSelection?.name ?? record.active.modelName,
            ...(raw.adapterId === 'codex' ? { reasoningEffort: snap.thinking?.level || '' } : {}),
            usedHarnesses: harnesses.merge(record.active.usedHarnesses,
              current?.usedHarnesses || harnesses.fromSnapshot(snap, raw.adapterId)),
            started: typeof current?.nativeSessionStarted === 'boolean' ? current.nativeSessionStarted
              : record.active.started || Number(current?.count || 0) > 0 } };
        if (next.title !== record.title || JSON.stringify(next.active) !== JSON.stringify(record.active) ||
            JSON.stringify(next.accessPolicy) !== JSON.stringify(record.accessPolicy) ||
            JSON.stringify(next.activePluginIds) !== JSON.stringify(record.activePluginIds)) {
          record = next;
          void segments.save(options.app, record).then(() => { persistError = ''; }, error => { persistError = String(error.message || error); });
        }
      }
      emit(event, value);
    });
  }
  async function selectAgent(agentId, selection = {}) {
    if (closed || switching) return { ok: false, reason: '正在切换会话，请稍候' };
    if (pendingModel) return { ok: false, reason: '正在切换模型，请稍候再切换 Agent' };
    if (String(agentId) === raw.adapterId) return { ok: true, snapshot: snapshot() };
    if (busy(raw)) return { ok: false, code: 'EXECUTION_SWITCH_BUSY', reason: BUSY };
    let before = snapshot();
    if (goalSwitchBlocked(before))
      return { ok: false, reason: '请先结束目标模式，再切换 Agent' };
    if (!catalog.runtime(agentId)) return { ok: false, reason: '未知 Agent，请刷新后重试' };
    switching = true; emit({ kind: 'runtime-switching' });
    let candidate = null;
    try {
      // Routine process projections deliberately defer large tool bodies.
      // Freeze the complete old segment before it is disposed, so historical
      // tool details and a later reopen retain the original receipts.
      if (typeof raw.snapshotAsync === 'function') {
        before = snapshot(await raw.snapshotAsync());
        if (closed || busy(raw)) throw Error(closed ? '会话已关闭，本次切换已取消' : BUSY);
        if (goalSwitchBlocked(before)) throw Error('请先结束目标模式，再切换 Agent');
      }
      await selection.validate?.();
      const identity = switchIdentity(selection);
      if (persistError) { await segments.save(options.app, record); persistError = ''; }
      const ready = await probe(options.app, agentId);
      if (!ready?.ok) throw Error(ready?.reason || '此 Agent 尚不可用');
      const policy = before.nextAccessPolicy || before.accessPolicy;
      const support = ready.accessControl || catalog.runtime(agentId).accessControl;
      if (policy && (!support?.supported || !support.modes?.includes(policy.mode)))
        throw Error('目标 Agent 不支持当前权限模式，请先选择兼容的权限');
      let modelName = typeof selection.modelName === 'string' ? selection.modelName :
        catalog.runtime(agentId).modelMode === catalog.runtime(raw.adapterId)?.modelMode ? before.modelSelection?.name || '' : '';
      // Entering Codex uses the same first available native model as a new chat.
      if (agentId === 'codex' && !modelName)
        modelName = require('./native-model-catalog').list('codex').models?.[0]?.id || '';
      const nextOptions = { ...options, ref: 'chat-' + crypto.randomUUID(), cwd: raw.cwd, adapterId: agentId,
        sessionTitle: segments.title(record) || raw.historyRow?.()?.title || '',
        modelName, reasoningEffort: '', resumePath: '', resumeCwd: '', runtimeConversationId: '',
        nativeDispatchId: '', nativeSessionStarted: undefined, verifyLegacySegment: false,
        intent: '', mode: '', goal: '', acceptance: '', accessPolicy: policy,
        activePluginIds: before.activePlugins || [],
        contextPrompts: [...(options.contextPrompts || []), segments.brief(before)] };
      candidate = await openNative({ ...nextOptions, identity });
      await selection.validate?.();
      if (closed || busy(raw)) throw Error(closed ? '会话已关闭，本次切换已取消' : BUSY);
      const next = candidate.raw;
      for (const binding of raw.taskBindings || []) {
        const result = await next.bindTask?.(binding.taskId, binding.title || binding.taskTitle);
        if (result?.ok === false) throw Error(result.reason || '需求关联无法保留');
      }
      const old = raw, oldDescriptor = { ...descriptor(old), usedHarnesses:
        old.historyRow?.()?.usedHarnesses || harnesses.fromSnapshot(old.snapshot(), old.adapterId) };
      const historical = clone({ messages: before.messages || [], tools: before.tools || [],
        usageReceipts: before.usageReceipts || [], turnMetrics: before.turnMetrics || [] });
      // Native tools may reuse small IDs. Namespace only the newly-finished
      // segment, keeping previously displayed IDs stable across later switches.
      const ids = new Map(historical.tools.slice(prefix.tools.length).map(t => [t.id, old.sessionId + ':' + t.id]));
      for (const tool of historical.tools.slice(prefix.tools.length)) tool.id = ids.get(tool.id);
      for (const message of historical.messages.slice(prefix.messages.length)) for (const block of message.blocks || [])
        if (block.toolCall?.id && ids.has(block.toolCall.id)) block.toolCall.id = ids.get(block.toolCall.id);
      const nextRecord = { version: 1, id: publicId, owner,
        title: segments.title(record) || old.historyRow?.()?.title || '', cwd: old.cwd, originAdapter,
        at: Date.now(), prefix: historical,
        accessPolicy: policy, readOnly: options.readOnly,
        activePluginIds: before.activePlugins || [],
        segments: [...(record?.segments || []), oldDescriptor],
        active: { ...descriptor(next), modelName,
          ...(agentId === 'codex' ? { reasoningEffort: next.snapshot()?.thinking?.level || '' } : {}),
          started: false, usedHarnesses: [] } };
      if (closed) throw Error('会话已关闭，本次切换已取消');
      await segments.save(options.app, nextRecord);
      if (closed) {
        if (record) await segments.save(options.app, record);
        else await segments.remove(options.app, publicId);
        throw Error('会话已关闭，本次切换已取消');
      }
      record = nextRecord; prefix = record.prefix; raw = next;
      changed(candidate); subscribe(); candidate = null;
      // Old native close must not unsubscribe the conversation's memory observer.
      if (old.ui === overlays.ui) old.ui = {};
      raw.ui = overlays.ui;
      if (typeof overlays.captureDelivery === 'function') raw.captureDelivery = overlays.captureDelivery;
      await disposeNative(oldDescriptor).catch(() => {});
      overlays.usageAgentKey = agentId;
      switching = false; emit({ kind: 'runtime-changed' });
      return { ok: true, adapterId: agentId, displayName: raw.displayName, snapshot: snapshot() };
    } catch (error) {
      if (candidate) await disposeNative(descriptor(candidate.raw)).catch(() => {});
      return { ok: false, reason: String(error.message || error) };
    } finally { switching = false; if (!closed) emit({ kind: 'runtime-switch-settled' }); }
  }
  function beginSwitch(...args) {
    if (switchingCompletion) return Promise.resolve({ ok: false, reason: '正在切换 Agent，请稍候' });
    const job = selectAgent(...args).finally(() => { if (switchingCompletion === job) switchingCompletion = null; });
    switchingCompletion = job; return job;
  }
  const own = {
    selectAgent: beginSwitch, snapshot,
    toolDetail(id) {
      const old = prefix.tools.find(tool => String(tool.id) === String(id));
      if (old) return old;
      const detail = raw.toolDetail?.(id);
      const fallback = value => value || raw.snapshot().tools?.find(tool => String(tool.id) === String(id)) || null;
      return detail?.then ? Promise.resolve(detail).then(fallback) : fallback(detail);
    },
    uiSnapshot: value => record ? windowed.limitSnapshot(snapshot(), value) :
      { ...nativeSource.snapshot(raw.uiSnapshot?.(value) || windowed.limitSnapshot(snapshot(), value), raw.adapterId), runtimeSwitching: switching },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    inFlight: () => switching || Boolean(raw.inFlight?.()),
    historyRow(s) {
      const current = raw.historyRow?.(s);
      return { ...current, id: publicId, ref: publicRef,
        usedHarnesses: harnesses.merge(harnesses.fromRecord(record),
          current?.usedHarnesses || harnesses.fromSnapshot(raw.snapshot(), raw.adapterId)),
        ...(record ? { title: segments.title(record) || current?.title || '' } : {}), adapterId: raw.adapterId };
    },
    async close() { closed = true; unsub?.(); listeners.clear(); overlays.ui?.memorySubscription?.();
      await switchingCompletion;
      await pendingModel;
      if (record) await segments.flush(options.app, publicId); return true; },
  };
  const handle = new Proxy({}, {
    get(_target, key) {
      if (key === 'ref') return publicRef;
      if (key === 'sessionId') return publicId;
      if (key === 'runtimeOriginAdapter') return originAdapter;
      if (key === 'runtimeAdapters') return [...new Set([originAdapter, ...(record?.segments || []).map(s => s.adapterId), raw.adapterId])];
      if (Object.hasOwn(overlays, key)) return overlays[key];
      if (Object.hasOwn(own, key)) return own[key];
      const value = raw[key];
      if (typeof value !== 'function') return value;
      if (methods.get(key)?.source !== value) methods.set(key, { source: value, call: (...args) => {
        if ((closed || switching) && ['send', 'submit', 'selectModel', 'setThinkingLevel', 'setAccessPolicy', 'bindTask'].includes(key)) {
          const result = { ok: false, reason: closed ? '会话已关闭，请重新打开' : '正在切换 Agent，请稍候再发送' };
          return key === 'submit' ? { accepted: false, result } : result;
        }
        if (key === 'setThinkingLevel' && pendingModel) return { ok: false, reason: '正在切换模型，请稍候' };
        if (key === 'selectModel') {
          if (pendingModel) return { ok: false, reason: '正在切换模型，请稍候' };
          const result = raw[key](...args);
          if (!result?.then) return result;
          const job = Promise.resolve(result).finally(() => { if (pendingModel === job) pendingModel = null; });
          pendingModel = job; return job;
        }
        return raw[key](...args);
      } });
      return methods.get(key).call;
    },
    set(_target, key, value) { overlays[key] = value;
      if (key === 'captureDelivery' || typeof value !== 'function') Reflect.set(raw, key, value); return true; },
  });
  subscribe(); return handle;
}
module.exports = { create, resumeOptions, busy, goalSwitchBlocked };
