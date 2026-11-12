'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createPiSessionBridge } = require('../main/agent-runtime/pi-session-bridge');
const { createRunnerRuntimeAdapter, _uuidV5 } = require('../main/agent-runtime/runner-adapter');
const catalog = require('../main/agent-runtime/runtime-catalog');
const segments = require('../main/conversation/runtime-segments');
const sessionArchive = require('../main/pi-session/session');
const { goalSwitchBlocked } = require('../main/agent-runtime/switchable-conversation');
const identity = uid => ({ hub: 'http://127.0.0.1:9', clientId: 'test-device', session:
  Buffer.from(JSON.stringify({ typ: 'device', uid, cid: 'test-device', iat: Math.floor(Date.now()/1000)-10, exp: Math.floor(Date.now()/1000)+3600 })).toString('base64url') + '.' + 'a'.repeat(64) });

test('completed goal conversations can switch while active goals remain protected', () => {
  assert.equal(goalSwitchBlocked({ execution: { configured: false } }), false);
  assert.equal(goalSwitchBlocked({ execution: { configured: true, active: true } }), true);
  assert.equal(goalSwitchBlocked({ execution: { configured: true, terminalConfirmed: false, harness: { state: 'idle' } } }), true);
  assert.equal(goalSwitchBlocked({ execution: { configured: true, terminalConfirmed: true, harness: { state: 'idle' } } }), false);
  assert.equal(goalSwitchBlocked({ execution: { configured: true, harness: { state: 'completed' } } }), false);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-agent-switch-')), app = { getPath: () => root };
  const archives = new Map(), runs = new Map(), openings = [], requests = [];
  let serial = 0, unavailable = '', busy = false, gate = null, strictMissing = false;
  let absence = { has: false, inflight: false, persisted: false, admissionDurable: true, bootId: 'test-boot' };
  const engine = {
    ...Object.fromEntries(['setArchived', 'isArchived', 'archiveState', 'archiveRoot'].map(k => [k, sessionArchive[k]])),
    probe: async () => ({ ok: true }),
    async open(options) {
      openings.push(options);
      const id = archives.get(options.resumePath)?.raw.sessionId || 'pi-' + (++serial), file = options.resumePath || path.join(root, id + '.jsonl');
      const messages = archives.get(file)?.messages || [];
      const listeners = new Set(); let model = options.modelName || 'model-a';
      const raw = { ref: options.ref, adapterId: 'pi', displayName: 'Pi', sessionId: id, cwd: root, ui: {},
        resumeLocation: () => file, status: () => 'idle', inFlight: () => busy,
        snapshot: () => ({ adapterId: 'pi', status: 'idle', activePlugins: options.activePluginIds || ['meeting'],
          modelSelection: { name: model, model: { id: model } }, accessPolicy: options.accessPolicy,
          messages: messages.slice(), tools: [] }),
        historyRow: () => ({ id, adapterId: 'pi', path: file, cwd: root, title: 'Switch test', count: messages.length }),
        on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        submit(text) { messages.push({ role: 'user', text }, { role: 'assistant', blocks: [{ kind: 'text', text: 'Pi reply' }], done: true });
          fs.writeFileSync(file, 'archive'); listeners.forEach(fn => fn({ kind: 'settled' }, raw.snapshot()));
          return { accepted: true, completion: Promise.resolve({ ok: true }) }; },
        selectModel(name) { model = name; return { ok: true, selection: raw.snapshot().modelSelection }; },
        close() { listeners.clear(); },
      };
      archives.set(file, { raw, messages }); return { ok: true, session: raw };
    },
    history: async () => ({ ok: true, chats: [...archives.values()].map(x => x.raw.historyRow()) }),
    historyEntry: async (_app, id) => {
      const found = [...archives.values()].find(x => x.raw.sessionId === id);
      return found ? { ok: true, entry: found.raw.historyRow() } : { ok: false, notFound: true };
    },
    archiveHistory: async (_app, id) => { sessionArchive.setArchived(app, id, true); return { ok: true }; },
    restoreHistory: async (_app, id) => { sessionArchive.setArchived(app, id, false); return { ok: true }; },
    permanentlyDeleteHistory: async (_app, id) => {
      for (const [key, x] of archives) if (x.raw.sessionId === id) archives.delete(key);
      sessionArchive.setArchived(app, id, false); return { ok: true };
    },
  };
  const runtime = { async rpc(op, input) {
    requests.push({ op, input });
    if (op === 'runtime.detect') { if (gate) await gate;
      return { ok: true, data: { installed: input.key !== unavailable, state: input.key === unavailable ? 'missing' : 'ready',
        accessControl: { ...catalog.runtime(input.key).accessControl, canChangeDuringSession: true } } }; }
    if (op === 'job.dispatch') {
      const ref = _uuidV5('9af442c8-cd1d-4b91-a668-22da2b2635bf', input.dispatchId || 'chat:' + input.task.id + ':' + input.cli);
      runs.set(ref, { ref, cli: input.cli, taskId: input.task.id, workDir: input.ctx.workDir, state: 'done', title: input.task.title,
        items: [{ seq: 1, kind: 'user', text: input.ctx.conversationUserText },
          { seq: 2, kind: 'say', text: 'Reply ' + input.cli }] });
      return { ok: true, data: { ref } };
    }
    if (op === 'job.comment') { const run = runs.get(input.ref); run.items.push({ seq: run.items.length+1, kind: 'say', text: 'Followup' }); return { ok: true, data: { ok: true } }; }
    if (op === 'job.session') { const run = runs.get(input.ref);
      if (!run && strictMissing) return { ok: true, data: { ok: false, error: 'Native session does not exist' } };
      return { ok: true, data: { status: 'done', round: 1, items: (run?.items || []).filter(x => x.seq > (input.since || 0)) } }; }
    if (op === 'job.has') { if (absence instanceof Error) throw absence; return { ok: true, data: { ...absence } }; }
    if (op === 'runtime.sessions') return { ok: true, data: { runs: [...runs.values()] } };
    if (op === 'runtime.session.forget') { runs.delete(input.ref); return { ok: true, data: { ok: true } }; }
    if (op === 'job.stop') return { ok: true, data: { ok: true } };
    throw Error('Unexpected ' + op);
  } };
  function bridge() { return createPiSessionBridge({ app, sessionModule: engine, runnerAdapters: catalog.runnerRuntimes().map(spec => createRunnerRuntimeAdapter({
    app, runtimeSpec: spec, runnerRuntime: runtime,
    modelConfig: { fetchModel: async (_id, name) => name === 'denied' ? { ok: false, reason: 'unauthorized model' } :
      { ok: true, model: { id: name || 'model-a', name: name || 'model-a', key: 'fixture-secret', baseUrl: 'http://fixture.invalid' } } },
  })) }); }
  let current = bridge();
  t.after(async () => { await current.dispose(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });
  return { app, root, openings, requests, runs, archives, get bridge() { return current; },
    restart: async () => { await current.dispose(); current = bridge(); },
    set strictMissing(v) { strictMissing = v; }, set absence(v) { absence = v; },
    set unavailable(v) { unavailable = v; }, set busy(v) { busy = v; }, set gate(v) { gate = v; } };
}

test('history and live presence retain used runtimes across switches and exclude unused choices', async t => {
  const f = fixture(t);
  const opened = await f.bridge.open(options(f));
  assert.equal(opened.ok, true, opened.reason);
  const handle = opened.session, id = handle.sessionId;
  assert.deepEqual(handle.historyRow().usedHarnesses, []);
  await send(handle, 'Use Pi');
  assert.deepEqual(handle.historyRow().usedHarnesses, ['pi']);
  assert.equal((await handle.selectAgent('qwen')).ok, true);
  assert.deepEqual(handle.historyRow().usedHarnesses, ['pi'], 'selecting an idle runtime is not usage');
  await send(handle, 'Use Qwen');
  assert.deepEqual(handle.historyRow().usedHarnesses, ['pi', 'qwen']);
  assert.equal((await handle.selectAgent('opencode')).ok, true);
  assert.deepEqual(handle.historyRow().usedHarnesses, ['pi', 'qwen']);
  assert.deepEqual((await f.bridge.history(f.app)).chats.find(row => row.id === id).usedHarnesses, ['pi', 'qwen']);
  await f.restart();
  assert.deepEqual((await f.bridge.history(f.app)).chats.find(row => row.id === id).usedHarnesses, ['pi', 'qwen']);
  const restored = await f.bridge.open({ ...options(f), ref: 'used-harnesses-restored', runtimeConversationId: id });
  assert.equal(restored.ok, true, restored.reason);
  assert.deepEqual(restored.session.historyRow().usedHarnesses, ['pi', 'qwen']);
});

test('reopening a switched conversation marks missing native archives as resumed', async t => {
  const f = fixture(t), opened = await f.bridge.open(options(f));
  assert.equal(opened.ok, true, opened.reason);
  await send(opened.session, 'Keep historical context');
  assert.equal((await opened.session.selectAgent('qwen')).ok, true);
  await send(opened.session, 'Use the switched Agent');
  assert.equal((await opened.session.selectAgent('pi')).ok, true);
  await send(opened.session, 'Return to the native Agent');
  const id = opened.session.sessionId;
  const record = segments.read(f.app, id);
  assert.ok(record);
  assert.equal(record.active.adapterId, 'pi');
  assert.ok(record.active.path);
  record.active.modelName = 'dev-coding-large-agent-soduwork';
  await segments.save(f.app, record);
  fs.rmSync(record.active.path, { force: true });
  await f.restart();
  const restored = await f.bridge.open({ ...options(f), ref: 'missing-active-archive', runtimeConversationId: id });
  assert.equal(restored.ok, true, restored.reason);
  assert.equal(f.openings.at(-1).resumePath, '');
  assert.equal(f.openings.at(-1).resumedConversation, true);
});

test('switching persists completed statistics and offsets the next native turn without mutating receipts', async t => {
  const f = fixture(t), opened = await f.bridge.open(options(f)), handle = opened.session;
  await send(handle, 'First Pi turn');
  const first = [...f.archives.values()].at(-1).raw, firstSnapshot = first.snapshot;
  const firstMetric = { fromMessage: 0, toMessage: 1, elapsedMs: 2000, tokens: 11 };
  first.snapshot = () => ({ ...firstSnapshot(), turnMetrics: [firstMetric] });
  assert.equal((await handle.selectAgent('qwen')).ok, true);
  assert.deepEqual(segments.read(f.app, handle.sessionId).prefix.turnMetrics, [firstMetric]);
  assert.deepEqual(handle.snapshot().turnMetrics, [firstMetric]);
  await send(handle, 'Qwen turn');
  assert.equal((await handle.selectAgent('pi')).ok, true);
  await send(handle, 'Second Pi turn');
  const second = [...f.archives.values()].at(-1).raw, secondSnapshot = second.snapshot;
  const nextMetric = { fromMessage: 0, toMessage: 1, elapsedMs: 3000, tokens: 7 };
  second.snapshot = () => ({ ...secondSnapshot(), turnMetrics: [nextMetric] });
  const snap = handle.snapshot(), offset = snap.messages.length - 2;
  assert.deepEqual(snap.turnMetrics, [firstMetric,
    { fromMessage: 2, toMessage: 3, elapsedMs: null, tokens: null },
    { ...nextMetric, fromMessage: offset, toMessage: offset + 1 }]);
  assert.equal(nextMetric.fromMessage, 0, 'native receipt remains local to its segment');
});

test('an existing conversation switched to Codex keeps editable reasoning across model changes and restart', async t => {
  t.mock.method(require('../main/agent-runtime/native-model-catalog'), 'list', () => ({ ok: true, models: [
    { id: 'balanced', reasoningLevels: ['low', 'medium', 'high'], defaultReasoning: 'high' },
    { id: 'limited', reasoningLevels: ['low'], defaultReasoning: 'low' },
  ] }));
  const f = fixture(t), handle = (await f.bridge.open(options(f))).session;
  await send(handle, 'Existing conversation');
  const originalId = handle.sessionId;
  assert.equal((await handle.selectAgent('codex', { modelName: 'balanced' })).ok, true);
  assert.equal(handle.snapshot().thinking.level, 'medium');
  assert.equal((await handle.setThinkingLevel('high')).ok, true);
  await segments.flush(f.app, originalId);
  assert.equal(segments.read(f.app, originalId).active.reasoningEffort, 'high');
  assert.equal((await handle.selectModel('limited')).thinking.level, 'low');
  await segments.flush(f.app, originalId);
  assert.equal(segments.read(f.app, originalId).active.reasoningEffort, 'low');
  await send(handle, 'Use selected effort');
  assert.equal(f.requests.find(row => row.op === 'job.dispatch').input.cfg.codex_reasoning_effort, 'low');
  await f.restart();
  const restored = await f.bridge.open({ ...options(f), runtimeConversationId: originalId, ref: 'restored-codex' });
  assert.equal(restored.ok, true, restored.reason);
  assert.equal(restored.session.sessionId, originalId);
  assert.equal(restored.session.snapshot().modelSelection.name, 'limited');
  assert.equal(restored.session.snapshot().thinking.level, 'low');
  assert.equal((await restored.session.selectModel('balanced')).thinking.level, 'low');
  assert.equal((await restored.session.setThinkingLevel('')).thinking.level, 'medium');
  await restored.session.close();
  assert.equal((await restored.session.setThinkingLevel('high')).ok, false);
});

for (const selection of [undefined, { modelName: '' }, { modelName: 'limited' }]) {
  test(`switching an existing conversation to Codex resolves its initial model for ${JSON.stringify(selection)}`, async t => {
    t.mock.method(require('../main/agent-runtime/native-model-catalog'), 'list', () => ({ ok: true, models: [
      { id: 'balanced', reasoningLevels: ['low', 'medium', 'high'], defaultReasoning: 'high' },
      { id: 'limited', reasoningLevels: ['low'], defaultReasoning: 'low' },
    ] }));
    const f = fixture(t), handle = (await f.bridge.open(options(f))).session;
    await send(handle, 'Existing managed conversation');
    assert.equal((await handle.selectAgent('codex', selection)).ok, true);
    const explicit = selection?.modelName === 'limited';
    assert.equal(handle.snapshot().modelSelection.name, explicit ? 'limited' : 'balanced');
    assert.equal(handle.snapshot().thinking.supported, true);
    assert.equal((await handle.setThinkingLevel(explicit ? 'low' : 'high')).ok, true);
    await send(handle, 'Apply selected Codex settings');
    const dispatch = f.requests.find(row => row.op === 'job.dispatch').input;
    assert.equal(dispatch.cfg.codex_model, explicit ? 'limited' : 'balanced');
    assert.equal(dispatch.cfg.codex_reasoning_effort, explicit ? 'low' : 'high');
  });
}

test('switching to Codex with an empty native directory retains an unknown default without invented levels', async t => {
  t.mock.method(require('../main/agent-runtime/native-model-catalog'), 'list', () => ({ ok: true, models: [] }));
  const f = fixture(t), handle = (await f.bridge.open(options(f))).session;
  await send(handle, 'Existing managed conversation');
  assert.equal((await handle.selectAgent('codex')).ok, true);
  assert.equal(handle.snapshot().modelSelection.name, '');
  assert.equal(handle.snapshot().thinking.supported, false);
  assert.deepEqual(handle.snapshot().thinking.levels, []);
  assert.equal((await handle.setThinkingLevel('high')).ok, false);
  assert.equal(f.requests.filter(row => row.op === 'job.dispatch').length, 0);
});
const options = f => ({ app: f.app, ref: 'chat-switch', cwd: f.root, identity: identity('alice'), adapterId: 'pi', modelName: 'model-a',
  resolvePlugins: async ids => ({ items: ids.map(pluginId => ({ pluginId, name: 'Meeting', context: 'Fixture plugin context' })) }) });
async function send(handle, text) { const sent = handle.submit(text, [], {}); assert.equal(sent.accepted, true); const done = await sent.completion; assert.equal(done.ok, true, JSON.stringify(done)); }

async function waitIdle(handle) {
  for (let n = 0; n < 200; n++) {
    if (handle.snapshot().status === 'idle' && !handle.inFlight()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('The restored review conversation did not become idle');
}

for (const spec of catalog.runnerRuntimes()) test(spec.id + ': controlled receipts survive restart without claiming native admission', async t => {
  const f = fixture(t); f.strictMissing = true;
  const handle = (await f.bridge.open(options(f))).session;
  await send(handle, 'Requirement draft');
  assert.equal((await handle.selectAgent(spec.id)).ok, true);
  const id = handle.sessionId;
  assert.equal(handle.bindTask('requirement', 'Existing requirement').ok, true);
  handle.appendTaskMessage('user', 'Execute the requirement', [], 'requirement', 'request');
  handle.appendTaskMessage('assistant', 'Completed delivery', [], 'requirement', 'result');
  handle.taskExecutionChanged({ taskId: 'requirement', status: 'completed' });
  await segments.flush(f.app, id);
  const active = segments.read(f.app, id).active;
  assert.equal(active.started, false, 'task output is not a native dispatch acknowledgement');
  await f.restart();
  const reopened = await f.bridge.open({ ...options(f), ref: 'review-reopen', runtimeConversationId: id });
  assert.equal(reopened.ok, true, reopened.reason);
  await waitIdle(reopened.session);
  assert.match(JSON.stringify(reopened.session.snapshot().messages), /Completed delivery/);
  assert.equal(f.requests.filter(row => row.op === 'job.dispatch').length, 0);
  const task = { id: 'requirement', title: 'Existing requirement', ownerClientId: 'test-device',
    workRouting: { conversationTurn: { conversationId: id } } };
  let allowed = true, checks = 0;
  const review = await require('../main/pi-session/acceptance-turn').prepare({
    identity: identity('alice'), taskId: task.id, requested: { acceptanceExecutionSession: true },
    runtime: { handle: reopened.session }, request: async () => { checks++;
      return { task, canDecide: allowed, approvalId: 'approval', artifactVersionId: 'delivery-v1',
        requirementVersion: 1, criteria: [{ id: 'criterion', label: 'Complete content' }],
        attachments: [], artifact: { manifest: { text: 'Existing delivery' } } }; } });
  const reviewSent = reopened.session.submit(review.displayText, [], { beforeTurn: review.beforeTurn, promptText: review.text });
  assert.equal(reviewSent.accepted, true);
  assert.equal((await reviewSent.completion).ok, true);
  assert.equal(checks, 2, 'review authorization is checked again at the turn boundary');
  const starts = f.requests.filter(row => row.op === 'job.dispatch');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].input.cli, spec.id);
  assert.equal(starts[0].input.ctx.workDir, f.root);
  assert.match(starts[0].input.task.note, /delivery-v1/);
  assert.doesNotMatch(starts[0].input.ctx.conversationUserText, /delivery-v1/);
  assert.ok(f.runs.has(active.sessionId), 'first dispatch retains the segment and its task-output journal');
  await f.restart();
  const again = await f.bridge.open({ ...options(f), ref: 'review-again', runtimeConversationId: id });
  assert.equal(again.ok, true, again.reason);
  await waitIdle(again.session);
  await send(again.session, 'One explicit follow-up');
  assert.equal(f.requests.filter(row => row.op === 'job.dispatch').length, 1);
  assert.equal(f.requests.filter(row => row.op === 'job.comment').length, 1);
  allowed = false;
  const refused = again.session.submit(review.displayText, [], { beforeTurn: review.beforeTurn, promptText: review.text });
  assert.equal((await refused.completion).ok, false);
  assert.equal(f.requests.filter(row => row.op === 'job.comment').length, 1, 'revocation cannot start another review');
});

test('legacy message-count admission is repaired only with durable Runner absence proof', async t => {
  const f = fixture(t); f.strictMissing = true;
  const handle = (await f.bridge.open(options(f))).session;
  assert.equal((await handle.selectAgent('qwen')).ok, true);
  const id = handle.sessionId;
  handle.appendTaskMessage('assistant', 'Existing controlled delivery', [], 'requirement', 'result');
  await segments.flush(f.app, id);
  const record = segments.read(f.app, id);
  await segments.save(f.app, { ...record, active: { ...record.active, nativeDispatchId: undefined, started: true } });
  await f.restart();
  const opened = await f.bridge.open({ ...options(f), runtimeConversationId: id });
  assert.equal(opened.ok, true, opened.reason);
  await waitIdle(opened.session);
  assert.ok(f.requests.some(row => row.op === 'job.has' && row.input.ref === record.active.sessionId));
  assert.equal(f.requests.filter(row => row.op === 'job.dispatch').length, 0);
  assert.match(JSON.stringify(opened.session.snapshot().messages), /Existing controlled delivery/);
  let current = opened.session;
  const repaired = segments.read(f.app, id), durations = [];
  for (let cycle = 0; cycle < 25; cycle++) {
    await f.restart();
    const startedAt = performance.now();
    const next = await f.bridge.open({ ...options(f), ref: 'repeated-open-' + cycle, runtimeConversationId: id });
    assert.equal(next.ok, true, next.reason);
    await waitIdle(next.session); current = next.session;
    durations.push(performance.now() - startedAt);
    const saved = segments.read(f.app, id);
    assert.equal(saved.active.sessionId, repaired.active.sessionId);
    assert.equal(saved.segments.length, repaired.segments.length);
    assert.deepEqual(saved.prefix, repaired.prefix);
    assert.equal(current.snapshot().messages.filter(row => JSON.stringify(row).includes('Existing controlled delivery')).length, 1);
    assert.equal(f.requests.filter(row => row.op === 'job.dispatch').length, 0);
  }
  durations.sort((a, b) => a - b);
  t.diagnostic('Isolated cold open: 25 cycles, p95 ' + durations[23].toFixed(2) + ' ms, max ' + durations[24].toFixed(2) + ' ms');
  await send(current, 'Analyze only');
  assert.equal(f.requests.filter(row => row.op === 'job.dispatch').length, 1);
});

test('legacy native repair remains retryable when the public manifest cannot be committed', async t => {
  const f = fixture(t); f.strictMissing = true;
  const handle = (await f.bridge.open(options(f))).session;
  assert.equal((await handle.selectAgent('qwen')).ok, true);
  const id = handle.sessionId;
  assert.equal(handle.bindTask('requirement', 'Existing requirement').ok, true);
  handle.appendTaskMessage('assistant', 'Durable delivery', [], 'requirement', 'result');
  await segments.flush(f.app, id);
  const record = segments.read(f.app, id);
  await segments.save(f.app, { ...record, active: { ...record.active, nativeDispatchId: undefined, started: true } });
  await f.restart();
  const blocked = t.mock.method(segments, 'save', async () => { throw Error('Isolated manifest write failure'); });
  const failed = await f.bridge.open({ ...options(f), runtimeConversationId: id });
  assert.equal(failed.ok, false);
  assert.equal(segments.read(f.app, id).active.sessionId, record.active.sessionId);
  assert.equal(f.requests.filter(row => row.op === 'job.dispatch').length, 0);
  blocked.mock.restore();
  const reopened = await f.bridge.open({ ...options(f), runtimeConversationId: id });
  assert.equal(reopened.ok, true, reopened.reason);
  await waitIdle(reopened.session);
  assert.equal(reopened.session.sessionId, id);
  assert.match(JSON.stringify(reopened.session.snapshot().messages), /Durable delivery/);
  assert.ok(reopened.session.taskBindings.some(binding => binding.taskId === 'requirement'));
  await send(reopened.session, 'Analyze only');
  assert.equal(f.requests.filter(row => row.op === 'job.dispatch').length, 1);
});

for (const [name, evidence] of [
  ['offline', Error('Runner request timed out')],
  ['old Runner', { has: false }],
  ['active admission', { has: true, inflight: true, persisted: true, admissionDurable: true, bootId: 'boot' }],
  ['retained admission', { has: true, inflight: false, persisted: true, admissionDurable: true, bootId: 'boot' }],
]) test('missing legacy native archive stays fenced with ' + name, async t => {
  const f = fixture(t); f.strictMissing = true; f.absence = evidence;
  const handle = (await f.bridge.open(options(f))).session;
  assert.equal((await handle.selectAgent('qwen')).ok, true);
  const id = handle.sessionId;
  handle.appendTaskMessage('assistant', 'Retained delivery', [], 'requirement', 'result');
  await segments.flush(f.app, id);
  const record = segments.read(f.app, id);
  await segments.save(f.app, { ...record, active: { ...record.active, nativeDispatchId: undefined, started: true } });
  await f.restart();
  const opened = await f.bridge.open({ ...options(f), runtimeConversationId: id });
  assert.equal(opened.ok, true, opened.reason);
  assert.equal(opened.session.submit('Analyze only', []).queued, true);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.requests.filter(row => row.op === 'job.dispatch').length, 0);
  assert.equal(f.requests.filter(row => row.op === 'job.comment').length, 0);
  assert.equal(segments.read(f.app, id).active.sessionId, record.active.sessionId);
});

test('a stale unstarted manifest observes its durable native turn before accepting analysis', async t => {
  const f = fixture(t); f.strictMissing = true;
  const handle = (await f.bridge.open(options(f))).session;
  assert.equal((await handle.selectAgent('qwen')).ok, true);
  await send(handle, 'A native turn admitted before the manifest write');
  const id = handle.sessionId;
  await segments.flush(f.app, id);
  const record = segments.read(f.app, id);
  await segments.save(f.app, { ...record, active: { ...record.active, started: false } });
  await f.restart();
  const opened = await f.bridge.open({ ...options(f), runtimeConversationId: id });
  assert.equal(opened.ok, true, opened.reason);
  await waitIdle(opened.session);
  await send(opened.session, 'Analyze only');
  assert.equal(f.requests.filter(row => row.op === 'job.dispatch').length, 1);
  assert.equal(f.requests.filter(row => row.op === 'job.comment').length, 1);
});

for (const boundary of [{ after: 1, kind: 'message', role: 'assistant', text: 'Native-bound receipt' },
  { after: 0, kind: 'context-sent' }]) test('local native history prevents recreating an apparently absent segment: ' + boundary.kind, async t => {
  const f = fixture(t); f.strictMissing = true;
  const handle = (await f.bridge.open(options(f))).session;
  assert.equal((await handle.selectAgent('qwen')).ok, true);
  const id = handle.sessionId;
  await segments.flush(f.app, id);
  const record = segments.read(f.app, id);
  const journal = await require('../main/conversation/task-output-journal').create(f.app, record.active.sessionId);
  journal.append(boundary.after, boundary); journal.close();
  await segments.save(f.app, { ...record, active: { ...record.active, nativeDispatchId: undefined, started: true } });
  await f.restart();
  const opened = await f.bridge.open({ ...options(f), runtimeConversationId: id });
  assert.equal(opened.ok, true, opened.reason);
  assert.equal(opened.session.submit('Analyze only', []).queued, true);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.requests.filter(row => row.op === 'job.dispatch').length, 0);
  assert.equal(f.requests.filter(row => row.op === 'job.comment').length, 0);
  assert.equal(segments.read(f.app, id).active.sessionId, record.active.sessionId);
});

