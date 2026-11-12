'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(user = 'user-a', options = {}) {
  const events = new Map(), pending = [], subscriptions = [], renders = [];
  let hub = 'https://hub.example.invalid', device = 'device-a';
  const window = { URL,
    setTimeout: options.setTimeout, clearTimeout: options.clearTimeout,
    addEventListener(name, fn) { (events.get(name) || events.set(name, []).get(name)).push(fn); },
    SoduWorkAPI: { hubBase: () => hub, clientAuthSnapshot: () => ({ user: user ? { id: user } : null, clientId: device }),
      taskStorageKey: () => ['cache', hub, device, user || 'unbound'].join('@') },
    soduWorkAPI: { conversationSession: {
      localHistorySupported: options.local === true,
      history: options.history || (() => new Promise((resolve, reject) => pending.push({ user, resolve, reject }))),
      onEvent() {},
      onEventBatch(fn) { const sub = { fn, closed: false }; subscriptions.push(sub); return () => { sub.closed = true; }; },
    } },
  };
  const sandbox = vm.createContext({ window, URL });
  for (const name of ['workspace-chat-history', 'workspace-sidebar-state', 'workspace-chat-list']) {
    let source = fs.readFileSync(path.join(__dirname, '../components/workspace', name + '.js'), 'utf8');
    if (options.realHistory && name === 'workspace-chat-list') {
      const start = source.indexOf('function renderChats() {'), end = source.indexOf('function subscribeConversationPresence()', start);
      assert.ok(start > 0 && end > start);
      // Keep the actual reconciliation and pagination path; only omit DOM painting.
      source = source.slice(0, start) + 'function renderChats() {}\n' + source.slice(end);
    }
    vm.runInContext(source, sandbox);
  }
  const ctx = { ...window.WorkspaceChatHistory, root: {}, historyLoad: null, chatItems: [], chatNames: new Map(), incomingOpened: new Map(),
    activeChatId: '', chatsLoading: false, sessionOff: null, openChatMenu: null,
    renderChats() { renders.push(ctx.chatItems.map(row => row.id)); },
    setChats(rows) { ctx.chatItems = rows; ctx.chatsLoading = false; },
    updateChatState(event) { ctx.chatItems.push(event.presence); } };
  const api = window.WorkspaceChatList.create(ctx);
  if (options.realHistory) { ctx.setChats = api.setChats; ctx.upsertChat = api.upsertChat; ctx.updateChatState = api.updateChatState; }
  return { ctx, api, pending, subscriptions, renders, history: window.WorkspaceChatHistory, window,
    unload() { for (const fn of events.get('beforeunload') || []) fn(); },
    async switch(nextUser, name = 'soduwork-data-scope-changed', nextHub = hub, nextDevice = device) {
      user = nextUser; hub = nextHub; device = nextDevice;
      for (const fn of events.get(name) || []) fn(); await tick();
    },
  };
}
const row = (id = 'private-a') => ({ id, title: 'Private A', usedHarnesses: ['pi', 'qwen'] });

test('a reloaded signed-out shell loads persisted native history under the first authenticated main-process actor', async t => {
  const os = require('node:os');
  const auth = require('../main/device-auth');
  const { identity } = require('./helpers/platform-session-fixture.cjs');
  const { scope } = require('../main/platform-connections/runtime.cjs');
  const sessions = require('../main/pi-session/session');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-history-login-'));
  const app = { getPath: () => root }, handlers = new Map();
  const previous = Object.fromEntries(['identity', 'session', 'profiles', 'localOwner'].map(key => [key, auth[key]]));
  let current = null, release, reads = 0;
  const pending = new Promise(resolve => { release = resolve; });
  auth.identity = () => current;
  auth.session = () => current?.session || '';
  auth.profiles = () => [];
  auth.localOwner = () => current ? scope(current) : '';
  t.after(() => { Object.assign(auth, previous); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, 'pi-agent', 'sessions', 'fixture', 'saved.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    { type: 'session', id: 'saved-native', cwd: root, timestamp: '2026-11-10T00:00:00Z' },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Saved native conversation' }] } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
  require('../main/pi-session/environment-ipc').install({ app,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    session: { async history() { reads++; await pending; return sessions.history(app); } } });
  const f = fixture('', { history: () => handlers.get('pi-session-history')() });
  const anonymous = f.api.refreshConversationHistory(); await tick();
  current = identity('two');
  await f.switch('second-account', 'soduwork-device-auth');
  const authenticated = f.ctx.historyLoad;
  release();
  assert.equal(await authenticated, true, 'the first authenticated read cannot reuse an IPC captured before login');
  await anonymous;
  assert.equal(reads, 1, 'a signed-out shell must not start an unusable native history read');
  assert.deepEqual(f.ctx.chatItems.map(item => [item.id, item.title]), [['saved-native', 'Saved native conversation']]);
});

