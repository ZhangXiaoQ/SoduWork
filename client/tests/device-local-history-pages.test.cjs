'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createWorker } = require('../main/conversation/replica-store.cjs');
const { create } = require('../main/conversation/shared-history.cjs');
const { createPiSessionBridge } = require('../main/agent-runtime/pi-session-bridge');

async function fixture(t, count = 123) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-local-pages-'));
  const app = { getPath: () => root };
  const counters = { native: 0, external: 0 };
  let account = 'a';
  let discover = async () => ({ ok: true, chats: [] }), discoverArchived = discover;
  const bridge = createPiSessionBridge({ app, runnerAdapters: [], sessionModule: {
    open: async () => assert.fail('Listing local history cannot start a runtime'),
    probe: async () => ({ ok: true }),
    history: async (...args) => { counters.native++; return discover(...args); },
    archivedHistory: (...args) => discoverArchived(...args),
  } });
  bridge.setExternalHistory({ history: async () => {
    counters.external++;
    return { ok: true, chats: Array.from({ length: 160 }, (_, i) => ({ id: 'remote-' + account + '-' + i,
      title: 'Account-only metadata', accountProjection: true, at: 100000 + i })) };
  } });
  const file = path.join(root, 'history.sqlite');
  let store = createWorker(file), shared = create({ app, session: bridge, store });
  bridge.setReplicaHistory(shared);
  for (let start = 0; start < count; start += 200) await shared.register(Array.from({ length: Math.min(200, count - start) }, (_, i) => ({
    id: 'local-' + String(start + i).padStart(5, '0'), historyAliasIds: ['native-' + (start + i)],
    adapterId: 'pi', title: 'Stored local conversation ' + (start + i), at: Math.floor((start + i) / 3), count: 2,
  })));
  t.after(async () => { await shared.close(); await bridge.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { app, bridge, counters, get store() { return store; },
    capture: (handle, identity) => shared.capture(handle, identity),
    read: options => bridge.history(app, { source: 'local', ...options }),
    discover(active, archived = async () => ({ ok: true, chats: [] })) { discover = active; discoverArchived = archived; },
    switch(value) { account = value; },
    async restart() {
      await shared.close();
      store = createWorker(file); shared = create({ app, session: bridge, store }); bridge.setReplicaHistory(shared);
    } };
}

test('local metadata pages remain exhaustive across A to B to A and cold store reopen', async t => {
  const f = await fixture(t);
  let workspace;
  for (const account of ['a', 'b', 'a']) {
    f.switch(account);
    const rows = []; let after, catalog;
    do {
      const reply = await f.read({ limit: 17, after, catalogRevision: catalog?.revision });
      assert.equal(reply.ok, true);
      assert.ok(reply.chats.length <= 17);
      if (!after) { catalog = reply.localCatalog; assert.equal(catalog.items.length, 123); }
      else assert.equal(Object.hasOwn(reply.localCatalog, 'items'), false);
      workspace ||= reply.localCatalog.workspace;
      assert.equal(reply.localCatalog.workspace, workspace);
      rows.push(...reply.chats); after = reply.next;
    } while (after);
    assert.equal(rows.length, 123);
    assert.equal(new Set(rows.map(row => row.id)).size, 123);
    assert.ok(rows.every(row => row.localReplica === true && row.id.startsWith('local-')));
    assert.ok(catalog.items.every(row => !Object.hasOwn(row, 'title') && !Object.hasOwn(row, 'creator')));
    await f.restart();
  }
  assert.deepEqual(f.counters, { native: 0, external: 0 }, 'cached local pages cannot wait for auth, Hub or runtime discovery');
});

test('native refresh discovers more than fifty real Pi archives and retains the cached page on inventory failure', async t => {
  const f = await fixture(t, 0);
  const sessions = require('../main/pi-session/session');
  const archiveState = require('../main/pi-session/archive-state');
  const folder = path.join(f.app.getPath('userData'), 'pi-agent', 'sessions', 'fixture');
  fs.mkdirSync(folder, { recursive: true });
  for (let i = 0; i < 83; i++) fs.writeFileSync(path.join(folder, 'saved-' + i + '.jsonl'), [
    { type: 'session', id: 'saved-' + i, cwd: folder, timestamp: new Date(10000 + i).toISOString() },
    { type: 'message', message: { role: 'user', content: 'Synthetic native question ' + i, timestamp: 10000 + i } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  archiveState.setArchived(path.join(f.app.getPath('userData'), 'pi-agent'), 'saved-1', true);
  const segments = require('../main/conversation/runtime-segments');
  const owner = require('./helpers/platform-session-fixture.cjs').identity();
  await segments.save(f.app, { version: 1, id: 'saved-0', owner: segments.scope(owner), title: 'Canonical original title',
    cwd: folder, at: 10000, prefix: { messages: [], tools: [] },
    active: { sessionId: 'runner-canonical', adapterId: 'harness2', path: 'runner-canonical' },
    segments: [{ sessionId: 'saved-0', adapterId: 'pi', path: path.join(folder, 'saved-0.jsonl') }] });
  f.discover(sessions.history, sessions.archivedHistory);
  const refreshed = await f.read({ refresh: true, limit: 50 });
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.refreshError, undefined);
  assert.equal(refreshed.localCatalog.items.length, 83);
  assert.equal(refreshed.localCatalog.items.find(row => row.id === 'saved-1').archived, true);
  assert.equal(refreshed.chats.length, 50);
  const tail = await f.read({ after: refreshed.next, limit: 50 });
  assert.equal(tail.chats.length, 32);
  assert.equal(new Set([...refreshed.chats, ...tail.chats].map(row => row.id)).size, 82);
  const canonical = [...refreshed.chats, ...tail.chats].find(row => row.id === 'saved-0');
  assert.equal(canonical.title, 'Canonical original title');
  assert.equal(canonical.adapterId, 'harness2');
  assert.ok(canonical.historyAliasIds.includes('runner-canonical'));
  const access = require('../main/conversation/history-access');
  access.assertOwner(f.app, canonical.id, access.actor(f.app, owner), canonical);
  assert.throws(() => access.assertOwner(f.app, canonical.id,
    access.actor(f.app, require('./helpers/platform-session-fixture.cjs').identity('two')), canonical), /账号/);
  assert.equal(f.counters.external, 0);
  assert.equal(f.counters.native, 1, 'paging does not rescan any native transcript');
  const other = await fixture(t, 3);
  other.discover(async () => { throw Error('Native engine unavailable'); });
  const retained = await other.read({ refresh: true });
  assert.equal(retained.ok, true);
  assert.equal(retained.chats.length, 3);
  assert.match(retained.refreshError, /Native engine unavailable/);
});

test('main local history remains readable before login and across an auth change while default history stays fenced', async t => {
  const f = await fixture(t, 42), handlers = new Map();
  const auth = require('../main/device-auth');
  const previous = Object.fromEntries(['identity', 'session', 'profiles', 'localOwner'].map(key => [key, auth[key]]));
  auth.identity = () => null; auth.session = () => ''; auth.profiles = () => []; auth.localOwner = () => '';
  t.after(() => Object.assign(auth, previous));
  require('../main/pi-session/environment-ipc').install({ app: f.app, session: f.bridge,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) } });
  const read = options => handlers.get('pi-session-history')(null, options);
  const anonymous = await read({ source: 'local' });
  assert.equal(anonymous.ok, true);
  assert.equal(anonymous.chats.length, 42);
  assert.equal((await read()).ok, false, 'remote/default requests still require an authenticated actor');
  let release;
  f.discover(() => new Promise(resolve => { release = resolve; }));
  const pending = read({ source: 'local', refresh: true });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const identity = require('./helpers/platform-session-fixture.cjs').identity('two');
  auth.identity = () => identity; auth.session = () => identity.session;
  auth.localOwner = () => require('../platform-connections/runtime.cjs').scope(identity);
  release({ ok: true, chats: [] });
  assert.equal((await pending).chats.length, 42, 'a new account cannot invalidate device-local metadata');
  const wrong = await read({ source: 'local', workspace: 'another-device-workspace' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.chats.length, 0);
});

test('concurrent refreshes share native discovery while cached pages never wait for it', async t => {
  const f = await fixture(t, 12);
  let release;
  f.discover(() => new Promise(resolve => { release = resolve; }));
  const pending = Array.from({ length: 32 }, () => f.read({ refresh: true }));
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.read()).chats.length, 12);
  assert.equal(f.counters.native, 1);
  release({ ok: true, chats: [] });
  const rows = await Promise.all(pending);
  assert.ok(rows.every(row => row.ok && row.chats.length === 12));
  assert.deepEqual(f.counters, { native: 1, external: 0 });
});