function workArchive(f) {
  const row = { id: 'reserved-work', title: '仅表单草稿', adapterId: 'pi', cwd: f.root,
    path: path.join(f.root, 'reserved-work.jsonl'), count: 0, workOnly: true,
    workOwner: segments.scope(identity('alice')) };
  fs.writeFileSync(row.path, JSON.stringify({ type: 'session', id: row.id }) + '\n');
  f.archives.set(row.path, { raw: { sessionId: row.id, historyRow: () => row }, messages: [] });
  return { id: row.id, title: row.title, path: row.path, cwd: row.cwd, owner: row.workOwner };
}

test('空表单会话首次选择非 Pi 底座，保留公开身份且不初始化旧 Pi', async t => {
  const f = fixture(t), work = workArchive(f), accessPolicy = require('../main/access-control/policy').create('readonly', f.root);
  const opened = await f.bridge.open({ ...options(f), adapterId: 'qwen', modelName: 'chosen-model', accessPolicy,
    workConversation: work, validateWorkConversation: async () => {} });
  assert.equal(opened.ok, true, opened.reason);
  assert.equal(opened.session.sessionId, work.id);
  assert.equal(opened.session.adapterId, 'qwen');
  assert.equal(opened.session.snapshot().accessPolicy.mode, 'readonly');
  assert.equal(opened.session.snapshot().modelSelection.name, 'chosen-model');
  assert.equal(f.openings.length, 0, '旧 Pi 只提供存档身份，不初始化 Pi Agent');
  assert.equal(f.requests.some(x => x.op === 'job.dispatch'), false, '建立底座不发送任务');
  assert.equal(segments.read(f.app, work.id).active.adapterId, 'qwen');
  await send(opened.session, '后续正常任务');
  const history = await f.bridge.history(f.app);
  assert.equal(history.chats.length, 1);
  assert.equal(history.chats[0].id, work.id);
  await f.restart();
  const restored = await f.bridge.open({ ...options(f), ref: 'reopen-work', runtimeConversationId: work.id });
  assert.equal(restored.ok, true, restored.reason);
  assert.equal(restored.session.sessionId, work.id);
  assert.equal(restored.session.adapterId, 'qwen');
});

