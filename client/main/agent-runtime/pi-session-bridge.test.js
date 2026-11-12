'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createPiSessionBridge, RUNTIME_RECORD } = require('./pi-session-bridge');
const { MemoryGoalCheckpointStore } = require('./goal-checkpoint-store');

function fakeSessionModule() {
  const opened = [];
  const handles = [];
  let serial = 0;
  const module = {
    opened,
    handles,
    execution: {},
    sessionStatus: 'idle',
    running: false,
    controls: [],
    closeHook: null,
    async probe(app) { return { ok: true, app: app && app.name || '' }; },
    async open(options) {
      opened.push(options);
      serial += 1;
      const listeners = new Set();
      const handle = {
        ref: options.ref || 'chat-' + serial,
        sessionId: 'pi-' + serial,
        cwd: options.cwd || 'C:\\work',
        model: { id: 'model-' + serial },
        closed: false,
        on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        emit(touched, snapshot) { listeners.forEach((listener) => listener(touched, snapshot)); },
        snapshot() {
          return {
            status: module.sessionStatus,
            messages: [], tools: [],
            execution: { ...module.execution },
          };
        },
        status() { return module.sessionStatus; },
        inFlight() { return module.running; },
        submit() { return { accepted: true, queued: false, completion: Promise.resolve({ ok: true }) }; },
        cancel() {},
        outputs() { return []; },
        answerUi() {},
        continueGoal() { module.controls.push('continue'); return { ok: true }; },
        pauseGoal() { module.controls.push('pause'); return { ok: true }; },
        disableGoal() { module.controls.push('disable'); return { ok: true }; },
        async close() { if (module.closeHook) await module.closeHook(); handle.closed = true; },
      };
      handles.push(handle);
      return { ok: true, session: handle, seeded: 3 };
    },
    history() { return Promise.resolve({ ok: true, chats: [] }); },
    prewarm() { return Promise.resolve({ ok: true }); },
  };
  return module;
}

test('Pi bridge opens a real legacy handle through the runtime registry', async () => {
  const raw = fakeSessionModule();
  const bridge = createPiSessionBridge({ sessionModule: raw });
  const result = await bridge.open({ ref: 'chat-a', cwd: 'C:\\work', identity: { id: 'u-1' } });

  assert.equal(result.ok, true);
  assert.equal(result.seeded, 3);
  assert.equal(result.session.ref, 'chat-a');
  assert.equal(bridge.get('chat-a'), result.session);
  assert.equal(bridge.findBySessionId('pi-1'), result.session);
  assert.equal(result.session[RUNTIME_RECORD].consumer, 'chat');
  assert.equal(bridge.runtimeSession('chat-a').adapterId, 'pi');
  assert.equal(raw.opened[0].identity.id, 'u-1');

  await bridge.dispose();
});

test('Pi task binding mismatch remains a typed refusal through the runtime adapter and bridge', async () => {
  const raw = fakeSessionModule();
  raw.open = async () => ({ ok: false, code: 'TASK_BINDING_MISMATCH', reason: '这条会话不是该需求的协作会话' });
  const bridge = createPiSessionBridge({ sessionModule: raw, runnerAdapters: [] });
  for (const resumePath of ['', 'old-session.jsonl']) {
    const result = await bridge.open({ ref: 'wrong-task', taskRef: 'new-task', requireTaskBinding: true, resumePath });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TASK_BINDING_MISMATCH');
    assert.equal(result.runtimeError, 'TASK_BINDING_MISMATCH');
    assert.equal(bridge.get('wrong-task'), null);
  }
  raw.open = async () => ({ ok: false, reason: '其他初始化失败' });
  const failed = await bridge.open({ ref: 'ordinary-error' });
  assert.equal(failed.code, undefined, 'unrelated failures must not trigger task mapping recovery');
  assert.equal(failed.runtimeError, 'PI_SESSION_OPEN_FAILED');
  await bridge.dispose();
});

