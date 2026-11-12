'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const sessions = require('../main/pi-session/session');
const { createPiSessionBridge } = require('../main/agent-runtime/pi-session-bridge');
const { create: createSync } = require('../main/conversation/account-sync');
const { create: createStore } = require('../main/conversation/account-sync-store');
const nativeSource = require('../main/conversation/account-native-source.cjs');
const { identity } = require('./helpers/platform-session-fixture.cjs');
const auth = require('../main/device-auth');
const { scope } = require('../main/platform-connections/runtime.cjs');

async function fixture(t, { native = true, synced = true, sidecar = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-lifecycle-'));
  const app = { getPath: () => root }, actor = identity(), saved = {};
  let current = actor;
  for (const key of ['identity', 'session', 'profiles', 'localOwner']) saved[key] = auth[key];
  auth.identity = () => current; auth.session = () => current.session;
  auth.profiles = () => []; auth.localOwner = () => scope(current);
  const file = path.join(root, 'pi-agent', 'sessions', 'workspace', 'native.jsonl');
  if (native) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      { type: 'session', id: 'native', cwd: root, timestamp: '2026-11-06T00:00:00Z' },
      { type: 'custom', customType: 'soduwork.work-entry', data: { version: 1, owner: scope(actor) } },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Keep my work' }] } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n');
    if (sidecar) require('../main/conversation/session-memory').bind(app, 'native', actor, [], true);
  }
  const output = path.join(root, 'output.txt'); fs.writeFileSync(output, 'Keep this result');
  let item = synced ? { id: 'acct-fixture', sourceSessionId: 'native',
    sourceClientId: native ? actor.clientId : 'previous-device', title: 'Keep my work', state: 'completed',
    revision: 1, lifecycleRevision: 0, archived: false, deleted: false } : null;
  let fail = false, deleteFailure = false, trashFailure = false, beforePost = null, sync, failDeleteId = '';
  const extraItems = [];
  const posts = [], events = [];
  const response = (ok, body, status = ok ? 200 : 503) => ({ ok, status, json: async () => body });
  const fetch = async (_identity, url, options = {}) => {
    if (options.method === 'POST' && url.endsWith('/lifecycle')) {
      const body = JSON.parse(options.body); posts.push(body);
      const id = decodeURIComponent(url.match(/\/account-conversations\/([^/]+)\/lifecycle$/)[1]);
      const selected = item?.id === id ? item : extraItems.find(value => value.id === id);
      if (beforePost) await beforePost();
      if (fail || ((deleteFailure || id === failDeleteId) && body.action === 'delete')) return response(false, { detail: 'fixture offline' });
      if (!selected || body.expectedRevision !== selected.revision) return response(false, {}, 409);
      if (selected.deleted && body.action !== 'delete') return response(false, {}, 410);
      const updated = { ...selected, archived: body.action === 'archive' ? true : body.action === 'restore' ? false : selected.archived,
        deleted: body.action === 'delete', revision: selected.revision + 1, lifecycleRevision: selected.revision + 1 };
      if (item?.id === id) item = updated;
      else extraItems[extraItems.indexOf(selected)] = updated;
      return response(true, { ok: true, conversation: { ...updated } });
    }
    if (url.includes('/source')) return response(Boolean(item), { conversation: item && { ...item } }, item ? 200 : 404);
    return response(true, { items: [...(item ? [{ ...item }] : []), ...extraItems],
      cursor: Math.max(item?.revision || 0, ...extraItems.map(value => value.revision)), hasMore: false });
  };
  const bridge = createPiSessionBridge({ app, sessionModule: sessions, runnerAdapters: [] });
  const startSync = () => createSync({ app, identityOf: async () => current,
    store: createStore(path.join(root, 'outbox.json')), fetch,
    resolveNativeSource: (item, identity) => nativeSource.resolve({ app, session: bridge, item, identity }) });
  sync = startSync();
  bridge.setExternalHistory({ history: options => sync.history(options) });
  const accountHistory = { resolveLifecycle: (...args) => sync.resolveLifecycle(...args),
    setLifecycle: (...args) => sync.setLifecycle(...args) };
  const handlers = new Map();
  require('../main/pi-session/history-ipc').install({ app, session: bridge, accountHistory,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (_name, event) => events.push(event) } }] },
    shell: {}, trash: async (_shell, file) => {
      if (trashFailure) throw Error('fixture trash unavailable');
      fs.unlinkSync(file);
    } });
  t.after(async () => { await sync.close(); await bridge.dispose(); Object.assign(auth, saved);
    fs.rmSync(root, { recursive: true, force: true }); });
  return { app, bridge, file, output, posts, events, actor, extraItems,
    invoke: (action, id = native ? 'native' : 'acct-fixture', options) =>
      handlers.get('pi-session-history-' + action)({}, id, options),
    get item() { return item; }, set item(value) { item = value; },
    set fail(value) { fail = value; }, set beforePost(value) { beforePost = value; },
    set deleteFailure(value) { deleteFailure = value; }, set trashFailure(value) { trashFailure = value; },
    set failDeleteId(value) { failDeleteId = value; },
    switchUser: () => { current = identity('two'); },
    refresh: () => sync.history({ force: true }),
    restart: async () => { await sync.close(); sync = startSync(); },
  };
}

