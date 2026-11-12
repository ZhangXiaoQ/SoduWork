'use strict';
// Shared workspace deletion replaces snapshot-based Hub deletion. The original
// failure, account, restart and retry scenarios remain exercised through IPC.
// Strict Hub CAS/foreign-receipt/epoch coverage lives in account-sync-lifecycle.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
async function fixture(t, language = 'zh-CN') {
  const locale = require('../main/native-locale.cjs'), previousLocale = locale.getLocale();
  locale.setLocale(language);
  t.after(() => locale.setLocale(previousLocale));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-local-delete-'));
  const original = path.join(root, 'original.jsonl'), output = path.join(root, 'delivery.txt');
  fs.writeFileSync(original, 'retained native archive'); fs.writeFileSync(output, 'retained output');
  const app = { getPath: () => root }, row = { id: 'native', title: 'Review', path: original, adapterId: 'pi' };
  let busy = false, fail = false, history, actions, handlers, recycled = 0;
  const events = [], session = { findBySessionId: () => busy ? { inFlight: () => true } : null,
    historyEntry: async (_app, id) => id === row.id && fs.existsSync(original) ? { ok: true, entry: row } : { ok: false, notFound: true },
    archivedConversation: async () => null, setArchived() {}, forgetRunner: async () => ({ ok: true }) };
  const start = async () => {
    history = require('../main/conversation/shared-history.cjs').create({ app, session });
    await history.register([row]); handlers = new Map();
    actions = require('../main/pi-session/history-ipc').install({ app, session, sharedHistory: history,
      accountHistory: new Proxy({}, { get: () => () => assert.fail('Local operation reached Hub mutation') }),
      ipcMain: { handle: (key, fn) => handlers.set(key, fn) },
      BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (_, event) => events.push(event) } }] },
      trash: async (_, file) => { if (fail) throw Error('recycle failed'); fs.renameSync(file, path.join(root, 'recycled.jsonl')); recycled++; } });
  };
  await start();
  t.after(async () => { await history.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, row, original, output, events, app, session, history: () => history,
    action: (...args) => actions.localAction(...args),
    remove: options => handlers.get('pi-session-history-delete')({}, 'native', options),
    restart: async () => { await history.close(); await start(); }, recycled: () => recycled,
    set busy(value) { busy = value; }, set fail(value) { fail = value; } };
}
test('offline deletion survives restart and stale inventory cannot resurrect it', async t => {
  const f = await fixture(t); assert.equal((await f.remove({ confirmed: true })).ok, true);
  await f.restart(); assert.equal((await f.history().resolve('native')).deleted, true);
  assert.equal((await f.history().list()).items.length, 0);
  assert.equal(fs.existsSync(f.original), false); assert.equal(fs.readFileSync(f.output, 'utf8'), 'retained output');
});
test('failed recycling retains bytes and a durable archived retry entry', async t => {
  const f = await fixture(t); f.fail = true;
  assert.equal((await f.remove({ confirmed: true })).ok, false); assert.equal(fs.existsSync(f.original), true);
  await f.restart(); const row = await f.history().resolve('native');
  assert.equal(row.archived, true); assert.equal(row.deleted, false);
});
test('local deletion neither borrows nor changes another account checkpoint', async t => {
  const f = await fixture(t);
  await f.history().register([{ ...f.row, workOwner: 'different-account' }]);
  assert.equal((await f.remove({ confirmed: true })).ok, true);
  assert.equal((await f.history().resolve('native')).deleted, true);
});
test('production IPC requires confirmation before deleting local bytes', async t => {
  const f = await fixture(t), reply = await f.remove({});
  assert.equal(reply.needsConfirm, true); assert.match(reply.confirm.detail, /不删除云端/);
  assert.equal(fs.existsSync(f.original), true); assert.equal(f.recycled(), 0);
  assert.equal((await f.remove({ confirmed: true })).ok, true); assert.equal(f.recycled(), 1);
});

