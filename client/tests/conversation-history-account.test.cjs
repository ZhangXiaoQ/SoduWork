'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const auth = require('../main/device-auth');
const access = require('../main/conversation/history-access');
const memories = require('../main/conversation/session-memory');
const { identity, sessions } = require('./helpers/platform-session-fixture.cjs');
const { scope, connectionScope } = require('../main/platform-connections/runtime.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-history-account-'));
  const app = { getPath: () => root }, saved = {};
  let current = identity(), trustedOwner = scope(current);
  for (const key of ['identity', 'session', 'profiles', 'localOwner']) saved[key] = auth[key];
  auth.identity = () => current;
  auth.session = () => current?.session || '';
  auth.profiles = () => [];
  auth.localOwner = () => trustedOwner;
  t.after(() => { Object.assign(auth, saved); fs.rmSync(root, { recursive: true, force: true }); });
  for (const [id, actor] of [['alice', identity()], ['bob', identity('two')]]) memories.bind(app, id, actor, [], true);
  return { app, root, switch(actor) { current = actor; trustedOwner = actor ? scope(actor) : ''; },
    expire() { current = { ...identity(), session: sessions().expired }; },
    write(directory, id, value) {
      const file = path.join(root, directory, crypto.createHash('sha256').update(id).digest('hex') + '.json');
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); return file;
    } };
}
test('local history remains visible across accounts while execution ownership stays strict', t => {
  const f = fixture(t), id = 'pre-rename';
  const previous = crypto.createHash('sha256').update('soduwork-account\0one').digest('hex').slice(0, 32);
  f.write('session-memory-bindings', id, { owner: previous, ids: [] });
  const rows = [{ id, workOwner: previous }];
  assert.deepEqual(access.visible(f.app, rows).map(row => row.id), [id]);
  assert.doesNotThrow(() => access.assertOwner(f.app, id, access.actor(f.app), rows[0]));
  f.switch(identity('two'));
  assert.deepEqual(access.visible(f.app, rows).map(row => row.id), [id]);
  assert.throws(() => access.assertOwner(f.app, id, access.actor(f.app), rows[0]), /当前账号/);
  f.switch(identity());
  f.write('requirement-session-context', id, { owner: scope(identity('two')) });
  assert.deepEqual(access.visible(f.app, rows).map(row => row.id), [id]);
  assert.throws(() => access.assertOwner(f.app, id, access.actor(f.app), rows[0]), /当前账号/);
});
test('local history visibility survives account switch, expiry and signout without granting execution', t => {
  const f = fixture(t), rows = ['alice', 'bob', 'unbound'].map(id => ({ id, count: 1 }));
  assert.deepEqual(access.visible(f.app, rows).map(row => row.id), ['alice', 'bob', 'unbound']);
  f.switch(identity('two'));
  assert.deepEqual(access.visible(f.app, rows).map(row => row.id), ['alice', 'bob', 'unbound']);
  assert.throws(() => access.assertOwner(f.app, 'alice'), /当前账号/);
  f.switch(identity());
  assert.deepEqual(access.visible(f.app, rows).map(row => row.id), ['alice', 'bob', 'unbound']);
  f.expire();
  assert.deepEqual(access.visible(f.app, rows).map(row => row.id), ['alice', 'bob', 'unbound']);
  f.switch(null);
  assert.deepEqual(access.visible(f.app, rows).map(row => row.id), ['alice', 'bob', 'unbound']);
  assert.throws(() => access.assertOwner(f.app, 'alice'), /请先登录/);
});
test('local read does not claim execution ownership and cloud flag alone is not authority', t => {
  const f = fixture(t);
  f.write('requirement-session-context', 'alice', { owner: scope(identity('two')) });
  assert.deepEqual(access.visible(f.app, [{ id: 'alice' }, { id: 'unknown', cloud: true }]).map(row => row.id), ['alice']);
  assert.throws(() => access.assertOwner(f.app, 'alice'), /当前账号/);
  f.write('conversation-handoffs', 'remote', { sessionId: 'remote', owner: connectionScope(identity()), entryKind: 'cloud' });
  assert.equal(access.visible(f.app, [{ id: 'remote', cloud: true }]).length, 1);
  f.switch(identity('two'));
  assert.deepEqual(access.visible(f.app, [{ id: 'remote', cloud: true }]), []);
});

