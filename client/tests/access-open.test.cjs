'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../main/pi-session/ipc.js'), 'utf8');
const handler = source.slice(source.indexOf('  async function openConversation('), source.indexOf("  ipcMain.handle('pi-session-open',"));

function standardPreferenceFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-saved-standard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'access-preferences.json'), JSON.stringify({ schema: 1, mode: 'standard', revision: 0 }));
  return fixture({ ...options, app: { getPath: () => root } });
}
function fixture(options = {}) {
  const calls = [], dialogs = [], ownerActions = [], cwd = os.tmpdir();
  let viewAttachments = 0, viewDetachments = 0, rendererGrants = 0;
  const defaultIdentity = automationIdentity();
  const cachedIdentity = options.cachedIdentity || (() => options.identity || defaultIdentity);
  const emptyStorage = path.join(cwd, 'soduwork-access-open-' + require('node:crypto').randomUUID());
  const sender = { mainFrame: {}, isDestroyed: () => false,
    getURL: () => require('node:url').pathToFileURL(path.join(__dirname, '../desk.html')).href };
  const event = { sender, senderFrame: sender.mainFrame };
  const context = vm.createContext({
    _accountSync: options.accountSync,
    _sharedHistory: options.sharedHistory || null,
    _cloudHandoff: options.cloudHandoff || { observe() {} },
    skillTurn: require('../main/pi-session/skill-turn'), sendIdentityOf: null,
    taskInput: { request: async (_identity, route) => options.request(route) },
    app: options.app || { getPath: () => emptyStorage }, path,
    identityOf: options.identityOf || (async () => defaultIdentity),
    memories: { context: async () => ({}),
      attach: options.memoryAttach || (async () => {}), assertOwner() {} },
    pluginGrant: require('../main/pi-session/plugin-grant'),
    updateWorkloads: { guard: () => ({ ok: true }) },
    session: { findBySessionId: id => options.live?.sessionId === id ? options.live : null,
      get: () => options.live,
      attachView: remote => options.attachView ? options.attachView(remote) : remote,
      archivedConversation: async () => options.archive || null,
      historyEntry: async () => ({ entry: options.archive }),
      open: async value => { if (options.validateWork) await value.validateWorkConversation?.();
        calls.push(value); return options.openResult || { ok: true, session: { sessionId: 'fixture', cwd,
        close: async () => {} } }; }, ...options.session },
    capabilities: { resolve: options.resolve || (async () => ({ catalog: {}, selectedSkills: [], capabilityIds: [] })) },
    capabilityGrantsOf: null, _skillDirs: () => [], _newSessionCwd: () => cwd, _defaultCwd: () => cwd,
    workDir: () => cwd, attachments: { stage: async () => ({ files: [], warnings: [] }) },
    sessionSpec: require('../main/conversation/session-spec'), _conf: () => ({}),
    BrowserWindow: { fromWebContents: () => ({ fixture: true }) },
    confirmFullAccess: async parent => {
      dialogs.push(parent);
      if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
      return options.response === 1;
    },
    _entryContextPrompts: () => [], _awaitBounded: value => value, OPEN_TIMEOUT_MS: 45000,
    newChatAccess: options.newChatAccess,
    _sessionOwners: options.sessionOwners || {
      bind(handle, identity, policy) { ownerActions.push(['bind', handle, identity, policy]); },
      quarantine(handle) { ownerActions.push(['quarantine', handle]); },
      closed(handle, confirmed) { ownerActions.push(['closed', handle, confirmed]); },
    },
    _bindUsage() {}, _attach() { viewAttachments++; },
    _detach(handle) { viewDetachments++; return options.detach?.(handle); },
    _discardRenderer(handle) { viewDetachments++; return options.discard?.(handle); },
    _clearRelease() {},
    _wire(...args) { return options.wire?.(...args); },
    _openReply: (...args) => options.openReply ? options.openReply(...args) : ({ ok: true }),
    require: name => {
      if (name.startsWith('node:')) return require(name);
      if (name === './app-mcp-grant.cjs') {
        const actual = require(path.join(__dirname, '../main/pi-session', name));
        return { ...actual, bind(...args) { rendererGrants++; return actual.bind(...args); } };
      }
      if (['../work-preview', '../conversation/app-surfaces.cjs'].includes(name)) {
        return require(path.join(__dirname, '../main/pi-session', name));
      }
      if (name === '../conversation/history-access') {
        const actual = require(path.join(__dirname, '../main/pi-session', name));
        return { ...actual,
          actor(app, identity) { return actual.actor(app, identity === undefined ? cachedIdentity() : identity); } };
      }
      if (name === '../conversation/acceptance-session' && options.acceptance) return options.acceptance;
      if (name === '../conversation/account-native-source.cjs') return require('../main/conversation/account-native-source.cjs');
      if (name === '../conversation/shared-history.cjs') return require('../main/conversation/shared-history.cjs');
      if (!['../native-locale.cjs', '../agent-runtime/runtime-catalog', '../access-control/policy', '../access-control/preferences', '../access-control/automation-access', '../platform-connections/runtime.cjs', '../conversation/history-access', '../conversation/requirement-context', '../conversation/acceptance-session', '../conversation/work-conversation-opening', '../conversation-connectors.cjs', './resume-cwd', './task-access'].includes(name)) throw Error('Unexpected dependency ' + name);
      return require(path.join(__dirname, '../main/pi-session', name));
    },
  });
  vm.runInContext(handler, context);
  return { calls, dialogs, ownerActions, event, viewAttachments: () => viewAttachments,
    viewDetachments: () => viewDetachments, rendererGrants: () => rendererGrants,
    open: (raw, source = event) => context.openConversation(source, raw),
    openExpected: (raw, expectedIdentity, source = null) => context.openConversation(source, raw, expectedIdentity),
    ...require('../main/access-control/automation-access').service(context.app, context.openConversation) };
}

function automationIdentity(uid = 'owner') {
  const now = Math.floor(Date.now() / 1000);
  const claims = Buffer.from(JSON.stringify({ typ: 'device', uid, cid: 'fixture', iat: now - 60, exp: now + 3600 })).toString('base64url');
  return { hub: 'http://fixture.invalid', clientId: 'fixture', session: claims + '.' + 'a'.repeat(64) };
}