test('reinstalled account-only chats archive, restore and delete through the authenticated lifecycle IPC', async t => {
  const f = await fixture(t, { native: false });
  assert.deepEqual((await f.bridge.history(f.app)).chats.map(row => row.id), ['acct-fixture']);
  assert.equal((await f.invoke('archive')).ok, true);
  assert.equal(f.item.archived, true);
  assert.deepEqual((await f.bridge.history(f.app)).chats, []);
  await f.restart();
  assert.deepEqual((await f.bridge.archivedHistory(f.app)).chats.map(row => row.id), ['acct-fixture']);
  assert.equal((await f.invoke('restore')).ok, true);
  assert.equal((await f.bridge.history(f.app)).chats.length, 1);
  const count = f.posts.length;
  assert.equal((await f.invoke('delete')).needsConfirm, true);
  assert.equal(f.posts.length, count, 'confirmation never writes account state');
  assert.equal((await f.invoke('delete', 'acct-fixture', { confirmed: true })).ok, true);
  await f.restart();
  assert.deepEqual((await f.bridge.history(f.app)).chats, []);
  assert.deepEqual((await f.bridge.archivedHistory(f.app)).chats, []);
  assert.equal(fs.readFileSync(f.output, 'utf8'), 'Keep this result');
});

test('native archive and account alias stay one lifecycle across refresh, restart, restore and deletion', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.bridge.history(f.app)).chats.map(row => row.id), ['native']);
  const archived = await f.invoke('archive'); assert.equal(archived.ok, true, archived.reason);
  assert.ok(archived.aliasIds.includes('acct-fixture'));
  assert.equal(f.item.archived, true);
  await f.restart();
  assert.deepEqual((await f.bridge.history(f.app)).chats, []);
  assert.deepEqual((await f.bridge.archivedHistory(f.app)).chats.map(row => row.id), ['native']);
  assert.equal((await f.invoke('restore')).ok, true);
  assert.equal(sessions.isArchived(f.app, 'native'), false);
  assert.equal((await f.bridge.history(f.app)).chats.length, 1);
  assert.equal((await f.invoke('delete')).needsConfirm, true);
  assert.equal((await f.invoke('delete', 'native', { confirmed: true })).ok, true);
  assert.equal(fs.existsSync(f.file), false); assert.equal(f.item.deleted, true);
  await f.restart();
  assert.deepEqual((await f.bridge.history(f.app)).chats, []);
  assert.equal(fs.readFileSync(f.output, 'utf8'), 'Keep this result');
});

