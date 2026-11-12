'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { identity } = require('../../tests/helpers/platform-session-fixture.cjs');
const { create } = require('./account-sync');
const { connectionScope } = require('../platform-connections/runtime.cjs');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const reply = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => clone(data) });

function fixture(t, options = {}) {
  let current = identity(), offline = false, nextRevision = 2;
  const rows = new Map(), queued = new Map(), checkpoints = new Map(), directory = new Map();
  const requests = [], changes = [];
  const initial = { id: 'acct-1', sourceSessionId: 'native-1', sourceClientId: 'other-device',
    title: 'Saved conversation', revision: 1, lifecycleRevision: 0, archived: false, deleted: false };
  if (options.initial !== false) rows.set(initial.id, { ...initial, ...options.item });
  const store = {
    jobs: () => clone([...queued.values()]), pending: () => clone([...queued.values()]),
    session: key => clone(checkpoints.get(key)), setSession: (key, value) => checkpoints.set(key, clone(value)),
    enqueue: job => queued.set(job.id, clone(job)), fail() {},
    ack(id, receipt) {
      const job = queued.get(id);
      for (const [key, value] of checkpoints) if (value.sourceSessionId === job.body.sourceSessionId)
        checkpoints.set(key, { ...value, conversationId: receipt.conversationId });
      queued.delete(id);
    },
    directory: key => clone(directory.get(key) || { cursor: 0, items: [] }),
    saveDirectory(key, items, cursor) {
      const previous = directory.get(key) || { cursor: 0, items: [] };
      const merged = new Map(previous.items.map(item => [item.id, item]));
      for (const item of items) if (Number(merged.get(item.id)?.revision || 0) <= Number(item.revision || 0)) merged.set(item.id, clone(item));
      directory.set(key, { cursor: cursor ?? previous.cursor, items: [...merged.values()] });
    },
  };
  const fetch = async (actor, url, request) => {
    const body = request.body ? JSON.parse(request.body) : null;
    const call = { actor: clone(actor), url, method: request.method, body }; requests.push(call);
    if (offline) throw Error('offline');
    const override = await options.intercept?.(call, { rows, current });
    if (override) return override;
    if (url.endsWith('/sync')) {
      const item = { ...initial, sourceSessionId: body.sourceSessionId, sourceClientId: actor.clientId,
        revision: nextRevision++ };
      rows.set(item.id, item);
      return reply({ ok: true, conversationId: item.id, sourceRevision: body.sourceRevision });
    }
    if (url.endsWith('/lifecycle')) {
      const id = decodeURIComponent(url.split('/').at(-2)), old = rows.get(id);
      if (!old || old.revision !== body.expectedRevision) return reply({ detail: 'revision conflict' }, 409);
      const revision = Math.max(nextRevision, ...[...rows.values()].map(item => Number(item.revision || 0) + 1));
      nextRevision = revision + 1;
      const updated = { ...old, revision, lifecycleRevision: revision,
        archived: body.action === 'archive', deleted: body.action === 'delete' };
      rows.set(id, updated);
      return reply({ ok: true, conversation: updated });
    }
    if (url.endsWith('/source')) {
      const item = rows.get(decodeURIComponent(url.split('/').at(-2)));
      return item ? reply({ conversation: item }) : reply({}, 404);
    }
    return reply({ items: [...rows.values()], cursor: nextRevision - 1, hasMore: false });
  };
  const sync = create({ app: options.app || {}, identityOf: async () => current, store, fetch,
    realtime: options.realtime === true,
    ...(options.resolveNativeSource ? { resolveNativeSource: options.resolveNativeSource } : {}) });
  sync.onChange((id, row, presence) => changes.push({ id, row, presence }));
  t.after(() => sync.close());
  return { sync, store, rows, queued, checkpoints, directory, requests, changes,
    offline(value) { offline = value; }, switch(value) { current = value; } };
}

test('remote-only account projections archive, restore and delete using acknowledged revisions', async t => {
  const f = fixture(t);
  const target = await f.sync.resolveLifecycle('acct-1');
  assert.equal(target.found, true);
  assert.equal(target.projection.owner, connectionScope(identity()));
  assert.deepEqual(target.nativeIds, []);
  assert.equal(f.requests.filter(item => item.method === 'POST').length, 0, 'authorization remains read-only');
  for (const action of ['archive', 'restore', 'delete']) {
    const previous = f.rows.get('acct-1').revision;
    const result = await f.sync.setLifecycle('acct-1', action);
    assert.equal(result.ok, true);
    assert.deepEqual(f.requests.filter(item => item.url.endsWith('/lifecycle')).at(-1).body, { action, expectedRevision: previous });
    assert.equal(result.projection.lifecycleRevision, result.conversation.revision);
    assert.equal(result.deleted, action === 'delete');
    const active = await f.sync.history(), archived = await f.sync.history({ archived: true });
    assert.equal(active.chats.length, action === 'restore' ? 1 : 0);
    assert.equal(archived.chats.length, action === 'archive' ? 1 : 0);
    assert.equal(active.lifecycle[0].deleted, action === 'delete');
  }
  assert.equal(f.changes.length, 3);
  assert.equal(f.changes.at(-1).presence.deleted, true);
  assert.equal([...f.directory.values()][0].items[0].deleted, true);
});