test('首次选底座失败或账号失效不写切换清单、不吞原表单会话', async t => {
  const f = fixture(t), work = workArchive(f);
  const denied = await f.bridge.open({ ...options(f), adapterId: 'qwen', modelName: 'denied',
    workConversation: work, validateWorkConversation: async () => {} });
  assert.equal(denied.ok, false);
  assert.equal(segments.read(f.app, work.id), null);
  let checked = 0;
  const changed = await f.bridge.open({ ...options(f), adapterId: 'qwen', workConversation: work,
    validateWorkConversation: async () => { if (++checked > 1) throw Error('账号已经切换'); } });
  assert.equal(changed.ok, false);
  assert.match(changed.reason, /账号已经切换/);
  assert.equal(segments.read(f.app, work.id), null);
  assert.equal(f.bridge.list().length, 0);
  assert.equal(f.openings.length, 0);
  assert.ok(fs.existsSync(work.path));
});

test('同一空表单会话不能并发启动两个底座，失败写盘后仍能重试', async t => {
  const f = fixture(t), work = workArchive(f);
  let release;
  const gate = new Promise(done => { release = done; });
  const first = f.bridge.open({ ...options(f), adapterId: 'qwen', workConversation: work,
    validateWorkConversation: async () => { await gate; } });
  const duplicate = await f.bridge.open({ ...options(f), ref: 'another-window', adapterId: 'opencode',
    workConversation: work, validateWorkConversation: async () => {} });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.reason, /正在接入/);
  const saving = t.mock.method(segments, 'save', async () => { throw Error('隔离写盘失败'); });
  release();
  assert.equal((await first).ok, false);
  assert.equal(segments.read(f.app, work.id), null);
  assert.equal(f.bridge.list().length, 0);
  saving.mock.restore();
  const retried = await f.bridge.open({ ...options(f), adapterId: 'qwen', workConversation: work,
    validateWorkConversation: async () => {} });
  assert.equal(retried.ok, true, retried.reason);
  assert.equal(retried.session.sessionId, work.id);
});