test('cold history IPC carries explicit lifecycle evidence for pinned and grouped snapshots', async t => {
  const f = await fixture(t);
  const handlers = new Map();
  require('../main/pi-session/environment-ipc').install({ app: f.app,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, session: f.bridge });
  f.item = { ...f.item, archived: true, revision: 2, lifecycleRevision: 2 };
  const archived = await handlers.get('pi-session-history')();
  assert.equal(archived.ok, true, archived.reason);
  assert.deepEqual(archived.chats, []);
  assert.equal(archived.lifecycle.length, 1);
  assert.equal(archived.lifecycle[0].archived, true);
  assert.equal(archived.lifecycle[0].lifecycleRevision, 2);
  assert.deepEqual(new Set([archived.lifecycle[0].id, ...archived.lifecycle[0].historyAliasIds]),
    new Set(['acct-fixture', 'native']));
  assert.equal(f.events.length, 0, 'cold reads must work even before a lifecycle push occurs');
  f.item = { ...f.item, sourceClientId: 'previous-device', sourceSessionId: 'foreign-native',
    deleted: true, revision: 3, lifecycleRevision: 3 };
  await f.restart();
  const deleted = await handlers.get('pi-session-history')();
  assert.equal(deleted.lifecycle[0].deleted, true);
  assert.equal(deleted.lifecycle[0].lifecycleRevision, 3);
  assert.equal(deleted.lifecycle[0].historyAliasIds.includes('foreign-native'), false,
    'a remote device source ID is never authority to remove a local sidebar row');
});

test('remote lifecycle overrides stale native archive flags without exposing foreign source IDs', async t => {
  const f = await fixture(t);
  await f.invoke('archive');
  assert.equal(sessions.isArchived(f.app, 'native'), true);
  f.item = { ...f.item, archived: false, revision: 8, lifecycleRevision: 8 };
  await f.refresh();
  assert.deepEqual((await f.bridge.history(f.app)).chats.map(row => row.id), ['native']);
  assert.deepEqual((await f.bridge.archivedHistory(f.app)).chats, []);
  f.item = { ...f.item, deleted: true, revision: 9, lifecycleRevision: 9 };
  await f.refresh();
  assert.deepEqual((await f.bridge.history(f.app)).chats, []);
  assert.deepEqual((await f.bridge.archivedHistory(f.app)).chats, []);
  assert.equal(fs.existsSync(f.file), true, 'sync filtering never destroys a native file');
});

test('account mutation failures leave native files and archive flags unchanged and remain retryable', async t => {
  const f = await fixture(t); f.fail = true;
  for (const action of ['archive', 'delete']) {
    const result = await f.invoke(action, 'native', { confirmed: true });
    assert.equal(result.ok, false); assert.equal(fs.existsSync(f.file), true);
    assert.equal(sessions.isArchived(f.app, 'native'), false);
  }
  assert.equal(f.events.length, 0);
  f.fail = false;
  assert.equal((await f.invoke('archive')).ok, true);
});

test('trusted JSONL ownership remains sufficient when legacy native sidecars are absent', async t => {
  const f = await fixture(t, { synced: false, sidecar: false });
  const result = await f.invoke('archive'); assert.equal(result.ok, true, result.reason);
  assert.equal(sessions.isArchived(f.app, 'native'), true); assert.equal(f.posts.length, 0);
});

test('account change during a lifecycle write cannot delete local files or emit a new-account event', async t => {
  const f = await fixture(t); f.beforePost = async () => f.switchUser();
  const result = await f.invoke('delete', 'native', { confirmed: true });
  assert.equal(result.ok, false); assert.match(result.reason, /账号|服务/);
  assert.equal(fs.existsSync(f.file), true); assert.equal(f.events.length, 0);
});

test('failed local deletion stays archived and can be retried without losing the account entry', async t => {
  const f = await fixture(t); f.trashFailure = true;
  const failed = await f.invoke('delete', 'native', { confirmed: true });
  assert.equal(failed.ok, false); assert.equal(f.item.archived, true); assert.equal(f.item.deleted, false);
  assert.equal(fs.existsSync(f.file), true);
  assert.deepEqual((await f.bridge.history(f.app)).chats, []);
  assert.deepEqual((await f.bridge.archivedHistory(f.app)).chats.map(row => row.id), ['native']);
  f.trashFailure = false;
  const retry = await f.invoke('permanent-delete');
  assert.equal(retry.ok, true, retry.reason); assert.equal(f.item.deleted, true);
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(fs.readFileSync(f.output, 'utf8'), 'Keep this result');
});