test('account changes clear private rows and reject a late history response without blocking the next account', async () => {
  const f = fixture(); f.ctx.chatItems = [row()]; f.ctx.activeChatId = 'private-a'; f.ctx.chatNames.set('private-a', { title: 'A override' });
  const old = f.api.refreshConversationHistory(); await tick();
  await f.switch('user-b');
  assert.equal(f.ctx.chatItems.length, 0); assert.equal(f.ctx.chatNames.size, 0); assert.equal(f.ctx.activeChatId, '');
  assert.ok(f.renders.some(rows => rows.length === 0), 'old rows disappear synchronously');
  assert.equal(f.pending.length, 2, 'B history starts without waiting for A');
  const next = f.ctx.historyLoad; f.pending[0].resolve({ ok: true, chats: [row()] }); await old;
  assert.equal(f.ctx.chatItems.length, 0); assert.equal(f.ctx.historyLoad, next, 'old finally cannot clear B in-flight request');
  f.pending[1].resolve({ ok: true, chats: [{ id: 'private-b', title: 'B', usedHarnesses: ['claude'] }] }); await next;
  assert.deepEqual(f.ctx.chatItems.map(item => item.id), ['private-b']);
});

test('A to B to A rejects both previous epochs and restores the current account title', async () => {
  const f = fixture();
  f.api.subscribeConversationPresence();
  const first = f.api.refreshConversationHistory(); await tick();
  const firstPresence = f.subscriptions[0];
  await f.switch('user-b');
  const second = f.ctx.historyLoad, secondPresence = f.subscriptions[1];
  await f.switch('user-a');
  const third = f.ctx.historyLoad;
  assert.equal(f.pending.length, 3, 'returning to A starts a new request while its old request is still pending');
  f.pending[2].resolve({ ok: true, chats: [{ id: 'original-a', title: 'Original first question' }] });
  assert.equal(await third, true);
  f.pending[1].resolve({ ok: true, chats: [{ id: 'private-b', title: 'Private B' }] });
  f.pending[0].resolve({ ok: true, chats: [{ id: 'original-a', title: 'Stale later request' }] });
  await Promise.all([first, second]);
  firstPresence.fn({ presence: { id: 'original-a', title: 'Old A title' } });
  secondPresence.fn({ presence: { id: 'private-b', title: 'Private B' } });
  assert.deepEqual(f.ctx.chatItems.map(item => [item.id, item.title]), [['original-a', 'Original first question']]);
  assert.equal(f.ctx.historyLoad, null);
  assert.equal(firstPresence.closed, true); assert.equal(secondPresence.closed, true);
});

test('startup authentication, token renewal and same-account device replacement preserve current history and selection', async () => {
  const f = fixture(''); f.ctx.chatItems = [row()]; f.ctx.activeChatId = 'private-a';
  f.api.subscribeConversationPresence();
  assert.equal(await f.api.refreshConversationHistory(), false);
  assert.equal(f.pending.length, 0, 'startup waits for an authenticated owner before reading history');
  assert.equal(f.subscriptions.length, 0, 'startup waits for authentication before accepting presence');
  await f.switch('user-a', 'soduwork-device-auth');
  const request = f.ctx.historyLoad;
  await f.switch('user-a', 'soduwork-device-auth');
  await f.switch('user-a', 'soduwork-data-scope-changed', 'https://hub.example.invalid/', 'replacement');
  assert.equal(f.ctx.chatItems[0].id, 'private-a'); assert.equal(f.ctx.activeChatId, 'private-a'); assert.equal(f.pending.length, 1);
  assert.equal(f.subscriptions.length, 1, 'renewal reuses the authenticated subscription');
  f.pending[0].resolve({ ok: true, chats: [row('fresh-a')] }); assert.equal(await request, true);
  assert.equal(f.ctx.chatItems[0].id, 'fresh-a');
});