test('a downloaded transcript cannot shadow the cloud original on repeated desktop opens', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-cloud-copy-open-'));
  const app = { getPath: () => root };
  const store = require('../main/conversation/replica-store.cjs').create(path.join(root, 'replicas.sqlite'));
  const bridge = require('../main/agent-runtime/pi-session-bridge').createPiSessionBridge({
    sessionModule: { open() { assert.fail('must not execute locally'); }, probe() {} }, runnerAdapters: [],
  });
  const original = 'cloud-sync-original', copy = 'copy-local';
  store.register([{ id: copy, cached: true, source: { id: original } }]);
  let localReads = 0, remoteReads = 0;
  const view = (id, remote) => ({ ref: 'view-' + id, sessionId: id, cwd: root,
    localReplica: !remote, passiveCloudView: remote, snapshot: () => ({ messages: [{role: 'assistant', text: 'CLOUD-OK'}] }),
    close: async () => true });
  const f = fixture({ app, session: bridge,
    sharedHistory: { resolve: async id => store.get(id), open: async id => { localReads++; return view(store.get(id).id, false); } },
    cloudHandoff: { isRemote: id => id === original, observe() {}, reopen: async id => { remoteReads++; return view(id, true); } },
    openReply: handle => ({ ok: true, sessionId: handle.sessionId, cloud: handle.passiveCloudView, messages: handle.snapshot().messages }),
  });
  t.after(async () => { for (const h of bridge.list()) await h.close(); store.close(); fs.rmSync(root, {recursive: true, force: true}); });
  for (let i = 0; i < 3; i++) {
    const reply = await f.open({chatId: original});
    assert.equal(reply.ok, true, reply.reason);
    assert.equal(reply.sessionId, original);
    assert.equal(reply.cloud, true);
    assert.equal(reply.messages[0].text, 'CLOUD-OK');
  }
  assert.equal(remoteReads, 1);
  assert.equal(localReads, 0);
  assert.equal(store.get(copy).id, copy, 'the explicit local copy remains available');
});

test('local history aliases reopen their canonical registered view without identity conflicts', async t => {
  const bridge = require('../main/agent-runtime/pi-session-bridge').createPiSessionBridge({
    sessionModule: { open() { assert.fail('read-only history must not execute'); }, probe() {} }, runnerAdapters: [],
  });
  const row = {id: 'copy-local', cached: true, historyAliasIds: ['source-alias']};
  const f = fixture({ session: bridge, sharedHistory: { resolve: async () => row,
    open: async () => ({ref: 'local-copy', sessionId: row.id, localReplica: true, close: async () => true}) },
    openReply: handle => ({ok: true, sessionId: handle.sessionId}),
  });
  t.after(async () => { for (const h of bridge.list()) await h.close(); });
  for (let i = 0; i < 3; i++) assert.equal((await f.open({chatId: 'source-alias'})).sessionId, row.id);
  assert.equal(bridge.list().length, 1);
});

test('a downloaded account transcript cannot intercept authenticated original opens or bypass account login', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-account-copy-open-'));
  const app = { getPath: () => root }, actor = automationIdentity();
  const store = require('../main/conversation/replica-store.cjs').create(path.join(root, 'replicas.sqlite'));
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const original = 'acct-original', copy = 'copy-local';
  store.register([{ id: copy, cached: true, source: { id: original }, historyAliasIds: ['explicit-native-alias'] }]);
  let current = actor, localReads = 0, accountReads = 0;
  const f = fixture({ app, cachedIdentity: () => current, identityOf: async () => current,
    sharedHistory: { resolve: async id => store.get(id), open: async id => {
      localReads++; return { sessionId: id, localReplica: true };
    } },
    accountSync: { isAccountConversation: id => id === original,
      row: async () => ({ id: original, sourceClientId: 'other-device', sourceSessionId: 'foreign-native' }),
      openProjection: async id => { accountReads++; return { sessionId: id, adapterId: 'account-sync' }; } },
    openReply: handle => ({ ok: true, sessionId: handle.sessionId, localReplica: handle.localReplica,
      adapterId: handle.adapterId }),
  });
  assert.equal(store.get(original).id, copy, 'the passive read locator remains available');
  const reply = await f.open({ chatId: original });
  assert.equal(reply.ok, true, reply.reason); assert.equal(reply.sessionId, original);
  assert.equal(reply.adapterId, 'account-sync'); assert.equal(localReads, 0); assert.equal(accountReads, 1);
  current = null;
  assert.equal((await f.open({ chatId: original })).ok, false);
  for (const id of [copy, 'explicit-native-alias']) {
    const local = await f.open({ chatId: id });
    assert.equal(local.ok, true, local.reason); assert.equal(local.sessionId, copy); assert.equal(local.localReplica, true);
  }
  assert.equal(accountReads, 1); assert.equal(f.calls.length, 0);
});

test('owned local history remains readable offline without starting a runtime or changing cloud access', async () => {
  for (const unavailable of [async () => null, async () => { throw Error('Hub offline'); }]) {
    const local = { id: 'offline-native', adapterId: 'codex-harness',
      workOwner: require('../main/platform-connections/runtime.cjs').scope(automationIdentity()) };
    const projection = { sessionId: local.id, localReplica: true, readOnly: true };
    const f = fixture({ identityOf: unavailable, sharedHistory: {
      resolve: async id => id === local.id ? local : null, open: async () => projection,
    }, openReply: handle => ({ ok: true, readOnly: handle.readOnly }) });
    assert.equal((await f.open({ chatId: local.id })).readOnly, true);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.open({ chatId: 'cloud-execution:private' })).ok, false);
  }
});

