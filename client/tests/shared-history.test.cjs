'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { create: createStore } = require('../main/conversation/replica-store.cjs');
const { create } = require('../main/conversation/shared-history.cjs');
const { identity } = require('./helpers/platform-session-fixture.cjs');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-shared-'));
  const app = { getPath: () => root }, file = path.join(root, 'pi-agent', 'sessions', 'one.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    { type: 'session', id: 'one' },
    { type: 'message', id: 'msg-1', message: { role: 'user', content: 'saved by Alice' } },
    { type: 'message', id: 'msg-2', message: { role: 'assistant', content: [{ type: 'text', text: 'local answer' }] } },
  ].map(row => JSON.stringify(row)).join('\n'));
  const row = { id: 'one', title: 'History', path: file, adapterId: 'pi', count: 2, at: 1 };
  const store = createStore(path.join(root, 'replicas.sqlite'));
  const flags = new Map();
  let live = null;
  const session = { archivedConversation: async idApp => row,
    historyEntry: async () => fs.existsSync(file) ? { ok: true, entry: row } : { ok: false, notFound: true },
    findBySessionId: () => live, setArchived: (_app, id, value) => flags.set(id, value),
    forgetRunner: async () => ({ ok: false, notFound: true }) };
  const history = create({ app, session, store });
  t.after(async () => { await history.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, file, app, row, session, store, history, flags, set live(value) { live = value; } };
}
test('shared local reader opens native text without starting any account runtime', async t => {
  const f = setup(t);
  const rows = await f.history.projectRows([{ ...f.row, workOwner: 'another-account' }]);
  assert.equal(rows.length, 1);
  const view = await f.history.open('one');
  assert.equal(view.localReplica, true);
  assert.deepEqual(view.snapshot().messages.map(row => row.text), ['saved by Alice', 'local answer']);
  assert.equal(view.snapshot().messages[1].blocks[0].text, 'local answer');
  assert.equal((await view.send('should not execute')).accepted, false);
});
test('legacy outbox recovery preserves sparse positions with bounded batches before metadata-only sync', async t => {
  const f = setup(t), original = f.store.cache.bind(f.store); let writes = 0;
  f.store.cache = (...args) => { writes++; return original(...args); };
  const messages = Array.from({ length: 250 }, (_, i) => ({ position: i < 150 ? i : i + 10,
    role: 'user', text: 'retained-' + i }));
  const job = { hub: 'https://isolated.invalid', ownerKey: 'original', body: {
    sourceSessionId: 'orphan', sourceEpoch: 'first', title: 'Recovered', messages } };
  await f.history.preserveLegacyOutbox(job, identity());
  const recovered = (await f.history.list({ archived: true })).items[0];
  assert.equal(writes, 3);
  const first = await f.store.messages(recovered.id, { limit: 200 });
  const last = await f.store.messages(recovered.id, { after: first.next, limit: 200 });
  assert.deepEqual([...first.items, ...last.items].map(row => [row.position, row.text]), messages.map(row => [row.position, row.text]));
  await f.history.preserveLegacyOutbox(job, identity());
  assert.equal((await f.history.list({ archived: true })).items.length, 1);
});
test('local lifecycle never calls cloud or account mutation endpoints', async t => {
  const f = setup(t), events = [];
  const action = require('../main/pi-session/local-history-actions.cjs').create({ ...f,
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (_event, data) => events.push(data) } }] },
    trash: async (_shell, file) => fs.renameSync(file, path.join(f.root, 'recycled.jsonl')) });
  assert.equal((await action('delete', 'one')).needsConfirm, true);
  assert.equal((await action('delete', 'one', null)).needsConfirm, true);
  assert.equal(fs.existsSync(f.file), true);
  assert.equal((await action('archive', 'one')).archived, true);
  assert.equal((await f.history.projectRows([f.row])).length, 0);
  assert.equal((await action('restore', 'one')).archived, false);
  assert.equal((await action('delete', 'one', { confirmed: true })).deleted, true);
  assert.equal(fs.existsSync(f.file), false);
  assert.equal((await f.history.projectRows([f.row])).length, 0);
  assert.equal(events.at(-1).presence.deleted, true);
  assert.equal((await action('delete', 'one', { confirmed: true })).alreadyDeleted, true);
});
test('failed recycle preserves archived retry entry and original bytes', async t => {
  const f = setup(t);
  const action = require('../main/pi-session/local-history-actions.cjs').create({ ...f,
    trash: async () => { throw Error('recycle failed'); } });
  await assert.rejects(action('delete', 'one', { confirmed: true }), /recycle failed/);
  assert.equal(fs.existsSync(f.file), true);
  assert.equal((await f.history.resolve('one')).archived, true);
  assert.equal((await f.history.resolve('one')).deleted, false);
});
test('active local execution remains protected from archive or delete', async t => {
  const f = setup(t);
  f.live = { inFlight: () => true };
  const action = require('../main/pi-session/local-history-actions.cjs').create({ ...f, trash: async () => assert.fail('must not recycle') });
  await assert.rejects(action('archive', 'one'), /还在执行/);
  await assert.rejects(action('delete', 'one', { confirmed: true }), /还在执行/);
  assert.equal((await f.history.resolve('one')).deleted, false);
});
test('downloaded cloud copy remains local across accounts and late refresh cannot revive it', async t => {
  const f = setup(t);
  const handle = { snapshot: () => ({ messages: [{ role: 'assistant', text: 'saved cloud answer' }] }),
    historyRow: () => ({ id: 'remote-one', cloud: true, remoteProjection: true, adapterId: 'codex-harness', title: 'Cloud result' }) };
  await f.history.capture(handle, identity());
  const copy = (await f.history.list()).items[0];
  assert.ok(copy.id.startsWith('copy-'));
  assert.equal(copy.cloud, false);
  assert.equal((await f.history.read(copy.id)).items[0].text, 'saved cloud answer');
  await f.history.lifecycle(copy.id, 'delete', identity('two'));
  await f.history.capture(handle, identity());
  assert.equal((await f.history.list()).items.length, 0);
  assert.equal((await f.history.resolve(copy.id)).deleted, true);
  assert.equal((await f.history.resolve(copy.id)).source.id, 'remote-one');
});

