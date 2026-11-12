'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { identity } = require('./helpers/platform-session-fixture.cjs');
const ownership = require('../main/platform-connections/runtime.cjs');
const ipcSource = fs.readFileSync(path.join(__dirname, '../main/pi-session/ipc.js'), 'utf8');
const openSource = ipcSource.slice(ipcSource.indexOf('  async function openConversation('),
  ipcSource.indexOf("  ipcMain.handle('pi-session-open',"));

// Exercise the production IPC routing and ownership resolver with isolated
// archives and a synthetic adapter, without contacting a model or user profile.
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-native-reopen-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, actor = identity();
  let currentActor = actor;
  const file = path.join(root, 'native-session.jsonl');
  const row = { id: 'native-session', adapterId: options.adapterId || 'pi', title: 'Saved conversation',
    path: file, cwd: root, count: 2, at: Date.now(), workOwner: ownership.scope(options.otherOwner ? identity('two') : actor) };
  fs.writeFileSync(file, '{"role":"user","content":"Original question"}\n{"role":"assistant","content":"Original answer"}\n');
  const item = { id: 'acct-native-session', sourceSessionId: row.id,
    sourceClientId: options.otherDevice ? 'other-device' : actor.clientId };
  const opens = [], views = [], reads = [], retired = [], live = new Map();
  const nativeHandle = () => ({ ref: 'native-ref', sessionId: row.id, adapterId: row.adapterId, cwd: root,
    historyRow: () => row, close: async () => true, snapshot: () => ({ adapterId: row.adapterId,
      modelSelection: { activeName: 'saved-model' }, messages: [{ role: 'user', text: 'Original question' }] }) });
  const projection = (id = item.id) => ({ ref: 'account-view', sessionId: id, adapterId: 'account-sync', cwd: '',
    historyRow: () => ({ ...item, accountProjection: true, accountConversation: true }),
    close: async () => {
      retired.push(id);
      if (options.closeUnconfirmed) return false;
      if (options.switchAccountDuringClose) currentActor = identity('two');
      live.delete(id);
      return true;
    },
    inFlight: () => false, snapshot: () => ({ adapterId: 'account-sync', modelSelection: {},
      accessControl: { mode: 'readonly' }, execution: { accountConversation: true, readOnly: true } }) });
  const sender = { mainFrame: {}, isDestroyed: () => false,
    getURL: () => require('node:url').pathToFileURL(path.join(__dirname, '../desk.html')).href };
  const event = { sender, senderFrame: sender.mainFrame };
  const session = {
    findBySessionId: id => live.get(id) || null,
    archivedConversation: async (_app, id, flags) => {
      reads.push({ id, flags });
      return id === row.id && !options.missingArchive ? row : null;
    },
    attachView: view => { views.push(view); return view; },
    open: async value => { opens.push(value); const handle = nativeHandle(); live.set(row.id, handle);
      return { ok: true, session: handle }; },
    get: () => null,
  };
  let context;
  function restart() {
    live.clear();
    context = vm.createContext({
      app, path, session, identityOf: async () => currentActor, sendIdentityOf: null,
      _accountSync: {
        isAccountConversation: id => options.coldDirectory !== true && !item.deleted && [item.id, row.id].includes(id),
        row: async () => {
          // A directory entry can be deleted after the initial live-row check.
          if (options.deleteDuringLookup) item.deleted = true;
          return item;
        },
        openProjection: async id => {
          if (item.deleted) return null;
          if (options.switchAccountDuringProjection) currentActor = identity('two');
          if (options.lateNative) live.set(row.id, nativeHandle());
          return [item.id, row.id].includes(id) ? projection(id) : null;
        },
      },
      _sharedHistory: null, _cloudHandoff: { observe() {} },
      memories: { context: async () => ({}), attach: async () => {}, assertOwner() {} },
      skillTurn: require('../main/pi-session/skill-turn'),
      pluginGrant: require('../main/pi-session/plugin-grant'),
      updateWorkloads: { guard: () => ({ ok: true }) },
      capabilities: { resolve: async () => ({ catalog: {}, selectedSkills: [], capabilityIds: [] }) },
      capabilityGrantsOf: null, _skillDirs: () => [], _newSessionCwd: () => root, _defaultCwd: () => root,
      workDir: () => root, attachments: { stage: async () => ({ files: [], warnings: [] }) },
      sessionSpec: require('../main/conversation/session-spec'), _conf: () => ({}),
      BrowserWindow: { fromWebContents: () => ({}) }, confirmFullAccess: async () => false,
      _entryContextPrompts: () => [], _awaitBounded: value => value, OPEN_TIMEOUT_MS: 45000,
      _sessionOwners: { bind() {}, quarantine() {}, closed() {} },
      _bindUsage() {}, _attach() {}, _detach() {}, _discardRenderer() {}, _wire() {},
      _openReply: (handle, extra) => ({ ok: true, ...extra, sessionId: handle.sessionId, snapshot: handle.snapshot() }),
      require: name => {
        if (name.startsWith('node:')) return require(name);
        const actual = require(path.join(__dirname, '../main/pi-session', name));
        if (name === '../conversation/history-access') return { ...actual,
          actor: (app, selected) => actual.actor(app, selected === undefined ? currentActor : selected) };
        return actual;
      },
    });
    vm.runInContext(openSource, context, { filename: 'production-openConversation.js' });
  }
  restart();
  if (options.live) live.set(row.id, nativeHandle());
  if (options.passiveLive) live.set(row.id, projection(row.id));
  return { row, item, opens, views, reads, retired, restart,
    open: raw => context.openConversation(event, raw) };
}