test('requirement execution IPC opens and reattaches the remote view without starting a native runtime', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-task-execution-ipc-'));
  const app = { getPath: () => root }, actor = automationIdentity();
  let allowed = true, reads = 0, view;
  const context = { location: { mode: 'remote' }, runner: { runnerId: 'isolated-cloud' } };
  const cloud = require('../main/conversation/cloud-handoff').create({ app, identityOf: async () => actor,
    interval: 60000, request: async (_, route) => {
      if (route === '/tasks/req') {
        reads++;
        if (!allowed) throw Error('access revoked');
        return { id: 'req', kind: 'requirement', status: 'done', workRouting: { executionContext: context } };
      }
      if (route.includes('/ai-session?')) return { ok: true, taskId: 'req', ref: 'cloud-run',
        runnerId: 'isolated-cloud', executionContext: context, canSend: true, status: 'done', last: 0, items: [] };
      if (route.endsWith('/attachments')) return [];
      assert.fail(route);
    } });
  t.after(async () => { await view?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const first = fixture({ app, cloudHandoff: cloud, attachView: remote => (view = remote) });
  const input = { chatId: 'task-execution:req', taskRef: 'req', taskSession: true };
  assert.equal((await first.open(input)).ok, true);
  assert.equal(first.calls.length, 0);
  assert.equal(view.passiveCloudView, true);
  const again = fixture({ app, cloudHandoff: cloud, live: view });
  assert.equal((await again.open(input)).ok, true);
  assert.equal(reads, 2, 'live reuse must revalidate authoritative task access');
  assert.equal(again.calls.length, 0);
  allowed = false;
  assert.equal((await again.open(input)).ok, false);
  assert.equal(again.calls.length, 0);
  const missing = fixture({ app, cloudHandoff: cloud });
  assert.equal((await missing.open(input)).ok, false);
  assert.equal(missing.calls.length, 0, 'failed remote opens must never manufacture local conversations');
});

test('an account switch while the initial identity is resolving rejects before runtime work', async () => {
  const owner = automationIdentity(); let current = owner, releaseIdentity, identityStarted = false;
  const delayed = new Promise(resolve => { releaseIdentity = resolve; });
  const f = fixture({ cachedIdentity: () => current, identityOf: async () => {
    identityStarted = true; await delayed; return current;
  } });
  const opening = f.open({});
  while (!identityStarted) await new Promise(resolve => setImmediate(resolve));
  current = automationIdentity('other-account');
  releaseIdentity();
  const result = await opening;
  assert.equal(result.ok, false);
  assert.match(result.reason, /账号已切换/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.rendererGrants(), 0);
  assert.equal(f.viewAttachments(), 0);
});

test('direct expected identity rejects a different uid on the same Hub and client but tolerates token refresh', async () => {
  const expected = automationIdentity('expected-account');
  const other = automationIdentity('other-account');
  const blocked = fixture({ cachedIdentity: () => other, identityOf: async () => other });
  const rejected = await blocked.openExpected({}, expected);
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /连接环境已切换/);
  assert.equal(blocked.calls.length, 0, 'the mismatched account must be rejected before runtime creation');

  const refreshed = { ...expected, session: expected.session.split('.')[0] + '.' + 'b'.repeat(64) };
  const allowed = fixture({ cachedIdentity: () => refreshed, identityOf: async () => refreshed });
  const opened = await allowed.openExpected({}, expected);
  assert.equal(opened.ok, true, opened.reason);
  assert.equal(allowed.calls.length, 1, 'a token refresh for the same account and connection stays valid');
});

test('direct expected identity rejects a same-account connection switch during preparation', async () => {
  const owner = automationIdentity(); let current = owner;
  const f = fixture({ identityOf: async () => current, resolve: async () => {
    current = { ...owner, hub: 'http://other-fixture.invalid' };
    return { catalog: {}, selectedSkills: [], capabilityIds: [] };
  } });
  const result = await f.openExpected({}, owner);
  assert.equal(result.ok, false);
  assert.match(result.reason, /连接环境已切换/);
  assert.equal(f.calls.length, 0, 'an expected connection remains fixed through preparation');
  assert.equal(f.rendererGrants(), 0);
});

test('direct expected identity closes a runtime if the same account changes connection during finalization', async () => {
  const owner = automationIdentity(); let current = owner, closes = 0;
  const handle = { ref: 'expected-ref', sessionId: 'expected-session', cwd: os.tmpdir(),
    close: async () => { closes++; return true; } };
  const f = fixture({ identityOf: async () => current, openResult: { ok: true, session: handle },
    memoryAttach: async () => { current = { ...owner, hub: 'http://other-fixture.invalid' }; } });
  const result = await f.openExpected({}, owner);
  assert.equal(result.ok, false);
  assert.match(result.reason, /连接环境已切换/);
  assert.equal(closes, 1);
  assert.equal(f.rendererGrants(), 0);
  assert.equal(f.viewAttachments(), 0);
});

test('cloud finalization failure detaches and closes the registered passive view', async () => {
  let closes = 0;
  const remote = { ref: 'cloud-ref', sessionId: 'cloud-session', close: async () => { closes++; return true; } };
  const f = fixture({
    cloudHandoff: { reopen: async () => remote, observe() {} },
    attachView: value => value,
    wire: () => { throw Error('cloud wire failed'); },
  });
  const result = await f.open({ chatId: remote.sessionId });
  assert.equal(result.ok, false);
  assert.match(result.reason, /cloud wire failed/);
  assert.equal(f.viewAttachments(), 1);
  assert.equal(f.viewDetachments(), 1);
  assert.equal(closes, 1);
});

test('opened runtime finalization failure detaches and closes an already attached handle', async () => {
  let closes = 0;
  const handle = { ref: 'opened-ref', sessionId: 'opened-session', cwd: os.tmpdir(),
    close: async () => { closes++; return true; } };
  const f = fixture({ openResult: { ok: true, session: handle },
    openReply: () => { throw Error('reply failed'); } });
  const result = await f.open({});
  assert.equal(result.ok, false);
  assert.match(result.reason, /reply failed/);
  assert.equal(f.viewAttachments(), 1);
  assert.equal(f.viewDetachments(), 1);
  assert.equal(closes, 1);
});

test('a live finalization failure discards renderer ownership without closing the existing runtime', async () => {
  let closes = 0;
  const live = { ref: 'live-ref', sessionId: 'live-session', cwd: os.tmpdir(),
    close: async () => { closes++; return true; } };
  const f = fixture({ live, openReply: () => { throw Error('live reply failed'); } });
  const result = await f.open({ chatId: live.sessionId });
  assert.equal(result.ok, false);
  assert.match(result.reason, /live reply failed/);
  assert.equal(f.viewAttachments(), 1);
  assert.equal(f.viewDetachments(), 1);
  assert.equal(closes, 0, 'failed reattachment cannot destroy a pre-existing runtime');
  assert.equal(f.ownerActions.some(action => action[0] === 'quarantine'), false);
});

test('opening a synchronized local alias reattaches the native runtime without a partial account projection', async () => {
  const identity = automationIdentity();
  let projections = 0;
  const live = { ref: 'native-ref', sessionId: 'native-session', cwd: os.tmpdir(),
    historyRow: () => ({ id: 'native-session', workOwner: require('../main/platform-connections/runtime.cjs').scope(identity) }) };
  const f = fixture({ live, identityOf: async () => identity, accountSync: {
    isAccountConversation: id => id === 'account-copy',
    row: async () => ({ id: 'account-copy', sourceClientId: identity.clientId, sourceSessionId: live.sessionId }),
    openProjection: async () => { projections++; return null; },
  } });
  const result = await f.open({ chatId: 'account-copy' });
  assert.equal(result.ok, true, result.reason);
  assert.equal(f.calls.length, 0, 'no second runtime is started');
  assert.equal(f.viewAttachments(), 1);
  assert.equal(projections, 0, 'the complete native transcript remains authoritative');
});