test('invalid local page options cannot trigger native discovery or change profile membership', async t => {
  const f = await fixture(t, 3);
  for (const options of [{ limit: 201 }, { after: { at: 1, id: '../bad\nidentity' } },
    { after: { at: 'not-a-timestamp', id: 'valid' } }, { workspace: 'wrong-profile' }, { catalogRevision: -1 }])
    await assert.rejects(f.read({ ...options, refresh: true }), /Invalid|workspace changed/);
  assert.deepEqual(f.counters, { native: 0, external: 0 });
  assert.equal((await f.read({ limit: 200 })).chats.length, 3);
});

test('Runner metadata inventory avoids transcript journals and keeps the existing detailed history contract', async t => {
  const f = await fixture(t, 0);
  const journal = require('../main/conversation/task-output-journal');
  const previous = journal.usedHarnesses;
  let journals = 0;
  journal.usedHarnesses = async () => { journals++; return ['pi']; };
  t.after(() => { journal.usedHarnesses = previous; });
  const adapter = require('../main/agent-runtime/runner-adapter').createRunnerRuntimeAdapter({ app: f.app,
    runnerRuntime: { rpc: async method => {
      assert.equal(method, 'runtime.sessions');
      return { ok: true, data: { runs: Array.from({ length: 123 }, (_, i) => ({
        ref: 'runner-' + i, cli: 'qwen', taskId: 'chat-' + i, state: 'done', seq: 2,
      })) } };
    } }, runtimeSpec: require('../main/agent-runtime/runtime-catalog').runtime('qwen') });
  const inventory = await adapter.history(Number.MAX_SAFE_INTEGER, { metadataOnly: true });
  assert.equal(inventory.chats.length, 123);
  assert.equal(journals, 0);
  const detailed = await adapter.history(17);
  assert.equal(detailed.chats.length, 17);
  assert.equal(journals, 17);
  assert.deepEqual(detailed.chats[0].usedHarnesses, ['qwen', 'pi']);
});

