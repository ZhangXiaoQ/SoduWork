'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const preferences = require('../main/access-control/preferences');
function fixture(t, confirm, initialMode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-access-preference-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, handlers = new Map(), notifications = [], confirmations = [];
  if (initialMode) fs.writeFileSync(path.join(root, 'access-preferences.json'), JSON.stringify({ schema: 1, mode: initialMode, revision: 0 }));
  const wc = { getURL: () => pathToFileURL(path.resolve(__dirname, '../desk.html')).href + '?panel=workspace', isDestroyed: () => false, mainFrame: {} };
  const parent = { isDestroyed: () => false, webContents: { send: (...args) => notifications.push(args) } };
  const event = { sender: wc, senderFrame: wc.mainFrame };
  preferences.install({ app, ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    BrowserWindow: { getAllWindows: () => [parent], fromWebContents: () => parent },
    confirmFullAccess: async (...args) => { confirmations.push(args); return confirm ? confirm(...args) : false; } });
  return { app, root, event, wc, confirmations, notifications,
    get: (e = event) => handlers.get('access-preferences-get')(e),
    remember: (mode, e = event) => handlers.get('access-preferences-remember')(e, { mode }),
    set: (mode, revision, e = event) => handlers.get('access-preferences-set')(e, { mode, revision }),
    apply: (opts = {}, interactive = true) => preferences.forNewChat(app, opts, interactive) };
}
test('default modes persist locally and are applied only to new supported interactive chats', async t => {
  const f = fixture(t);
  assert.deepEqual(f.get(), { ok: true, mode: 'full', revision: 0 });
  assert.equal(f.apply({ adapterId: 'pi' }).accessMode, 'full');
  assert.equal(preferences.hasFullConsent(f.app, {}), true);
  assert.equal(fs.existsSync(path.join(f.root, 'access-preferences.json')), false);
  assert.equal((await f.set('readonly', 0)).ok, true);
  assert.equal(preferences.snapshot(f.app).mode, 'readonly');
  for (const adapterId of ['pi', 'codex-harness', 'opencode', 'qwen', 'codex', 'dsh', 'kimi', 'claude']) assert.equal(f.apply({ adapterId }).accessMode, 'readonly');
  for (const options of [{ taskSession: true }, { taskRef: 'task' }]) assert.equal(f.apply(options).accessMode, 'readonly');
  for (const options of [{ chatId: 'existing' }, { automationId: 'schedule' },
    ...['unknown-runtime'].map(adapterId => ({ adapterId })), { accessMode: 'standard' }]) assert.equal(f.apply(options), options);
  assert.equal(f.apply({}, false).accessMode, undefined);
  assert.equal((await f.set('standard', 1)).ok, true);
  assert.equal(f.apply({ mode: 'readonly' }).accessMode, 'readonly');
  assert.equal(f.confirmations.length, 0);
  assert.equal(f.notifications.length, 2);
});
test('explicit session choices update the remembered mode for the next new chat', async t => {
  const f = fixture(t);
  assert.equal((await f.remember('readonly')).ok, true);
  assert.equal(preferences.snapshot(f.app).mode, 'readonly');
  assert.equal((await f.remember('full')).ok, true);
  assert.equal(preferences.snapshot(f.app).mode, 'full');
  assert.equal(f.notifications.length, 2);
});
test('saved standard and readonly defaults survive reload instead of inheriting the new full default', t => {
  for (const mode of ['standard', 'readonly']) {
    const f = fixture(t, undefined, mode);
    assert.deepEqual(preferences.snapshot(f.app), { mode, revision: 0 });
    assert.equal(f.apply({ adapterId: 'pi' }).accessMode, mode);
    assert.equal(preferences.hasFullConsent(f.app, {}), false);
  }
});
test('saved full access requires dedicated default-scope consent; cancelling changes nothing', async t => {
  const f = fixture(t, undefined, 'standard');
  assert.equal((await f.set('full', 0)).cancelled, true);
  assert.deepEqual(preferences.snapshot(f.app), { mode: 'standard', revision: 0 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'access-preferences.json'), 'utf8')).mode, 'standard');
  assert.deepEqual(f.confirmations[0][1], { scope: 'default' });
  const allowed = fixture(t, () => true, 'standard');
  assert.equal((await allowed.set('full', 0)).ok, true);
  assert.equal(preferences.snapshot(allowed.app).mode, 'full');
  assert.equal(preferences.hasFullConsent(allowed.app, {}), true);
  assert.equal(preferences.hasFullConsent(allowed.app, { chatId: 'history' }), false);
  assert.equal(preferences.hasFullConsent(allowed.app, { taskSession: true }), true);
  assert.equal(allowed.apply({}).accessMode, 'full');
  await allowed.set('standard', 1);
  assert.equal(preferences.hasFullConsent(allowed.app, {}), false);
});
test('stale, invalid, embedded and untrusted updates cannot persist access changes', async t => {
  const f = fixture(t, () => true);
  assert.equal((await f.set('full', 0, { ...f.event, senderFrame: {} })).ok, false);
  assert.equal((await f.set('unknown', 0)).ok, false);
  await f.set('readonly', 0);
  assert.equal((await f.set('full', 0)).ok, false);
  f.wc.getURL = () => 'https://example.invalid/desk.html';
  assert.equal((await f.set('full', 1)).ok, false);
  assert.equal(f.confirmations.length, 0);
  assert.equal(preferences.snapshot(f.app).mode, 'readonly');
});
test('concurrent changes and owner navigation during full consent cannot save a stale choice', async t => {
  let answer;
  const f = fixture(t, () => new Promise(resolve => { answer = resolve; }), 'standard');
  const saving = f.set('full', 0);
  assert.equal((await f.set('readonly', 0)).ok, false);
  f.wc.getURL = () => 'file:///untrusted.html';
  answer(true);
  assert.equal((await saving).ok, false);
  assert.equal(preferences.snapshot(f.app).mode, 'standard');
});
test('corrupt or old unconfirmed full defaults fall back to standard; saved choices survive reload', async t => {
  const f = fixture(t, () => true), destination = path.join(f.root, 'access-preferences.json');
  fs.writeFileSync(destination, JSON.stringify({ schema: 1, mode: 'full', revision: 2 }));
  assert.deepEqual(preferences.snapshot(f.app), { mode: 'standard', revision: 2 });
  assert.equal((await f.set('full', 2)).ok, true);
  delete require.cache[require.resolve('../main/access-control/preferences')];
  assert.equal(require('../main/access-control/preferences').snapshot(f.app).mode, 'full');
  fs.writeFileSync(destination, '{invalid');
  assert.equal(preferences.snapshot(f.app).mode, 'standard');
});