test('an alias restored before the history cache is ready still opens the native conversation', async () => {
  const identity = automationIdentity();
  const live = { ref: 'native-ref', sessionId: 'native-session', cwd: os.tmpdir(),
    historyRow: () => ({ id: 'native-session', workOwner: require('../main/platform-connections/runtime.cjs').scope(identity) }) };
  const f = fixture({ live, identityOf: async () => identity, accountSync: {
    isAccountConversation: () => false,
    openProjection: async () => ({ historyRow: () => ({ id: 'account-copy',
      sourceClientId: identity.clientId, sourceSessionId: live.sessionId }) }),
  }, attachView: () => { throw Error('A local source must not become a passive account view'); } });
  const result = await f.open({ chatId: 'account-copy' });
  assert.equal(result.ok, true, result.reason);
  assert.equal(f.calls.length, 0);
  assert.equal(f.viewAttachments(), 1);
});

test('a stale account projection never falls through to the Agent registry', async () => {
  const identity = automationIdentity();
  const f = fixture({ identityOf: async () => identity, archive: {
    id: 'stale-account-row', adapterId: 'account-sync', accountConversation: true,
    accountProjection: true, owner: require('../main/platform-connections/runtime.cjs').connectionScope(identity),
    sourceClientId: identity.clientId, sourceSessionId: 'native-source',
  }, accountSync: {
    isAccountConversation: () => false,
    openProjection: async () => null,
  } });
  const result = await f.open({ chatId: 'stale-account-row' });
  assert.equal(result.ok, false);
  assert.equal(result.notFound, true);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
  assert.equal(f.calls.length, 0);
});

test('verified native archive ignores stale account flags on the sidebar row', async () => {
  const identity = automationIdentity();
  const local = {id: 'native-source', adapterId: 'pi', path: 'verified-archive',
    workOwner: require('../main/platform-connections/runtime.cjs').scope(identity)};
  const f = fixture({archive: local, sharedHistory: {resolve: async () => local},
    accountSync: {openProjection: async () => assert.fail('native history must not read an account projection') }});
  const reply = await f.open({chatId: local.id, adapterId: 'account-sync', accountConversation: true, accountProjection: true});
  assert.equal(reply.ok, true, reply.reason);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].adapterId, 'pi');
});

test('an unconfirmed close leaves the failed open quarantined', async () => {
  let closes = 0;
  const handle = { ref: 'unclosed-ref', sessionId: 'unclosed-session', cwd: os.tmpdir(),
    close: async () => { closes++; return false; } };
  const f = fixture({ openResult: { ok: true, session: handle },
    openReply: () => { throw Error('reply failed'); } });
  const result = await f.open({});
  assert.equal(result.ok, false);
  assert.equal(closes, 1);
  assert.deepEqual(f.ownerActions.map(action => [action[0], action[2]]),
    [['quarantine', undefined], ['closed', false]]);
});

test('consent finalization and immediate rollback share one failed-open close', async () => {
  let closes = 0, tracked, finish;
  const handle = { ref: 'consent-ref', sessionId: 'consent-session', cwd: os.tmpdir(),
    close: async () => { closes++; return true; } };
  const consent = { assertValid() {}, track(promise) { tracked = promise; }, commit() {},
    finish() { finish = tracked.then(result => result.session.close()); } };
  const f = fixture({ openResult: { ok: true, session: handle },
    newChatAccess: { reserve: () => consent },
    openReply: () => { throw Error('consent reply failed'); } });
  const result = await f.open({ accessMode: 'full', accessDraftId: 'draft', accessConsentId: 'consent' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /consent reply failed/);
  await finish;
  assert.equal(closes, 1, 'the reservation must await the same cleanup as immediate rollback');
  assert.equal(f.viewDetachments(), 1);
  assert.deepEqual(f.ownerActions.map(action => [action[0], action[2]]),
    [['quarantine', undefined], ['closed', true]]);
});

test('memory finalization failure closes an opened handle before renderer attachment', async () => {
  let closes = 0;
  const handle = { ref: 'memory-ref', sessionId: 'memory-session', cwd: os.tmpdir(),
    close: async () => { closes++; return true; } };
  const f = fixture({ openResult: { ok: true, session: handle },
    memoryAttach: async () => { throw Error('memory failed'); } });
  const result = await f.open({});
  assert.equal(result.ok, false);
  assert.match(result.reason, /memory failed/);
  assert.equal(f.viewAttachments(), 0);
  assert.equal(f.viewDetachments(), 1);
  assert.equal(closes, 1);
});

test('an account switch while an archived runtime is opening closes it before any attachment', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-history-open-switch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = automationIdentity(), archive = { id: 'history', path: path.join(root, 'history.jsonl'),
    cwd: root, adapterId: 'pi', workOwner: require('../main/platform-connections/runtime.cjs').scope(owner) };
  fs.writeFileSync(archive.path, JSON.stringify({ type: 'session', id: archive.id }) + '\n');
  let resolveOpen, current = owner, closes = 0;
  const delayed = new Promise(resolve => { resolveOpen = resolve; });
  const handle = { sessionId: archive.id, cwd: root, close: async () => { closes++; } };
  const f = fixture({ app: { getPath: () => root }, archive, identityOf: async () => current,
    openResult: delayed });
  const opening = f.open({ chatId: archive.id });
  while (f.calls.length === 0) await new Promise(resolve => setImmediate(resolve));
  current = automationIdentity('other-account');
  resolveOpen({ ok: true, session: handle });
  const result = await opening;
  assert.equal(result.ok, false);
  assert.match(result.reason, /账号已切换/);
  assert.equal(closes, 1, 'the old-account runtime must be closed before it can be attached');
});

test('an ownerless native archive binds on the first direct open', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-history-legacy-open-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = { id: 'legacy-open', path: path.join(root, 'legacy-open.jsonl'), cwd: root,
    adapterId: 'pi', count: 1 };
  fs.writeFileSync(archive.path, JSON.stringify({ type: 'session', id: archive.id }) + '\n');
  const f = fixture({ app: { getPath: () => root }, archive });
  const result = await f.open({ chatId: archive.id });
  assert.equal(result.ok, true, result.reason);
  assert.equal(f.calls.length, 1);
});

