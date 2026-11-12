'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const source = fs.readFileSync(path.join(__dirname, '../main/pi-session/ipc.js'), 'utf8');
const handler = source.slice(source.indexOf('  async function openConversation('), source.indexOf("  ipcMain.handle('pi-session-open',"));
const pending = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function sender() {
  const value = new EventEmitter();
  value.mainFrame = {}; value.isDestroyed = () => false;
  value.getURL = () => pathToFileURL(path.join(__dirname, '../desk.html')).href;
  return { sender: value, senderFrame: value.mainFrame };
}
function fixture(options = {}) {
  const calls = [], dialogs = [], cwd = os.tmpdir(), event = sender();
  const emptyStorage = path.join(cwd, 'soduwork-new-chat-' + require('node:crypto').randomUUID());
  let closes = 0;
  const runtime = { sessionId: 'fixture', cwd, close: async () => { closes++; return options.close ? options.close() : true; } };
  const BrowserWindow = { fromWebContents: contents => ({ webContents: contents }) };
  const confirmFullAccess = async parent => {
    dialogs.push(parent);
    return options.confirm ? options.confirm(parent) : true;
  };
  const consent = require('../main/access-control/new-chat-consent').create({ BrowserWindow, confirmFullAccess });
  const defaultIdentity = (() => {
    const now = Math.floor(Date.now() / 1000), clientId = 'fixture';
    const claims = Buffer.from(JSON.stringify({ typ: 'device', uid: 'fixture-owner', cid: clientId,
      iat: now - 10, exp: now + 3600 })).toString('base64url');
    return { hub: 'http://fixture.invalid', clientId, session: claims + '.' + 'a'.repeat(64) };
  })();
  const context = vm.createContext({
    _sharedHistory: null,
    _cloudHandoff: { observe() {} }, _sessionOwners: null, _discardRenderer() {},
    skillTurn: require('../main/pi-session/skill-turn'), sendIdentityOf: null,
    app: options.app || { getPath: () => emptyStorage }, path, newChatAccess: consent,
    identityOf: async () => options.identity || defaultIdentity,
    memories: { context: async () => ({}), attach: options.attach || (async () => {}) },
    updateWorkloads: { guard: () => ({ ok: true }) },
    session: { findBySessionId: () => null, archivedConversation: async () => options.archive || null,
      open: async value => { calls.push(value); return options.open ? options.open(value, runtime) : { ok: true, session: runtime }; } },
    capabilities: { resolve: options.resolve || (async () => ({ catalog: {}, selectedSkills: [], capabilityIds: [] })) },
    capabilityGrantsOf: null, _skillDirs: () => [], _newSessionCwd: () => cwd, _defaultCwd: () => cwd,
    workDir: () => cwd, attachments: { stage: async () => ({ files: [], warnings: [] }) },
    sessionSpec: require('../main/conversation/session-spec'), _conf: () => ({}), BrowserWindow, confirmFullAccess,
    _entryContextPrompts: () => [], _awaitBounded: options.bounded || (value => value), OPEN_TIMEOUT_MS: 45000,
    _bindUsage() {}, _attach() {}, _detach() {}, _clearRelease() {}, _wire() {}, _openReply: () => ({ ok: true }),
    require: name => {
      if (name === '../conversation/history-access') {
        const actual = require(path.join(__dirname, '../main/pi-session', name));
        return { ...actual,
          actor(app, identity) { return actual.actor(app, identity === undefined ? (options.identity || defaultIdentity) : identity); } };
      }
      return require(path.join(__dirname, '../main/pi-session', name));
    },
  });
  vm.runInContext(handler, context);
  const confirm = async (draftId = 'draft-one', adapterId = 'pi') => {
    const reply = await consent.confirm(event, { draftId, adapterId });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return { accessMode: 'full', accessDraftId: draftId, accessConsentId: reply.consentId, adapterId };
  };
  return { event, calls, dialogs, consent, runtime, confirm, closes: () => closes,
    open: (opts, input = event, identity) => context.openConversation(input, opts, identity) };
}

test('manual selection confirms once before send, supports all permission runtimes and consumes one new chat', async () => {
  for (const adapterId of ['pi', 'codex-harness', 'opencode', 'qwen']) {
    const f = fixture(), opts = await f.confirm('draft-one', adapterId);
    assert.equal(f.dialogs.length, 1); assert.equal(f.calls.length, 0);
    assert.equal((await f.open(opts)).ok, true);
    assert.equal(f.calls[0].accessPolicy.mode, 'full');
    assert.equal(typeof f.calls[0].resolveSkills, 'function');
    assert.equal(f.dialogs.length, 1);
    assert.equal(JSON.stringify(f.calls).includes(opts.accessConsentId), false, 'capability must not leak into session metadata');
    assert.equal((await f.open(opts)).ok, false); assert.equal(f.calls.length, 1);
  }
  const f = fixture(), opts = await f.confirm();
  assert.equal((await f.open({ ...opts, adapterId: 'qwen' })).ok, true, 'same draft may change supported adapter');
});