test('network failure and revision conflict never publish optimistic lifecycle success', async t => {
  let conflict = false;
  const f = fixture(t, { intercept: call => conflict && call.url.endsWith('/lifecycle') ? reply({ detail: 'revision conflict' }, 409) : null });
  await f.sync.history();
  f.offline(true);
  const offline = await f.sync.setLifecycle('acct-1', 'archive');
  assert.equal(offline.ok, false);
  assert.match(offline.reason, /offline/);
  assert.equal(f.changes.length, 0);
  assert.equal((await f.sync.history()).chats.length, 1);
  f.offline(false); conflict = true;
  assert.equal((await f.sync.setLifecycle('acct-1', 'delete')).ok, false);
  assert.equal(f.rows.get('acct-1').deleted, false);
  assert.equal(f.changes.length, 0);
});

test('pending native upload is read-only during resolution and flushed before lifecycle changes', async t => {
  const f = fixture(t, { initial: false });
  f.sync.bind({ sessionId: 'native-1', snapshot: () => ({ messages: [{ role: 'user', text: 'fixture' }] }) }, identity());
  const target = await f.sync.resolveLifecycle('native-1');
  assert.equal(target.pending, true);
  assert.equal(target.found, true);
  assert.equal(f.requests.filter(item => item.method === 'POST').length, 0);
  const result = await f.sync.setLifecycle('native-1', 'archive');
  assert.equal(result.ok, true);
  assert.ok(result.aliasIds.includes('native-1'));
  assert.deepEqual(f.requests.filter(item => item.method === 'POST').map(item => item.url.split('/').at(-1)), ['sync', 'lifecycle']);
  assert.equal(f.queued.size, 0);
  assert.equal(f.rows.get('acct-1').archived, true);
});

test('failed pending upload prevents local-only success and keeps the durable upload for retry', async t => {
  const f = fixture(t, { initial: false });
  f.sync.bind({ sessionId: 'native-1', snapshot: () => ({ messages: [{ role: 'user', text: 'fixture' }] }) }, identity());
  f.offline(true);
  const result = await f.sync.setLifecycle('native-1', 'delete');
  assert.equal(result.ok, false);
  assert.equal(result.localOnly, undefined);
  assert.equal(f.queued.size, 1);
  assert.equal(f.requests.some(item => item.url.endsWith('/lifecycle')), false);
});

test('a persisted pending upload is flushed before deletion without a live native handle', async t => {
  const f = fixture(t, { initial: false });
  f.queued.set('pending', { id: 'pending', hub: identity().hub, clientId: identity().clientId,
    ownerKey: require('../device-auth-request').accountScopeKey(identity()),
    body: { sourceSessionId: 'native-1', sourceEpoch: 'native-1:desktop', sourceRevision: 1,
      state: 'completed', messages: [{ role: 'assistant', text: 'Recovered final answer' }] } });
  const target = await f.sync.resolveLifecycle('native-1');
  assert.equal(target.pending, true);
  const result = await f.sync.setLifecycle('native-1', 'delete');
  assert.equal(result.ok, true);
  assert.equal(result.deleted, true);
  assert.equal(result.localOnly, undefined);
  assert.equal(f.queued.size, 0);
  assert.deepEqual(f.requests.filter(item => item.method === 'POST').map(item => item.url.split('/').at(-1)), ['sync', 'lifecycle']);
});

test('an ACK resolves directly when the directory page has not caught up yet', async t => {
  const f = fixture(t, { initial: false, intercept: call => call.url.includes('?after=')
    ? reply({ items: [], cursor: 0, hasMore: false }) : null });
  f.sync.bind({ sessionId: 'native-1', snapshot: () => ({ messages: [{ role: 'user', text: 'fixture' }] }) }, identity());
  const result = await f.sync.setLifecycle('native-1', 'archive');
  assert.equal(result.ok, true);
  assert.ok(f.requests.some(item => item.url.endsWith('/acct-1/source')));
  assert.equal(f.rows.get('acct-1').archived, true);
});

