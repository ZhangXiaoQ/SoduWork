'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../main/conversation/account-sync');
const { create: createRefresh } = require('../main/conversation/directory-refresh.cjs');
const { identity } = require('./helpers/platform-session-fixture.cjs');
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const sockets = [], requests = [], changes = [];
  let actor = identity(), revision = 1, row = { id: 'account-1', title: 'Original', sourceClientId: 'other', sourceSessionId: 'source' };
  let intercept = null;
  const previousSocket = global.WebSocket;
  global.WebSocket = class {
    constructor() { this.readyState = 1; sockets.push(this); }
    send() {}
    close() { this.readyState = 3; }
  };
  t.after(() => { global.WebSocket = previousSocket; });
  const sync = create({ app: {}, store: { jobs: () => [] }, realtime: true,
    identityOf: async () => actor, discovery: { attach: () => ({ message() {}, close() {} }) },
    fetch: async (who, url) => {
      const after = Number(new URL(url).searchParams.get('after'));
      const body = { items: after < revision ? [{ ...row, revision }] : [], cursor: revision, hasMore: false };
      requests.push({ who, after, at: Date.now() });
      if (intercept) await intercept();
      return { ok: true, json: async () => body };
    }, ...options });
  sync.onChange((id, raw, projection) => changes.push({ id, raw, projection }));
  t.after(() => sync.close());
  return { sync, sockets, requests, changes,
    actor(value) { actor = value; },
    intercept(fn) { intercept = fn; },
    change(patch) { revision++; row = { ...row, ...patch }; },
    event(value) { sockets.at(-1).onmessage({ data: JSON.stringify(value) }); },
    async ready() {
      sockets.at(-1).onopen();
      this.event({ type: 'ready' });
      await settle();
    },
    async advance(ms) { t.mock.timers.tick(ms); await settle(); },
  };
}

test('authenticated socket serves 250ms multi-window reads locally and still reconciles at 30 seconds', async t => {
  const f = fixture(t);
  await f.sync.history(); await f.ready();
  assert.equal(f.requests.length, 2, 'initial subscription closes the delivery gap');
  for (let i = 0; i < 116; i++) {
    await f.advance(250);
    const results = await Promise.all(Array.from({ length: 8 }, () => f.sync.history()));
    assert.ok(results.every(value => value.ok && value.chats[0].title === 'Original'));
  }
  assert.equal(f.requests.length, 2, '928 ordinary reads share the existing directory');
  f.change({ title: 'A lost push' });
  await f.advance(1000);
  assert.equal(f.requests.length, 3, 'periodic reconciliation bypasses the fresh cache');
  assert.equal(f.requests.at(-1).after, 1, 'reconciliation uses the persisted cursor');
  assert.equal(f.changes.at(-1).projection.title, 'A lost push');
});

test('an event after a request snapshot forces a trailing fetch and publishes the new row', async t => {
  const f = fixture(t);
  await f.sync.history(); await f.ready(); await f.advance(1000);
  const gate = deferred();
  f.intercept(() => gate.promise);
  const first = f.sync.history({ force: true }); await settle();
  f.change({ title: 'Newer than the in-flight response' });
  for (let i = 0; i < 100; i++) f.event({ type: 'account-conversation', conversationId: 'account-1', revision: 2 });
  assert.equal(f.requests.length, 3, 'notifications must not overlap the in-flight HTTP request');
  f.intercept(null); gate.resolve(); await first; await settle();
  assert.equal(f.requests.length, 4);
  assert.equal((await f.sync.history()).chats[0].title, 'Newer than the in-flight response');
  assert.equal(f.changes.at(-1).projection.title, 'Newer than the in-flight response');
  await f.advance(1000);
  assert.ok(f.requests.length <= 5, 'a burst has at most one trailing coalesced refresh');
});

test('notification bursts during a push refresh retain the last change without overlapping requests', async t => {
  const f = fixture(t);
  await f.sync.history(); await f.ready(); await f.advance(1000);
  f.change({ title: 'First change' });
  const gate = deferred(); f.intercept(() => gate.promise);
  f.event({ type: 'account-conversation', conversationId: 'account-1' }); await settle();
  f.change({ title: 'Final change' });
  for (let i = 0; i < 50; i++) f.event({ type: 'account-conversation', conversationId: 'account-1' });
  assert.equal(f.requests.length, 3);
  f.intercept(null); gate.resolve(); await settle();
  await f.advance(999); assert.equal(f.requests.length, 3);
  await f.advance(1); assert.equal(f.requests.length, 4);
  assert.equal(f.changes.at(-1).projection.title, 'Final change');
});

test('replayed revision hints already covered by the directory cursor cause no extra HTTP or repaint', async t => {
  const f = fixture(t);
  await f.sync.history(); await f.ready();
  for (let i = 0; i < 100; i++) f.event({ type: 'account-conversation', conversationId: 'account-1', revision: 1 });
  await f.advance(1000);
  assert.equal(f.requests.length, 2);
  assert.equal(f.changes.length, 0);
});