test('failed final account deletion remains retryable after native cleanup and restart', async t => {
  const f = await fixture(t); f.deleteFailure = true;
  const failed = await f.invoke('delete', 'native', { confirmed: true });
  assert.equal(failed.ok, false); assert.equal(f.item.archived, true); assert.equal(f.item.deleted, false);
  assert.equal(fs.existsSync(f.file), false);
  await f.restart();
  const archived = (await f.bridge.archivedHistory(f.app)).chats;
  assert.deepEqual(archived.map(row => row.id), ['acct-fixture']);
  f.deleteFailure = false;
  const retry = await f.invoke('permanent-delete', archived[0].id);
  assert.equal(retry.ok, true, retry.reason); assert.equal(f.item.deleted, true);
  assert.deepEqual((await f.bridge.archivedHistory(f.app)).chats, []);
  assert.equal(fs.readFileSync(f.output, 'utf8'), 'Keep this result');
});

test('explicit lifecycle wins over later ordinary checkpoints across verified native aliases', () => {
  const { create } = require('../main/conversation/history-lifecycle-view.cjs');
  const view = create([
    { id: 'acct-a', nativeIds: ['public', 'pi'], revision: 12, lifecycleRevision: 12, archived: false },
    { id: 'acct-b', nativeIds: ['public', 'external'], revision: 30, lifecycleRevision: 0, archived: true },
  ], { pi: 1, public: 1 });
  for (const id of ['public', 'pi', 'external', 'acct-a', 'acct-b']) {
    const row = view.project({ id });
    assert.equal(row.archived, false); assert.equal(row.lifecycleRevision, 12);
    assert.equal(row.historyAliasIds.length, 4);
  }
});

test('permanent deletion covers a transitive alias group but never foreign source IDs', () => {
  const { create } = require('../main/conversation/history-lifecycle-view.cjs');
  const view = create([
    { id: 'acct-a', nativeIds: ['public', 'pi'], revision: 12, lifecycleRevision: 12, deleted: true },
    { id: 'acct-b', nativeIds: ['external'], revision: 13, lifecycleRevision: 13, archived: false },
    { id: 'acct-c', nativeIds: ['external', 'pi'], revision: 14, lifecycleRevision: 0 },
    { id: 'acct-foreign', sourceSessionId: 'foreign-native', nativeIds: [], revision: 20, lifecycleRevision: 20, archived: true },
  ]);
  for (const id of ['public', 'pi', 'external', 'acct-a', 'acct-b', 'acct-c']) assert.equal(view.visible({ id }), false);
  assert.equal(view.visible({ id: 'foreign-native' }), true);
  assert.equal(view.visible({ id: 'acct-foreign' }, true), true);
});

test('missing owned content requires confirmation and clears leftover local metadata without deleting outputs', async t => {
  const f = await fixture(t, { synced: false });
  const titles = require('../main/conversation/titles');
  titles.save(f.app, 'native', 'Missing conversation');
  sessions.setArchived(f.app, 'native', true);
  fs.unlinkSync(f.file);
  const prompt = await f.invoke('delete');
  assert.equal(prompt.needsConfirm, true, prompt.reason);
  assert.equal(prompt.missingContent, true);
  assert.match(prompt.confirm.message, /Missing conversation/);
  assert.equal(f.events.length, 0);
  assert.equal(sessions.isArchived(f.app, 'native'), true, 'asking or cancelling never cleans metadata');
  const result = await f.invoke('delete', 'native', { confirmed: true, missingOnly: true });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.missingContent, true);
  assert.equal(sessions.isArchived(f.app, 'native'), false);
  assert.equal(titles.decorate(f.app, { id: 'native' }).title, undefined);
  await f.restart();
  assert.deepEqual((await f.bridge.history(f.app)).chats, []);
  assert.deepEqual((await f.bridge.archivedHistory(f.app)).chats, []);
  assert.equal(fs.readFileSync(f.output, 'utf8'), 'Keep this result');
});