test('an account switch during archived setup closes the runtime before renderer grants or attachment', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-history-setup-switch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = automationIdentity(), archive = { id: 'history-setup',
    path: path.join(root, 'history-setup.jsonl'), cwd: root, adapterId: 'pi',
    workOwner: require('../main/platform-connections/runtime.cjs').scope(owner) };
  fs.writeFileSync(archive.path, JSON.stringify({ type: 'session', id: archive.id }) + '\n');
  let releaseMemory, memoryStarted = false, current = owner, closes = 0;
  const memory = new Promise(resolve => { releaseMemory = resolve; });
  const handle = { sessionId: archive.id, cwd: root, close: async () => { closes++; } };
  const f = fixture({ app: { getPath: () => root }, archive, identityOf: async () => current,
    openResult: { ok: true, session: handle },
    memoryAttach: async () => { memoryStarted = true; await memory; } });
  const opening = f.open({ chatId: archive.id });
  while (!memoryStarted) await new Promise(resolve => setImmediate(resolve));
  current = automationIdentity('other-account');
  releaseMemory();
  const result = await opening;
  assert.equal(result.ok, false);
  assert.match(result.reason, /账号已切换/);
  assert.equal(closes, 1);
  assert.equal(f.rendererGrants(), 0, 'the old-account archive must not grant its renderer application');
  assert.equal(f.viewAttachments(), 0, 'the old-account archive must not reach renderer attachment');
});

test('an account switch during new-session setup closes the runtime before renderer attachment', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-new-setup-switch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = automationIdentity(); let current = owner, releaseMemory, memoryStarted = false, closes = 0;
  const memory = new Promise(resolve => { releaseMemory = resolve; });
  const handle = { sessionId: 'new-session', cwd: root, close: async () => { closes++; } };
  const f = fixture({ app: { getPath: () => root }, identityOf: async () => current,
    openResult: { ok: true, session: handle },
    memoryAttach: async () => { memoryStarted = true; await memory; } });
  const opening = f.open({});
  while (!memoryStarted) await new Promise(resolve => setImmediate(resolve));
  current = automationIdentity('other-account');
  releaseMemory();
  const result = await opening;
  assert.equal(result.ok, false);
  assert.match(result.reason, /账号已切换/);
  assert.equal(closes, 1);
  assert.equal(f.rendererGrants(), 0, 'the old-account runtime must not grant its renderer application');
  assert.equal(f.viewAttachments(), 0);
});

test('an account switch while a live runtime is reattaching never binds it to the new renderer', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-live-reattach-switch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = automationIdentity(), live = { sessionId: 'live-history', cwd: root };
  let releaseAttach, attachStarted = false, current = owner;
  const attach = new Promise(resolve => { releaseAttach = resolve; });
  const f = fixture({ app: { getPath: () => root }, live, identityOf: async () => current,
    acceptance: { attach: async () => { attachStarted = true; await attach; }, assertTask() {} } });
  const opening = f.open({ chatId: live.sessionId });
  while (!attachStarted) await new Promise(resolve => setImmediate(resolve));
  current = automationIdentity('other-account');
  releaseAttach();
  const result = await opening;
  assert.equal(result.ok, false);
  assert.match(result.reason, /账号已切换/);
  assert.equal(f.viewAttachments(), 0, 'the old-account live runtime must remain detached');
});

test('an account switch while a cloud conversation is reopening closes it before attachView', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-cloud-reopen-switch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = automationIdentity(); let current = owner, resolveRemote, closes = 0, attachedViews = 0;
  const delayed = new Promise(resolve => { resolveRemote = resolve; });
  const remote = { close: async () => { closes++; } };
  const f = fixture({ app: { getPath: () => root }, identityOf: async () => current,
    cloudHandoff: { reopen: async () => delayed, observe() {} },
    attachView: value => { attachedViews++; return value; } });
  const opening = f.open({ chatId: 'cloud-history' });
  await new Promise(resolve => setImmediate(resolve));
  current = automationIdentity('other-account');
  resolveRemote(remote);
  const result = await opening;
  assert.equal(result.ok, false);
  assert.match(result.reason, /账号已切换/);
  assert.equal(closes, 1);
  assert.equal(attachedViews, 0, 'the old-account cloud view must not attach');
  assert.equal(f.viewAttachments(), 0);
});

test('a same-account connection switch while cloud reopen is pending closes it before attachView', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-cloud-connection-switch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = automationIdentity(); let current = owner, resolveRemote, closes = 0, attachedViews = 0;
  const delayed = new Promise(resolve => { resolveRemote = resolve; });
  const remote = { close: async () => { closes++; } };
  const f = fixture({ app: { getPath: () => root }, identityOf: async () => current,
    cloudHandoff: { reopen: async () => delayed, observe() {} },
    attachView: value => { attachedViews++; return value; } });
  const opening = f.open({ chatId: 'cloud-history' });
  await new Promise(resolve => setImmediate(resolve));
  const now = Math.floor(Date.now() / 1000), clientId = 'other-device';
  const claims = Buffer.from(JSON.stringify({ typ: 'device', uid: 'owner', cid: clientId,
    iat: now - 60, exp: now + 3600 })).toString('base64url');
  current = { hub: owner.hub, clientId, session: claims + '.' + 'b'.repeat(64) };
  resolveRemote(remote);
  const result = await opening;
  assert.equal(result.ok, false);
  assert.match(result.reason, /账号或服务已切换/);
  assert.equal(closes, 1);
  assert.equal(attachedViews, 0, 'an old-connection cloud view must not attach');
  assert.equal(f.viewAttachments(), 0);
});