test('Pi 首次绑定复用草稿首开锁，并发请求不进底座且失败后可重试', async t => {
  const f = fixture(t), work = workArchive(f);
  let release;
  const gate = new Promise(done => { release = done; });
  const first = f.bridge.open({ ...options(f), resumePath: work.path, workConversationId: work.id,
    validateWorkConversation: async () => { await gate; throw Error('账号已经切换'); } });
  const duplicate = await f.bridge.open({ ...options(f), ref: 'other-window', resumePath: work.path,
    workConversationId: work.id, validateWorkConversation: async () => {} });
  assert.equal(duplicate.ok, false); assert.match(duplicate.reason, /正在接入/);
  assert.equal(f.openings.length, 0, 'duplicate request cannot initialize Pi before the first validation');
  release();
  assert.equal((await first).ok, false); assert.equal(f.openings.length, 0);
  const retried = await f.bridge.open({ ...options(f), resumePath: work.path, workConversationId: work.id,
    validateWorkConversation: async () => {} });
  assert.equal(retried.ok, true, retried.reason); assert.equal(retried.session.sessionId, work.id);
  assert.equal(f.openings.length, 1);
  assert.equal(segments.read(f.app, work.id), null, 'Pi first open must not create a substrate switch record');
});

test('Agent switch survives managed-storage rename errors and a failed save keeps the original conversation retryable', async t => {
  const f = fixture(t), opened = await f.bridge.open(options(f));
  assert.equal(opened.ok, true, opened.reason);
  const h = opened.session, id = h.sessionId;
  await send(h, 'Keep this existing conversation');
  const before = h.snapshot(), rename = fs.renameSync, copy = fs.copyFileSync;
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (source.includes('conversation-models')) throw Object.assign(Error('private profile EXDEV'), { code:'EXDEV' });
    return rename(source, target);
  });
  const copyFailure = t.mock.method(fs, 'copyFileSync', (source, target, flags) => {
    if (source.includes('conversation-models') && source.endsWith('.tmp')) {
      fs.writeFileSync(target, 'partial');
      throw Object.assign(Error('private profile EIO'), { code:'EIO' });
    }
    return copy(source, target, flags);
  });
  const rejected = await h.selectAgent('opencode');
  assert.equal(rejected.ok, false);
  assert.doesNotMatch(rejected.reason, /private profile|EXDEV|EIO|rename/);
  assert.equal(h.adapterId, 'pi');
  assert.equal(h.sessionId, id);
  assert.deepEqual(h.snapshot().messages, before.messages);
  assert.equal(h.snapshot().runtimeSwitching, false);
  assert.equal(segments.read(f.app, id), null);
  copyFailure.mock.restore();
  const accepted = await h.selectAgent('opencode');
  assert.equal(accepted.ok, true, accepted.reason);
  assert.equal(h.adapterId, 'opencode');
  assert.equal(h.sessionId, id);
  assert.deepEqual(h.snapshot().messages, before.messages);
  assert.equal(fs.readdirSync(path.join(f.root, 'conversation-models')).some(n => n.endsWith('.tmp')), false);
});

