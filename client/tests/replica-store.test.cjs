'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { create, createWorker } = require('../main/conversation/replica-store.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-replica-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'history.sqlite');
}

test('incomplete import quota rejects new bytes while allowing exact durable retries', t => {
  const file = fixture(t), body = Buffer.from(JSON.stringify([{ role: 'user', text: 'preserved' }]));
  const pointer = { sha256: require('node:crypto').createHash('sha256').update(body).digest('hex'), size: body.length };
  const store = create(file, { maxImportBytes: body.length });
  try {
    store.importChunk('first', pointer, 0, body.toString('base64'));
    assert.equal(store.importChunk('first', pointer, 0, body.toString('base64')).ok, true);
    assert.throws(() => store.importChunk('second', pointer, 0, body.toString('base64')), /storage budget/);
    store.sealImport('first', pointer, { title: 'one' });
    assert.equal(store.messages('first').items[0].text, 'preserved');
    assert.equal(store.importChunk('second', pointer, 0, body.toString('base64')).ok, true);
  } finally { store.close(); }
});
test('device lifecycle survives account changes, stale snapshots and restart', t => {
  const file = fixture(t);
  let store = create(file);
  const workspace = store.workspace();
  store.register([{ id: 'local-1', title: 'original', creator: { account: 'alice' }, historyAliasIds: ['native-1'], at: 1 }]);
  store.cache('local-1', [{ role: 'assistant', text: 'retained history' }], { expectedRevision: 0 });
  const archived = store.lifecycle('native-1', 'archive', { account: 'bob', secret: 'must-not-persist' });
  assert.equal(archived.conversation.archived, true);
  assert.equal(store.list({ archived: true }).items[0].creator.account, 'alice');
  store.lifecycle('local-1', 'delete', { account: 'bob' });
  const revision = store.get('local-1').replicaRevision;
  assert.equal(store.lifecycle('native-1', 'delete', { account: 'alice' }).unchanged, true);
  store.close();
  store = create(file);
  try {
    assert.equal(store.workspace(), workspace);
    store.register([{ id: 'native-1', creator: { account: 'bob' }, archived: false, at: 9 }]);
    assert.equal(store.get('native-1').creator.account, 'alice');
    assert.equal(store.get('native-1').replicaRevision, revision);
    assert.equal(store.list().items.length, 0);
    assert.equal(store.list({ archived: true }).items.length, 0);
    assert.equal(store.messages('local-1').items.length, 0);
    assert.equal(store.cache('local-1', [{ role: 'user', text: 'late response' }], { expectedRevision: 0 }).stale, true);
    assert.throws(() => store.lifecycle('native-1', 'restore'), /explicit restoration/);
    assert.equal(store.changes().find(row => row.action === 'archive').actor.account, 'bob');
    assert.equal(JSON.stringify(store.changes()).includes('must-not-persist'), false);
  } finally { store.close(); }
});
test('keyset pages retain equal timestamps without duplicates and ignore another replica lifecycle', t => {
  const store = create(fixture(t));
  try {
    store.register(Array.from({ length: 250 }, (_, i) => ({ id: 'session-' + String(i).padStart(3, '0'), at: 10 })));
    store.lifecycle('session-200', 'archive');
    store.lifecycle('session-201', 'delete');
    const found = []; let after;
    do { const page = store.list({ limit: 31, after }); found.push(...page.items.map(row => row.id)); after = page.next; } while (after);
    assert.equal(found.length, 248);
    assert.equal(new Set(found).size, 248);
    assert.equal(store.list({ archived: true }).items[0].id, 'session-200');
    assert.equal(store.get('session-202').deleted, false);
  } finally { store.close(); }
});