test('cloud history uses the existing archive lifecycle without requiring a native Agent archive', async () => {
  const raw = fakeSessionModule(), archived = {}, row = { id: 'cloud1', cloud: true, adapterId: 'pi', title: 'Cloud', state: 'running', at: 1 };
  let hidden = false;
  Object.assign(raw, { historyEntry: async () => ({ ok: false, notFound: true }),
    archiveRoot: () => 'fixture', archiveState: { read: () => ({ conversations: archived }) },
    isArchived: (_app, id) => Boolean(archived[id]),
    setArchived: (_app, id, value) => { if (value) archived[id] = 1; else delete archived[id]; return archived[id]; } });
  const bridge = createPiSessionBridge({ sessionModule: raw, runnerAdapters: [] });
  bridge.setExternalHistory({ history: async () => ({ ok: true, chats: hidden ? [] : [row] }),
    forget: async id => { assert.equal(id, 'cloud1'); hidden = true; return { ok: true }; } });
  assert.equal((await bridge.history()).chats[0].id, 'cloud1');
  assert.equal((await bridge.archiveHistory(null, 'cloud1')).ok, false);
  row.state = 'completed'; assert.equal((await bridge.archiveHistory(null, 'cloud1')).ok, true);
  assert.equal((await bridge.history()).chats.length, 0);
  assert.equal((await bridge.archivedHistory()).chats[0].id, 'cloud1');
  assert.equal((await bridge.restoreHistory(null, 'cloud1')).ok, true);
  assert.equal((await bridge.history()).chats.length, 1);
  await bridge.archiveHistory(null, 'cloud1');
  assert.equal((await bridge.permanentlyDeleteHistory(null, 'cloud1')).ok, true);
  assert.equal((await bridge.history()).chats.length, 0); assert.equal(raw.opened.length, 0);
});

test('local and cloud history rows keep separate directory scopes and cloud wins an id collision', async () => {
  const raw = fakeSessionModule();
  raw.history = async () => ({ ok: true, chats: [
    { id: 'same-id', title: 'local copy', cwd: 'C:\\projects\\local', at: 200 },
    { id: 'local-only', title: 'local only', cwd: 'C:\\projects\\other', at: 100 },
  ] });
  const bridge = createPiSessionBridge({ sessionModule: raw, runnerAdapters: [] });
  bridge.setExternalHistory({
    history: async () => ({ ok: true, chats: [
      { id: 'same-id', title: 'cloud copy', cwd: 'C:\\Users\\me\\AppData\\cloud-cache', cloud: true, at: 1 },
      { id: 'cloud-only', title: 'cloud only', cwd: 'C:\\Users\\me\\AppData\\cloud-cache-2', cloud: true, at: 300 },
    ] }),
    isRemote: id => id === 'same-id',
  });
  const rows = (await bridge.history()).chats;
  const local = rows.find(row => row.id === 'local-only');
  const cloud = rows.find(row => row.id === 'cloud-only');
  const collision = rows.find(row => row.id === 'same-id');
  assert.equal(rows.length, 3);
  assert.equal(local.cwd, 'C:\\projects\\other');
  assert.equal(local.location, 'local');
  assert.equal(cloud.cloud, true);
  assert.equal(cloud.location, 'cloud');
  assert.equal(cloud.locationMode, 'remote');
  assert.equal(cloud.cwd, '');
  assert.equal(collision.title, 'cloud copy');
  assert.equal(collision.cwd, '');
  await bridge.dispose();
});

test('account projections and local replay copies share one history row by trusted origin ids', async () => {
  const raw = fakeSessionModule();
  raw.history = async () => ({ ok: true, chats: [
    { id: 'native-1', title: 'Same conversation', sourceSessionId: 'native-1', at: 30 },
    { id: 'independent', title: 'Same conversation', at: 20 },
  ] });
  const bridge = createPiSessionBridge({ sessionModule: raw, runnerAdapters: [] });
  bridge.setExternalHistory({ history: async () => ({ ok: true, chats: [
    { id: 'acct-1', title: 'Same conversation', accountProjection: true,
      sourceClientId: 'desktop', sourceSessionId: 'native-1', at: 40 },
    { id: 'acct-independent', title: 'Same conversation', accountProjection: true,
      sourceClientId: 'desktop', sourceSessionId: 'other-native', at: 10 },
  ] }) });
  bridge.setReplicaHistory({
    projectRows: async rows => rows,
    indexedRows: async () => [{ id: 'copy-1', title: 'Same conversation', cached: true,
      source: { id: 'acct-1' }, sourceSessionId: 'native-1', at: 35 }],
    store: { lifecycleRows: () => [] },
  });
  const rows = (await bridge.history()).chats;
  assert.equal(rows.filter(row => row.title === 'Same conversation').length, 3);
  const merged = rows.find(row => row.id === 'copy-1');
  assert.ok(merged);
  assert.ok(merged.historyAliasIds.includes('acct-1'));
  assert.ok(merged.historyAliasIds.includes('native-1'));
  assert.ok(rows.some(row => row.id === 'independent'));
  assert.ok(rows.some(row => row.id === 'acct-independent'));
  await bridge.dispose();
});