test('first authentication refreshes history even when the shell had no initial request', async () => {
  const f = fixture('');
  assert.equal(f.pending.length, 0);
  await f.switch('user-a', 'soduwork-device-auth');
  assert.equal(f.pending.length, 1);
  f.pending[0].resolve({ ok: true, chats: [row('fresh-a')] });
  assert.equal(await f.ctx.historyLoad, true);
  assert.deepEqual(f.ctx.chatItems.map(item => item.id), ['fresh-a']);
});

test('logout and a different Hub clear history while queued callbacks from the prior presence subscription stay invalid', async () => {
  const f = fixture(); f.api.subscribeConversationPresence(); const old = f.subscriptions[0];
  f.ctx.chatItems = [row()]; await f.switch('');
  assert.equal(f.ctx.chatItems.length, 0); assert.equal(old.closed, true);
  old.fn({ presence: row() }); assert.equal(f.ctx.chatItems.length, 0);
  await f.switch('user-a', 'soduwork-device-auth');
  f.ctx.chatItems = [row()]; await f.switch('user-a', 'soduwork-data-scope-changed', 'https://other.example.test');
  assert.equal(f.ctx.chatItems.length, 0);
});

test('ordinary requests coalesce and failed history loads release the slot for retry', async () => {
  const f = fixture(); const first = f.api.refreshConversationHistory(), second = f.api.refreshConversationHistory();
  await tick(); assert.equal(f.pending.length, 1); f.pending[0].reject(Error('offline'));
  assert.equal(await first, false); assert.equal(await second, false); assert.equal(f.ctx.historyLoad, null);
  const retry = f.api.refreshConversationHistory(); await tick(); assert.equal(f.pending.length, 2);
  f.pending[1].resolve({ ok: true, chats: [row()] }); assert.equal(await retry, true); assert.equal(f.ctx.chatItems[0].id, 'private-a');
});

test('after logout a shell remount cannot reload or resubscribe to private history before authentication', async () => {
  const f = fixture(); f.api.subscribeConversationPresence(); await f.switch('');
  const requests = f.pending.length, subscriptions = f.subscriptions.length;
  f.api.subscribeConversationPresence(); void f.api.refreshConversationHistory(); await tick();
  assert.equal(f.pending.length, requests, 'logout must block another history IPC');
  assert.equal(f.subscriptions.length, subscriptions, 'logout must block another presence subscription');
  await f.switch('user-b', 'soduwork-device-auth');
  assert.equal(f.pending.length, requests + 1); assert.equal(f.subscriptions.length, subscriptions + 1);
});

function localFixture(user = 'user-a', count = 123) {
  const rows = Array.from({ length: count }, (_, i) => ({ id: 'saved-' + i, title: 'Saved ' + i, at: count - i }));
  const calls = [], remote = [];
  let failLocal = false, revision = 0, responseWorkspace = 'profile-one';
  const f = fixture(user, { local: true, realHistory: true, history(options = {}) {
    calls.push({ ...options });
    if (options.source !== 'local') {
      assert.equal(options.source, 'account', 'Separate local inventory must use the unmerged authenticated account projection');
      return new Promise(resolve => remote.push(resolve));
    }
    if (failLocal) return Promise.reject(Error('Local inventory unavailable'));
    const start = options.after ? rows.findIndex(row => row.id === options.after.id) + 1 : 0;
    const chats = rows.slice(start, start + options.limit), last = chats.at(-1);
    return Promise.resolve({ ok: true, chats,
      next: start + chats.length < rows.length ? { id: last.id, at: last.at } : null,
      localCatalog: { workspace: responseWorkspace, revision,
        ...(options.catalogRevision === revision ? {} : { items: rows.map(row => ({ id: row.id, historyAliasIds: [] })) }) } });
  } });
  return { ...f, rows, calls, remote, fail: value => { failLocal = value; },
    profile: value => { responseWorkspace = value; }, revision: value => { revision = value; } };
}

