'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { create, createWorker } = require('../main/conversation/account-sync-store');
const { create: synchronize } = require('../main/conversation/account-sync');
const { identity } = require('./helpers/platform-session-fixture.cjs');
const { accountScopeKey } = require('../main/device-auth-request');
function root(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-stability-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'outbox.json');
}
const handle = (id, text = 'original') => ({ sessionId: id,
  snapshot: () => ({ status: 'completed', messages: [{ id: 'message', role: 'user', text, createdAt: 1 }] }) });
const reply = body => new Response(JSON.stringify(body));
const job = (id, revision = 1, actor = identity()) => ({ id: id + ':' + revision, hub: actor.hub,
  ownerKey: accountScopeKey(actor), clientId: actor.clientId, body: { sourceSessionId: id,
    sourceEpoch: 'epoch', sourceRevision: revision, snapshotComplete: true, messages: [] } });

test('metadata-only upgrade retains an old queued body until its local recovery copy is durable', async t => {
  const store = createWorker(root(t)), actor = identity(), queued = job('old-body');
  queued.body.messages = [{ id: 'old-message', position: 0, role: 'user', text: 'sole queued content' }];
  await store.enqueue(queued);
  let durable = false, sends = 0;
  const sync = synchronize({ app: {}, store, metadataOnly: true, identityOf: () => actor,
    preserveLegacyOutbox: async value => {
      assert.equal(value.body.messages[0].text, 'sole queued content');
      if (!durable) throw Error('Local disk unavailable');
    }, fetch: async (_actor, _url, options) => {
      assert.equal(durable, true); sends++;
      const body = JSON.parse(options.body);
      assert.deepEqual(body.messages, []);
      assert.equal(body.storageMode, 'endpoint');
      assert.equal(body.snapshotComplete, false);
      return reply({ ok: true, conversationId: 'old-body', sourceRevision: body.sourceRevision });
    } });
  try {
    assert.equal((await sync.flush()).pending, 1);
    assert.equal(sends, 0);
    assert.equal((await store.jobs())[0].body.messages[0].text, 'sole queued content');
    durable = true;
    assert.equal((await sync.flush()).pending, 0);
    assert.equal(sends, 1);
    assert.equal(sync.bind({ ...handle('read-only'), localReplica: true }, actor), null);
    assert.equal((await store.jobs()).length, 0);
  } finally { await sync.close(); }
});

test('101 offline sources survive worker restart and each receive an exact ACK', async t => {
  const file = root(t), actor = identity(); let online = false;
  const sent = [];
  const transport = async (_id, _url, options) => {
    if (!online) throw Error('offline');
    const body = JSON.parse(options.body); sent.push(body.sourceSessionId);
    return reply({ ok: true, conversationId: body.sourceSessionId, sourceRevision: body.sourceRevision });
  };
  let store = createWorker(file);
  let sync = synchronize({ app: {}, store, identityOf: () => actor, fetch: transport });
  const sources = Array.from({ length: 101 }, (_, i) => handle('source-' + i));
  for (const source of sources) sync.bind(source, actor);
  assert.equal((await sync.flush()).pending, 101);
  assert.ok(sources.every(source => source.accountSync.state !== 'synced'));
  await sync.close(); online = true;
  store = createWorker(file); sync = synchronize({ app: {}, store, identityOf: () => actor, fetch: transport });
  try {
    assert.equal((await sync.flush()).pending, 1);
    assert.equal((await sync.flush()).pending, 0);
    assert.equal(new Set(sent).size, 101);
    for (const source of sources) sync.bind(source, actor);
    await sync.flush();
    assert.equal(sent.length, 101, 'persisted ACKs prevent replay of unchanged acknowledged content');
    assert.ok(sources.every(source => source.accountSync.state === 'synced'));
  } finally { await sync.close(); }
});

