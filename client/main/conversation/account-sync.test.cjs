'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('unchanged local transcripts retain their revision across polling and reopen', async t => {
  const session = Buffer.from(JSON.stringify({ typ: 'device', uid: 'alice', cid: 'desktop',
    exp: 9999999999 })).toString('base64url') + '.' + 'a'.repeat(64);
  const identity = { hub: 'http://hub.test', clientId: 'desktop', session };
  const saved = new Map(), queued = new Map(), sent = [];
  let clock = 1793440000000;
  const view = { status: 'idle', messages: [
    { id: 'legacy', role: 'user', text: 'Read this existing conversation' },
    { id: 'reply', role: 'assistant', text: 'Original reply', done: true,
      createdAt: '2026-10-31T07:00:00Z' },
  ] };
  const store = {
    session: key => saved.get(key),
    setSession: (key, value) => saved.set(key, JSON.parse(JSON.stringify(value))),
    enqueue: job => queued.set(job.id, job), jobs: () => [...queued.values()],
    ack: id => queued.delete(id), fail() {},
  };
  const options = { app: {}, store, now: () => clock, identityOf: async () => identity,
    fetch: async (_identity, _url, request) => {
      const body = JSON.parse(request.body);
      sent.push(body);
      return response({ ok: true, conversationId: 'account-1', sourceRevision: body.sourceRevision });
    } };
  const handle = { sessionId: 'native-1', snapshot: () => view,
    historyRow: () => ({ title: 'Local conversation' }) };
  const sync = require('./account-sync').create(options);
  t.after(() => sync.close());
  sync.bind(handle, identity);
  await sync.flush();
  clock += 30000;
  await sync.flush();
  assert.equal(sent.length, 1, 'polling must not invalidate a mobile continuation snapshot');
  assert.equal(sent[0].messages[1].createdAt, '2026-10-31T07:00:00.000Z');
  await sync.close();
  const reopened = require('./account-sync').create(options);
  t.after(() => reopened.close());
  reopened.bind(handle, identity);
  await reopened.flush();
  assert.equal(sent.length, 1, 'reopening an unchanged local session must not change its revision');
  view.messages[1].text = 'Updated reply';
  await reopened.flush();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].sourceRevision, sent[0].sourceRevision + 1);
  assert.equal(sent[1].messages[0].createdAt, sent[0].messages[0].createdAt);
  view.messages[1].deleted = true;
  await reopened.flush();
  assert.equal(sent[2].messages[1].deleted, true);
  assert.equal(sent[2].sourceRevision, sent[1].sourceRevision + 1);
  view.status = 'running';
  await reopened.flush();
  assert.equal(sent[3].state, 'responding');
});

test('a failed sync retries the same source revision and payload', async t => {
  const session = Buffer.from(JSON.stringify({ typ: 'device', uid: 'alice', cid: 'desktop',
    exp: 9999999999 })).toString('base64url') + '.' + 'a'.repeat(64);
  const identity = { hub: 'http://hub.test', clientId: 'desktop', session };
  const queued = new Map(), sent = [];
  const sync = require('./account-sync').create({ app: {}, identityOf: async () => identity,
    store: { session: () => null, setSession() {}, enqueue: job => queued.set(job.id, job),
      jobs: () => [...queued.values()], ack: id => queued.delete(id), fail() {} },
    fetch: async (_identity, _url, request) => {
      sent.push(JSON.parse(request.body));
      if (sent.length === 1) throw Error('offline');
      return response({ ok: true, conversationId: 'account-1', sourceRevision: sent[1].sourceRevision });
    } });
  t.after(() => sync.close());
  sync.bind({ sessionId: 'native-1', snapshot: () => ({ messages: [
    { role: 'user', text: 'Stable request', sentAt: 1793440000000 },
  ] }) }, identity);
  assert.equal((await sync.flush()).pending, 1);
  assert.equal((await sync.flush()).pending, 0);
  assert.deepEqual(sent[1], sent[0]);
});