test('local saved history paints before a hung account request and stays stable across A/B/A', async () => {
  const f = localFixture('user-a', 42);
  const first = f.api.refreshConversationHistory();
  assert.equal(await f.api.refreshLocalHistory(), true); await tick();
  assert.deepEqual(Array.from(f.ctx.chatItems, row => row.id), f.rows.map(row => row.id));
  assert.equal(f.remote.length, 1, 'The account request remains independently pending');
  f.ctx.activeChatId = 'saved-1'; f.ctx.chatNames.set('saved-1', { title: 'Saved title' });
  await f.switch('user-b');
  assert.equal(f.ctx.chatItems.length, 42); assert.equal(f.ctx.activeChatId, 'saved-1');
  assert.equal(f.ctx.chatNames.get('saved-1').title, 'Saved title');
  const second = f.ctx.historyLoad;
  await f.switch('user-a'); const third = f.ctx.historyLoad;
  f.remote[2]({ ok: true, chats: [{ id: 'cloud-a', title: 'Current account cloud-only' }] }); await third;
  f.remote[1]({ ok: true, chats: [{ id: 'cloud-b', title: 'Private B' }] });
  f.remote[0]({ ok: true, chats: [{ id: 'old-cloud-a', title: 'Old A' }] });
  await Promise.all([first, second]);
  assert.deepEqual(Array.from(f.ctx.chatItems.filter(row => row.id.startsWith('saved-')), row => row.id), f.rows.map(row => row.id));
  assert.equal(f.ctx.chatItems.some(row => row.id === 'cloud-b' || row.id === 'old-cloud-a'), false);
  assert.equal(f.calls.filter(call => call.refresh).length, 1, 'Initial native discovery is separate and coalesced');
});

test('signed-out and expired-account clients can load all local pages without a private history read', async () => {
  const f = localFixture('');
  assert.equal(await f.api.refreshConversationHistory(), true); await tick();
  assert.equal(f.remote.length, 0); assert.equal(f.ctx.chatItems.length, 50);
  assert.equal(await f.api.refreshLocalHistory({ append: true }), true);
  assert.equal(f.ctx.chatItems.length, 100);
  assert.equal(await f.api.refreshLocalHistory({ append: true }), true);
  assert.equal(f.ctx.chatItems.length, 123);
  const before = f.calls.length;
  assert.equal(await f.api.refreshLocalHistory({ append: true }), true);
  assert.equal(f.calls.length, before, 'The exhausted cursor does not repeat a page');
  assert.equal(new Set(Array.from(f.ctx.chatItems, row => row.id)).size, 123);
  for (const call of f.calls.filter(call => call.after)) {
    assert.equal(call.workspace, 'profile-one'); assert.equal(call.catalogRevision, 0);
  }
  await f.switch('user-b'); const remote = f.ctx.historyLoad;
  f.remote[0]({ ok: false, reason: 'Account session expired' }); assert.equal(await remote, false);
  assert.equal(f.ctx.chatItems.length, 123, 'An account 401 cannot hide durable local rows');
});

test('older records discovered after exhausting the catalog remain reachable without losing loaded rows', async () => {
  const f = localFixture('');
  await f.api.refreshConversationHistory(); await tick();
  await f.api.refreshLocalHistory({ append: true }); await f.api.refreshLocalHistory({ append: true });
  assert.equal(f.ctx.chatItems.length, 123);
  const originalIds = Array.from(f.ctx.chatItems, row => row.id);
  for (let i = 0; i < 20; i++) f.rows.push({ id: 'imported-' + i, title: 'Older import ' + i, at: -i - 1 });
  f.revision(1);
  assert.equal(await f.api.refreshLocalHistory(), true);
  assert.deepEqual(Array.from(f.ctx.chatItems, row => row.id), originalIds);
  const before = f.calls.length;
  assert.equal(await f.api.refreshLocalHistory({ append: true }), true);
  assert.equal(f.calls.length, before + 1, 'Catalog growth must reopen an exhausted traversal');
  assert.equal(f.calls.at(-1).after.id, 'saved-49');
  await f.api.refreshLocalHistory({ append: true });
  assert.equal(f.ctx.chatItems.length, 143);
  assert.equal(new Set(Array.from(f.ctx.chatItems, row => row.id)).size, 143);
  assert.deepEqual(Array.from(f.ctx.chatItems.slice(0, 123), row => row.id), originalIds);
});

