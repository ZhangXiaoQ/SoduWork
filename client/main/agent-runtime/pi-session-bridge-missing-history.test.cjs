'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { createPiSessionBridge } = require('./pi-session-bridge');
const { createRunnerRuntimeAdapter } = require('./runner-adapter');
const segments = require('../conversation/runtime-segments');
const archiveState = require('../pi-session/archive-state');
const context = require('../conversation/requirement-context');
const { identity, sessions } = require('../../tests/helpers/platform-session-fixture.cjs');

function runner(id, lookup) {
  return { id, displayName: id, capabilities: [], detect: async () => ({ ok: true }),
    createSession: async () => { throw Error('Must not execute a conversation'); }, historyEntry: lookup };
}
function fixture(t, adapters = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-missing-history-'));
  const app = { getPath: () => root }, rows = new Map(), live = new Map(), lookups = [];
  let piFailure, currentIdentity = identity();
  t.mock.method(context, 'cachedIdentity', () => currentIdentity);
  const raw = { open: async () => { throw Error('Must not open a conversation'); }, probe: async () => ({ ok: true }),
    async historyEntry(_app, id, options) {
      lookups.push({ id, options });
      if (piFailure) throw piFailure;
      return rows.has(id) ? { ok: true, entry: rows.get(id) } : { ok: false, notFound: true };
    },
    archiveRoot: () => path.join(root, 'pi-agent'), archiveState,
    findBySessionId: id => live.get(id),
  };
  const bridge = createPiSessionBridge({ app, sessionModule: raw, runnerAdapters: adapters });
  t.after(async () => {
    await bridge.dispose();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { app, root, raw, bridge, rows, live, lookups,
    failPi: error => { piFailure = error; },
    changeIdentity: value => { currentIdentity = value; },
    manifestFile: id => path.join(root, 'conversation-runtime-segments', crypto.createHash('sha256').update(id).digest('hex') + '.json'),
    flags: () => archiveState.read(raw.archiveRoot()).conversations,
    flag: id => archiveState.setArchived(raw.archiveRoot(), id, true),
    async manifest(extra = {}) {
      const record = { version: 1, id: 'public', owner: segments.scope(identity()), prefix: [],
        segments: [{ sessionId: 'old-pi', adapterId: 'pi' }],
        active: { sessionId: 'new-runner', adapterId: 'qwen' }, ...extra };
      await segments.save(app, record); return record;
    },
  };
}

test('strict Runner lookup rejects mixed empty success and offline failure, but a real match wins', async t => {
  let present = false;
  const seen = [];
  const adapters = [runner('empty', async (_id, options) => { seen.push(options); return { ok: true, chats: present ? [{ id: 'wanted' }] : [] }; }),
    runner('offline', async () => { throw Error('Runner offline'); })];
  const f = fixture(t, adapters);
  assert.equal(await f.bridge.findRunnerRow('wanted', { nativeOnly: true }), null);
  await assert.rejects(f.bridge.findRunnerRow('wanted', { nativeOnly: true, strict: true }), /Runner offline/);
  assert.equal(seen.at(-1).strict, true);
  present = true;
  assert.equal((await f.bridge.findRunnerRow('wanted', { nativeOnly: true, strict: true })).id, 'wanted');
});

test('existing Pi or Runner content prevents missing cleanup even if the other source is unreadable', async t => {
  let online = true;
  const f = fixture(t, [runner('runner', async () => {
    if (!online) throw Error('Runner offline');
    return { ok: true, chats: [{ id: 'existing' }] };
  })]);
  f.failPi(Error('Pi permission denied'));
  assert.deepEqual(await f.bridge.probeMissingHistory(f.app, 'existing'), { ok: true, missing: false, aliasIds: ['existing'] });
  f.failPi(null); online = false; f.rows.set('existing', { id: 'existing' });
  assert.equal((await f.bridge.probeMissingHistory(f.app, 'existing')).missing, false);
  assert.ok(f.lookups.every(row => row.options.strict === true));
});

test('an orphan manifest checks all native aliases and removes only its metadata and archive flags', async t => {
  const runnerLookups = [];
  const f = fixture(t, [runner('runner', async (id, options) => { runnerLookups.push({ id, options }); return { ok: true, chats: [] }; })]);
  await f.manifest();
  for (const id of ['public', 'old-pi', 'new-runner', 'untouched']) f.flag(id);
  const output = path.join(f.root, 'output.txt'); fs.writeFileSync(output, 'Keep this generated file');
  const result = await f.bridge.probeMissingHistory(f.app, 'public');
  assert.deepEqual(result, { ok: true, missing: true, aliasIds: ['public', 'old-pi', 'new-runner'] });
  assert.deepEqual(f.lookups.map(row => row.id), result.aliasIds);
  assert.deepEqual(runnerLookups.map(row => row.id), result.aliasIds);
  assert.ok(runnerLookups.every(row => row.options.strict === true));
  const removed = await f.bridge.removeMissingHistory(f.app, 'public');
  assert.equal(removed.ok, true); assert.equal(removed.alreadyDeleted, true);
  assert.deepEqual(Object.keys(f.flags()), ['untouched']);
  assert.equal(fs.existsSync(f.manifestFile('public')), false);
  assert.equal(segments.read(f.app, 'public'), null);
  assert.equal(fs.readFileSync(output, 'utf8'), 'Keep this generated file');
});

test('any surviving switched segment prevents deleting the manifest or flags', async t => {
  const f = fixture(t);
  await f.manifest(); f.flag('public');
  f.rows.set('new-runner', { id: 'new-runner' });
  assert.equal((await f.bridge.probeMissingHistory(f.app, 'public')).missing, false);
  const removed = await f.bridge.removeMissingHistory(f.app, 'public');
  assert.equal(removed.ok, false);
  assert.equal(fs.existsSync(f.manifestFile('public')), true); assert.ok(f.flags().public);
});

test('unreadable Pi or partially offline Runner is not proof of missing content', async t => {
  const f = fixture(t, [runner('empty', async () => ({ ok: true, chats: [] })),
    runner('offline', async () => ({ ok: false, reason: 'Offline', chats: [] }))]);
  f.flag('missing');
  assert.equal((await f.bridge.probeMissingHistory(f.app, 'missing')).ok, false);
  f.failPi(Object.assign(Error('Unreadable archive'), { code: 'EACCES' }));
  assert.equal((await f.bridge.removeMissingHistory(f.app, 'missing')).ok, false);
  assert.ok(f.flags().missing);
});

test('cached manifest cannot hide corruption or another account owner during cleanup', async t => {
  const f = fixture(t);
  const record = await f.manifest(); f.flag('public');
  assert.equal(segments.read(f.app, 'public').id, 'public');
  fs.writeFileSync(f.manifestFile('public'), '{broken');
  assert.equal((await f.bridge.probeMissingHistory(f.app, 'public')).ok, false);
  fs.writeFileSync(f.manifestFile('public'), JSON.stringify({ ...record, owner: segments.scope(identity('two')) }));
  const refused = await f.bridge.removeMissingHistory(f.app, 'public');
  assert.equal(refused.ok, false); assert.match(refused.reason, /另一个账号/);
  assert.ok(f.flags().public); assert.equal(fs.existsSync(f.manifestFile('public')), true);
});

test('a linked segment owned by another account prevents orphan cleanup', async t => {
  const f = fixture(t);
  await f.manifest(); f.flag('public');
  await f.manifest({ id: 'old-pi', owner: segments.scope(identity('two')), segments: [], active: { sessionId: 'old-pi', adapterId: 'pi' } });
  const result = await f.bridge.removeMissingHistory(f.app, 'public');
  assert.equal(result.ok, false); assert.match(result.reason, /另一个账号/);
  assert.ok(f.flags().public); assert.equal(fs.existsSync(f.manifestFile('public')), true);
});

test('a trusted manifest cannot clear a linked segment with foreign or corrupt ownership sidecars', async t => {
  const f = fixture(t); await f.manifest(); f.flag('public'); f.flag('old-pi');
  const sidecar = path.join(f.root, 'session-memory-bindings', crypto.createHash('sha256').update('old-pi').digest('hex') + '.json');
  fs.mkdirSync(path.dirname(sidecar));
  fs.writeFileSync(sidecar, JSON.stringify({ owner: segments.scope(identity('two')) }));
  const foreign = await f.bridge.removeMissingHistory(f.app, 'public');
  assert.equal(foreign.ok, false); assert.equal(foreign.reason, '无法确认这条会话属于当前账号，请切回原账号');
  assert.ok(f.flags().public); assert.ok(f.flags()['old-pi']);
  fs.writeFileSync(sidecar, '{broken');
  assert.equal((await f.bridge.removeMissingHistory(f.app, 'public')).ok, false);
  assert.equal(fs.existsSync(f.manifestFile('public')), true); assert.ok(f.flags()['old-pi']);
});

for (const change of ['account', 'hub', 'device']) test('identity guard blocks ' + change + ' changes during missing history lookup', async t => {
  const f = fixture(t); f.flag('missing');
  f.raw.historyEntry = async () => {
    f.changeIdentity(change === 'account' ? identity('two') : change === 'hub'
      ? { ...identity(), hub: 'https://changed.invalid' }
      : { ...identity(), clientId: 'device-two', session: sessions().otherDevice });
    return { ok: false, notFound: true };
  };
  const result = await f.bridge.removeMissingHistory(f.app, 'missing');
  assert.equal(result.ok, false); assert.match(result.reason, /已切换/); assert.ok(f.flags().missing);
});

test('an idle empty view does not prove disk content exists, but memory messages and queued work are protected', async t => {
  const f = fixture(t); f.flag('empty-view');
  f.live.set('empty-view', { inFlight: () => false, snapshot: () => ({ status: 'idle', messages: [], tools: [] }) });
  assert.equal((await f.bridge.probeMissingHistory(f.app, 'empty-view')).missing, true);
  assert.equal((await f.bridge.removeMissingHistory(f.app, 'empty-view')).ok, true);
  assert.equal(f.flags()['empty-view'], undefined);
  for (const snapshot of [
    { status: 'idle', messages: [{ role: 'user', text: 'Only copy in memory' }] },
    { status: 'idle', messages: [], tools: [{ id: 'unsaved-tool' }] },
    { status: 'idle', messages: [], tools: [], execution: { queue: [{ id: 'paused-turn' }] } },
  ]) {
    f.flag('memory-only');
    f.live.set('memory-only', { inFlight: () => false, snapshot: () => snapshot });
    assert.equal((await f.bridge.probeMissingHistory(f.app, 'memory-only')).missing, false);
    assert.equal((await f.bridge.removeMissingHistory(f.app, 'memory-only')).ok, false);
    assert.ok(f.flags()['memory-only']);
  }
});

test('remove rechecks after confirmation and refuses newly available or busy content', async t => {
  const f = fixture(t); f.flag('missing');
  assert.equal((await f.bridge.probeMissingHistory(f.app, 'missing')).missing, true);
  f.rows.set('missing', { id: 'missing' });
  assert.equal((await f.bridge.removeMissingHistory(f.app, 'missing')).ok, false);
  f.rows.clear(); f.live.set('missing', { inFlight: () => true });
  assert.equal((await f.bridge.removeMissingHistory(f.app, 'missing')).ok, false);
  assert.ok(f.flags().missing);
});

test('already absent archive root remains absent after metadata cleanup', async t => {
  const f = fixture(t); await f.manifest();
  assert.equal(fs.existsSync(f.raw.archiveRoot()), false);
  const result = await f.bridge.removeMissingHistory(f.app, 'public');
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(f.raw.archiveRoot()), false, 'Do not recreate a deleted archive directory');
  assert.equal(fs.existsSync(f.manifestFile('public')), false);
  assert.equal((await f.bridge.removeMissingHistory(f.app, 'missing')).ok, true);
});

test('an archive-state write failure preserves the orphan manifest for retry', async t => {
  const f = fixture(t); await f.manifest(); f.flag('public');
  t.mock.method(archiveState, 'write', () => { throw Object.assign(Error('Archive state denied'), { code: 'EACCES' }); });
  const result = await f.bridge.removeMissingHistory(f.app, 'public');
  assert.equal(result.ok, false); assert.match(result.reason, /Archive state denied/);
  assert.equal(fs.existsSync(f.manifestFile('public')), true); assert.ok(f.flags().public);
});

test('invalid IDs and changed manifest identities cannot be used as cleanup targets', async t => {
  const f = fixture(t), record = await f.manifest(); f.flag('public');
  for (const id of ['', ' public ', null, 'bad\0id'])
    assert.equal((await f.bridge.removeMissingHistory(f.app, id)).ok, false);
  fs.writeFileSync(f.manifestFile('public'), JSON.stringify({ ...record, id: 'someone-else' }));
  assert.equal((await f.bridge.removeMissingHistory(f.app, 'public')).ok, false);
  assert.ok(f.flags().public);
});

test('archivedConversation forwards strict Pi lookup and rejects uncertain Runner absence', async t => {
  const f = fixture(t, [runner('empty', async () => ({ ok: true, chats: [] })), runner('offline', async () => ({ ok: false, reason: 'Offline' }))]);
  await assert.rejects(f.bridge.archivedConversation(f.app, 'missing', { nativeOnly: true, strict: true }), /Offline/);
  assert.equal(f.lookups[0].options.strict, true);
});

test('strict Runner history bypasses cached empty inventory, discovers new content, and surfaces offline errors', async t => {
  const f = fixture(t);
  let runs = [], calls = 0, offline = false;
  const runtime = { async rpc(method) {
    assert.equal(method, 'runtime.sessions'); calls++;
    if (offline) throw Error('Fresh inventory unavailable');
    return { ok: true, data: { runs } };
  } };
  const adapter = createRunnerRuntimeAdapter({ app: f.app, runnerRuntime: runtime,
    runtimeSpec: require('./runtime-catalog').runtime('qwen') });
  assert.deepEqual((await adapter.historyEntry('created')).chats, []); assert.equal(calls, 1);
  runs = [{ ref: 'created', cli: 'qwen', taskId: 'chat-created', state: 'done' }];
  assert.deepEqual((await adapter.historyEntry('created')).chats, []); assert.equal(calls, 1);
  assert.equal((await adapter.historyEntry('created', { strict: true })).chats[0].id, 'created'); assert.equal(calls, 2);
  offline = true;
  assert.equal((await adapter.historyEntry('missing', { strict: true })).ok, false); assert.equal(calls, 3);
  assert.equal((await adapter.history(50, { strict: true })).ok, false); assert.equal(calls, 4);
});

test('a malformed Runner inventory is unavailable, never successful empty history', async t => {
  const f = fixture(t);
  const adapter = createRunnerRuntimeAdapter({ app: f.app,
    runnerRuntime: { rpc: async () => ({ ok: true, data: {} }) },
    runtimeSpec: require('./runtime-catalog').runtime('qwen') });
  const result = await adapter.historyEntry('missing', { strict: true });
  assert.equal(result.ok, false); assert.match(result.reason, /响应无效/);
});