test('a live chat moved from the main window into its application resolves the current native app connection', async () => {
  const preview = require('../main/work-preview'), grants = require('../main/pi-session/plugin-grant');
  const guard = require('../main/pi-session/app-mcp-grant.cjs');
  const stored = require('../main/app-conversation-connection.cjs'), originalStoredContext = stored.context,
    originalAssociation = stored.association;
  const originalContext = preview.appContextFor, originalResolve = grants.resolve;
  const appSender = { mainFrame: {}, isDestroyed: () => false,
    getURL: () => require('node:url').pathToFileURL(path.join(__dirname, '../desk.html')).href };
  const appEvent = { sender: appSender, senderFrame: appSender.mainFrame };
  const appContext = { pluginId: 'local:operations', pageUrl: 'https://app.example/',
    connection: { credentialKey: 'ukey', scope: 'account-app-origin', revision: 1 } };
  const handle = { sessionId: 'live-app-chat', cwd: os.tmpdir(), close: async () => {} };
  const options = { openResult: { ok: true, session: handle } }, f = fixture(options);
  const resolved = [];
  preview.appContextFor = sender => sender === appSender ? appContext : null;
  stored.context = (_app, id) => id === appContext.pluginId ? appContext : null;
  stored.association = (_app, ids) => ids?.length === 1 && ids[0] === appContext.pluginId ? appContext.pluginId : '';
  grants.resolve = async value => { resolved.push(value.appContext); return { items: [], grant: null }; };
  try {
    assert.equal((await f.open({})).ok, true);
    options.live = handle;
    const resolvePlugins = f.calls[0].resolvePlugins;
    await resolvePlugins([appContext.pluginId], '');
    assert.equal(resolved.at(-1), null);
    handle.snapshot = () => ({ activePlugins: [appContext.pluginId] });
    const reattached = await f.open({ chatId: handle.sessionId }, appEvent);
    assert.equal(reattached.ok, true, reattached.reason);
    assert.equal(handle.appPluginId, appContext.pluginId, 'reattachment must restore the native app binding');
    const turn = {}; guard.guardSend(handle, turn); await turn.beforeTurn();
    await resolvePlugins([appContext.pluginId], '');
    assert.equal(resolved.at(-1), appContext, 'the original resolver follows the reattached application, not its first window');
    assert.equal(handle.appPluginId, appContext.pluginId);
    assert.equal(f.calls.length, 1, 'reattachment keeps one runtime and its existing conversation');
    assert.equal((await f.open({ chatId: handle.sessionId })).ok, true);
    const mainTurn = {}; guard.guardSend(handle, mainTurn); await mainTurn.beforeTurn();
    await resolvePlugins([appContext.pluginId], '');
    assert.equal(resolved.at(-1), appContext, 'the same application conversation keeps its authorized connection in the main window');
    assert.equal(handle.appPluginId, appContext.pluginId);
  } finally { preview.appContextFor = originalContext; grants.resolve = originalResolve; stored.context = originalStoredContext; stored.association = originalAssociation; }
});

test('opening IPC preserves the runtime task binding mismatch without treating it as success', async () => {
  const f = fixture({ openResult: { ok: false, code: 'TASK_BINDING_MISMATCH',
    runtimeError: 'TASK_BINDING_MISMATCH', reason: '这条会话不是该需求的协作会话' } });
  const result = await f.open({ adapterId: 'pi', taskRef: 'new-task' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TASK_BINDING_MISMATCH');
  assert.equal(result.runtimeError, 'TASK_BINDING_MISMATCH');
  assert.equal(f.calls.length, 1);
});
test('manual worker choices compile real standard, readonly and confirmed full policies without a renderer', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-manual-open-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, identity = automationIdentity(), f = fixture({ app, identityOf: async () => identity });
  for (const mode of ['standard', 'readonly', 'full']) {
    fs.writeFileSync(path.join(root, 'access-preferences.json'), JSON.stringify({ schema: 1, mode, revision: 1, fullConsentVersion: 1 }));
    const options = { adapterId: 'pi' };
    const choice = f.captureAutomationAccess(options, identity, 'run-' + mode, 'manual');
    const opened = await f.openAutomation(options, identity, choice, 'run-' + mode);
    assert.equal(opened.ok, true, opened.reason);
    assert.equal(f.calls.at(-1).accessPolicy.mode, mode);
    assert.equal(f.calls.at(-1).readOnly, mode === 'readonly');
  }
  assert.equal(f.dialogs.length, 0, 'existing confirmed default is the native consent source');
});
test('unconfirmed full, timer, legacy and renderer-supplied automation choices do not gain full access', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-automation-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, identity = automationIdentity(), f = fixture({ app, identityOf: async () => identity });
  fs.writeFileSync(path.join(root, 'access-preferences.json'), JSON.stringify({ schema: 1, mode: 'full', revision: 1 }));
  assert.equal(f.captureAutomationAccess({}, identity, 'unconfirmed', 'manual').mode, 'standard');
  fs.writeFileSync(path.join(root, 'access-preferences.json'), JSON.stringify({ schema: 1, mode: 'full', revision: 2, fullConsentVersion: 1 }));
  for (const trigger of ['timer', 'retry', undefined, '']) assert.equal(f.captureAutomationAccess({}, identity, 'scheduled', trigger), null);
  assert.equal((await f.open({}, null)).ok, true);
  assert.equal(f.calls.at(-1).accessPolicy, null);
  const choice = f.captureAutomationAccess({}, identity, 'manual', 'manual');
  assert.equal((await f.open({ accessMode: 'full', automationContext: choice }, null)).ok, false);
  assert.equal(f.dialogs.length, 0);
});
test('a frozen manual choice survives later default changes and rejects wrong run, adapter, revision or account', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-automation-frozen-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, identity = automationIdentity(); let current = identity;
  const f = fixture({ app, identityOf: async () => current });
  fs.writeFileSync(path.join(root, 'access-preferences.json'), JSON.stringify({ schema: 1, mode: 'full', revision: 1, fullConsentVersion: 1 }));
  const choice = f.captureAutomationAccess({ adapterId: 'pi' }, identity, 'manual', 'manual');
  fs.writeFileSync(path.join(root, 'access-preferences.json'), JSON.stringify({ schema: 1, mode: 'readonly', revision: 2 }));
  assert.equal((await f.openAutomation({ adapterId: 'pi' }, identity, JSON.parse(JSON.stringify(choice)), 'manual')).ok, true);
  assert.equal(f.calls.at(-1).accessPolicy.mode, 'full');
  for (const [options, modified, run] of [[{ adapterId: 'pi' }, choice, 'wrong'], [{ adapterId: 'qwen' }, choice, 'manual'],
    [{ adapterId: 'pi' }, { ...choice, revision: -1 }, 'manual'], [{ adapterId: 'pi' }, { ...choice, mode: 'forged' }, 'manual']]) {
    assert.equal((await f.openAutomation(options, identity, modified, run)).ok, false);
  }
  current = automationIdentity('other-account');
  assert.equal((await f.openAutomation({ adapterId: 'pi' }, identity, choice, 'manual')).ok, false);
  assert.equal(f.calls.length, 1);
});
test('account changes during preparation reject the manual choice before creating a runtime', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-automation-switch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, identity = automationIdentity(); let current = identity;
  fs.writeFileSync(path.join(root, 'access-preferences.json'), JSON.stringify({ schema: 1, mode: 'full', revision: 1, fullConsentVersion: 1 }));
  const f = fixture({ app, identityOf: async () => current, resolve: async () => {
    current = automationIdentity('other-account'); return { catalog: {}, selectedSkills: [], capabilityIds: [] };
  } });
  const choice = f.captureAutomationAccess({}, identity, 'manual', 'manual');
  assert.equal((await f.openAutomation({}, identity, choice, 'manual')).ok, false);
  assert.equal(f.calls.length, 0);
});