test('capacity failure rolls back replacement and checkpoint, preserving original replay after restart', t => {
  const file = root(t), store = create(file, { maxBytes: 1200 });
  const first = job('source');
  store.checkpointAndEnqueue('key', { sourceRevision: 1 }, first);
  const next = job('source', 2); next.body.messages = [{ text: 'x'.repeat(2000) }];
  assert.throws(() => store.checkpointAndEnqueue('key', { sourceRevision: 2 }, next), /storage is full/);
  const reopened = create(file);
  assert.equal(reopened.session('key').sourceRevision, 1);
  assert.deepEqual(reopened.jobs().map(row => row.id), [first.id]);
});

test('a failed async enqueue cannot advance the in-memory digest or consume a revision', async t => {
  const store = createWorker(root(t), { maxBytes: 2500 }), actor = identity();
  let text = 'first', online = false;
  const source = { sessionId: 'atomic', snapshot: () => ({ messages: [{ role: 'user', text, createdAt: 1 }] }) };
  const sent = [];
  const sync = synchronize({ app: {}, store, identityOf: () => actor, fetch: async (_i, _u, options) => {
    if (!online) throw Error('offline');
    const body = JSON.parse(options.body); sent.push(body);
    return reply({ ok: true, conversationId: 'atomic', sourceRevision: body.sourceRevision });
  } });
  try {
    const state = sync.bind(source, actor); await state.ready;
    const firstDigest = state.contentDigest;
    text = 'x'.repeat(20000); await state.record();
    assert.equal(state.sourceRevision, 1); assert.equal(state.contentDigest, firstDigest);
    assert.equal(source.accountSync.state, 'error');
    assert.equal((await store.jobs())[0].body.messages[0].text, 'first');
    text = 'corrected'; online = true; await sync.flush();
    assert.equal(sent.length, 1); assert.equal(sent[0].sourceRevision, 2);
    assert.equal(sent[0].messages[0].text, text); assert.equal(source.accountSync.state, 'synced');
  } finally { await sync.close(); }
});

test('same source names in separate Hubs and epochs never coalesce', t => {
  const store = create(root(t)), first = job('source');
  const second = { ...job('source', 2), hub: 'https://another.invalid' };
  const third = job('source', 3); third.body.sourceEpoch = 'replacement-epoch';
  for (const value of [first, second, third]) store.enqueue(value);
  assert.equal(store.jobs().length, 3);
});

test('legacy import preserves every job and replays an orphaned checkpoint without advancing its version', async t => {
  const file = root(t), actor = identity(), source = handle('orphan');
  const saved = new Map(); let recorded;
  const memory = { session: key => saved.get(key), setSession: (key, value) => saved.set(key, value),
    enqueue: value => { recorded = value; }, jobs: () => [] };
  const first = synchronize({ app: {}, store: memory });
  first.bind(source, actor); await first.close();
  const checkpoint = [...saved.values()][0];
  const old = { version: 1, sessions: { [accountScopeKey(actor) + ':orphan']: checkpoint },
    jobs: Array.from({ length: 120 }, (_, i) => job('queued-' + i)) };
  fs.writeFileSync(file, JSON.stringify(old));
  const bytes = fs.readFileSync(file);
  const store = create(file), requests = [];
  assert.equal(store.jobs().length, 120);
  const sync = synchronize({ app: {}, store, identityOf: () => actor, fetch: async (_i, _u, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    return reply({ ok: true, conversationId: body.sourceSessionId, sourceRevision: body.sourceRevision });
  } });
  try {
    sync.bind(source, actor); await sync.flush(); await sync.flush();
    assert.deepEqual(requests.find(body => body.sourceSessionId === 'orphan'), recorded.body);
    assert.deepEqual(fs.readFileSync(file), bytes, 'migration never rewrites the legacy recovery source');
  } finally { await sync.close(); }
});