test('reconnect ready immediately repairs missing archive/deletion changes and notifies existing views', async t => {
  const f = fixture(t);
  await f.sync.history(); await f.ready();
  f.sockets[0].onclose(); f.change({ archived: true });
  await f.advance(1000);
  assert.equal(f.sockets.length, 2);
  await f.ready();
  assert.equal(f.changes.at(-1).projection.archived, true);
  assert.deepEqual((await f.sync.history()).chats, []);
  f.sockets[1].onclose(); f.change({ deleted: true });
  await f.advance(1000); await f.ready();
  assert.equal(f.changes.at(-1).projection.deleted, true);
  assert.deepEqual((await f.sync.history()).chats, []);
});

test('pushed lifecycle deletion retains its tombstone in shared active and archived directory reads', async t => {
  const f = fixture(t);
  await f.sync.history(); await f.ready();
  f.change({ deleted: true, lifecycleRevision: 2 });
  f.event({ type: 'account-conversation', conversationId: 'account-1', revision: 2 });
  await f.advance(1000);
  const [active, archived] = await Promise.all([f.sync.history(), f.sync.history({ archived: true })]);
  assert.deepEqual(active.chats, []); assert.deepEqual(archived.chats, []);
  for (const result of [active, archived]) {
    assert.equal(result.lifecycle.length, 1);
    assert.equal(result.lifecycle[0].id, 'account-1');
    assert.equal(result.lifecycle[0].deleted, true);
    assert.equal(result.lifecycle[0].lifecycleRevision, 2);
  }
  assert.equal(f.changes.length, 1);
  assert.equal(f.changes[0].projection.deleted, true);
  assert.equal(f.changes[0].projection.lifecycleRevision, 2);
  assert.equal(f.requests.length, 3, 'the push refresh and both views share one incremental directory read');
});

test('failed socket reconnects cannot cancel periodic reconciliation or fabricate authentication readiness', async t => {
  const f = fixture(t);
  await f.sync.history();
  f.sockets[0].onclose(); await f.advance(1000);
  f.sockets[1].onclose(); await f.advance(2000);
  f.change({ title: 'Offline websocket update' });
  await f.advance(27000);
  assert.equal(f.requests.length, 2);
  assert.equal(f.changes.at(-1).projection.title, 'Offline websocket update');
  await f.advance(3001); await f.sync.history();
  assert.equal(f.requests.length, 3, 'without authenticated ready the legacy short cache applies');
});

test('late socket refreshes stay in their captured account and close disposes retries', async t => {
  const f = fixture(t);
  await f.sync.history(); await f.ready(); await f.advance(1000);
  const gate = deferred(); f.intercept(() => gate.promise);
  f.change({ title: 'Private old account update' });
  f.event({ type: 'account-conversation', conversationId: 'account-1' }); await settle();
  f.actor(identity('two')); f.intercept(null); gate.resolve(); await settle();
  assert.equal(f.changes.length, 0);
  await f.sync.history();
  const count = f.requests.length;
  await f.sync.close(); await f.advance(120000);
  assert.equal(f.requests.length, count);
});

test('ordinary UI and force reads cannot bypass a failed push refresh deadline', async t => {
  const f = fixture(t);
  await f.sync.history(); await f.ready(); await f.advance(1000);
  f.change({ title: 'Recovered update' });
  f.intercept(() => { throw Error('isolated network failure'); });
  f.event({ type: 'account-conversation', conversationId: 'account-1', revision: 2 }); await settle();
  assert.equal(f.requests.length, 3);
  for (let i = 0; i < 12; i++) {
    const cached = await f.sync.history({ force: i % 2 === 0 });
    assert.equal(cached.ok, false); assert.equal(cached.stale, true);
    assert.equal(cached.chats[0].title, 'Original');
  }
  assert.equal(f.requests.length, 3);
  await f.advance(4999); await f.sync.history(); assert.equal(f.requests.length, 3);
  f.intercept(null); await f.advance(1);
  assert.equal(f.requests.length, 4);
  assert.equal((await f.sync.history()).chats[0].title, 'Recovered update');
});

test('a failed push refresh retains invalidations and new hints cannot bypass its retry backoff', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const calls = []; let failing = true;
  const queue = createRefresh({ refresh: async ids => { calls.push(ids); return { ok: !failing }; } });
  t.after(() => queue.stop());
  queue.wake('one'); await settle();
  for (let i = 0; i < 50; i++) queue.wake('two');
  t.mock.timers.tick(4999); await settle(); assert.equal(calls.length, 1);
  failing = false; t.mock.timers.tick(1); await settle();
  assert.equal(calls.length, 2); assert.deepEqual(new Set(calls[1]), new Set(['one', 'two']));
  queue.stop(); queue.wake('three'); t.mock.timers.tick(120000); await settle();
  assert.equal(calls.length, 2);
});

test('slow failed refreshes wait the complete error backoff after finishing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const gate = deferred(); let calls = 0;
  const queue = createRefresh({ refresh: async () => { calls++; await gate.promise; return { ok: false }; } });
  t.after(() => queue.stop());
  queue.wake('one');
  t.mock.timers.tick(20000); await settle(); assert.equal(calls, 1);
  queue.wake('two'); gate.resolve(); await settle();
  t.mock.timers.tick(4999); await settle(); assert.equal(calls, 1);
  t.mock.timers.tick(1); await settle(); assert.equal(calls, 2);
});