test('deleted account origins hide cached copies without hiding independent same-title chats', async () => {
  const raw = fakeSessionModule();
  raw.history = async () => ({ ok: true, chats: [
    { id: 'independent', title: 'Same conversation', at: 20 },
  ] });
  const bridge = createPiSessionBridge({ sessionModule: raw, runnerAdapters: [] });
  bridge.setExternalHistory({ history: async () => ({ ok: true,
    chats: [{ id: 'acct-deleted', title: 'Same conversation', accountProjection: true, at: 30 }],
    lifecycle: [{ id: 'acct-deleted', deleted: true, lifecycleRevision: 4, revision: 4 }] }) });
  bridge.setReplicaHistory({
    projectRows: async rows => rows,
    indexedRows: async () => [{ id: 'copy-deleted', title: 'Same conversation', cached: true,
      source: { id: 'acct-deleted' }, at: 35 }],
    store: { lifecycleRows: () => [] },
  });
  const rows = (await bridge.history()).chats;
  assert.deepEqual(rows.map(row => row.id), ['independent']);
  await bridge.dispose();
});

test('bridge collapses account aliases from multiple devices by source session', async () => {
  const raw = fakeSessionModule();
  raw.history = async () => ({ ok: true, chats: [] });
  const bridge = createPiSessionBridge({ sessionModule: raw, runnerAdapters: [] });
  bridge.setExternalHistory({ history: async () => ({ ok: true, chats: [
    { id: 'acct-current', title: 'Shared', accountConversation: true, sourceSessionId: 'source-1', at: 20 },
    { id: 'acct-old', title: 'Shared', accountConversation: true, sourceSessionId: 'source-1', at: 30 },
    { id: 'acct-other', title: 'Shared', accountConversation: true, sourceSessionId: 'source-2', at: 10 },
  ] }) });
  bridge.setReplicaHistory({ projectRows: async rows => rows, indexedRows: async () => [],
    store: { lifecycleRows: () => [] } });
  const rows = (await bridge.history()).chats;
  assert.deepEqual(rows.map(row => row.id), ['acct-old', 'acct-other']);
  assert.ok(rows[0].historyAliasIds.includes('acct-current'));
  await bridge.dispose();
});

test('Pi bridge keeps mutable legacy fields while exposing normalized events', async () => {
  const raw = fakeSessionModule();
  const bridge = createPiSessionBridge({ sessionModule: raw });
  const result = await bridge.open({ ref: 'chat-b' });
  const events = [];
  bridge.runtimeSession('chat-b').subscribe((event) => events.push(event));

  result.session.ui = { mode: 'full' };
  result.session.detached = true;
  raw.handles[0].emit({ kind: 'turn-finished' }, {
    status: 'idle', messages: [], tools: [], execution: {},
  });

  assert.deepEqual(raw.handles[0].ui, { mode: 'full' });
  assert.equal(raw.handles[0].detached, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'turn.completed');
  assert.equal(events[0].native.namespace, 'pi');

  result.session.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(raw.handles[0].closed, true);
  assert.equal(bridge.get('chat-b'), null);
  assert.equal(bridge.runtimeSession('chat-b'), null);
  await bridge.dispose();
});

test('Pi bridge uses the goal consumer and resume path without changing open options', async () => {
  const raw = fakeSessionModule();
  raw.execution = {
    configured: true, visible: true, active: false, paused: true,
    harness: {
      runId: 'goal-run-1', node: 'verify', phase: 'verify', state: 'paused',
      revision: 7, iteration: 2,
    },
    quality: { required: true, phase: 'paused', reason: 'step limit' },
    limitRequest: { kind: 'steps', reason: 'step limit', used: 30, limit: 30 },
  };
  const bridge = createPiSessionBridge({
    sessionModule: raw, checkpointStore: new MemoryGoalCheckpointStore(),
  });
  const result = await bridge.open({
    ref: 'chat-goal', intent: 'goal', goal: 'deliver', resumePath: 'C:\\state\\session.jsonl',
  });

  assert.equal(result.ok, true);
  assert.equal(result.session[RUNTIME_RECORD].consumer, 'goal');
  assert.equal(raw.opened[0].intent, 'goal');
  assert.equal(raw.opened[0].goal, 'deliver');
  assert.equal(raw.opened[0].resumePath, 'C:\\state\\session.jsonl');
  assert.equal(bridge.goalCheckpoint('chat-goal').goal.harnessRevision, 7);
  assert.equal(bridge.goalCheckpoint('pi-1').safeBoundary, true);

  const continued = result.session.continueGoal();
  assert.equal(continued.ok, true);
  assert.deepEqual(raw.controls, ['continue']);
  const checkpoint = bridge.goalCheckpoint('chat-goal');
  assert.equal(checkpoint.action.name, 'continue');
  assert.equal(checkpoint.action.state, 'accepted');
  await bridge.dispose();
});