test('native Pi text blocks sync as visible replies without leaking reasoning or tool inputs', async t => {
  const identity = { hub: 'http://hub.test', clientId: 'desktop', session: 'fixture' };
  const queued = new Map(), sent = [];
  const sync = require('./account-sync').create({ app: {}, identityOf: async () => identity,
    store: { session: () => null, setSession() {}, enqueue: job => queued.set(job.id, job),
      jobs: () => [...queued.values()], ack: id => queued.delete(id), fail() {} },
    fetch: async (_identity, _url, request) => {
      const body = JSON.parse(request.body); sent.push(body);
      return response({ ok: true, conversationId: 'account-1', sourceRevision: body.sourceRevision });
    } });
  t.after(() => sync.close());
  sync.bind({ sessionId: 'native-1', snapshot: () => ({ messages: [
    { role: 'assistant', text: '', blocks: [
      { kind: 'thinking', text: 'private reasoning' }, { kind: 'text', text: 'First paragraph' },
      { kind: 'toolcall', text: 'private tool input' }, { kind: 'text', text: 'Second paragraph' },
    ], done: true },
  ] }) }, identity);
  await sync.flush();
  assert.equal(sent[0].messages[0].text, 'First paragraph\n\nSecond paragraph');
  assert.equal(sent[0].messages[0].done, true);
});

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status,
    async json() { return body; } };
}

test('unsent review drafts do not checkpoint until their first submitted message', async t => {
  const identity = { hub: 'http://hub.test', clientId: 'desktop', session: 'fixture' };
  const queued = new Map(), sent = [], view = { status: 'idle', messages: [] };
  const sync = require('./account-sync').create({ app: {}, metadataOnly: true, identityOf: async () => identity,
    store: { session: () => null, setSession() {}, enqueue: job => queued.set(job.id, job),
      jobs: () => [...queued.values()], ack: id => queued.delete(id), fail() {} },
    fetch: async (_identity, _url, request) => {
      const body = JSON.parse(request.body); sent.push(body);
      return response({ ok: true, conversationId: 'account-review', sourceRevision: body.sourceRevision });
    } });
  t.after(() => sync.close());
  sync.bind({ sessionId: 'native-review', acceptanceSession: { taskRef: 'requirement' }, snapshot: () => view,
    historyRow: () => ({ title: 'Requirement', taskId: 'requirement' }) }, identity);
  await sync.flush();
  assert.equal(sent.length, 0);
  view.messages.push({ role: 'user', text: 'Review the delivery' });
  await sync.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].messageCount, 1);
  assert.equal(sent[0].taskProjectionId, '');
});

test('legacy idle zero-message account rows carry a reversible visibility hint', async t => {
  const actor = require('../../tests/helpers/platform-session-fixture.cjs').identity();
  const sync = require('./account-sync').create({ app: {}, store: { jobs: () => [] },
    identityOf: async () => actor, resolveNativeSource: async () => null,
    fetch: async () => response({ items: [
      { id: 'empty', sourceSessionId: 'native-empty', messageCount: 0, state: 'idle' },
      { id: 'unknown', state: 'idle' },
      { id: 'sent', messageCount: 2, state: 'idle' },
      { id: 'task', messageCount: 0, state: 'idle', taskProjectionId: 'task' },
    ], cursor: 4, hasMore: false }) });
  t.after(() => sync.close());
  const page = await sync.history();
  assert.deepEqual(page.chats.map(row => row.emptyPlaceholder), [true, false, false, false]);
  assert.equal(page.chats[0].deleted, false);
});