test('account projections require the exact authenticated connection and source identity', t => {
  const f = fixture(t);
  const row = { id: 'acct-review', accountProjection: true, accountConversation: true,
    adapterId: 'account-sync', sourceSessionId: 'native-review', sourceClientId: 'other-device',
    owner: connectionScope(identity()) };
  assert.equal(access.visible(f.app, [row]).length, 1);
  for (const patch of [{ owner: '' }, { accountProjection: false }, { sourceSessionId: '' },
    { sourceClientId: '' }, { adapterId: 'pi' }, { accountConversation: false }]) {
    assert.equal(access.visible(f.app, [{ ...row, ...patch }]).length, 0);
  }
  f.switch(identity('two'));
  assert.equal(access.visible(f.app, [row]).length, 0);
  f.switch({ ...identity(), hub: 'https://different.test' });
  assert.equal(access.visible(f.app, [row]).length, 0);
  f.switch(identity());
  assert.equal(access.visible(f.app, [row]).length, 1);
});
test('a legacy archive is bound to the first authenticated account that opens it', t => {
  const f = fixture(t), captured = access.actor(f.app);
  const archive = path.join(f.root, 'pi-agent', 'sessions', 'project', 'legacy.jsonl');
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.writeFileSync(archive, '{"type":"session","id":"legacy"}\n{"type":"message"}\n');
  assert.doesNotThrow(() => access.assertOwner(f.app, 'legacy', captured,
    { id: 'legacy', path: archive, count: 1 }, { allowLegacy: true }));
  assert.throws(() => {
    f.switch(identity('two'));
    access.assertOwner(f.app, 'legacy', access.actor(f.app), { id: 'legacy' });
  }, /当前账号/);
  f.switch(identity());
  assert.doesNotThrow(() => access.assertOwner(f.app, 'legacy', access.actor(f.app), { id: 'legacy' }));
});
test('legacy migration never claims an ownerless runner row', t => {
  const f = fixture(t);
  assert.throws(() => access.assertOwner(f.app, 'runner-only', access.actor(f.app),
    { id: 'runner-only', adapterId: 'runner' }, { allowLegacy: true }), /当前账号/);
  assert.equal(fs.existsSync(path.join(f.root, 'conversation-history-owners')), false);
});
test('listing an ownerless archive never assigns it to the current account', t => {
  const f = fixture(t), archive = path.join(f.root, 'pi-agent', 'sessions', 'project', 'legacy.jsonl');
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.writeFileSync(archive, '{"type":"session","id":"legacy-list"}\n');
  const rows = [{ id: 'legacy-list', path: archive, count: 1, cwd: f.root }];
  assert.deepEqual(access.visible(f.app, rows).map(row => row.id), ['legacy-list']);
  assert.throws(() => access.assertOwner(f.app, 'legacy-list', access.actor(f.app), rows[0]), /当前账号/);
  assert.equal(fs.existsSync(path.join(f.root, 'conversation-history-owners')), false);
  f.switch(identity('two'));
  assert.deepEqual(access.visible(f.app, rows).map(row => row.id), ['legacy-list']);
});
test('a legacy owner sidecar never follows a symbolic link', t => {
  const f = fixture(t), directory = path.join(f.root, 'conversation-history-owners');
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, 'target.json');
  fs.writeFileSync(target, JSON.stringify({ version: 1, sessionId: 'linked', owner: scope(identity()) }));
  const link = path.join(directory, crypto.createHash('sha256').update('linked').digest('hex') + '.json');
  try { fs.symlinkSync(target, link, 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) return t.skip('symbolic links are unavailable in this environment');
    throw error;
  }
  assert.throws(() => access.assertOwner(f.app, 'linked', access.actor(f.app)), /无法读取会话归属记录/);
});
test('legacy account lifecycle IPC stays strict when no device replica service is installed', async t => {
  const f = fixture(t), handlers = new Map(), calls = [];
  require('../main/pi-session/history-ipc').install({ app: f.app,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, BrowserWindow: { getAllWindows: () => [] },
    session: { findBySessionId: () => null, archivedConversation: async () => ({ id: 'alice' }),
      archiveHistory: async () => { calls.push('archive'); return { ok: true }; },
      restoreHistory: async () => { calls.push('restore'); return { ok: true }; },
      permanentlyDeleteHistory: async () => { calls.push('delete'); return { ok: true }; },
      archivedHistory: async () => ({ ok: true, chats: [{ id: 'alice' }, { id: 'bob' }] }) } });
  f.switch(identity('two'));
  for (const name of ['rename', 'archive', 'restore', 'delete', 'permanent-delete']) {
    const result = await handlers.get('pi-session-history-' + name)({}, 'alice', 'stolen');
    assert.equal(result.ok, false, name); assert.match(result.reason, /当前账号/);
  }
  assert.deepEqual(calls, []);
  assert.deepEqual((await handlers.get('pi-session-history-archived')()).chats.map(row => row.id), ['alice', 'bob']);
  f.switch(identity());
  assert.equal((await handlers.get('pi-session-history-archive')({}, 'alice')).ok, true);
  assert.deepEqual(calls, ['archive']);
});
test('an in-flight history read cannot return the previous account after login changes', async t => {
  const f = fixture(t), handlers = new Map();
  let resolve;
  require('../main/pi-session/environment-ipc').install({ app: f.app,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    session: { history: () => new Promise(done => { resolve = done; }) } });
  const pending = handlers.get('pi-session-history')();
  f.switch(identity('two')); resolve({ ok: true, chats: [{ id: 'alice' }] });
  const result = await pending;
  assert.equal(result.ok, false); assert.deepEqual(result.chats, []); assert.match(result.reason, /账号已切换/);
});