test('archived task copies keep executable origins out of cold recent history until explicit restore', async t => {
  const f = setup(t), who = identity();
  const origin = { id: 'remote-one', taskId: 'task-one', cloud: true, remoteProjection: true,
    title: 'Same title', at: 20 };
  const alias = { ...origin, id: 'remote-alias', historyAliasIds: [origin.id] };
  const namesake = { ...origin, id: 'other', taskId: 'other-task' };
  await f.history.capture({ snapshot: () => ({ messages: [{ role: 'assistant', text: 'retained' }] }),
    historyRow: () => origin }, who);
  const copy = (await f.history.list()).items[0];
  await f.history.lifecycle(copy.id, 'archive', who);
  const projections = [origin, alias, namesake];
  assert.equal((await f.history.remoteLifecycle(projections, who)).length, 2);
  assert.deepEqual(await f.history.remoteLifecycle(projections, identity('two')), []);
  assert.deepEqual(await f.history.remoteLifecycle(projections, { ...who, hub: 'https://other.invalid' }), []);
  const makeBridge = () => {
    const bridge = require('../main/agent-runtime/pi-session-bridge').createPiSessionBridge({ app: f.app,
      sessionModule: { open: async () => ({}), probe: async () => ({ ok: true }),
        history: async () => ({ ok: true, chats: [] }) }, runnerAdapters: [] });
    bridge.setExternalHistory({ history: async options => ({ ok: true, chats: options?.archived ? [] : projections }) });
    bridge.setReplicaHistory({ ...f.history, remoteLifecycle: rows => f.history.remoteLifecycle(rows, who) });
    return bridge;
  };
  let bridge = makeBridge();
  assert.deepEqual((await bridge.history()).chats.map(row => row.id), ['other']);
  await bridge.dispose();
  bridge = makeBridge();
  assert.deepEqual((await bridge.history()).chats.map(row => row.id), ['other']);
  assert.ok((await bridge.archivedHistory()).chats.some(row => row.id === copy.id));
  await f.history.lifecycle(copy.id, 'restore', who);
  const restored = await bridge.history();
  assert.equal(restored.chats.filter(row => row.taskId === 'task-one').length, 1);
  assert.ok(restored.lifecycle.some(row => row.id === origin.id && !row.archived && row.lifecycleRevision > 0));
  assert.equal((await f.history.read(copy.id)).items[0].text, 'retained');
  await f.history.lifecycle(copy.id, 'delete', who);
  assert.deepEqual(await f.history.remoteLifecycle(projections, who), []);
  assert.equal((await bridge.history()).chats.filter(row => row.taskId === 'task-one').length, 1);
  await bridge.dispose();
});