for (const { id: adapterId } of require('../main/agent-runtime/runtime-catalog').runtimes()) {
  test(`${adapterId}: cold account alias resumes the saved native archive with stale sidebar flags`, async t => {
    const f = fixture(t, { adapterId });
    const result = await f.open({ chatId: f.item.id, adapterId: 'account-sync',
      accountConversation: true, accountProjection: true });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.snapshot.adapterId, adapterId);
    assert.equal(f.views.length, 0, 'authenticated native history must not attach a readonly account view');
    assert.equal(f.opens.length, 1);
    assert.equal(f.opens[0].adapterId, adapterId);
    assert.equal(f.opens[0].resumePath, f.row.path);
    assert.equal(f.opens[0].resumedConversation, true);
  });
}

test('a native source ID from a cold directory resumes even when account metadata resolves to the same ID', async t => {
  const f = fixture(t, { coldDirectory: true });
  const result = await f.open({ chatId: f.row.id });
  assert.equal(result.ok, true, result.reason);
  assert.equal(f.views.length, 0);
  assert.equal(f.opens.length, 1);
  assert.equal(f.opens[0].resumePath, f.row.path);
});

test('a conversation that reattaches while live resumes the same archive after the IPC host restarts', async t => {
  const f = fixture(t, { live: true });
  assert.equal((await f.open({ chatId: f.item.id })).snapshot.adapterId, 'pi');
  assert.equal(f.opens.length, 0, 'reattaching must not create a second runtime');
  f.restart();
  const restored = await f.open({ chatId: f.item.id });
  assert.equal(restored.ok, true, restored.reason);
  assert.equal(restored.snapshot.adapterId, 'pi');
  assert.equal(f.views.length, 0);
  assert.equal(f.opens.length, 1);
  assert.equal(f.opens[0].resumePath, f.row.path);
});

test('another source device remains a readonly projection without starting a local adapter', async t => {
  const f = fixture(t, { otherDevice: true });
  const result = await f.open({ chatId: f.item.id });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.snapshot.adapterId, 'account-sync');
  assert.equal(result.snapshot.execution.readOnly, true);
  assert.equal(f.opens.length, 0);
  assert.equal(f.views.length, 1);
});

test('native runtime created during account projection lookup is reattached without duplicate execution', async t => {
  const f = fixture(t, { coldDirectory: true, lateNative: true });
  const result = await f.open({ chatId: f.item.id });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.snapshot.adapterId, 'pi');
  assert.equal(f.opens.length, 0, 'async account lookup must not create a second runtime');
  assert.equal(f.views.length, 0);
});