test('local catalog retains aliases and lifecycle tombstones and advances for alias-only changes', async t => {
  const f = await fixture(t, 5);
  const initial = (await f.read()).localCatalog;
  await f.store.register([{ id: 'local-00000', title: 'Stored local conversation 0', adapterId: 'pi', at: 0, count: 2,
    historyAliasIds: ['native-0', 'later-native'] }]);
  const renamed = (await f.read({ catalogRevision: initial.revision })).localCatalog;
  assert.ok(renamed.revision > initial.revision);
  assert.ok(renamed.items.find(row => row.id === 'local-00000').historyAliasIds.includes('later-native'));
  await f.store.lifecycle('native-1', 'archive');
  await f.store.lifecycle('native-2', 'delete');
  const next = await f.read({ catalogRevision: renamed.revision });
  assert.equal(next.chats.length, 3);
  assert.equal(next.localCatalog.items.length, 5);
  assert.equal(next.localCatalog.items.find(row => row.id === 'local-00001').archived, true);
  assert.equal(next.localCatalog.items.find(row => row.id === 'local-00002').deleted, true);
  assert.deepEqual((await f.read({ archived: true })).chats.map(row => row.id), ['local-00001']);
  await f.restart();
  assert.deepEqual((await f.read()).localCatalog, next.localCatalog);
});