test('account original lifecycle bypasses downloaded read locators while explicit local identities stay offline', async t => {
  const f = await fixture(t), actor = require('./helpers/platform-session-fixture.cjs').identity();
  const auth = require('../main/device-auth'), prior = Object.fromEntries(['identity', 'session', 'profiles', 'localOwner'].map(key => [key, auth[key]]));
  let current = actor;
  auth.identity = () => current; auth.session = () => current?.session || ''; auth.profiles = () => [];
  auth.localOwner = () => current ? require('../main/platform-connections/runtime.cjs').scope(current) : '';
  t.after(() => Object.assign(auth, prior));
  const original = { id: 'acct-original', sourceSessionId: 'foreign-native', sourceClientId: 'other-device',
    accountProjection: true, accountConversation: true, adapterId: 'account-sync',
    owner: require('../main/platform-connections/runtime.cjs').connectionScope(actor) };
  await f.history().capture({ historyRow: () => original,
    snapshot: () => ({ messages: [{ role: 'assistant', text: 'Synthetic downloaded copy' }] }) }, actor);
  const copy = (await f.history().list()).items.find(row => row.cached);
  await f.history().register([{ ...copy, historyAliasIds: ['native-copy-alias'] }]);
  const handlers = new Map(), writes = [];
  const actions = require('../main/pi-session/history-ipc').install({ app: f.app, session: f.session,
    sharedHistory: f.history(), ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    BrowserWindow: { getAllWindows: () => [] },
    accountHistory: {
      resolveLifecycle: async id => ({ ok: true, found: true, projection: { ...original, id }, nativeIds: [] }),
      setLifecycle: async (id, action) => { writes.push({ id, action }); return { ok: true, found: true }; },
    } });
  assert.equal((await f.history().resolve(original.id)).id, copy.id);
  assert.equal(await actions.localAction('delete', original.id), null);
  const confirmation = await handlers.get('pi-session-history-delete')({}, original.id, {});
  assert.equal(confirmation.needsConfirm, true); assert.equal(confirmation.id, original.id);
  for (const action of ['archive', 'restore']) {
    assert.equal((await handlers.get('pi-session-history-' + action)({}, original.id)).ok, true);
    assert.equal((await f.history().resolve(copy.id)).archived, false);
  }
  assert.deepEqual(writes, [{ id: original.id, action: 'archive' }, { id: original.id, action: 'restore' }]);
  current = null;
  assert.equal((await handlers.get('pi-session-history-archive')({}, original.id)).ok, false);
  assert.equal((await actions.localAction('archive', 'native-copy-alias')).ok, true);
  assert.equal((await f.history().resolve(copy.id)).archived, true);
  assert.equal((await actions.localAction('restore', copy.id)).ok, true);
  assert.equal(writes.length, 2);
});

test('English deletion confirmation retains the same local-only boundary', async t => {
  const f = await fixture(t, 'en-US'), reply = await f.remove({});
  assert.equal(reply.needsConfirm, true);
  assert.equal(reply.confirm.detail, 'Delete this local history only. Cloud originals, requirements and output files are retained. Restarting will not restore the deleted local copy.');
  assert.equal(fs.existsSync(f.original), true); assert.equal(f.recycled(), 0);
});
test('active execution blocks deletion and archive without damaging bytes', async t => {
  const f = await fixture(t); f.busy = true;
  assert.match((await f.remove({ confirmed: true })).reason, /执行/);
  await assert.rejects(f.action('archive', 'native'), /执行/); assert.equal(fs.existsSync(f.original), true);
});
test('cleanup retry publishes deletion only after success', async t => {
  const f = await fixture(t); f.fail = true;
  assert.equal((await f.remove({ confirmed: true })).ok, false); assert.notEqual(f.events.at(-1)?.presence.deleted, true);
  f.fail = false; assert.equal((await f.remove({ confirmed: true })).ok, true);
  assert.equal(f.events.at(-1).presence.deleted, true); assert.equal(f.recycled(), 1);
});
test('lost reply and deletion retry after restart cannot recycle twice', async t => {
  const f = await fixture(t); await f.remove({ confirmed: true }); await f.restart();
  assert.equal((await f.remove({ confirmed: true })).alreadyDeleted, true); assert.equal(f.recycled(), 1);
});
test('phone account revocation while queued prevents mutation', async t => {
  const f = await fixture(t); let checks = 0;
  await assert.rejects(f.action('delete', 'native', { confirmed: true,
    assertCurrent: () => { if (++checks > 1) throw Error('account changed'); } }), /account changed/);
  assert.equal(fs.existsSync(f.original), true); assert.equal((await f.history().resolve('native')).deleted, false);
});
test('stale phone archive cannot undo a newer restore', async t => {
  const f = await fixture(t), revision = (await f.history().resolve('native')).revision;
  await f.action('archive', 'native', { expectedRevision: revision }); await f.action('restore', 'native');
  await assert.rejects(f.action('archive', 'native', { expectedRevision: revision }), /其他窗口更新/);
  assert.equal((await f.history().resolve('native')).archived, false);
});
test('a tombstone fences only its own replica and leaves other account copies', async t => {
  const f = await fixture(t); await f.history().register([{ id: 'other', cached: true }]);
  await f.remove({ confirmed: true }); await f.restart();
  assert.deepEqual((await f.history().list()).items.map(row => row.id), ['other']);
});
test('phone rejects missing revisions and unknown identities before deletion', async t => {
  const f = await fixture(t);
  const remote = require('../main/pi-session/local-history-remote.cjs').create({ app: f.app, session: f.session,
    history: f.history(), action: f.action, identityOf: async () => ({ clientId: 'fixture' }) });
  await assert.rejects(remote({ action: 'delete', id: 'native', confirmed: true }, () => {}), /刷新/);
  await assert.rejects(remote({ action: 'delete', id: 'unknown', expectedRevision: 1, confirmed: true }, () => {}), /不存在/);
  assert.equal(fs.existsSync(f.original), true);
});