test('remote lifecycle skips unrelated inventory and resolves all alias batches with the newest explicit intent', async t => {
  const f = setup(t), who = identity();
  f.store.list = () => assert.fail('Lifecycle overlays must not scan the local inventory');
  let queries = 0;
  const lookup = f.store.remoteLifecycleRows.bind(f.store);
  f.store.remoteLifecycleRows = options => { queries++; return lookup(options); };
  assert.deepEqual(await f.history.remoteLifecycle([], who), []);
  assert.deepEqual(await f.history.remoteLifecycle([{ id: 'native' }], who), []);
  assert.equal(queries, 0);
  const origin = { id: 'last-alias', taskId: 'shared-task', cloud: true };
  await f.history.capture({ snapshot: () => ({ messages: [{ role: 'assistant', text: 'retained' }] }),
    historyRow: () => origin }, who);
  const original = f.store.get('last-alias');
  await f.history.lifecycle(original.id, 'archive', who);
  f.store.register([{ id: 'second-copy', cached: true, taskId: origin.taskId,
    source: { id: 'another-origin', account: 'one', hub: who.hub } }]);
  await f.history.lifecycle('second-copy', 'archive', who);
  await f.history.lifecycle('second-copy', 'restore', who);
  f.store.register([{ id: 'foreign-copy', cached: true, taskId: origin.taskId,
    source: { id: 'foreign-origin', account: 'one', hub: 'https://foreign.test' } }]);
  await f.history.lifecycle('foreign-copy', 'archive', who);
  const rows = Array.from({ length: 205 }, (_, index) => ({ id: 'view-' + index, cloud: true,
    historyAliasIds: [index === 204 ? 'last-alias' : 'missing-' + index] }));
  rows.push({ id: 'task-view', taskId: origin.taskId, remoteProjection: true });
  const states = await f.history.remoteLifecycle(rows, who);
  assert.deepEqual(states.map(row => [row.id, row.archived]).sort(), [['task-view', false], ['view-204', true]]);
  assert.equal(queries, 3, 'Every source identity batch is queried, including the last alias');
  assert.deepEqual(await f.history.remoteLifecycle(rows, { ...who, hub: 'malformed' }), []);
  assert.equal(queries, 3);
});

test('large cloud snapshots are cached in bounded batches without losing their tail', async t => {
  const f = setup(t), original = f.store.cache.bind(f.store), writes = [];
  f.store.cache = (id, messages, options) => {
    writes.push({ bytes: Buffer.byteLength(JSON.stringify(messages)), ...options });
    return original(id, messages, options);
  };
  const messages = Array.from({ length: 40 }, (_, i) => ({ role: 'assistant', text: String(i) + 'x'.repeat(600000) }));
  const handle = { snapshot: () => ({ messages }), historyRow: () => ({ id: 'large-remote', cloud: true }) };
  await f.history.capture(handle, identity());
  assert.ok(writes.length > 1);
  assert.ok(writes.every(row => row.bytes < 16 * 1024 * 1024));
  assert.equal(writes.at(-1).complete, true);
  const copy = (await f.history.list()).items[0];
  const stored = []; let after = 0;
  do {
    const page = await f.history.read(copy.id, { after });
    stored.push(...page.items); after = page.nextCursor;
  } while (after !== null);
  assert.deepEqual(stored.map(row => row.text), messages.map(row => row.text));
  messages.splice(2);
  await f.history.capture(handle, identity());
  assert.equal((await f.history.read(copy.id)).items.length, 2);
});