test('表单先占用会话后仍复用同一窗口手动确认的完全访问，不重复弹框或跳过授权', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-work-consent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Math.floor(Date.now() / 1000), identity = { hub: 'https://fixture.invalid', clientId: 'fixture', session:
    Buffer.from(JSON.stringify({ typ: 'device', uid: 'owner', cid: 'fixture', iat: now - 10, exp: now + 3600 })).toString('base64url') + '.' + 'a'.repeat(64) };
  const archive = { id: 'work', path: path.join(root, 'work.jsonl'), cwd: root, adapterId: 'pi', workOnly: true,
    workOwner: require('../main/platform-connections/runtime.cjs').scope(identity) };
  fs.writeFileSync(archive.path, JSON.stringify({ type: 'session', id: 'work' }) + '\n');
  const f = fixture({ app: { getPath: () => root }, identity, archive }), grant = await f.confirm();
  const opened = await f.open({ ...grant, chatId: 'work' });
  assert.equal(opened.ok, true, opened.reason);
  assert.equal(f.calls[0].accessPolicy.mode, 'full');
  assert.equal(f.dialogs.length, 1);
  assert.equal((await f.open({ ...grant, chatId: 'work' })).ok, false, '同一授权只能消费一次');
  assert.equal(f.calls.length, 1);
});

test('cancelled, forged, incomplete and non-full credentials never reopen a confirmation or create a runtime', async () => {
  const f = fixture({ confirm: () => false });
  assert.equal((await f.consent.confirm(f.event, { draftId: 'draft-one', adapterId: 'pi' })).cancelled, true);
  for (const opts of [
    { accessDraftId: 'draft-one' }, { accessConsentId: 'forged' },
    { accessDraftId: 'draft-one', accessConsentId: 'forged' },
    { accessDraftId: '', accessConsentId: '' },
  ]) assert.equal((await f.open({ accessMode: 'full', ...opts })).ok, false);
  assert.equal(f.dialogs.length, 1); assert.equal(f.calls.length, 0);
  const allowed = fixture(), opts = await allowed.confirm();
  assert.equal((await allowed.open({ ...opts, accessMode: 'standard' })).ok, false);
  assert.equal((await allowed.open({ ...opts, adapterId: 'unknown-runtime' })).ok, false);
  assert.equal(allowed.dialogs.length, 1);
});

test('confirmation and credential use are scoped to trusted top-level document, never another window or task', async () => {
  const f = fixture(), opts = await f.confirm();
  assert.equal((await f.open(opts, sender())).ok, false);
  assert.equal((await f.open(opts, { ...f.event, senderFrame: {} })).ok, false);
  assert.equal((await f.open(opts, null)).ok, false);
  for (const scope of [{ chatId: 'history' }, { taskSession: true }, { taskRef: 'task' }, { automationId: 'automation' }]) {
    assert.equal((await f.open({ ...opts, ...scope })).ok, false);
  }
  assert.equal((await f.open(opts, f.event, { hub: 'fixture', clientId: 'fixture' })).ok, false);
  const untrusted = sender(); untrusted.sender.getURL = () => 'https://example.invalid/desk.html';
  assert.equal((await f.consent.confirm(untrusted, { draftId: 'other', adapterId: 'pi' })).ok, false);
  assert.equal((await f.consent.confirm({ ...f.event, senderFrame: {} }, { draftId: 'other' })).ok, false);
  assert.equal(f.calls.length, 0); assert.equal(f.dialogs.length, 1);
  assert.equal((await f.open(opts)).ok, true, 'rejected foreign use does not consume the owner grant');
});

test('revoke, navigation, reload and renderer exit invalidate existing grants', async () => {
  for (const action of ['revoke', 'did-start-navigation', 'render-process-gone', 'destroyed', 'frame-replacement']) {
    const f = fixture(), opts = await f.confirm();
    if (action === 'revoke') assert.equal(f.consent.revoke(f.event, { draftId: opts.accessDraftId }).ok, true);
    else if (action === 'frame-replacement') f.event.sender.mainFrame = f.event.senderFrame = {};
    else f.event.sender.emit(action, {}, f.event.sender.getURL(), false, true);
    assert.equal((await f.open(opts)).ok, false, action);
    assert.equal(f.calls.length, 0); assert.equal(f.dialogs.length, 1);
  }
});