test('only a dedicated task transcript publishes its task projection identity', async t => {
  const identity = { hub: 'http://hub.test', clientId: 'desktop', session: 'fixture' };
  const saved = new Map(), queued = new Map(), sent = [];
  const view = { messages: [] };
  const history = { title: 'Same title', taskId: 'task-one', taskIds: ['task-one'] };
  const handle = { sessionId: 'native-task', snapshot: () => view, historyRow: () => history };
  const sync = require('./account-sync').create({ app: {}, identityOf: async () => identity,
    store: { session: key => saved.get(key), setSession: (key, value) => saved.set(key, value),
      enqueue: job => queued.set(job.id, job), jobs: () => [...queued.values()],
      ack: id => queued.delete(id), fail() {} },
    fetch: async (_identity, _url, request) => {
      const body = JSON.parse(request.body); sent.push(body);
      return response({ ok: true, conversationId: 'account-task', sourceRevision: body.sourceRevision });
    } });
  t.after(() => sync.close());
  sync.bind(handle, identity);
  await sync.flush();
  assert.equal(sent.at(-1).taskProjectionId, 'task-one');
  view.messages = [{ role: 'user', text: 'task request', taskId: 'task-one' }];
  await sync.flush();
  assert.equal(sent.at(-1).taskProjectionId, 'task-one');
  view.messages.push({ role: 'user', text: 'independent conversation' });
  await sync.flush();
  assert.equal(sent.at(-1).taskProjectionId, '');
  view.messages = [];
  history.taskIds.push('task-two');
  await sync.flush();
  assert.equal(sent.at(-1).taskProjectionId, '');
  history.taskIds = ['task-one'];
  await sync.flush();
  assert.equal(sent.at(-1).taskProjectionId, 'task-one');
  handle.acceptanceSession = { taskId: 'task-one' };
  await sync.flush();
  assert.equal(sent.at(-1).taskProjectionId, '');
});

function fixture() {
  let version = 1;
  const calls = [];
  const store = {
    session() { return {}; },
    setSession() {},
    enqueue() {},
    jobs() { return []; },
    ack() {},
    fail() {},
  };
  const fetch = async (_identity, url) => {
    calls.push(String(url));
    const conversation = {
      id: 'acct-1', sourceClientId: 'desktop', sourceSessionId: 'native-1',
      title: version === 1 ? '第一版' : '已更新', state: 'idle',
      updatedAt: `2026-10-31T00:0${version}:00Z`, canSend: false,
    };
    const messages = version === 1
      ? [{ id: 'm1', position: 0, role: 'user', text: '第一条', createdAt: conversation.updatedAt, done: true }]
      : [{ id: 'm1', position: 0, role: 'user', text: '第一条', createdAt: conversation.updatedAt, done: true },
        { id: 'm2', position: 1, role: 'assistant', text: '第二条', createdAt: conversation.updatedAt, done: true }];
    if (String(url).includes('/source')) return response({ conversation });
    return response({ conversation, items: messages, cursor: messages.length,
      hasMore: false });
  };
  const sync = require('./account-sync').create({ app: {}, store,
    identityOf: async () => require('../../tests/helpers/platform-session-fixture.cjs').identity(),
    localIdentityOf: async () => require('../../tests/helpers/platform-session-fixture.cjs').identity(),
    fetch, realtime: false,
  });
  return { sync, calls, advance() { version = 2; } };
}

test('an open account projection refreshes its transcript after a realtime invalidation', async () => {
  const f = fixture();
  const view = await f.sync.openProjection('acct-1');
  assert.deepEqual(view.snapshot().messages.map(item => item.id), ['m1']);
  f.advance();
  await view.refresh();
  assert.deepEqual(view.snapshot().messages.map(item => item.id), ['m1', 'm2']);
  assert.equal(view.snapshot().messages[1].blocks[0].kind, 'text');
  assert.equal(view.snapshot().messages[1].blocks[0].text, '第二条');
  assert.equal(view.snapshot().messages[1].blocks[0].done, true);
  assert.equal(view.historyRow().title, '已更新');
});

test('a cache miss can resolve a directory row without downloading its transcript', async () => {
  const f = fixture();
  const row = await f.sync.row('acct-1');
  assert.equal(row.id, 'acct-1');
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0], /\/source$/);
});

test('fresh and cached account history retain authenticated ownership through account changes', async t => {
  const { identity } = require('../../tests/helpers/platform-session-fixture.cjs');
  const { connectionScope } = require('../platform-connections/runtime.cjs');
  let current = identity(), requests = 0;
  const sync = require('./account-sync').create({ app: {}, store: { jobs: () => [] }, identityOf: async () => current,
    fetch: async () => { requests++; return response({ items: [{ id: 'acct-1', sourceSessionId: 'native-1',
      sourceClientId: 'other-device', title: 'Review' }], hasMore: false }); } });
  t.after(() => sync.close());
  for (let i = 0; i < 2; i++) {
    const row = (await sync.history()).chats[0];
    assert.equal(row.accountProjection, true);
    assert.equal(row.owner, connectionScope(current));
  }
  assert.equal(requests, 1);
  current = identity('two');
  assert.equal((await sync.history()).chats[0].owner, connectionScope(current));
  assert.equal(requests, 2);
});