test('saved defaults reach real opening policy; explicit choices win and untrusted sources cannot inherit full', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-open-default-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, destination = path.join(root, 'access-preferences.json');
  const f = fixture({ app });
  fs.writeFileSync(destination, JSON.stringify({ schema: 1, mode: 'readonly', revision: 1 }));
  for (const adapterId of ['pi', 'opencode', 'qwen', 'codex-harness']) {
    assert.equal((await f.open({ adapterId })).ok, true);
    assert.equal(f.calls.at(-1).accessPolicy.mode, 'readonly');
    assert.equal(typeof f.calls.at(-1).resolveSkills, 'function');
    assert.equal(typeof f.calls.at(-1).resolveConnectors, 'function');
  }
  assert.equal((await f.open({ accessMode: 'standard' })).ok, true);
  assert.equal(f.calls.at(-1).accessPolicy.mode, 'standard');
  fs.writeFileSync(destination, JSON.stringify({ schema: 1, mode: 'full', revision: 2, fullConsentVersion: 1 }));
  assert.equal((await f.open({})).ok, true);
  assert.equal(f.calls.at(-1).accessPolicy.mode, 'full');
  assert.equal(f.dialogs.length, 0);
  const before = f.calls.length;
  assert.equal((await f.open({}, { ...f.event, senderFrame: {} })).ok, false);
  for (const url of ['https://example.invalid/desk.html', 'file:///other/desk.html']) {
    f.event.sender.getURL = () => url;
    assert.equal((await f.open({})).ok, false);
    assert.equal((await f.open({ accessMode: 'full' })).ok, false);
  }
  assert.equal(f.calls.length, before);
  assert.equal(f.dialogs.length, 0);
});

test('本机新建需求继承系统权限，显式选择优先且后台派发不能继承完全访问', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-task-default-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const destination = path.join(root, 'access-preferences.json');
  const f = fixture({ app: { getPath: () => root } });
  const task = { taskRef: 'fixture-task', taskSession: true };
  for (const mode of ['readonly', 'standard', 'full']) {
    fs.writeFileSync(destination, JSON.stringify({ schema: 1, mode, revision: 1, fullConsentVersion: 1 }));
    for (const adapterId of ['pi', 'opencode', 'codex-harness', 'qwen']) {
      const result = await f.open({ ...task, adapterId });
      assert.equal(result.ok, true, result.reason);
      assert.equal(f.calls.at(-1).accessPolicy.mode, mode);
      assert.equal(f.calls.at(-1).readOnly, mode === 'readonly');
    }
  }
  assert.equal((await f.open({ ...task, accessMode: 'full' })).ok, true);
  assert.equal(f.dialogs.length, 0, '系统设置已确认完全访问，不重复询问同一授权');
  for (const accessMode of ['standard', 'readonly']) {
    assert.equal((await f.open({ ...task, accessMode })).ok, true);
    assert.equal(f.calls.at(-1).accessPolicy.mode, accessMode);
  }
  assert.equal((await f.open(task, null)).ok, true);
  assert.equal(f.calls.at(-1).accessPolicy.mode, 'standard');
  assert.equal((await f.open({ ...task, accessMode: 'full' }, null)).ok, false);
  assert.equal((await f.open(task, { ...f.event, senderFrame: {} })).ok, false);
  fs.writeFileSync(destination, JSON.stringify({ schema: 1, mode: 'full', revision: 2 }));
  assert.equal((await f.open(task)).ok, true);
  assert.equal(f.calls.at(-1).accessPolicy.mode, 'standard', '历史未确认的 full 不能提升权限');
});

test('a fresh interactive desktop chat inherits full access while headless calls cannot inherit it', async () => {
  const fresh = fixture();
  assert.equal((await fresh.open({ adapterId: 'pi' })).ok, true);
  assert.equal(fresh.calls[0].accessPolicy.mode, 'full'); assert.equal(fresh.dialogs.length, 0);
  const headless = fixture();
  assert.equal((await headless.open({ adapterId: 'pi' }, null)).ok, true);
  assert.equal(headless.calls[0].accessPolicy, null, 'headless legacy calls do not inherit device preferences');
});
test('a composer task full choice uses task-scoped native confirmation and cancellation never falls back to standard', async t => {
  const options = { taskRef: 'fixture-task', taskSession: true, adapterId: 'pi', accessMode: 'full' };
  const allowed = standardPreferenceFixture(t, { response: 1 });
  assert.equal((await allowed.open(options)).ok, true);
  assert.equal(allowed.calls[0].accessPolicy.mode, 'full');
  assert.equal(allowed.dialogs.length, 1);
  const cancelled = standardPreferenceFixture(t);
  assert.equal((await cancelled.open(options)).cancelled, true);
  assert.equal(cancelled.calls.length, 0);
  assert.equal(cancelled.dialogs.length, 1);
});

test('full access requires native consent before opening with a saved standard default; cancel and noninteractive callers cannot enable it', async t => {
  const cancelled = standardPreferenceFixture(t);
  assert.equal((await cancelled.open({ accessMode: 'full' })).cancelled, true);
  assert.equal(cancelled.calls.length, 0);
  assert.equal(cancelled.dialogs[0].fixture, true);
  const headless = standardPreferenceFixture(t, { response: 1 });
  assert.equal((await headless.open({ accessMode: 'full' }, null)).ok, false);
  assert.equal(headless.calls.length, 0);
  assert.equal(headless.dialogs.length, 0);
  const allowed = standardPreferenceFixture(t, { response: 1 });
  assert.equal((await allowed.open({ accessMode: 'full' })).ok, true);
  assert.equal(allowed.calls[0].accessPolicy.mode, 'full');
  assert.equal(allowed.calls[0].accessPolicy.schema, 'soduwork.access-policy/v1');
});

test('main process compiles policy and ignores renderer-supplied full access on standard or unsupported calls', async t => {
  const forged = { schema: 'soduwork.access-policy/v1', mode: 'full', revision: 100, workspaceRoot: os.tmpdir() };
  const standard = fixture();
  const raw = { accessMode: 'standard', accessPolicy: forged };
  assert.equal((await standard.open(raw)).ok, true);
  assert.equal(standard.calls[0].accessPolicy.mode, 'standard');
  assert.equal(standard.calls[0].accessPolicy.revision, 1);
  assert.equal(raw.accessPolicy, forged);
  const legacy = fixture();
  assert.equal((await legacy.open({ adapterId: 'unknown-runtime', mode: 'full', accessPolicy: forged })).ok, true);
  assert.equal(legacy.calls[0].accessPolicy, null);
  assert.equal(legacy.calls[0].readOnly, false);
  const newChat = standardPreferenceFixture(t);
  assert.equal((await newChat.open({ mode: 'full', accessPolicy: forged })).ok, true);
  assert.equal(newChat.calls[0].accessPolicy.mode, 'standard');
});