test('missing source alias can delete its authenticated account record after native ownership files are lost', async t => {
  const f = await fixture(t, { sidecar: false });
  fs.unlinkSync(f.file);
  const prompt = await f.invoke('delete');
  assert.equal(prompt.needsConfirm, true, prompt.reason);
  assert.equal(f.posts.length, 0);
  const result = await f.invoke('delete', 'native', { confirmed: true, missingOnly: true });
  assert.equal(result.ok, true, result.reason);
  assert.ok(result.aliasIds.includes('native'));
  assert.ok(result.aliasIds.includes('acct-fixture'));
  assert.equal(f.item.deleted, true);
  assert.deepEqual(f.posts.map(post => post.action), ['delete']);
  await f.restart();
  assert.deepEqual((await f.bridge.history(f.app)).chats, []);
});

test('a cache-only missing name permits only a confirmed display cleanup', async t => {
  const f = await fixture(t, { native: false, synced: false });
  const titles = require('../main/conversation/titles');
  titles.save(f.app, 'stale-id', 'A cached label is not ownership');
  const prompt = await f.invoke('delete', 'stale-id');
  assert.equal(prompt.needsConfirm, true, prompt.reason);
  assert.equal(prompt.missingContent, true);
  assert.equal(f.events.length, 0);
  const result = await f.invoke('delete', 'stale-id', { confirmed: true, missingOnly: true });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.displayOnly, true);
  assert.deepEqual(result.aliasIds, ['stale-id']);
  assert.equal(f.posts.length, 0);
  assert.equal(titles.decorate(f.app, { id: 'stale-id' }).title, 'A cached label is not ownership',
    'an unowned display cleanup cannot mutate global metadata');
  assert.equal(fs.readFileSync(f.output, 'utf8'), 'Keep this result');
});

test('missing switched conversation can be permanently removed without first archiving nonexistent content', async t => {
  const f = await fixture(t);
  const segments = require('../main/conversation/runtime-segments');
  await segments.save(f.app, { version: 1, id: 'native', owner: scope(f.actor),
    title: 'Switched and missing', cwd: path.dirname(f.file),
    segments: [{ adapterId: 'pi', sessionId: 'native', path: f.file }],
    active: { adapterId: 'opencode', sessionId: 'missing-runner' } });
  fs.unlinkSync(f.file);
  const prompt = await f.invoke('delete');
  assert.equal(prompt.needsConfirm, true, prompt.reason);
  assert.equal(prompt.missingContent, true);
  const result = await f.invoke('delete', 'native', { confirmed: true, missingOnly: true });
  assert.equal(result.ok, true, result.reason);
  assert.equal(segments.read(f.app, 'native'), null);
  assert.equal(f.item.deleted, true);
  assert.ok(result.aliasIds.includes('missing-runner'));
  await f.restart();
  assert.deepEqual((await f.bridge.history(f.app)).chats, []);
});

test('missing content from another account cannot be cleared using the cache-only fallback', async t => {
  const f = await fixture(t, { synced: false });
  fs.unlinkSync(f.file); f.switchUser();
  const result = await f.invoke('delete', 'native', { confirmed: true });
  assert.equal(result.ok, false);
  assert.match(result.reason, /账号/);
  assert.equal(f.events.length, 0);
});