test('downloaded source locators retain resolver precedence without becoming native lifecycle aliases', async t => {
  const f = await fixture(t, 0);
  const { identity } = require('./helpers/platform-session-fixture.cjs');
  await f.store.register([{ id: 'native-direct', at: 1, historyAliasIds: ['explicit-source'] }]);
  const capture = (actor, at, sourceSessionId) => f.capture({
    snapshot: () => ({ messages: [{ role: 'user', text: 'Synthetic downloaded history' }] }),
    historyRow: () => ({ id: 'account-original', title: 'Same title is not an alias', at,
      adapterId: 'account-sync', accountProjection: true, sourceSessionId }),
  }, actor);
  await capture(identity(), 10, 'explicit-source');
  await capture(identity('two'), 20, 'source-native');
  const first = await f.read();
  const canonical = alias => first.localCatalog.items.find(row => row.historyAliasIds.includes(alias))?.id;
  const origin = alias => first.localCatalog.items.find(row => row.originIds.includes(alias))?.id;
  const newer = await f.store.get('account-original');
  assert.equal(origin('account-original'), newer.id);
  assert.equal(origin('source-native'), newer.id);
  assert.equal(canonical('account-original'), undefined, 'an active local copy cannot shadow its executable account original');
  assert.equal(canonical('source-native'), undefined);
  assert.equal(canonical('explicit-source'), 'native-direct');
  assert.equal((await f.store.get('explicit-source')).id, 'native-direct');
  assert.equal((await f.store.messages(newer.id)).items[0].text, 'Synthetic downloaded history');
  assert.equal(canonical('Same title is not an alias'), undefined);
  await f.store.lifecycle(newer.id, 'delete');
  const deleted = await f.read({ catalogRevision: first.localCatalog.revision });
  const owner = deleted.localCatalog.items.find(row => row.originIds.includes('account-original'));
  assert.equal(owner.id, (await f.store.get('account-original')).id);
  assert.equal(owner.deleted, true, 'deleted source aliases obey the same resolver instead of reviving an older copy');
  assert.ok(deleted.localCatalog.items.every(row => !row.historyAliasIds.includes('account-original')),
    'deleting a local copy cannot hide or mutate its separately authorized account original');
  assert.equal(JSON.stringify(deleted.localCatalog).includes('Synthetic downloaded history'), false);
  assert.equal(JSON.stringify(deleted.localCatalog).includes('Same title'), false);
});