test('catalog growth arriving during append restarts before the old cursor without dropping existing rows', async () => {
  const f = localFixture('');
  await f.api.refreshConversationHistory(); await tick();
  await f.api.refreshLocalHistory({ append: true });
  const imported = Array.from({ length: 20 }, (_, i) => ({ id: 'mid-import-' + i, title: 'Imported ' + i, at: 98.5 - i / 100 }));
  f.rows.splice(25, 0, ...imported); f.revision(1);
  await f.api.refreshLocalHistory({ append: true });
  assert.equal(f.ctx.chatItems.length, 123, 'The old final page remains visible while the changed catalog is reconciled');
  const count = f.calls.length;
  await f.api.refreshLocalHistory({ append: true });
  assert.equal(f.calls.length, count + 1);
  assert.equal(f.calls.at(-1).after, undefined, 'New rows before the old cursor require a fresh first page');
  assert.equal(f.ctx.chatItems.length, 143);
  assert.equal(new Set(Array.from(f.ctx.chatItems, row => row.id)).size, 143);
  for (const item of imported) assert.ok(f.ctx.chatItems.some(row => row.id === item.id));
});

test('local read failure and changed-profile replies preserve the last successful visible catalog', async () => {
  const f = localFixture('', 12);
  await f.api.refreshConversationHistory(); await tick();
  f.fail(true); assert.equal(await f.api.refreshLocalHistory(), false);
  assert.deepEqual(Array.from(f.ctx.chatItems, row => row.id), f.rows.map(row => row.id));
  f.fail(false); f.profile('other-profile'); f.revision(1);
  assert.equal(await f.api.refreshLocalHistory(), false);
  assert.deepEqual(Array.from(f.ctx.chatItems, row => row.id), f.rows.map(row => row.id));
  f.profile('profile-one'); assert.equal(await f.api.refreshLocalHistory(), true);
});

test('initial local tombstones do not discard an unrelated concurrently loading account directory', async () => {
  let resolveAccount;
  const f = fixture('user-a', { local: true, realHistory: true, history: options => options?.source === 'local'
    ? Promise.resolve({ ok: true, chats: [], next: null, localCatalog: { workspace: 'race-profile', revision: 3,
      items: [{ id: 'deleted-copy', deleted: true, historyAliasIds: [], originIds: ['cloud-original'] }] } })
    : new Promise(resolve => { resolveAccount = resolve; }) });
  const loading = f.api.refreshConversationHistory(); await tick();
  resolveAccount({ ok: true, chats: [{ id: 'cloud-execution:retained', title: 'Retained execution', accountConversation: true }] });
  assert.equal(await loading, true);
  assert.deepEqual(Array.from(f.ctx.chatItems, row => row.id), ['cloud-execution:retained']);
});

test('an executable account original remains independent of an active or deleted downloaded local copy', async () => {
  let deleted = false, revision = 1;
  const original = { id: 'cloud-original', title: 'Original account execution', accountConversation: true, accountCanSend: true };
  const copy = { id: 'local-copy', title: 'Local replay', cached: true, localReplica: true, source: { id: original.id } };
  const f = fixture('user-a', { local: true, realHistory: true, history: async options => {
    if (options?.source === 'local') return { ok: true, chats: deleted ? [] : [copy], next: null,
      localCatalog: { workspace: 'copy-profile', revision,
        items: [{ id: copy.id, historyAliasIds: [], originIds: [original.id], deleted }] } };
    assert.equal(options?.source, 'account', 'The default legacy bridge can merge the executable original into its copy');
    return { ok: true, chats: [original] };
  } });
  await f.api.refreshConversationHistory(); await tick();
  assert.deepEqual(new Set(Array.from(f.ctx.chatItems, row => row.id)), new Set([copy.id, original.id]));
  assert.equal(f.ctx.chatItems.find(row => row.id === original.id).accountCanSend, true);
  deleted = true; revision++;
  await f.api.refreshConversationHistory(); await tick();
  assert.deepEqual(Array.from(f.ctx.chatItems, row => row.id), [original.id]);
  assert.equal(f.ctx.chatItems[0].accountCanSend, true);
  await f.switch(''); await tick();
  assert.equal(f.ctx.chatItems.length, 0, 'The authorized original never becomes shared local history');
});