test('async capability failure during full-access consent does not open a session', async () => {
  const failed = fixture({ response: 1, delay: 30, resolve: async () => { throw Error('capability unavailable'); } });
  const reply = await failed.open({ accessMode: 'full' });
  assert.equal(reply.ok, false);
  assert.match(reply.reason, /capability unavailable/);
  assert.equal(failed.calls.length, 0);
});

test('navigating away while a chat is preparing cannot start a session from the old page', async () => {
  const f = fixture({ resolve: async () => {
    f.event.sender.getURL = () => 'https://example.invalid/';
    return { catalog: {}, selectedSkills: [], capabilityIds: [] };
  } });
  assert.equal((await f.open({ accessMode: 'standard' })).ok, false);
  assert.equal(f.calls.length, 0);
});

test('仅表单会话首次运行继承系统权限及显式选择，真实历史保持原权限', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-work-open-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, owner = automationIdentity(), file = path.join(root, 'work.jsonl');
  const archive = { id: 'work', path: file, cwd: root, adapterId: 'pi', workOnly: true,
    workOwner: require('../main/platform-connections/runtime.cjs').scope(owner) };
  fs.writeFileSync(file, JSON.stringify({ type: 'session', id: 'work' }) + '\n');
  const f = fixture({ app, identityOf: async () => owner, archive });
  for (const mode of ['standard', 'readonly', 'full']) {
    fs.writeFileSync(path.join(root, 'access-preferences.json'), JSON.stringify({ schema: 1, mode, revision: 1, fullConsentVersion: 1 }));
    const result = await f.open({ chatId: 'work', modelName: 'selected-model' });
    assert.equal(result.ok, true, result.reason);
    assert.equal(f.calls.at(-1).accessPolicy?.mode, mode);
    assert.equal(f.calls.at(-1).modelName, 'selected-model');
  }
  assert.equal(f.dialogs.length, 0);
  assert.equal((await f.open({ chatId: 'work', accessMode: 'readonly' })).ok, true);
  assert.equal(f.calls.at(-1).accessPolicy.mode, 'readonly');
  archive.workOnly = false;
  assert.equal((await f.open({ chatId: 'work', accessMode: 'full' })).ok, true);
  assert.equal(f.calls.at(-1).accessPolicy, null, '普通存档由底座恢复原权限，不用系统默认覆盖');
});

test('仅表单会话可以主动选非 Pi 底座与模型，首次打开准备复用同一会话身份', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-work-adapter-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, owner = automationIdentity(), file = path.join(root, 'work.jsonl');
  const archive = { id: 'work', path: file, cwd: root, adapterId: 'pi', workOnly: true,
    workOwner: require('../main/platform-connections/runtime.cjs').scope(owner) };
  fs.writeFileSync(file, JSON.stringify({ type: 'session', id: 'work' }) + '\n');
  const f = fixture({ app, identityOf: async () => owner, archive });
  const result = await f.open({ chatId: 'work', adapterId: 'opencode', modelName: 'explicit', accessMode: 'readonly' });
  assert.equal(result.ok, true, result.reason);
  assert.equal(f.calls[0].adapterId, 'opencode');
  assert.equal(f.calls[0].modelName, 'explicit');
  assert.equal(f.calls[0].workConversation?.id, 'work');
  assert.equal(f.calls[0].resumePath, '', '不能把 Pi JSONL 交给其他底座恢复');
  assert.equal(f.calls[0].accessPolicy.mode, 'readonly');
});

test('生产 IPC 只给通过回执和 Hub 校验的 Pi 首次草稿传递首次绑定选项', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-task-first-open-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, owner = automationIdentity(), file = path.join(root, 'work.jsonl');
  const archive = { id: 'work', path: file, cwd: root, adapterId: 'pi', workOnly: true,
    workOwner: require('../main/platform-connections/runtime.cjs').scope(owner) };
  fs.writeFileSync(file, JSON.stringify({ type: 'session', id: 'work' }) + '\n');
  const cardsFile = require('../main/conversation/work-conversation-cards').location(app, 'work');
  fs.mkdirSync(path.dirname(cardsFile), { recursive: true });
  fs.writeFileSync(cardsFile, JSON.stringify({ version: 1, sessionId: 'work', owner: archive.workOwner,
    cards: [{ actionId: 'work.requirement.create', state: { phase: 'succeeded', receipt: { id: 'created-task' } } }] }));
  const routes = [];
  const f = fixture({ app, archive, identityOf: async () => owner, validateWork: true,
    request: async route => { routes.push(route); return { id: 'created-task', status: 'todo', ownerClientId: owner.clientId }; } });
  const options = { chatId: 'work', taskRef: 'created-task', taskTitle: '新需求', taskSession: true,
    requireTaskBinding: true, modelName: 'chosen-model', workConversationId: 'renderer-cannot-select-lock' };
  assert.equal((await f.open(options)).ok, true);
  assert.equal(f.calls[0].requireTaskBinding, false);
  assert.equal(f.calls[0].workConversationId, 'work');
  assert.equal(f.calls[0].workConversation, null);
  assert.equal(f.calls[0].taskRef, 'created-task');
  assert.equal(f.calls[0].resumePath, file, '继续同一草稿，不另开会话');
  assert.equal(f.calls[0].modelName, 'chosen-model');
  assert.deepEqual(routes, ['/tasks/created-task']);
  const wrong = await f.open({ ...options, taskRef: 'another-task' });
  assert.equal(wrong.ok, false); assert.match(wrong.reason, /没有该需求的创建回执/);
  assert.equal(f.calls.length, 1, 'a refusal must not reach the native open boundary');
  fs.appendFileSync(file, JSON.stringify({ type: 'custom', customType: 'soduwork.access.policy', data: {} }) + '\n');
  assert.equal((await f.open(options)).ok, true);
  assert.equal(f.calls.at(-1).requireTaskBinding, true, 'initialized archives retain the original runtime authorization check');
  assert.equal(f.calls.at(-1).workConversationId, undefined);
  archive.workOnly = false;
  assert.equal((await f.open(options)).ok, true);
  assert.equal(f.calls.at(-1).requireTaskBinding, true, 'ordinary archives must retain their original binding');
  archive.workOnly = true; archive.workOwner = 'unrelated-owner';
  const before = f.calls.length;
  assert.equal((await f.open(options)).ok, false);
  assert.equal(f.calls.length, before, '其他账号的草稿仍拒绝启动');
});