test('untracked old native histories are explicitly local-only after a successful directory lookup', async t => {
  const f = fixture(t, { initial: false });
  const result = await f.sync.setLifecycle('legacy-native', 'archive');
  assert.equal(result.ok, true); assert.equal(result.found, false); assert.equal(result.localOnly, true);
  assert.equal(f.requests.some(item => item.method === 'POST'), false);
  f.offline(true);
  assert.equal((await f.sync.setLifecycle('legacy-native', 'archive')).ok, false);
});

test('legacy local archive is preserved; explicit Hub restore overrides its old flag', async t => {
  const f = fixture(t, { item: { sourceClientId: identity().clientId }, resolveNativeSource: async () => ({
    id: 'native-1', archived: true, nativeIds: ['native-1', 'segment-2'], historyAliasIds: ['acct-1', 'segment-2'],
  }) });
  const active = await f.sync.history();
  assert.equal(active.chats.length, 0);
  assert.equal(active.lifecycle[0].archived, true);
  assert.deepEqual(active.lifecycle[0].nativeIds, ['native-1', 'segment-2']);
  assert.equal((await f.sync.history({ archived: true })).chats[0].id, 'native-1');
  assert.equal((await f.sync.setLifecycle('acct-1', 'restore')).ok, true);
  const restored = await f.sync.history();
  assert.equal(restored.chats[0].id, 'native-1');
  assert.equal(restored.chats[0].archived, false);
  assert.ok(restored.lifecycle[0].lifecycleRevision > 0);
});

test('late older directory rows cannot overwrite a confirmed lifecycle receipt', async t => {
  let oldPage = false;
  const f = fixture(t, { intercept: call => oldPage && call.url.includes('?after=') ? reply({ items: [{
    id: 'acct-1', sourceSessionId: 'native-1', sourceClientId: 'other-device', revision: 1, archived: false,
  }], cursor: 1, hasMore: false }) : null });
  assert.equal((await f.sync.setLifecycle('acct-1', 'archive')).ok, true);
  oldPage = true;
  const history = await f.sync.history({ force: true });
  assert.equal(history.chats.length, 0);
  assert.equal(history.lifecycle[0].archived, true);
  assert.equal([...f.directory.values()][0].items[0].archived, true);
});

test('concurrent active and archived history readers share loading without sharing the wrong filter', async t => {
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const f = fixture(t, { item: { archived: true, lifecycleRevision: 1 }, intercept: async call => {
    if (!call.url.includes('?after=')) return;
    started(); await new Promise(resolve => { release = resolve; });
  } });
  const active = f.sync.history();
  await waiting;
  const archived = f.sync.history({ archived: true });
  release();
  assert.equal((await active).chats.length, 0);
  assert.equal((await archived).chats[0].id, 'acct-1');
  assert.equal(f.requests.length, 1);
});

test('repeated lifecycle clicks cannot unlock an operation that is still in flight', async t => {
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const f = fixture(t, { intercept: async call => {
    if (!call.url.endsWith('/lifecycle')) return;
    started(); await new Promise(resolve => { release = resolve; });
  } });
  const first = f.sync.setLifecycle('acct-1', 'archive');
  await waiting;
  assert.equal((await f.sync.setLifecycle('acct-1', 'archive')).ok, false);
  assert.equal((await f.sync.setLifecycle('acct-1', 'delete')).ok, false);
  assert.equal(f.requests.filter(item => item.url.endsWith('/lifecycle')).length, 1);
  release();
  assert.equal((await first).ok, true);
});

test('account switch during a lifecycle request cannot publish into the next account', async t => {
  let release, started;
  const pending = new Promise(resolve => { started = resolve; });
  const f = fixture(t, { intercept: async call => {
    if (!call.url.endsWith('/lifecycle')) return;
    started(); await new Promise(resolve => { release = resolve; });
  } });
  const mutation = f.sync.setLifecycle('acct-1', 'archive');
  await pending; f.switch(identity('two')); release();
  assert.equal((await mutation).ok, false);
  assert.equal(f.changes.length, 0);
  assert.equal([...f.directory.values()][0].items[0].archived, false);
});

test('another device native ID cannot resolve to a current-device lifecycle target', async t => {
  const f = fixture(t);
  const result = await f.sync.resolveLifecycle('native-1');
  assert.equal(result.found, false);
  assert.deepEqual(result.nativeIds, []);
});