test('Pi bridge keeps ordinary chat outside Goal Supervisor persistence', async () => {
  const raw = fakeSessionModule();
  const store = new MemoryGoalCheckpointStore();
  const bridge = createPiSessionBridge({ sessionModule: raw, checkpointStore: store });
  const result = await bridge.open({ ref: 'chat-plain' });

  assert.equal(result.ok, true);
  assert.equal(bridge.goalCheckpoint('chat-plain'), null);
  assert.deepEqual(result.session.continueGoal(), { ok: true });
  assert.deepEqual(raw.controls, ['continue']);
  await bridge.dispose();
});

test('Pi bridge allows emergency pause mid-turn but only continues at a safe boundary', async () => {
  const raw = fakeSessionModule();
  raw.sessionStatus = 'streaming';
  raw.running = true;
  raw.execution = {
    configured: true, active: true, running: true,
    harness: { runId: 'goal-run-active', state: 'running', revision: 2 },
  };
  const bridge = createPiSessionBridge({
    sessionModule: raw, checkpointStore: new MemoryGoalCheckpointStore(),
  });
  const result = await bridge.open({ ref: 'chat-active', intent: 'goal' });

  assert.equal(result.session.continueGoal().code, 'GOAL_TURN_ACTIVE');
  assert.deepEqual(raw.controls, []);
  assert.equal(bridge.runtimeSession('chat-active').controlGoal('pause').ok, true);
  assert.deepEqual(raw.controls, ['pause']);
  assert.equal(result.session.disableGoal().ok, true);
  assert.deepEqual(raw.controls, ['pause', 'disable']);
  assert.equal(bridge.runtimeSession('chat-active').controlGoal('continue').code,
    'GOAL_TURN_ACTIVE');
  await bridge.dispose();
});

test('Pi bridge refuses a goal session when durable checkpoints cannot be written', async () => {
  const raw = fakeSessionModule();
  raw.execution = {
    configured: true,
    harness: { runId: 'goal-no-store', state: 'paused', revision: 1 },
  };
  const bridge = createPiSessionBridge({
    sessionModule: raw,
    checkpointDurable: true,
    checkpointStore: {
      load() { return null; },
      save() { throw new Error('disk is read only'); },
    },
  });
  const result = await bridge.open({ ref: 'chat-no-store', intent: 'goal' });

  assert.equal(result.ok, false);
  assert.equal(result.runtimeError, 'GOAL_CHECKPOINT_WRITE_FAILED');
  assert.equal(bridge.list().length, 0);
  assert.equal(raw.handles[0].closed, true);
  await bridge.dispose();
});

test('Pi bridge preserves the legacy failure result shape', async () => {
  const raw = fakeSessionModule();
  raw.open = async () => ({ ok: false, reason: 'model unavailable' });
  const bridge = createPiSessionBridge({ sessionModule: raw });
  const result = await bridge.open({ ref: 'chat-fail' });

  assert.equal(result.ok, false);
  assert.match(result.reason, /model unavailable/);
  assert.equal(bridge.list().length, 0);
  await bridge.dispose();
});
test('Pi bridge close waits for the runtime handle before archive deletion can continue', async () => {
  const raw = fakeSessionModule();
  let releaseClose;
  raw.closeHook = () => new Promise((resolve) => { releaseClose = resolve; });
  const bridge = createPiSessionBridge({ sessionModule: raw });
  const result = await bridge.open({ ref: 'chat-delete' });

  const closing = result.session.close();
  assert.equal(typeof closing.then, 'function');
  assert.equal(bridge.get('chat-delete'), null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(raw.handles[0].closed, false);

  releaseClose();
  assert.equal(await closing, true);
  assert.equal(raw.handles[0].closed, true);
  await bridge.dispose();
});