test('remote lifecycle lookup returns only explicit account-owned matching copies and survives reopening', t => {
  const file = fixture(t);
  let store = create(file);
  const copy = (id, extra = {}) => ({ id, title: 'Private title must not cross this metadata query',
    cached: true, taskId: 'task-' + id, source: { id: 'source-' + id, account: 'alice', hub: 'https://hub.test' }, ...extra });
  store.register([copy('old', { at: 1 }), copy('new', { at: 2 }), copy('untouched'),
    copy('foreign', { source: { id: 'source-foreign', account: 'bob', hub: 'https://hub.test' } }),
    copy('native', { cached: false }), copy('deleted'), copy('unlinked', { taskId: '' })]);
  for (const id of ['old', 'new', 'foreign', 'native', 'deleted', 'unlinked']) store.lifecycle(id, 'archive');
  store.lifecycle('new', 'restore');
  store.lifecycle('deleted', 'delete');
  store.register(Array.from({ length: 300 }, (_, index) => ({ id: 'irrelevant-' + index, at: 1000 + index })));
  store.close();
  // Simulate an existing version-1 database that predates the lookup indexes.
  const existing = new (require('node:sqlite').DatabaseSync)(file);
  existing.exec('DROP INDEX replica_remote_lifecycle_source; DROP INDEX replica_remote_lifecycle_task;');
  existing.close();
  store = create(file);
  try {
    const rows = store.remoteLifecycleRows({ account: 'alice', sourceIds: ['source-old'],
      taskIds: ['task-old', 'task-new', 'task-untouched', 'task-foreign', 'task-native', 'task-deleted'] });
    assert.deepEqual(rows.map(row => row.id).sort(), ['new', 'old']);
    assert.equal(rows.find(row => row.id === 'old').archived, true);
    assert.equal(rows.find(row => row.id === 'new').archived, false);
    assert.ok(rows.every(row => row.replicaRevision > 0));
    assert.ok(rows.every(row => !Object.hasOwn(row, 'title') && !Object.hasOwn(row, 'historyAliasIds')));
    assert.deepEqual(store.remoteLifecycleRows({ account: 'alice' }), []);
    assert.throws(() => store.remoteLifecycleRows({ account: 'alice', sourceIds: Array(201).fill('id') }), /batch/);
    assert.throws(() => store.remoteLifecycleRows({ account: 'alice', taskIds: ['bad\nidentity'] }), /identity/);
  } finally { store.close(); }
});

test('worker exposes relevant lifecycle metadata without loading transcript bodies', async t => {
  const store = createWorker(fixture(t));
  try {
    await store.register([{ id: 'copy', cached: true, taskId: 'task',
      source: { id: 'remote', account: 'alice', hub: 'https://hub.test' } }]);
    await store.cache('copy', [{ role: 'assistant', text: 'Private transcript' }], { expectedRevision: 0 });
    await store.lifecycle('copy', 'archive');
    const rows = await store.remoteLifecycleRows({ account: 'alice', sourceIds: ['remote'] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'copy');
    assert.equal(rows[0].archived, true);
    assert.equal(JSON.stringify(rows).includes('Private transcript'), false);
  } finally { await store.close(); }
});
test('alias collisions roll back the whole batch and preserve provenance', t => {
  const store = create(fixture(t));
  try {
    store.register([{ id: 'one' }, { id: 'two' }]);
    assert.throws(() => store.register([{ id: 'new' }, { id: 'one', historyAliasIds: ['two'] }]), /Conflicting/);
    assert.equal(store.get('new'), null);
    assert.equal(store.get('two').id, 'two');
    assert.throws(() => store.lifecycle('missing', 'delete'), /does not exist/);
  } finally { store.close(); }
});
test('authenticated source IDs resolve the local replay copy without title matching', t => {
  const store = create(fixture(t));
  try {
    store.register([{ id: 'copy-1', title: 'Same title', cached: true,
      source: { id: 'acct-1', conversationId: 'cloud-1' }, sourceSessionId: 'native-1' }]);
    assert.equal(store.get('acct-1').id, 'copy-1');
    assert.equal(store.get('cloud-1').id, 'copy-1');
    assert.equal(store.get('native-1').id, 'copy-1');
    assert.equal(store.get('other-title-without-origin'), null);
  } finally { store.close(); }
});
test('worker commits cache and lifecycle in order and closes cleanly', async t => {
  const store = createWorker(fixture(t));
  try {
    await store.register([{ id: 'cloud-copy', source: { conversation: 'cloud-original', hub: 'https://example.test' } }]);
    await store.cache('cloud-copy', [{ role: 'user', text: 'cached locally' }], { expectedRevision: 0, complete: true });
    assert.equal((await store.messages('cloud-copy')).items[0].text, 'cached locally');
    const deletion = store.lifecycle('cloud-copy', 'delete', { account: 'different-user' });
    const late = store.cache('cloud-copy', [{ role: 'assistant', text: 'late' }], { expectedRevision: 0 });
    assert.equal((await deletion).ok, true);
    assert.equal((await late).stale, true);
    assert.equal((await store.list()).items.length, 0);
  } finally { await store.close(); }
});