async function multipleSources(t, options = {}) {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-lifecycle-aliases-'));
  const app = { getPath: () => root };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = require('../platform-connections/runtime.cjs').scope(identity());
  await require('./runtime-segments').save(app, { version: 1, id: 'native-1', owner,
    active: { adapterId: 'qwen', sessionId: 'native-2' }, segments: [{ adapterId: 'pi', sessionId: 'native-1' }] });
  const session = { findBySessionId: id => ({ historyRow: () => ({ id, title: 'Fixture', workOwner: owner }) }) };
  const f = fixture(t, { ...options, app, item: { sourceClientId: identity().clientId },
    resolveNativeSource: (item, identity) => require('./account-native-source.cjs').resolve({ app, session, item, identity }) });
  f.rows.set('acct-2', { ...f.rows.get('acct-1'), id: 'acct-2', sourceSessionId: 'native-2' });
  f.rows.set('foreign', { ...f.rows.get('acct-2'), id: 'foreign', sourceClientId: 'another-device' });
  return f;
}

test('all current-device account sources of a switched native conversation archive and delete together', async t => {
  const f = await multipleSources(t);
  const target = await f.sync.resolveLifecycle('acct-2');
  assert.deepEqual(new Set(target.conversations.map(item => item.id)), new Set(['acct-1', 'acct-2']));
  assert.deepEqual(target.nativeIds, ['native-1', 'native-2']);
  for (const action of ['archive', 'delete']) {
    const result = await f.sync.setLifecycle('acct-2', action);
    assert.equal(result.ok, true);
    assert.deepEqual(new Set(result.aliasIds), new Set(['acct-1', 'acct-2', 'native-1', 'native-2']));
    assert.equal(result.conversations.length, 2);
    for (const id of ['acct-1', 'acct-2']) assert.equal(f.rows.get(id)[action === 'archive' ? 'archived' : 'deleted'], true);
    assert.equal(f.rows.get('foreign').archived, false);
    assert.equal(f.rows.get('foreign').deleted, false);
  }
});

test('partial multi-source failure is explicit and retry completes the remaining lifecycle changes', async t => {
  let failSecond = true;
  const f = await multipleSources(t, { intercept: call => failSecond && call.url.endsWith('/acct-2/lifecycle')
    ? reply({ detail: 'temporary failure' }, 503) : null });
  const failed = await f.sync.setLifecycle('native-1', 'archive');
  assert.equal(failed.ok, false);
  assert.equal(failed.partial, true);
  assert.equal(f.rows.get('acct-1').archived, true);
  assert.equal(f.rows.get('acct-2').archived, false);
  failSecond = false;
  const retried = await f.sync.setLifecycle('native-1', 'archive');
  assert.equal(retried.ok, true);
  assert.equal(f.rows.get('acct-1').archived, true);
  assert.equal(f.rows.get('acct-2').archived, true);
});

test('account switch while native lifecycle notification is resolving suppresses the late event', async t => {
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const f = fixture(t, { item: { sourceClientId: identity().clientId }, resolveNativeSource: async item => {
    if (item.lifecycleRevision > 0) { started(); await new Promise(resolve => { release = resolve; }); }
    return { id: 'native-1' };
  } });
  const mutation = f.sync.setLifecycle('acct-1', 'archive');
  await waiting; f.switch(identity('two')); release();
  assert.equal((await mutation).ok, false);
  assert.equal(f.changes.length, 0);
});

test('newer restore overtakes an older pending archive notification without emitting stale state', async t => {
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const f = fixture(t, { item: { sourceClientId: identity().clientId }, resolveNativeSource: async item => {
    if (item.lifecycleRevision === 2) { started(); await new Promise(resolve => { release = resolve; }); }
    return { id: 'native-1' };
  } });
  const mutation = f.sync.setLifecycle('acct-1', 'archive');
  await waiting;
  f.rows.set('acct-1', { ...f.rows.get('acct-1'), revision: 3, lifecycleRevision: 3, archived: false });
  assert.equal((await f.sync.history({ force: true })).chats[0].archived, false);
  release();
  assert.equal((await mutation).ok, false);
  // Directory refresh now publishes confirmed changes to existing views. The
  // newer restore must be announced once; the delayed archive must stay silent.
  assert.equal(f.changes.length, 1);
  assert.equal(f.changes[0].id, 'native-1');
  assert.equal(f.changes[0].presence.archived, false);
  assert.equal(f.changes[0].presence.deleted, false);
  assert.equal(f.changes[0].presence.lifecycleRevision, 3);
});