test('a pending dialog cannot mint a credential after its draft is revoked or navigated away', async () => {
  for (const action of ['revoke', 'navigation']) {
    const dialog = pending(), f = fixture({ confirm: () => dialog.promise });
    const result = f.consent.confirm(f.event, { draftId: 'draft-one', adapterId: 'pi' });
    assert.equal((await f.consent.confirm(f.event, { draftId: 'draft-two', adapterId: 'pi' })).ok, false);
    if (action === 'revoke') f.consent.revoke(f.event, { draftId: 'draft-one' });
    else f.event.sender.emit('did-start-navigation', {}, f.event.sender.getURL(), false, true);
    dialog.resolve(true);
    assert.equal((await result).cancelled, true); assert.equal(f.dialogs.length, 1);
  }
});

test('parallel opens reserve the grant before asynchronous preparation', async () => {
  const prepare = pending(), f = fixture({ resolve: () => prepare.promise }), opts = await f.confirm();
  const first = f.open(opts);
  assert.equal((await f.open(opts)).ok, false);
  assert.equal((await f.consent.confirm(f.event, { draftId: 'draft-one', adapterId: 'pi' })).ok, false);
  prepare.resolve({ catalog: {}, selectedSkills: [], capabilityIds: [] });
  assert.equal((await first).ok, true); assert.equal(f.calls.length, 1); assert.equal(f.dialogs.length, 1);
});

test('failed initialization releases the same draft for safe retry without asking again', async () => {
  let attempts = 0;
  const f = fixture({ open: async (_value, runtime) => ++attempts === 1 ? { ok: false, reason: 'offline' } : { ok: true, session: runtime } });
  const opts = await f.confirm();
  assert.equal((await f.open(opts)).ok, false); await tick();
  assert.equal((await f.open(opts)).ok, true);
  assert.equal(f.dialogs.length, 1); assert.equal(attempts, 2);
});

test('timeout retains reservation until late runtime closure, then permits retry', async () => {
  const initialization = pending(), close = pending(); let timeout = true;
  const f = fixture({ open: () => initialization.promise, close: () => close.promise,
    bounded: async promise => { if (!timeout) return promise; const error = Error('timeout'); error.code = 'SODUWORK_OPEN_TIMEOUT'; throw error; } });
  const opts = await f.confirm();
  assert.equal((await f.open(opts)).ok, false);
  assert.equal((await f.open(opts)).ok, false); assert.equal(f.calls.length, 1);
  initialization.resolve({ ok: true, session: f.runtime }); await tick();
  assert.equal(f.closes(), 1); assert.equal((await f.open(opts)).ok, false);
  close.resolve(true); await tick(); timeout = false;
  assert.equal((await f.open(opts)).ok, true); assert.equal(f.calls.length, 2); assert.equal(f.dialogs.length, 1);
});

test('revoking during initialization closes the late session and cannot become full by fallback', async () => {
  const initialized = pending(), f = fixture({ open: () => initialized.promise }), opts = await f.confirm();
  const opening = f.open(opts); await tick();
  f.consent.revoke(f.event, { draftId: opts.accessDraftId });
  initialized.resolve({ ok: true, session: f.runtime });
  assert.equal((await opening).ok, false); await tick(); assert.equal(f.closes(), 1);
  assert.equal((await f.open(opts)).ok, false); assert.equal(f.dialogs.length, 1);
});

test('failure after runtime creation closes it before retry and refuses retry if closure fails', async () => {
  for (const closes of [true, false]) {
    let fail = true;
    const f = fixture({ attach: async () => { if (fail) throw Error('binding failed'); }, close: () => closes });
    const opts = await f.confirm();
    assert.equal((await f.open(opts)).ok, false); await tick(); assert.equal(f.closes(), 1); fail = false;
    assert.equal((await f.open(opts)).ok, closes);
    assert.equal(f.dialogs.length, 1);
  }
});

test('opening isolates unavailable defaults and forwards their warnings without advertising unloaded skills', async () => {
  let receivedWarnings;
  const warning = 'Skipped unavailable default skill: broken-default.';
  const f = fixture({
    resolve: async () => ({ catalog: {}, capabilityIds: [], selectedSkills: [],
      skills: [{ name: 'healthy' }, { name: 'broken-default' }],
      skillDirs: ['/skills/healthy', '/skills/broken-default'],
      optionalSkillDirs: ['/skills/broken-default'], warnings: ['policy warning'] }),
    open: async (_value, runtime) => {
      runtime.skills = ['healthy']; runtime.skillWarnings = [warning];
      return { ok: true, session: runtime };
    },
    attach: async (_session, _identity, _context, warnings) => { receivedWarnings = warnings; },
  });
  const result = await f.open({ accessMode: 'standard', optionalSkillDirs: ['/skills/healthy'] });
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls[0].optionalSkillDirs, ['/skills/broken-default']);
  assert.deepEqual(Array.from(f.runtime.ui.skills, item => item.name), ['healthy']);
  assert.deepEqual(Array.from(receivedWarnings), ['policy warning', warning]);
});