test('account-only history preserves the original identity while default history retains native projection', async t => {
  const actor = require('../../tests/helpers/platform-session-fixture.cjs').identity();
  let scans = 0, requests = 0;
  const sync = require('./account-sync').create({ app: {}, store: { jobs: () => [] }, identityOf: () => actor,
    resolveNativeSource: async () => { scans++; return { id: 'native-1', adapterId: 'pi', count: 2 }; },
    fetch: async () => { requests++; return response({ items: [{ id: 'acct-1', sourceSessionId: 'native-1',
      sourceClientId: actor.clientId, title: 'Original', canSend: true, messageCount: 2 }], hasMore: false }); } });
  t.after(() => sync.close());
  const account = (await sync.history({ source: 'account' })).chats[0];
  assert.equal(account.id, 'acct-1'); assert.equal(account.accountProjection, true);
  assert.equal(scans, 0);
  const legacy = (await sync.history()).chats[0];
  assert.equal(legacy.id, 'native-1'); assert.equal(scans, 1);
  assert.equal(requests, 1);
});

test('account-only forced refresh publishes current directory rows without native discovery', async t => {
  const actor = require('../../tests/helpers/platform-session-fixture.cjs').identity();
  let scans = 0, revision = 1;
  const changes = [];
  const sync = require('./account-sync').create({ app: {}, store: { jobs: () => [] }, identityOf: () => actor,
    realtime: false,
    resolveNativeSource: async () => { scans++; return { id: 'native-1', adapterId: 'pi', count: 2 }; },
    fetch: async () => response({ items: [{ id: 'acct-1', sourceSessionId: 'native-1',
      sourceClientId: actor.clientId, title: 'Revision ' + revision, revision,
      messageCount: 2, canSend: true }], hasMore: false }) });
  t.after(() => sync.close());
  sync.onChange((id, row, presence) => changes.push({ id, row, presence }));
  await sync.history({ source: 'account' });
  revision++;
  const result = await sync.history({ source: 'account', force: true });
  assert.equal(result.chats[0].revision, 2); assert.equal(scans, 0);
  assert.equal(changes.length, 1); assert.equal(changes[0].id, 'acct-1');
  assert.equal(changes[0].presence.accountProjection, true);
  assert.equal(changes[0].presence.owner, require('../platform-connections/runtime.cjs').connectionScope(actor));
  assert.equal((await sync.history()).chats[0].id, 'native-1');
  assert.equal(scans, 1, 'the legacy view still resolves its native identity');
});

test('coalesced account-only and legacy directory callers keep their respective identities in either order', async t => {
  const actor = require('../../tests/helpers/platform-session-fixture.cjs').identity();
  for (const firstSource of ['account', undefined]) {
    let revision = 1, scans = 0, requests = 0, release, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const sync = require('./account-sync').create({ app: {}, store: { jobs: () => [] }, identityOf: () => actor,
      realtime: false,
      resolveNativeSource: async () => { scans++; return { id: 'native-1', adapterId: 'pi', count: 2 }; },
      fetch: async () => {
        requests++;
        if (revision === 2) { entered(); await gate; }
        return response({ items: [{ id: 'acct-1', sourceSessionId: 'native-1', sourceClientId: actor.clientId,
          title: 'Revision ' + revision, revision, messageCount: 2 }], hasMore: false });
      } });
    t.after(() => sync.close());
    await sync.history({ source: 'account' }); revision = 2;
    const first = sync.history({ source: firstSource, force: true });
    await waiting;
    const second = sync.history({ source: firstSource === 'account' ? undefined : 'account', force: true });
    await new Promise(resolve => setImmediate(resolve)); release();
    const results = await Promise.all([first, second]);
    const account = results[firstSource === 'account' ? 0 : 1];
    const legacy = results[firstSource === 'account' ? 1 : 0];
    assert.equal(account.chats[0].id, 'acct-1'); assert.equal(account.chats[0].accountProjection, true);
    assert.equal(legacy.chats[0].id, 'native-1'); assert.equal(legacy.chats[0].accountProjection, undefined);
    assert.equal(requests, 2, 'different views still coalesce the same authorized refresh');
    assert.ok(scans > 0, 'the legacy caller retains its native projection');
    await sync.close();
  }
});