test('blocked conflict does not starve other sources and a different Hub cannot drain private jobs', async t => {
  const actor = identity(), store = create(root(t));
  store.enqueue(job('conflict')); store.enqueue(job('good'));
  let current = { ...actor, hub: 'https://other.invalid' }; const sent = [];
  const sync = synchronize({ app: {}, store, identityOf: () => current, fetch: async (_i, _u, options) => {
    const body = JSON.parse(options.body); sent.push(body.sourceSessionId);
    return body.sourceSessionId === 'conflict' ? new Response('{"detail":"conflict"}', { status: 409 })
      : reply({ ok: true, conversationId: 'good', sourceRevision: body.sourceRevision });
  } });
  try {
    await sync.flush(); assert.deepEqual(sent, []);
    current = actor; await sync.flush(); await sync.flush();
    assert.deepEqual(sent, ['conflict', 'good']);
    assert.equal(store.jobs()[0].blocked, true);
  } finally { await sync.close(); }
});

test('over 100 blocked or foreign jobs cannot starve the active account and batches bound payload bytes', async t => {
  const actor = identity(), store = create(root(t));
  for (let i = 0; i < 120; i++) {
    const value = job('blocked-' + i); store.enqueue(value); store.fail(value.id, true);
    store.enqueue(job('foreign-' + i, 1, identity('two')));
  }
  const large = job('active'); large.body.messages = [{ text: 'x'.repeat(2000) }];
  store.enqueue(large); store.enqueue(job('last'));
  assert.equal(store.batch({ ...actor, ownerKey: accountScopeKey(actor) }, 100, 2200).length, 1);
  const sent = [];
  const sync = synchronize({ app: {}, store, identityOf: () => actor, fetch: async (_i, _u, options) => {
    const body = JSON.parse(options.body); sent.push(body.sourceSessionId);
    return reply({ ok: true, conversationId: body.sourceSessionId, sourceRevision: body.sourceRevision });
  } });
  try {
    await sync.flush(); assert.deepEqual(sent, ['active', 'last']);
    assert.equal(store.pending().length, 240);
  } finally { await sync.close(); }
});

test('a late ACK never marks a newer snapshot synced, and close durably records the last edit', async t => {
  const file = root(t), store = createWorker(file), actor = identity();
  let text = 'first', release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const source = { sessionId: 'source', snapshot: () => ({ messages: [{ role: 'user', text, createdAt: 1 }] }) };
  const sync = synchronize({ app: {}, store, identityOf: () => actor, fetch: async (_i, _u, options) => {
    const body = JSON.parse(options.body); entered();
    await new Promise(resolve => { release = resolve; });
    return reply({ ok: true, conversationId: 'source', sourceRevision: body.sourceRevision });
  } });
  const state = sync.bind(source, actor);
  const flushing = sync.flush(); await started;
  text = 'second'; await state.record(); release(); await flushing;
  assert.equal(source.accountSync.state, 'queued');
  assert.equal(source.accountSync.sourceRevision, 2);
  assert.equal((await store.jobs())[0].body.messages[0].text, 'second');
  text = 'last edit before quit';
  await sync.close();
  const reopened = create(file);
  assert.equal(reopened.jobs()[0].body.messages[0].text, text);
  assert.equal(reopened.jobs()[0].body.sourceRevision, 3);
});

test('process termination recovers committed WAL rows and rolls back an unfinished transaction', async t => {
  const file = root(t), actor = identity();
  const { spawn } = require('node:child_process');
  const script = `
    const { DatabaseSync } = require('node:sqlite');
    const store = require(process.argv[1]).create(process.argv[2], {persistent:true});
    const job = JSON.parse(process.argv[3]);
    store.checkpointAndEnqueue('key', {sourceRevision:1}, job);
    const db = new DatabaseSync(process.argv[2]+'.sqlite');
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE checkpoints SET value=? WHERE key=?').run('{"sourceRevision":999}', 'key');
    process.send('uncommitted'); setInterval(()=>{}, 1000);
  `;
  const child = spawn(process.execPath, ['-e', script, require.resolve('../main/conversation/account-sync-store'),
    file, JSON.stringify(job('durable', 1, actor))], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Crash fixture did not become ready')), 10000);
      child.once('message', () => { clearTimeout(timer); resolve(); });
      child.once('error', reject);
      child.once('exit', code => { clearTimeout(timer); reject(Error('Crash fixture exited: ' + code)); });
    });
  } finally { child.kill('SIGKILL'); await exited; }
  const store = create(file);
  assert.equal(store.session('key').sourceRevision, 1);
  assert.equal(store.jobs()[0].body.sourceSessionId, 'durable');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file + '.sqlite');
  try { assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); }
  finally { db.close(); }
});