test('one recent projection sorts mixed history chronologically without coalescing account originals into copies', async () => {
  const local = [{ id: 'native', title: 'Native', at: 200 },
    { id: 'copy', title: 'Downloaded', at: 100, cached: true, localReplica: true, source: { id: 'account-original' } }];
  const account = [{ id: 'account-original', title: 'Original', at: 300, accountConversation: true, accountCanSend: true },
    { id: 'account-older', title: 'Older', at: 50, accountConversation: true }];
  const f = fixture('user-a', { local: true, realHistory: true, history: async options => options.source === 'local'
    ? { ok: true, chats: local, next: null, localCatalog: { workspace: 'unified-profile', revision: 1,
      items: local.map(row => ({ id: row.id, originIds: row.source ? [row.source.id] : [] })) } }
    : { ok: true, chats: account } });
  await f.api.refreshConversationHistory(); await tick();
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), key: index => [...values.keys()][index], get length() { return values.size; } };
  const state = f.window.WorkspaceSidebarState.create({ storage, deviceStorage: storage, key: 'unified-owner' });
  state.remember(f.ctx.chatItems);
  const recent = state.view(f.ctx.chatItems).recent;
  assert.deepEqual(Array.from(recent, row => row.id), ['account-original', 'native', 'copy', 'account-older']);
  assert.equal(recent[0].accountCanSend, true);
  assert.equal(recent[2].cached, true);
});

test('actual reconciliation retains loaded local pages while independently bounding account history and upserts', async () => {
  const f = localFixture('');
  await f.api.refreshConversationHistory(); await tick();
  await f.api.refreshLocalHistory({ append: true }); await f.api.refreshLocalHistory({ append: true });
  assert.equal(f.ctx.chatItems.length, 123);
  const cloud = Array.from({ length: 150 }, (_, i) => ({ id: 'cloud-' + i, title: 'Cloud ' + i, at: 1000 + i, accountConversation: true }));
  f.api.setChats([...f.rows, ...cloud]);
  assert.equal(f.ctx.chatItems.filter(row => row.id.startsWith('saved-')).length, 123);
  assert.equal(f.ctx.chatItems.filter(row => row.id.startsWith('cloud-')).length, 50);
  f.api.upsertChat({ id: 'saved-120', title: 'Updated local history', at: 3 });
  f.api.upsertChat({ id: 'cloud-new', title: 'New account history', at: 5000, accountConversation: true });
  assert.equal(f.ctx.chatItems.filter(row => row.id.startsWith('saved-')).length, 123);
  assert.equal(f.ctx.chatItems.find(row => row.id === 'saved-120').title, 'Updated local history');
  assert.equal(f.ctx.chatItems.filter(row => row.id.startsWith('cloud-')).length, 50);
  assert.equal(f.history._reconcileChats([], f.rows, Date.now()).length, 50, 'The existing default reconciliation contract stays bounded');
});

test('a retired native child tombstone cannot remove the active canonical conversation or its pin', async () => {
  const removed = [];
  const f = fixture('', { local: true, history: async () => ({ ok: true,
    chats: [{ id: 'public-parent', title: 'Saved parent', historyAliasIds: ['runtime-child'] }], next: null,
    localCatalog: { workspace: 'joined-profile', revision: 4, items: [
      { id: 'public-parent', historyAliasIds: ['runtime-child'], deleted: false },
      { id: 'runtime-child', historyAliasIds: [], deleted: true },
    ] } }) });
  f.ctx.sidebarProjects = { forgetMany(ids) { removed.push(...ids); return true; } };
  assert.equal(await f.api.refreshLocalHistory(), true);
  assert.deepEqual(removed, []);
  assert.deepEqual(Array.from(f.ctx.chatItems, row => row.id), ['public-parent']);
});

test('trusted local reconciliation scales by catalog identity while remote history retains its existing bound', async t => {
  const f = localFixture('', 2500);
  await f.api.refreshConversationHistory(); await tick();
  let reads = 0;
  for (const row of f.rows) Object.defineProperty(row, 'cached', { enumerable: true, get() { reads++; return false; } });
  const cloud = Array.from({ length: 150 }, (_, i) => ({ id: 'cloud-' + i, title: 'Account ' + i, at: 9000 + i, accountConversation: true }));
  f.api.setChats([...f.rows, ...cloud]);
  const first = f.ctx.chatItems.find(row => row.id === 'saved-2000');
  first._uiKey = 'draft:stable-native';
  const before = Array.from(f.ctx.chatItems.filter(row => row.id.startsWith('saved-')), row => row.id);
  reads = 0;
  const started = performance.now();
  for (let i = 0; i < 3; i++) {
    f.api.setChats([...f.rows, ...cloud]);
    f.api.upsertChat({ id: 'saved-2000', title: 'Updated native ' + i, state: 'running', at: 500 });
  }
  t.diagnostic(JSON.stringify({ localRows: 2500, remoteInput: 150, refreshes: 3, milliseconds: performance.now() - started, propertyReads: reads }));
  assert.ok(reads < 2500 * 30, 'Verified local rows must not re-enter the quadratic legacy alias search');
  assert.deepEqual(Array.from(f.ctx.chatItems.filter(row => row.id.startsWith('saved-')), row => row.id), before);
  assert.equal(f.ctx.chatItems.find(row => row.id === 'saved-2000')._uiKey, 'draft:stable-native');
  assert.equal(f.ctx.chatItems.find(row => row.id === 'saved-2000').title, 'Updated native 2');
  assert.equal(f.ctx.chatItems.filter(row => row.id.startsWith('cloud-')).length, 50);
});