test('archived account rows stay out of fresh and cached history and retain live archive state', async t => {
  const { identity } = require('../../tests/helpers/platform-session-fixture.cjs');
  const previous = global.WebSocket, sockets = [], events = [];
  global.WebSocket = class { constructor() { sockets.push(this); } close() {} };
  t.after(() => { global.WebSocket = previous; });
  let archived = true, requests = 0, nativeLookups = 0;
  const sync = require('./account-sync').create({ app: {}, store: { jobs: () => [] }, realtime: true,
    identityOf: async () => identity(),
    resolveNativeSource: async () => { nativeLookups++; return null; },
    fetch: async () => {
      requests++;
      return response({ items: [{ id: 'acct-archived', title: 'Archived fixture', archived,
        sourceSessionId: 'fixture', sourceClientId: 'other-device' }], hasMore: false });
    } });
  t.after(() => sync.close());
  sync.onChange((id, row, projection) => events.push({ id, row, projection }));
  assert.deepEqual((await sync.history()).chats, []);
  assert.deepEqual((await sync.history()).chats, []);
  assert.equal(requests, 1);
  sockets[0].onmessage({ data: JSON.stringify({ type: 'account-conversation', conversationId: 'acct-archived' }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.length, 1);
  assert.equal(events[0].projection.archived, true);
  assert.equal(nativeLookups, 0, 'archived projections cannot be replaced by live native aliases');
  archived = false;
  const restored = await sync.history({ force: true });
  assert.equal(restored.chats[0].id, 'acct-archived');
  assert.equal(restored.chats[0].archived, false);
  assert.equal(nativeLookups, 0, 'a different source device never probes this device\'s archives');
});

test('failed directory refresh hides archived rows loaded from disk', async t => {
  const { identity } = require('../../tests/helpers/platform-session-fixture.cjs');
  const sync = require('./account-sync').create({ app: {}, realtime: false,
    identityOf: async () => identity(),
    store: { jobs: () => [], directory: async () => ({ cursor: 4, items: [
      { id: 'acct-archived', title: 'Archived fixture', archived: true },
      { id: 'acct-visible', title: 'Visible conversation', archived: false },
    ] }) },
    fetch: async () => { throw new Error('Offline'); },
  });
  t.after(() => sync.close());
  const result = await sync.history();
  assert.equal(result.stale, true);
  assert.deepEqual(result.chats.map(item => item.id), ['acct-visible']);
});

test('late socket refreshes cannot publish another account or survive shutdown', async t => {
  const { identity } = require('../../tests/helpers/platform-session-fixture.cjs');
  const previous = global.WebSocket, sockets = [], events = [];
  global.WebSocket = class { constructor() { sockets.push(this); } close() {} };
  t.after(() => { global.WebSocket = previous; });
  let current = identity(), release;
  const sync = require('./account-sync').create({ app: {}, store: { jobs: () => [] }, realtime: true,
    identityOf: async () => current, fetch: async () => {
      if (release === null) await new Promise(resolve => { release = resolve; });
      return response({ items: [{ id: 'acct-1', sourceSessionId: 'native-1', sourceClientId: 'other' }], hasMore: false });
    } });
  t.after(() => sync.close());
  sync.onChange((id, row, projection) => events.push({ id, row, projection }));
  await sync.history();
  release = null;
  sockets[0].onmessage({ data: JSON.stringify({ type: 'account-conversation', conversationId: 'acct-1' }) });
  await new Promise(resolve => setImmediate(resolve));
  current = identity('two');
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.length, 0);
  await sync.history({ force: true });
  release = null;
  sockets.at(-1).onmessage({ data: JSON.stringify({ type: 'account-conversation', conversationId: 'acct-1' }) });
  await new Promise(resolve => setImmediate(resolve));
  await sync.close(); release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.length, 0);
});