test('Pi -> OpenCode -> Qwen -> Pi keeps one public conversation and bounded context, then reopens', async t => {
  const f = fixture(t), opened = await f.bridge.open(options(f)); assert.equal(opened.ok, true, opened.reason);
  const h = opened.session, id = h.sessionId, ref = h.ref; let events = 0; h.on(() => events++);
  await send(h, 'Remember cobalt-42; edit existing files, do not send email');
  for (const agent of ['opencode', 'qwen', 'pi']) {
    const result = await h.selectAgent(agent); assert.equal(result.ok, true, result.reason);
    assert.equal(h.adapterId, agent); assert.equal(h.sessionId, id); assert.equal(h.ref, ref); assert.equal(h.cwd, f.root);
    await send(h, 'Continue ' + agent);
  }
  assert.equal(h.snapshot().messages.filter(m => m.role === 'user').length, 4);
  assert.deepEqual(h.snapshot().messages.filter(m => m.role === 'assistant').map(m => m.sourceAgent.agentId), ['pi', 'opencode', 'qwen', 'pi']);
  assert.ok(events > 4); assert.equal(f.bridge.list().length, 1);
  assert.ok(f.requests.filter(r => r.op === 'job.dispatch').every(r => r.input.task.note.includes('cobalt-42')));
  assert.ok(f.openings.at(-1).contextPrompts.some(p => p.includes('cobalt-42')));
  assert.deepEqual(h.snapshot().activePlugins, ['meeting']);
  await h.close(); const history = await f.bridge.history(f.app); assert.equal(history.chats.length, 1); assert.equal(history.chats[0].id, id);
  const archive = await f.bridge.archivedConversation(f.app, id);
  await f.restart();
  const resumed = await f.bridge.open({ ...options(f), ref: 'chat-reopen', runtimeConversationId: id, resumePath: archive.path });
  assert.equal(resumed.ok, true, resumed.reason); assert.equal(resumed.session.sessionId, id);
  assert.equal(resumed.session.snapshot().messages.filter(m => m.role === 'user').length, 4);
  assert.deepEqual(resumed.session.snapshot().messages.filter(m => m.role === 'assistant').map(m => m.sourceAgent.agentId), ['pi', 'opencode', 'qwen', 'pi']);
  const manifest = segments.read(f.app, id);
  assert.deepEqual(manifest.prefix.messages.filter(m => m.role === 'assistant').map(m => m.sourceAgent.agentId), ['pi', 'opencode', 'qwen']);
  assert.equal(manifest.active.adapterId, 'pi'); assert.equal(manifest.segments.length, 3);
  assert.equal(JSON.stringify(manifest).includes('fixture-secret'), false);
  await resumed.session.close(); await f.bridge.archiveHistory(f.app, id);
  assert.equal((await f.bridge.history(f.app)).chats.length, 0);
  assert.equal((await f.bridge.permanentlyDeleteHistory(f.app, id)).ok, true);
  assert.equal(segments.read(f.app, id), null);
});