test('real account directory and local replica remain separate through bridge, IPC, paging and local deletion', async t => {
  const f = await fixture(t, 0), handlers = new Map();
  const actor = require('./helpers/platform-session-fixture.cjs').identity();
  const auth = require('../main/device-auth');
  const previous = Object.fromEntries(['identity', 'session', 'profiles', 'localOwner'].map(key => [key, auth[key]]));
  let current = actor, requests = 0, nativeLookups = 0;
  auth.identity = () => current; auth.session = () => current?.session || ''; auth.profiles = () => [];
  auth.localOwner = () => current ? require('../platform-connections/runtime.cjs').scope(current) : '';
  t.after(() => Object.assign(auth, previous));
  const sync = require('../main/conversation/account-sync').create({ app: f.app, store: { jobs: () => [] },
    identityOf: () => current, localIdentityOf: () => current,
    resolveNativeSource: async () => { nativeLookups++; return null; },
    fetch: async () => {
      requests++;
      return new Response(JSON.stringify({ items: Array.from({ length: 124 }, (_, i) => ({
        id: i === 0 ? 'acct-original' : 'acct-' + String(i).padStart(3, '0'),
        title: 'Original account conversation ' + i, sourceClientId: actor.clientId,
        sourceSessionId: 'original-' + i, canSend: true, archived: i === 123,
        messageCount: 2, updatedAt: new Date(Date.UTC(2026, 10, 10) - Math.floor(i / 2) * 1000).toISOString(), state: 'idle',
      })), cursor: 124, hasMore: false }));
    } });
  t.after(() => sync.close());
  f.bridge.setExternalHistory({ history: options => sync.history(options) });
  require('../main/pi-session/environment-ipc').install({ app: f.app, session: f.bridge,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) } });
  const read = options => handlers.get('pi-session-history')(null, options);
  const first = await read({ source: 'account', limit: 17 });
  assert.equal(first.ok, true);
  const original = first.chats.find(row => row.id === 'acct-original');
  assert.ok(original?.accountProjection);
  assert.equal(original.accountCanSend, true);
  await f.capture({ historyRow: () => original,
    snapshot: () => ({ messages: [{ role: 'user', text: 'Downloaded synthetic transcript' }] }) }, actor);
  const copy = (await f.read()).chats[0];
  assert.ok(copy.cached && copy.id !== original.id);
  const all = [...first.chats]; let after = first.next;
  while (after) {
    const page = await read({ source: 'account', limit: 17, after });
    assert.equal(page.ok, true); all.push(...page.chats); after = page.next;
  }
  assert.equal(all.length, 123); assert.equal(new Set(all.map(row => row.id)).size, 123);
  assert.deepEqual(all.map(row => row.id), Array.from({ length: 123 }, (_, i) =>
    i === 0 ? 'acct-original' : 'acct-' + String(i).padStart(3, '0')).sort((left, right) => {
      const index = id => id === 'acct-original' ? 0 : Number(id.slice(5));
      return Math.floor(index(left) / 2) - Math.floor(index(right) / 2) || (left < right ? 1 : -1);
    }), 'ISO timestamps and equal-time IDs keep stable chronological keyset pages');
  assert.ok(all.every(row => row.accountProjection && !row.localReplica && row.id !== copy.id));
  assert.equal(nativeLookups, 0, 'account-only directory pages never probe a native source');
  assert.equal(requests, 1, 'existing authorized directory cache serves every metadata page');
  assert.equal(f.counters.native, 0);
  const archived = await read({ source: 'account', archived: true, limit: 200 });
  assert.deepEqual(archived.chats.map(row => row.id), ['acct-123']);
  await f.store.lifecycle(copy.id, 'delete');
  const retained = await read({ source: 'account', limit: 200 });
  assert.equal(retained.chats.find(row => row.id === original.id)?.accountCanSend, true);
  assert.equal((await f.read()).chats.length, 0);
  current = null;
  assert.equal((await read({ source: 'account' })).ok, false);
  assert.equal(requests, 1, 'anonymous account reads fail before consulting the provider');
  assert.equal((await read({ source: 'local' })).ok, true);
});

test('ten thousand local rows support bounded pages and concurrent metadata reads without transcript access', async t => {
  const f = await fixture(t, 10020);
  const initial = await f.read({ limit: 50 });
  assert.equal(initial.localCatalog.items.length, 10020);
  assert.equal(initial.chats.length, 50);
  const start = performance.now();
  let heartbeat = 0;
  const timer = setInterval(() => heartbeat++, 1);
  const pages = await Promise.all(Array.from({ length: 64 }, () => f.read({ limit: 50,
    after: initial.next, catalogRevision: initial.localCatalog.revision })));
  clearInterval(timer);
  for (const page of pages) {
    assert.equal(page.chats.length, 50);
    assert.equal(Object.hasOwn(page.localCatalog, 'items'), false);
    assert.equal(page.chats.some(row => initial.chats.some(first => first.id === row.id)), false);
  }
  assert.ok(heartbeat > 0, 'SQLite metadata reads stay in the worker instead of blocking the main event loop');
  assert.deepEqual(f.counters, { native: 0, external: 0 });
  t.diagnostic(JSON.stringify({ catalogRows: 10020, concurrentPages: 64, pageSize: 50,
    elapsedMs: Math.round(performance.now() - start), heartbeat }));
});