test('native discovery reuses authenticated account socket without reloading history', async t => {
  const { identity } = require('../../tests/helpers/platform-session-fixture.cjs');
  const previous = global.WebSocket, sockets = [];
  global.WebSocket = class {
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; }
  };
  t.after(() => { global.WebSocket = previous; });
  const discovery = require('../native-discovery.cjs').create();
  let current = identity(), requests = 0, wakes = 0;
  const remove = discovery.register('personal-relay', () => wakes++);
  t.after(remove);
  const sync = require('./account-sync').create({ app: {}, store: { jobs: () => [] }, realtime: true, discovery,
    identityOf: async () => current, fetch: async () => { requests++; return response({ items: [], hasMore: false }); } });
  t.after(() => sync.close());
  await sync.history();
  const socket = sockets[0]; socket.onopen();
  assert.equal(socket.sent[0].t, 'auth');
  socket.onmessage({ data: JSON.stringify({ type: 'ready' }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(socket.sent[1].t, 'native-discovery');
  // Authentication now closes the HTTP-to-socket delivery gap with one
  // incremental reconcile. Native discovery hints must not add directory I/O.
  assert.equal(requests, 2);
  const reconciled = requests;
  socket.onmessage({ data: JSON.stringify({ type: 'native-discovery', topic: 'personal-relay' }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wakes, 1); assert.equal(requests, reconciled); assert.equal(sockets.length, 1);
  current = { ...current, hub: 'http://other-hub.test' };
  await sync.history({ force: true });
  assert.equal(sockets.length, 2); assert.equal(socket.readyState, 3);
});

test('history refreshes cannot bypass a failed socket reconnect backoff', async t => {
  const { identity } = require('../../tests/helpers/platform-session-fixture.cjs');
  const previous = global.WebSocket, sockets = [];
  global.WebSocket = class {
    constructor() { this.readyState = 1; sockets.push(this); }
    close() { this.readyState = 3; }
    send() {}
  };
  t.after(() => { global.WebSocket = previous; });
  const sync = require('./account-sync').create({ app: {}, store: { jobs: () => [] }, realtime: true,
    identityOf: async () => identity(), fetch: async () => response({ items: [], hasMore: false }) });
  t.after(() => sync.close());
  await sync.history();
  sockets[0].onopen(); sockets[0].onclose();
  for (let i = 0; i < 10; i++) await sync.history({ force: true });
  assert.equal(sockets.length, 1);
});

test('cloud and account projections never become new local sync sources on reopen', async t => {
  const jobs = [];
  const session = Buffer.from(JSON.stringify({ typ: 'device', uid: 'alice', cid: 'desktop',
    exp: 9999999999 })).toString('base64url') + '.' + 'a'.repeat(64);
  const identity = { hub: 'http://hub.test', clientId: 'desktop', session };
  const sync = require('./account-sync').create({ app: {}, identityOf: async () => identity,
    store: { session: () => null, setSession() {}, enqueue: job => jobs.push(job), jobs: () => [] } });
  t.after(() => sync.close());
  let snapshot = { messages: [{ role: 'user', text: 'Original local input' }], status: 'idle' };
  let change;
  const handle = { sessionId: 'native-1', snapshot: () => snapshot,
    historyRow: () => ({ title: 'Same title' }), on(fn) { change = fn; return () => {}; } };
  assert.ok(sync.bind(handle, identity));
  assert.equal(jobs.length, 1, 'ordinary local conversations still synchronize');
  snapshot = { ...snapshot, cloudHandoff: { phase: 'committed' } };
  change();
  await sync.flush();
  assert.equal(jobs.length, 1, 'handoff stops copying Hub-owned output into local sync');
  for (const projection of [
    { ...handle, passiveCloudView: true },
    handle,
    { ...handle, snapshot: () => ({ execution: { accountConversation: true } }) },
  ]) assert.equal(sync.bind(projection, identity), null);
  assert.equal(jobs.length, 1);
});

function sourceFixture(messages = [{ id: 'm1', role: 'user', text: 'hello', done: true }], status = 'idle') {
  let current = messages;
  let listener = null;
  const jobs = [];
  let saved = {};
  const store = {
    session() { return { ...saved }; },
    setSession(_key, value) { saved = { ...value }; },
    enqueue(job) { jobs.push(job); return job; },
    jobs() { return jobs.slice(); },
    ack(id) { const index = jobs.findIndex(item => item.id === id); if (index >= 0) jobs.splice(index, 1); },
    fail() {},
  };
  const handle = {
    sessionId: 'native-source-1',
    accountSync: null,
    snapshot() { return { title: 'source', status, messages: current }; },
    historyRow() { return { title: 'source', state: status }; },
    on(fn) { listener = fn; return () => { listener = null; }; },
  };
  const sync = require('./account-sync').create({ app: {}, store,
    identityOf: async () => ({ hub: 'http://hub.test', clientId: 'desktop', session: 'session' }),
    localIdentityOf: async () => ({ hub: 'http://hub.test', clientId: 'desktop', session: 'session' }),
    realtime: false,
  });
  return {
    sync, handle, jobs,
    setMessages(value) { current = value; },
    emit() { listener?.(); },
  };
}

test('unchanged streaming notifications do not enqueue duplicate checkpoints', async () => {
  const f = sourceFixture();
  f.sync.bind(f.handle, { hub: 'http://hub.test', clientId: 'desktop', session: 'session' });
  assert.equal(f.jobs.length, 1);
  const first = f.jobs[0];
  f.emit(); f.emit();
  await new Promise(resolve => setTimeout(resolve, 240));
  assert.equal(f.jobs.length, 1);
  assert.equal(f.jobs[0].body.sourceRevision, 1);
  assert.equal(f.jobs[0].body.snapshotComplete, true);
  assert.notEqual(first.body.sourceRevision, undefined);
  await f.sync.close();
});

test('a changed checkpoint supersedes content without using revision in its digest', async () => {
  const f = sourceFixture();
  f.sync.bind(f.handle, { hub: 'http://hub.test', clientId: 'desktop', session: 'session' });
  f.setMessages([{ id: 'm1', role: 'user', text: 'changed', done: true }]);
  f.emit();
  await new Promise(resolve => setTimeout(resolve, 240));
  assert.equal(f.jobs.length, 2);
  assert.equal(f.jobs[1].body.sourceRevision, 2);
  assert.notEqual(f.jobs[0].body.sourceRevision, f.jobs[1].body.sourceRevision);
  await f.sync.close();
});

test('oversized source snapshots fail visibly instead of being silently truncated', async () => {
  const f = sourceFixture(Array.from({ length: 1001 }, (_, index) => ({
    id: 'm' + index, role: index % 2 ? 'assistant' : 'user', text: 'x', done: true,
  })));
  f.sync.bind(f.handle, { hub: 'http://hub.test', clientId: 'desktop', session: 'session' });
  assert.equal(f.jobs.length, 0);
  assert.equal(f.handle.accountSync.state, 'error');
  assert.match(f.handle.accountSync.reason, /message limit/);
  await f.sync.close();
});

test('source checkpoints serialize assistant blocks instead of dropping their text', async () => {
  const f = sourceFixture([
    { id: 'm1', role: 'user', text: 'question', sentAt: 10, done: true },
    { id: 'm2', role: 'assistant', blocks: [{ kind: 'text', text: 'answer' }], completedAt: 20, done: true },
  ]);
  f.sync.bind(f.handle, { hub: 'http://hub.test', clientId: 'desktop', session: 'session' });
  assert.deepEqual(f.jobs[0].body.messages.map(item => item.text), ['question', 'answer']);
  assert.equal(f.jobs[0].body.messages[1].createdAt, '1970-01-01T00:00:00.020Z');
  await f.sync.close();
});

test('runner streaming states use the Hub account-sync state contract', async () => {
  const f = sourceFixture(undefined, 'streaming');
  f.sync.bind(f.handle, { hub: 'http://hub.test', clientId: 'desktop', session: 'session' });
  assert.equal(f.jobs[0].body.state, 'responding');
  await f.sync.close();
});