test('native projection work is bounded and simultaneous history readers share in-flight lookups', async t => {
  let active = 0, maximum = 0, count = 0;
  const f = fixture(t, { initial: false, resolveNativeSource: async item => {
    active++; count++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve)); active--;
    return { id: item.sourceSessionId };
  } });
  for (let index = 0; index < 40; index++) f.rows.set('acct-' + index, {
    id: 'acct-' + index, sourceSessionId: 'native-' + index, sourceClientId: identity().clientId, revision: 1,
  });
  const results = await Promise.all([f.sync.history(), f.sync.history(), f.sync.history({ archived: true })]);
  assert.equal(results[0].chats.length, 40);
  assert.equal(results[1].chats.length, 40);
  assert.equal(results[2].chats.length, 0);
  assert.equal(count, 40);
  assert.ok(maximum <= 4);
});

test('direct row reads do not mix account caches when switching away and back', async t => {
  const f = fixture(t, { intercept: call => call.url.endsWith('/source') ? reply({ conversation: {
    id: 'acct-1', revision: 1, title: call.actor.session === identity().session ? 'first' : 'second',
  } }) : null });
  assert.equal((await f.sync.row('acct-1')).title, 'first');
  f.switch(identity('two'));
  assert.equal((await f.sync.row('acct-1')).title, 'second');
  f.switch(identity());
  assert.equal((await f.sync.row('acct-1')).title, 'first');
  assert.equal(f.requests.length, 3);
});

test('a directory larger than the page budget cannot classify an unseen tail conversation as local-only', async t => {
  const items = Array.from({ length: 1001 }, (_, index) => ({ id: 'large-' + index, revision: index + 1,
    sourceSessionId: 'source-' + index, sourceClientId: 'other-device' }));
  items[1000] = { ...items[1000], sourceSessionId: 'native-tail', sourceClientId: identity().clientId };
  const f = fixture(t, { initial: false, intercept: call => {
    if (!call.url.includes('?after=')) return;
    const url = new URL(call.url), after = Number(url.searchParams.get('after')), limit = Number(url.searchParams.get('limit'));
    assert.equal(limit, 100, 'the request respects the Hub directory limit');
    const remaining = items.filter(item => item.revision > after), page = remaining.slice(0, limit);
    return reply({ items: page, cursor: page.at(-1)?.revision || after, hasMore: remaining.length > limit });
  } });
  f.rows.set(items[1000].id, items[1000]);
  const missing = await f.sync.setLifecycle('native-tail', 'delete');
  assert.equal(missing.ok, false);
  assert.equal(missing.localOnly, undefined);
  assert.equal(f.requests.length, 5, 'one lookup has a bounded page budget');
  assert.equal(f.requests.some(item => item.method === 'POST'), false);
  const limit = Number(new URL(f.requests[0].url).searchParams.get('limit'));
  let resumed;
  for (let cycle = 0; cycle < Math.ceil(items.length / limit); cycle++) {
    const before = f.requests.length;
    resumed = await f.sync.history();
    assert.ok(f.requests.length - before <= 5, 'continuations retain the page budget');
    if (!resumed.partial) break;
  }
  assert.equal(resumed.partial, false);
  assert.equal(resumed.cursor, items.length);
  assert.equal(resumed.chats.length, items.length);
  assert.equal(Number(new URL(f.requests[5].url).searchParams.get('after')),
    5 * limit,
    'the next read continues instead of restarting from page one');
  assert.equal((await f.sync.setLifecycle('native-tail', 'delete')).ok, true);
  assert.equal(f.rows.get(items[1000].id).deleted, true);
});

test('an offline directory cache that omits the target cannot authorize local-only deletion', async t => {
  const f = fixture(t);
  await f.sync.history();
  f.offline(true);
  const resolution = await f.sync.resolveLifecycle('not-in-cache');
  assert.equal(resolution.ok, false);
  assert.equal(resolution.found, undefined);
  const result = await f.sync.setLifecycle('not-in-cache', 'delete');
  assert.equal(result.ok, false);
  assert.equal(result.localOnly, undefined);
  assert.equal(f.requests.some(item => item.method === 'POST'), false);
});

test('finding one native source in a partial directory does not authorize an incomplete alias group', async t => {
  let calls = 0;
  const f = await multipleSources(t, { intercept: (call, { rows }) => {
    if (!call.url.includes('?after=')) return;
    calls++;
    const after = Number(new URL(call.url).searchParams.get('after'));
    return reply({ items: calls === 1 ? [rows.get('acct-1')] : [], cursor: after + 1, hasMore: true });
  } });
  const result = await f.sync.setLifecycle('native-1', 'archive');
  assert.equal(result.ok, false);
  assert.equal(calls, 5);
  assert.equal(f.requests.some(item => item.url.endsWith('/lifecycle')), false);
  assert.equal(f.rows.get('acct-1').archived, false);
  assert.equal(f.rows.get('acct-2').archived, false);
});