test('a damaged archive is not missing and its name cannot be permanently purged', async t => {
  const f = await fixture(t, { synced: false });
  fs.writeFileSync(f.file, '{damaged archive');
  const result = await f.invoke('delete', 'native', { confirmed: true });
  assert.equal(result.ok, false);
  assert.equal(result.needsConfirm, undefined);
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{damaged archive');
  assert.equal(f.events.length, 0);
});

test('confirmation for a missing name never deletes content restored while the dialog was open', async t => {
  const f = await fixture(t, { synced: false });
  const contents = fs.readFileSync(f.file);
  fs.unlinkSync(f.file);
  assert.equal((await f.invoke('delete')).missingContent, true);
  fs.writeFileSync(f.file, contents);
  const result = await f.invoke('delete', 'native', { confirmed: true, missingOnly: true });
  assert.equal(result.ok, false);
  assert.match(result.reason, /状态已变化/);
  assert.deepEqual(fs.readFileSync(f.file), contents);
  assert.equal(f.events.length, 0);
});

test('missing owned content remains retryable when the account tombstone cannot be saved', async t => {
  const f = await fixture(t); fs.unlinkSync(f.file); f.fail = true;
  const result = await f.invoke('delete', 'native', { confirmed: true, missingOnly: true });
  assert.equal(result.ok, false);
  assert.equal(f.item.deleted, false);
  assert.equal(f.events.length, 0);
  f.fail = false;
  const retried = await f.invoke('delete', 'native', { confirmed: true, missingOnly: true });
  assert.equal(retried.ok, true, retried.reason);
  assert.equal(f.item.deleted, true);
});

test('missing switched history keeps all source aliases until every account deletion is acknowledged', async t => {
  const f = await fixture(t);
  const segments = require('../main/conversation/runtime-segments');
  f.extraItems.push({ ...f.item, id: 'acct-second', sourceSessionId: 'missing-runner' });
  await segments.save(f.app, { version: 1, id: 'native', owner: scope(f.actor),
    title: 'Two missing sources', cwd: path.dirname(f.file),
    segments: [{ adapterId: 'pi', sessionId: 'native', path: f.file }],
    active: { adapterId: 'opencode', sessionId: 'missing-runner' } });
  fs.unlinkSync(f.file); f.failDeleteId = 'acct-second';
  const failed = await f.invoke('delete', 'native', { confirmed: true, missingOnly: true });
  assert.equal(failed.ok, false);
  assert.equal(f.item.deleted, true);
  assert.equal(f.extraItems[0].deleted, false);
  assert.ok(segments.read(f.app, 'native'), 'keep source mappings for partial deletion retry');
  f.failDeleteId = '';
  await f.restart();
  const retry = await f.invoke('delete', 'native', { confirmed: true, missingOnly: true });
  assert.equal(retry.ok, true, retry.reason);
  assert.equal(f.item.deleted, true); assert.equal(f.extraItems[0].deleted, true);
  assert.equal(segments.read(f.app, 'native'), null);
  assert.ok(retry.aliasIds.includes('acct-fixture')); assert.ok(retry.aliasIds.includes('acct-second'));
  assert.ok(f.posts.every(post => post.action === 'delete'), 'never try to archive already deleted sources');
  await f.restart();
  assert.deepEqual((await f.bridge.history(f.app)).chats, []);
  assert.deepEqual((await f.bridge.archivedHistory(f.app)).chats, []);
});

test('ordinary switched deletion preserves aliases for missing-content retry after partial account failure', async t => {
  const f = await fixture(t);
  const segments = require('../main/conversation/runtime-segments');
  f.extraItems.push({ ...f.item, id: 'acct-second', sourceSessionId: 'missing-runner' });
  await segments.save(f.app, { version: 1, id: 'native', owner: scope(f.actor),
    title: 'Two sources', cwd: path.dirname(f.file),
    segments: [{ adapterId: 'pi', sessionId: 'native', path: f.file }],
    active: { adapterId: 'opencode', sessionId: 'missing-runner' } });
  f.failDeleteId = 'acct-second';
  const failed = await f.invoke('delete', 'native', { confirmed: true });
  assert.equal(failed.ok, false);
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(f.item.deleted, true); assert.equal(f.extraItems[0].deleted, false);
  assert.ok(segments.read(f.app, 'native'));
  f.failDeleteId = '';
  await f.restart();
  const retry = await f.invoke('permanent-delete', 'native');
  assert.equal(retry.ok, true, retry.reason);
  assert.equal(f.extraItems[0].deleted, true);
  assert.equal(segments.read(f.app, 'native'), null);
  assert.equal(fs.readFileSync(f.output, 'utf8'), 'Keep this result');
});