test('busy/unavailable/unauthorized switches keep the original executor and selection intact', async t => {
  const f = fixture(t), h = (await f.bridge.open(options(f))).session;
  await send(h, 'Original'); const original = h.snapshot();
  f.busy = true; assert.equal((await h.selectAgent('qwen')).ok, false); f.busy = false;
  f.unavailable = 'opencode'; assert.equal((await h.selectAgent('opencode')).ok, false); f.unavailable = '';
  assert.equal((await h.selectAgent('qwen', { modelName: 'denied' })).ok, false);
  assert.equal(h.adapterId, 'pi'); assert.deepEqual(h.snapshot().messages, original.messages);
  assert.equal(segments.read(f.app, h.sessionId), null);
  await send(h, 'Still works');
});

test('switch transaction blocks sends/duplicate switches and rejects changed account before commit', async t => {
  const f = fixture(t), h = (await f.bridge.open(options(f))).session;
  let release; f.gate = new Promise(r => { release = r; }); let checks = 0;
  const pending = h.selectAgent('qwen', { validate: async () => { if (++checks > 1) throw Error('Account changed'); } });
  await new Promise(r => setImmediate(r));
  assert.equal(h.submit('must not run').accepted, false); assert.equal((await h.selectAgent('opencode')).ok, false);
  release(); assert.equal((await pending).ok, false); assert.equal(h.adapterId, 'pi');
  assert.equal(segments.read(f.app, h.sessionId), null);
});

test('restoring a switched conversation refuses another account', async t => {
  const f = fixture(t), h = (await f.bridge.open(options(f))).session;
  await send(h, 'Private context'); assert.equal((await h.selectAgent('qwen')).ok, true);
  const id = h.sessionId; await f.restart();
  const result = await f.bridge.open({ ...options(f), runtimeConversationId: id, identity: identity('bob') });
  assert.equal(result.ok, false); assert.match(result.reason, /另一个账号/);
});

test('closing while a switch is saving cancels the candidate without resurrecting the conversation', async t => {
  const f = fixture(t), h = (await f.bridge.open(options(f))).session, id = h.sessionId;
  const original = segments.save; let release, entered;
  const saved = new Promise(r => { entered = r; });
  const gate = new Promise(r => { release = r; });
  segments.save = async (...args) => { await original(...args); entered(); await gate; };
  t.after(() => { segments.save = original; });
  const changing = h.selectAgent('qwen'); await saved;
  const closing = h.close(); await new Promise(r => setImmediate(r));
  release(); assert.equal((await changing).ok, false); await closing;
  assert.equal(f.bridge.list().length, 0); assert.equal(segments.read(f.app, id), null);
});

test('deleting an open switched conversation closes all executors and cannot recreate its manifest', async t => {
  const f = fixture(t), h = (await f.bridge.open(options(f))).session, id = h.sessionId;
  await send(h, 'Keep history'); assert.equal((await h.selectAgent('qwen')).ok, true);
  await send(h, 'Qwen turn'); await f.bridge.archiveHistory(f.app, id);
  assert.equal((await f.bridge.permanentlyDeleteHistory(f.app, id)).ok, true);
  assert.equal(f.bridge.list().length, 0); assert.equal(segments.read(f.app, id), null);
  assert.equal((await f.bridge.history(f.app)).chats.length, 0);
  assert.equal(h.submit('Cannot resurrect').accepted, false);
});

test('requirements first linked by a middle Agent keep their original project and ownership after another switch', async t => {
  const context = require('../main/conversation/requirement-context');
  const f = fixture(t), h = (await f.bridge.open(options(f))).session, auth = identity('alice');
  assert.equal((await h.selectAgent('opencode')).ok, true);
  const task = { id: 'requirement-1', projectId: 'project-1', ownerClientId: auth.clientId };
  const request = async () => task, runtime = { app: f.app, handle: h, identity: auth, workRoot: f.root };
  await context.validate(runtime, task, {}, {}, request);
  assert.equal((await h.selectAgent('qwen')).ok, true);
  assert.equal(context.assertOwner(f.app, h, auth).projectId, 'project-1');
  await context.validate(runtime, task, {}, {}, request);
  await assert.rejects(context.validate(runtime, { ...task, projectId: 'other' }, {}, {}, request), /不属于同一项目/);
  assert.throws(() => context.assertOwner(f.app, h, identity('bob')), /另一个账号/);
});


test('large file receipts remain available by stable historical ID after Agent switch and reopen', async t => {
  const f = fixture(t), opened = await f.bridge.open(options(f));
  assert.equal(opened.ok, true, opened.reason);
  const h = opened.session, id = h.sessionId;
  await send(h, 'Create a file');
  const native = [...f.archives.values()][0].raw, before = native.snapshot;
  const content = 'original file body\n'.repeat(30000);
  const receipt = { id: 'write-1', name: 'write', args: { path: 'result.js', content }, result: 'saved', state: 'done', after: 1 };
  native.snapshot = () => ({ ...before(), tools: [receipt] });
  native.toolDetail = callId => callId === receipt.id ? receipt : null;
  assert.equal(h.uiSnapshot().tools[0].detailsDeferred, true);
  const result = await h.selectAgent('opencode'); assert.equal(result.ok, true, result.reason);
  await send(h, 'Continue');
  const tool = h.uiSnapshot().tools[0];
  assert.notEqual(tool.id, receipt.id); assert.equal(tool.detailsDeferred, true);
  assert.equal(h.toolDetail(tool.id).args.content, content);
  await f.restart();
  const restored = await f.bridge.open({ ...options(f), runtimeConversationId: id });
  assert.equal(restored.ok, true, restored.reason);
  assert.equal(restored.session.toolDetail(tool.id).args.content, content);
  assert.equal(restored.session.uiSnapshot().tools[0].detailsDeferred, true);
});

test('switching a process-backed Pi loads full tool receipts before disposing its source segment', async t => {
  const f = fixture(t), h = (await f.bridge.open(options(f))).session;
  await send(h, 'Create complete file');
  const native = [...f.archives.values()][0].raw, original = native.snapshot;
  const content = 'Unabridged file receipt.\n'.repeat(10000);
  const receipt = { id: 'remote-write', name: 'write', args: { path: 'result.js', content },
    result: 'saved', state: 'done', after: 1 };
  const summary = require('../main/pi-session/tool-detail').project(receipt);
  let snapshots = 0, closed = false;
  native.snapshot = () => ({ ...original(), tools: [summary] });
  native.snapshotAsync = async () => { snapshots++; assert.equal(closed, false); return { ...original(), tools: [receipt] }; };
  native.toolDetail = async id => id === receipt.id ? receipt : null;
  const close = native.close; native.close = () => { closed = true; return close(); };
  assert.equal((await h.toolDetail(receipt.id)).args.content, content);
  assert.equal(h.snapshot().tools[0].args.content, undefined);
  const switched = await h.selectAgent('qwen');
  assert.equal(switched.ok, true, switched.reason); assert.equal(snapshots, 1); assert.equal(closed, true);
  const historical = h.snapshot().tools[0];
  assert.equal((await h.toolDetail(historical.id)).args.content, content);
  const id = h.sessionId; await f.restart();
  const restored = await f.bridge.open({ ...options(f), runtimeConversationId: id });
  assert.equal(restored.ok, true, restored.reason);
  assert.equal((await restored.session.toolDetail(historical.id)).args.content, content);
});