test('verified aliases preserve the visible row identity and settle its pending native draft', () => {
  const f = fixture('', { realHistory: true });
  const canonicalId = id => ['child', 'parent'].includes(id) ? 'parent' : id;
  const current = [{ id: 'child', localId: 'draft-1', pending: true, title: 'Draft', at: 100, _uiKey: 'draft:draft-1' }];
  const incoming = [{ id: 'parent', title: 'Saved first question', at: 101, state: 'completed' }];
  const rows = f.history._reconcileChats(current, incoming, 102, { limit: 200, canonicalId });
  assert.equal(rows.length, 1); assert.equal(rows[0].id, 'parent'); assert.equal(rows[0].pending, false);
  assert.equal(rows[0]._uiKey, 'draft:draft-1'); assert.equal(rows[0].localId, undefined);
  const changed = f.history._upsertChatItems(rows, { id: 'child', title: 'Renamed' }, { limit: 200, canonicalId });
  assert.equal(changed.length, 1); assert.equal(changed[0].id, 'parent'); assert.equal(changed[0]._uiKey, rows[0]._uiKey);
});

test('meaningful native presence coalesces one delayed durable read and retains invalidation behind an in-flight read', async () => {
  const timers = new Map(), calls = []; let timerId = 0, revision = 0, blocked = false, release;
  const rows = [];
  const response = () => ({ ok: true, chats: rows.slice(), next: null,
    localCatalog: { workspace: 'presence-profile', revision, items: rows.map(row => ({ id: row.id, historyAliasIds: [] })) } });
  const f = fixture('', { local: true, realHistory: true,
    setTimeout(fn, milliseconds) { assert.equal(milliseconds, 1200); timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    history(options) { calls.push(options); return blocked ? new Promise(resolve => { release = resolve; }) : Promise.resolve(response()); },
  });
  const fire = async () => { const pending = [...timers.values()]; timers.clear(); for (const fn of pending) fn(); await tick(); };
  await f.api.refreshLocalHistory();
  f.api.updateChatState({ kind: 'presence', presence: { id: 'native-new', title: 'First question', state: 'running' } });
  for (let i = 0; i < 100; i++) f.api.updateChatState({ kind: 'presence', presence: { id: 'native-new', title: 'First question', state: 'running' } });
  assert.equal(timers.size, 1); assert.equal(calls.length, 1);
  assert.equal(f.ctx.chatItems[0].id, 'native-new', 'The optimistic native row stays visible before durable indexing');
  rows.push({ id: 'native-new', title: 'First question', state: 'completed' }); revision++;
  await fire(); assert.equal(calls.length, 2);
  await f.switch('user-b'); await tick();
  assert.equal(f.ctx.chatItems[0].id, 'native-new', 'The durable row now survives an account change');
  blocked = true; const pending = f.api.refreshLocalHistory(); await tick();
  f.api.updateChatState({ kind: 'renamed', presence: { id: 'native-new', title: 'Renamed', state: 'completed' } });
  await fire(); const count = calls.length;
  assert.equal(timers.size, 0);
  blocked = false; rows[0].title = 'Renamed'; revision++; release(response());
  await pending; await tick();
  assert.equal(calls.length, count + 1, 'A read already in progress cannot consume the trailing invalidation');
  assert.equal(calls.at(-1).source, 'local'); assert.equal(calls.at(-1).refresh, undefined);
  assert.equal(f.ctx.chatItems[0].title, 'Renamed');
  f.api.updateChatState({ kind: 'renamed', presence: { id: 'native-new', title: 'Closing', state: 'completed' } });
  assert.equal(timers.size, 1); f.unload(); assert.equal(timers.size, 0);
});