test('concurrent directory refreshes share the load after asynchronous identity lookup', async t => {
  const store = createWorker(root(t)), actor = identity();
  let calls = 0, release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  const sync = synchronize({ app: {}, store, identityOf: async () => actor, fetch: async () => {
    calls++; entered(); await response;
    return reply({ items: [{ id: 'shared', title: 'Latest directory row', revision: 2 }], cursor: 2, hasMore: false });
  } });
  try {
    const first = sync.history({ force: true }), second = sync.history({ force: true });
    await started; release();
    const results = await Promise.all([first, second]);
    assert.equal(calls, 1, 'Concurrent refreshes must not race cache or cursor commits');
    assert.ok(results.every(result => result.ok && result.cursor === 2));
    assert.deepEqual(results[0].chats, results[1].chats);
  } finally { release(); await sync.close(); }
});

test('10000 directory rows advance across batches and restart; tombstones and scope remain isolated', async t => {
  const file = root(t), actor = identity(); let current = actor, deleted = false, offline = false;
  let clock = 100000;
  const calls = [];
  const transport = async (_i, route) => {
    if (offline) throw Error('isolated directory outage');
    const after = Number(new URL(route).searchParams.get('after')); calls.push(after);
    const items = after < 10000 ? Array.from({ length: Math.min(100, 10000 - after) }, (_, i) =>
      ({ id: 'chat-' + (after + i + 1), revision: after + i + 1 }))
      : deleted && after === 10000 ? [{ id: 'chat-1', revision: 10001, deleted: true }] : [];
    const cursor = items.at(-1)?.revision || after;
    return reply({ items, cursor, hasMore: cursor < 10000 });
  };
  let sync = synchronize({ app: {}, store: createWorker(file), identityOf: () => current, fetch: transport, now: () => clock });
  try {
    let result;
    do { result = await sync.history({ force: true }); } while (result.partial);
    assert.equal(result.chats.length, 10000); assert.equal(calls.filter(v => v === 0).length, 1);
  } finally { await sync.close(); }
  calls.length = 0;
  sync = synchronize({ app: {}, store: createWorker(file), identityOf: () => current, fetch: transport, now: () => clock });
  try {
    assert.equal((await sync.history()).chats.length, 10000); assert.deepEqual(calls, [10000]);
    offline = true;
    const stale = await sync.history({ force: true });
    assert.equal(stale.ok, false); assert.equal(stale.stale, true); assert.equal(stale.chats.length, 10000);
    offline = false;
    deleted = true;
    // Forced reads share the outage backoff; retrying UI calls cannot flood Hub.
    const backingOff = await sync.history({ force: true });
    assert.equal(backingOff.ok, false); assert.equal(backingOff.chats.length, 10000);
    clock += 5000;
    const result = await sync.history({ force: true }); assert.equal(result.chats.length, 9999);
    assert.equal(result.chats.some(row => row.id === 'chat-1'), false);
    current = { ...identity('otherDevice'), clientId: 'device-two' }; calls.length = 0;
    await sync.history(); assert.equal(calls[0], 0, 'device-specific directory permissions require a fresh cursor');
    current = identity('two'); calls.length = 0;
    await sync.history(); assert.equal(calls[0], 0);
  } finally { await sync.close(); }
});