test('delivery capture crosses the public facade and follows each newly selected native runtime', async t => {
  const f = fixture(t), h = (await f.bridge.open(options(f))).session;
  const capture = async () => ({ frozen: true }); h.captureDelivery = capture;
  assert.equal([...f.archives.values()][0].raw.captureDelivery, capture);
  const custom = () => ({ decorated: true }), initialModel = [...f.archives.values()][0].raw.selectModel;
  h.selectModel = custom;
  assert.equal([...f.archives.values()][0].raw.selectModel, initialModel, 'other service method decorators remain local');
  await send(h, 'Preserve delivery boundary');
  assert.equal((await h.selectAgent('qwen')).ok, true);
  const record = h[Symbol.for('soduwork.agent-runtime.record')];
  const runner = require('../main/agent-runtime/runner-adapter').getRunnerSessionDetails(record.session).handle;
  assert.equal(runner.captureDelivery, capture);
  assert.equal((await h.selectAgent('pi')).ok, true);
  assert.equal([...f.archives.values()].at(-1).raw.captureDelivery, capture);
});

test('failed full-snapshot reads retain the source runtime and cannot persist incomplete tool history', async t => {
  const f = fixture(t), h = (await f.bridge.open(options(f))).session;
  await send(h, 'Keep original context');
  const native = [...f.archives.values()][0].raw, before = h.snapshot();
  native.snapshotAsync = async () => { throw Error('完整执行回执暂时不可读'); };
  const rejected = await h.selectAgent('qwen');
  assert.equal(rejected.ok, false); assert.match(rejected.reason, /完整执行回执/);
  assert.equal(h.adapterId, 'pi'); assert.equal(h.snapshot().runtimeSwitching, false);
  assert.deepEqual(h.snapshot().messages, before.messages);
  assert.equal(segments.read(f.app, h.sessionId), null); assert.equal(f.requests.length, 0);
  native.snapshotAsync = async () => native.snapshot();
  assert.equal((await h.selectAgent('qwen')).ok, true);
});

test('ordinary connector resolver survives Pi -> OpenCode -> Qwen -> Pi without a business plugin', async t => {
  const f = fixture(t); let issued = 0, cleaned = 0;
  const resolveConnectors = async () => ({ guide: 'SWITCH-CONNECTOR-' + (++issued), servers: ['fixture'],
    cleanup() { cleaned++; } });
  const opened = await f.bridge.open({ ...options(f), activePluginIds: [], resolveConnectors });
  assert.equal(opened.ok, true);
  const h = opened.session;
  for (const agent of ['opencode', 'qwen']) {
    assert.equal((await h.selectAgent(agent)).ok, true);
    await send(h, 'Read without selecting a plugin ' + agent);
  }
  const notes = f.requests.filter(row => row.op === 'job.dispatch').map(row => row.input.task.note);
  assert.match(notes[0], /SWITCH-CONNECTOR-1/); assert.match(notes[1], /SWITCH-CONNECTOR-2/);
  assert.equal(cleaned, 2); assert.deepEqual(h.snapshot().activePlugins, []);
  assert.equal((await h.selectAgent('pi')).ok, true);
  assert.equal(f.openings.at(-1).resolveConnectors, resolveConnectors);
  assert.doesNotMatch(JSON.stringify(h.snapshot()), /SWITCH-CONNECTOR/);
});


test('长会话旧凭据过期后使用同账号新凭据切换并保留上下文', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t), initial = options(f);
  const opened = await f.bridge.open(initial);
  assert.equal(opened.ok, true, opened.reason);
  const h = opened.session, id = h.sessionId;
  await send(h, 'Keep the original conversation after login renewal');
  for (const agent of ['opencode', 'qwen', 'pi']) {
    now += 3601000;
    const renewed = identity('alice');
    assert.throws(() => segments.scope(initial.identity), /会话已失效/);
    const result = await h.selectAgent(agent, { identity: renewed });
    assert.equal(result.ok, true, result.reason);
    assert.equal(h.adapterId, agent);
    assert.equal(h.sessionId, id);
    assert.equal(segments.read(f.app, id).owner, segments.scope(renewed));
    assert.equal(h.snapshot().messages[0].text, 'Keep the original conversation after login renewal');
    await send(h, 'Continue with ' + agent);
  }
  assert.equal(h.snapshot().messages.filter(m => m.role === 'user').length, 4);
  await f.restart();
  const reopened = await f.bridge.open({ ...options(f), runtimeConversationId: id });
  assert.equal(reopened.ok, true, reopened.reason);
  assert.equal(reopened.session.snapshot().messages.filter(m => m.role === 'user').length, 4);
});

test('切换只接受原账号原环境的新有效凭据，拒绝失效或跨账号凭据', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t), initial = options(f), h = (await f.bridge.open(initial)).session;
  await send(h, 'Private original');
  now += 3601000;
  for (const auth of [initial.identity, identity('bob'), { ...identity('alice'), hub: 'https://another.invalid' }]) {
    const result = await h.selectAgent('opencode', { identity: auth });
    assert.equal(result.ok, false);
    assert.equal(h.adapterId, 'pi');
    assert.equal(segments.read(f.app, h.sessionId), null);
    assert.equal(h.snapshot().runtimeSwitching, false);
  }
  assert.equal(f.requests.length, 0, '身份不匹配时不探测或启动目标 Agent');
  const result = await h.selectAgent('qwen', { identity: identity('alice') });
  assert.equal(result.ok, true, result.reason);
  const wrongAccount = await h.selectAgent('opencode', { identity: identity('bob') });
  assert.equal(wrongAccount.ok, false);
  assert.equal(h.adapterId, 'qwen');
  await send(h, 'Still available');
});

test('打开时凭据已过期仍可查看原会话，但不能以未经验证的归属切换', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t), initial = options(f);
  now += 3601000;
  const opened = await f.bridge.open(initial);
  assert.equal(opened.ok, true, opened.reason);
  assert.equal(opened.session.adapterId, 'pi');
  assert.ok(Array.isArray(opened.session.snapshot().messages));
  const result = await opened.session.selectAgent('qwen', { identity: identity('alice') });
  assert.equal(result.ok, false);
  assert.equal(opened.session.adapterId, 'pi');
  assert.equal(segments.read(f.app, opened.session.sessionId), null);
  assert.equal(f.requests.length, 0);
});

test('Runner 旧会话凭证失效时在首个恢复探针同步暴露可恢复错误', async () => {
  const calls = [];
  const adapter = createRunnerRuntimeAdapter({
    runtimeSpec: catalog.runtime('opencode'),
    runnerRuntime: { async rpc(op) {
      calls.push(op);
      if (op === 'job.session') return { ok: false, error: 'Internal error: Unauthorized' };
      return { ok: true, data: { installed: true, state: 'ready' } };
    } },
    modelConfig: { fetchModel: async (_identity, name) => ({ ok: true,
      model: { id: name || 'fixture-model', name: name || 'fixture-model', key: 'fixture-key', baseUrl: 'http://fixture.invalid' } }) },
  });
  await assert.rejects(() => adapter.resumeSession({ consumer: 'chat', identity: identity('alice'),
    native: { runner: { openOptions: { resumePath: 'runner-session-1', modelName: 'fixture-model' } } } }), /Unauthorized/);
  assert.deepEqual(calls, ['job.session']);
});