test('renderer-supplied native flags cannot make another device account projection executable', async t => {
  const f = fixture(t, { otherDevice: true });
  const result = await f.open({ chatId: f.item.id, nativeLocal: true, _nativeLocal: true,
    adapterId: 'pi', accountConversation: false, accountProjection: false });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.snapshot.adapterId, 'account-sync');
  assert.equal(result.snapshot.execution.readOnly, true);
  assert.equal(f.opens.length, 0);
  assert.equal(f.views.length, 1);
});

test('a previously attached account view is retired only after its owned native archive is verified', async t => {
  const f = fixture(t, { passiveLive: true });
  const result = await f.open({ chatId: f.item.id });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.snapshot.adapterId, 'pi');
  assert.equal(f.opens.length, 1);
  assert.equal(f.opens[0].resumePath, f.row.path);
  assert.deepEqual(f.retired, [f.row.id]);
  assert.equal(f.views.length, 0);
});

test('an unconfirmed passive-view close cannot start its replacement native runtime', async t => {
  const f = fixture(t, { passiveLive: true, closeUnconfirmed: true });
  const result = await f.open({ chatId: f.item.id });
  assert.equal(result.ok, false);
  assert.equal(f.opens.length, 0);
  assert.equal(f.views.length, 0);
  assert.deepEqual(f.retired, [f.row.id]);
});

test('an account switch while a passive view closes cannot open the prior account native archive', async t => {
  const f = fixture(t, { passiveLive: true, switchAccountDuringClose: true });
  const result = await f.open({ chatId: f.item.id });
  assert.equal(result.ok, false);
  assert.equal(f.opens.length, 0);
  assert.equal(f.views.length, 0);
  assert.deepEqual(f.retired, [f.row.id]);
});

test('an account alias cannot start a native archive owned by another account', async t => {
  const f = fixture(t, { otherOwner: true });
  const result = await f.open({ chatId: f.item.id });
  assert.equal(result.ok, false);
  assert.equal(f.opens.length, 0);
  assert.equal(f.views.length, 0);
});

test('a missing native archive does not manufacture a fresh executable session', async t => {
  const f = fixture(t, { missingArchive: true });
  const result = await f.open({ chatId: f.item.id });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.snapshot.adapterId, 'account-sync');
  assert.equal(f.opens.length, 0);
  assert.equal(f.views.length, 1);
});

test('a deletion observed during account-source lookup must not promote a still-present native archive', async t => {
  const f = fixture(t, { deleteDuringLookup: true });
  const result = await f.open({ chatId: f.item.id });
  assert.equal(result.ok, false);
  assert.equal(result.notFound, true);
  assert.equal(f.opens.length, 0);
  assert.equal(f.views.length, 0);
  assert.equal(fs.existsSync(f.row.path), true, 'open must not delete the retained local archive');
});

test('a deletion observed during native-alias account-source lookup cannot fall through to its retained archive', async t => {
  const f = fixture(t, { deleteDuringLookup: true });
  const result = await f.open({ chatId: f.row.id });
  assert.equal(result.ok, false);
  assert.equal(result.notFound, true);
  assert.equal(f.opens.length, 0);
  assert.equal(f.views.length, 0);
  assert.equal(fs.existsSync(f.row.path), true, 'opening deleted history must not mutate its retained archive');
});

test('an account change while the projection loads cannot promote the prior account native archive', async t => {
  const f = fixture(t, { coldDirectory: true, switchAccountDuringProjection: true });
  const result = await f.open({ chatId: f.item.id });
  assert.equal(result.ok, false);
  assert.equal(f.opens.length, 0);
  assert.equal(f.views.length, 0);
  assert.deepEqual(f.retired, []);
});

test('stale renderer workspace fields cannot relocate an existing native conversation', async t => {
  const f = fixture(t);
  const selected = path.join(f.row.cwd, 'other-existing-workspace');
  fs.mkdirSync(selected);
  const result = await f.open({ chatId: f.item.id, cwd: selected, resumeWorkspace: selected,
    workspaceMoved: selected, resumeCwd: selected });
  assert.equal(result.ok, true, result.reason);
  assert.equal(f.opens.length, 1);
  assert.equal(f.opens[0].cwd, f.row.cwd);
  assert.equal(f.opens[0].resumeCwd, f.row.cwd);
  assert.equal(f.opens[0].resumePath, f.row.path);
  assert.equal(f.opens[0].workspaceMoved, undefined);
});