test('Runner 历史会话的失效模型回退到当前默认并同步清理选择', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-runner-model-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const names = [];
  const runtime = { async rpc(op) {
    if (op === 'runtime.detect') return { ok: true, data: {
      installed: true, state: 'ready', accessControl: { schema: 'soduwork.access-policy/v1', supported: true,
        modes: ['standard', 'readonly', 'full'], canChangeDuringSession: true },
    } };
    if (op === 'job.session') return { ok: true, data: { ref: 'runner-stale', status: 'done', items: [] } };
    return { ok: true, data: { ok: true } };
  } };
  const adapter = createRunnerRuntimeAdapter({
    app: { getPath: () => root }, runtimeSpec: catalog.runtime('opencode'), runnerRuntime: runtime,
    modelConfig: { fetchModel: async (_identity, name) => {
      names.push(name);
      if (name === 'retired-model') return { ok: false, reason: 'model retired' };
      return { ok: true, model: { id: 'current-default', name: 'current-default', key: 'fixture-key', baseUrl: 'http://fixture.invalid' } };
    } },
  });
  const session = await adapter.createSession({ consumer: 'chat', identity: identity('alice'), native: {
    runner: { openOptions: { app: { getPath: () => root }, cwd: root, resumePath: 'runner-stale', modelName: 'retired-model' } },
  } });
  assert.deepEqual(names, ['retired-model', '']);
  assert.equal(session.snapshot().modelSelection.name, '');
  await session.dispose();
});

for (const mode of ['standard', 'readonly', 'full']) test('Pi -> Codex -> DSH -> Pi retains ' + mode + ' policy and one conversation', async t => {
  const f = fixture(t), accessPolicy = require('../main/access-control/policy').create(mode, f.root);
  const opened = await f.bridge.open({ ...options(f), accessPolicy });
  assert.equal(opened.ok, true, opened.reason);
  const h = opened.session, id = h.sessionId, originalPolicy = h.snapshot().accessPolicy;
  await send(h, 'Remember shared-switch-marker');
  for (const agent of ['codex', 'dsh', 'pi']) {
    const result = await h.selectAgent(agent);
    assert.equal(result.ok, true, result.reason);
    assert.equal(h.adapterId, agent);
    assert.equal(h.sessionId, id);
    assert.deepEqual(h.snapshot().accessPolicy, originalPolicy);
    await send(h, 'Continue with ' + agent);
  }
  assert.deepEqual(h.snapshot().messages.filter(m => m.role === 'assistant').map(m => m.sourceAgent.agentId), ['pi', 'codex', 'dsh', 'pi']);
  const dispatches = f.requests.filter(r => r.op === 'job.dispatch');
  assert.deepEqual(dispatches.map(r => r.input.cli), ['codex', 'dsh']);
  assert.ok(dispatches.every(r => r.input.task.note.includes('shared-switch-marker')));
  assert.deepEqual(h.snapshot().activePlugins, ['meeting']);
  await f.restart();
  const restored = await f.bridge.open({ ...options(f), ref: 'reopen-two-agents', runtimeConversationId: id });
  assert.equal(restored.ok, true, restored.reason);
  assert.deepEqual(restored.session.snapshot().messages.filter(m => m.role === 'assistant').map(m => m.sourceAgent.agentId), ['pi', 'codex', 'dsh', 'pi']);
});

async function settled(handle) {
  for (let attempt = 0; attempt < 200 && handle.snapshot().status !== 'idle'; attempt++)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(handle.snapshot().status, 'idle');
}

test('OpenCode title survives cold resume, Pi switch, follow-up and another cold reopen', async t => {
  const f = fixture(t), original = '写一篇关于雨的短文';
  const first = (await f.bridge.open({ ...options(f), adapterId: 'opencode' })).session;
  assert.equal(first.historyRow().title, '', 'an empty runtime cannot rename the composer');
  await send(first, original);
  const id = first.sessionId;
  await f.restart();
  const resumed = await f.bridge.open({ ...options(f), adapterId: 'opencode', resumePath: id });
  assert.equal(resumed.ok, true, resumed.reason);
  const h = resumed.session;
  await settled(h);
  assert.equal(h.historyRow().title, original, 'the first archived user message restores the title');
  assert.equal((await h.selectAgent('pi')).ok, true);
  assert.equal(h.sessionId, id);
  assert.equal(h.historyRow().title, original);
  assert.equal(f.openings.at(-1).sessionTitle, original);
  await send(h, '继续完善排版');
  assert.equal(h.historyRow().title, original);
  await f.restart();
  const restored = (await f.bridge.open({ ...options(f), runtimeConversationId: id })).session;
  assert.equal(restored.historyRow().title, original);
  assert.equal(require('../main/pi-session/open-reply').openReply(f.app, restored).title, original);
  assert.equal((await f.bridge.history(f.app)).chats.find(row => row.id === id).title, original);
});

test('legacy default runtime titles recover from the original prefix without overriding manual names', async t => {
  const f = fixture(t), h = (await f.bridge.open({ ...options(f), adapterId: 'opencode' })).session;
  const original = '输出一篇短文';
  await send(h, original);
  assert.equal((await h.selectAgent('pi')).ok, true);
  const id = h.sessionId, saved = segments.read(f.app, id);
  await segments.save(f.app, { ...saved, title: 'OpenCode 工作会话' });
  const prefixBefore = JSON.stringify(saved.prefix);
  await f.restart();
  assert.equal((await f.bridge.history(f.app)).chats.find(row => row.id === id).title, original);
  const restored = (await f.bridge.open({ ...options(f), runtimeConversationId: id })).session;
  const openReply = require('../main/pi-session/open-reply').openReply;
  assert.equal(openReply(f.app, restored).title, original);
  const custom = 'OpenCode 工作会话';
  require('../main/conversation/titles').save(f.app, id, custom);
  assert.equal(openReply(f.app, restored).title, custom, 'even a manually chosen default-like name is authoritative');
  assert.equal((await restored.selectAgent('qwen')).ok, true);
  assert.equal(openReply(f.app, restored).title, custom);
  assert.deepEqual(segments.read(f.app, id).prefix.messages.slice(0, saved.prefix.messages.length), saved.prefix.messages);
  assert.equal(JSON.stringify(saved.prefix), prefixBefore, 'repair never edits the archived transcript');
});

test('switching an empty runtime takes its first real title after sending and persists it', async t => {
  const f = fixture(t), h = (await f.bridge.open({ ...options(f), adapterId: 'opencode' })).session;
  assert.equal((await h.selectAgent('qwen')).ok, true);
  const id = h.sessionId;
  await send(h, '第一条真实请求');
  await segments.flush(f.app, id);
  assert.equal(h.historyRow().title, '第一条真实请求');
  assert.equal(segments.read(f.app, id).title, '第一条真实请求');
  assert.equal((await h.selectAgent('pi')).ok, true);
  await send(h, '第二条请求');
  assert.equal(h.historyRow().title, '第一条真实请求');
});


test('cold Runner open carries the saved title before history polling finishes', async t => {
  const f = fixture(t), first = (await f.bridge.open({ ...options(f), adapterId:'opencode' })).session;
  await send(first, 'Original saved request');
  const id = first.sessionId;
  await f.restart();
  const resumed = await f.bridge.open({ ...options(f), adapterId:'opencode', resumePath:id,
    sessionTitle:'Original saved request' });
  assert.equal(resumed.ok, true, resumed.reason);
  const h = resumed.session;
  assert.equal(require('../main/pi-session/open-reply').openReply(f.app, h).title, 'Original saved request');
  await settled(h);
  await send(h, 'Follow-up cannot rename history');
  assert.equal(h.historyRow().title, 'Original saved request');
});
