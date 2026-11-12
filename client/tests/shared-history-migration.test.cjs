'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const make = require('../main/conversation/replica-store.cjs').createWorker;
const pointerFor = value => {
  const bytes = Buffer.from(JSON.stringify(value));
  return { bytes, pointer: { schema: 1, scope: 'a'.repeat(64), runnerId: 'runner',
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length } };
};
async function upload(store, id, object) {
  for (let offset = 0; offset < Math.max(1, object.bytes.length); offset += 256 * 1024)
    await store.importChunk(id, object.pointer, offset, object.bytes.subarray(offset, offset + 256 * 1024).toString('base64'));
}

test('paged history publishes only a complete manifest and survives a process restart mid-import', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-pages-')), file = path.join(root, 'history.sqlite');
  let store = make(file);
  t.after(async () => { await store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const pages = [pointerFor([{ role: 'user', text: 'first' }, { role: 'assistant', text: 'second' }]),
    pointerFor([{ role: 'assistant', text: 'third' }])];
  const plan = pointerFor({ format: 'soduwork.account-history.pages.v1', count: 3,
    pages: pages.map((page, index) => ({ ...page.pointer, count: index ? 1 : 2 })) });
  await upload(store, 'copy', plan);
  await upload(store, 'copy', pages[0]);
  let decoded = await store.importPlan('copy', plan.pointer);
  await store.importPage('copy', plan.pointer, decoded.pages[0], 0);
  assert.equal((await store.list()).items.length, 0);
  await assert.rejects(store.sealImport('copy', plan.pointer, {}), /incomplete/);
  await store.close(); store = make(file);
  decoded = await store.importPlan('copy', plan.pointer);
  assert.equal(decoded.pages[0].staged, true);
  assert.equal(decoded.pages[1].staged, false);
  await store.importPage('copy', plan.pointer, decoded.pages[0], 0);
  await upload(store, 'copy', pages[1]);
  await assert.rejects(store.importPage('copy', plan.pointer, { ...decoded.pages[1], scope: 'b'.repeat(64) }, 1), /manifest/);
  await store.importPage('copy', plan.pointer, decoded.pages[1], 1);
  assert.equal((await store.sealImport('copy', plan.pointer, {})).count, 3);
  assert.deepEqual((await store.messages('copy')).items.map(item => item.text), ['first', 'second', 'third']);
  await store.lifecycle('copy', 'delete');
  await store.close(); store = make(file);
  assert.equal((await store.sealImport('copy', plan.pointer, {})).durable, true);
  assert.equal((await store.sealImport('copy', plan.pointer, {})).deleted, true);
  assert.equal((await store.messages('copy')).unavailable, true);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-import-'));
  const store = make(path.join(root, 'history.sqlite'));
  t.after(async () => { await store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return store;
}

test('partial import is invisible; durable seal verifies bytes and deletion prevents replay', async t => {
  const store = fixture(t);
  const body = Buffer.from(JSON.stringify([{ role: 'user', text: 'x'.repeat(300000) }, { role: 'assistant', text: 'retained' }]));
  const pointer = { sha256: crypto.createHash('sha256').update(body).digest('hex'), size: body.length };
  await store.importChunk('copy', pointer, 0, body.subarray(0, 256 * 1024).toString('base64'));
  assert.equal((await store.list()).items.length, 0);
  await assert.rejects(store.sealImport('copy', pointer, { title: 'Copy' }), /checksum/);
  await store.importChunk('copy', pointer, 256 * 1024, body.subarray(256 * 1024).toString('base64'));
  assert.equal((await store.sealImport('copy', pointer, { title: 'Copy' })).durable, true);
  assert.equal((await store.messages('copy')).items[1].text, 'retained');
  assert.equal((await store.sealImport('copy', pointer, { title: 'Copy' })).sha256, pointer.sha256);
  await store.lifecycle('copy', 'delete', { account: 'second-user' });
  assert.equal((await store.importChunk('copy', pointer, 0, body.subarray(0, 256 * 1024).toString('base64'))).deleted, true);
  assert.equal((await store.sealImport('copy', pointer, {})).deleted, true);
  assert.equal((await store.sealImport('copy', pointer, {})).durable, true);
  assert.equal((await store.messages('copy')).unavailable, true);
  const changed = { ...pointer, sha256: 'f'.repeat(64) };
  assert.equal((await store.importChunk('copy', changed, 0, body.subarray(0, 256 * 1024).toString('base64'))).ok, false);
  assert.equal((await store.sealImport('copy', changed, {})).ok, false);
  assert.equal((await store.list()).items.length, 0);
});

test('restarted worker retains imported bodies and local tombstones', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-import-restart-')), file = path.join(root, 'history.sqlite');
  let store = make(file);
  t.after(async () => { await store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const body = Buffer.from(JSON.stringify([{ role: 'assistant', text: 'saved' }]));
  const pointer = { sha256: crypto.createHash('sha256').update(body).digest('hex'), size: body.length };
  await store.importChunk('copy', pointer, 0, body.toString('base64'));
  await store.close(); store = make(file);
  await store.sealImport('copy', pointer, { title: 'Restarted' });
  await store.close(); store = make(file);
  assert.equal((await store.messages('copy')).items[0].text, 'saved');
  await store.lifecycle('copy', 'delete');
  await store.close(); store = make(file);
  assert.equal((await store.get('copy')).deleted, true);
  assert.equal((await store.sealImport('copy', pointer, {})).deleted, true);
  assert.equal((await store.sealImport('copy', pointer, {})).durable, true);
});

test('a deleted legacy import acknowledges retries without publishing its retained endpoint content', async t => {
  const store = fixture(t);
  const body = Buffer.from(JSON.stringify([{ role: 'assistant', text: 'legacy body' }]));
  const pointer = { sha256: crypto.createHash('sha256').update(body).digest('hex'), size: body.length };
  await store.importChunk('deleted', pointer, 0, body.toString('base64'));
  assert.equal((await store.sealImport('deleted', pointer, { deleted: true })).durable, true);
  assert.equal((await store.importChunk('deleted', pointer, 0, body.toString('base64'))).ok, true);
  assert.equal((await store.sealImport('deleted', pointer, {})).deleted, true);
  assert.equal((await store.list()).items.length, 0);
  assert.equal((await store.messages('deleted')).unavailable, true);
});

test('a child discovered before its public identity joins without losing archive or aliases', async t => {
  const store = fixture(t);
  await store.register([{ id: 'child', adapterId: 'codex-harness', at: 1 }]);
  await store.lifecycle('child', 'archive');
  await store.join('public', ['child']);
  assert.equal((await store.get('child')).id, 'public');
  assert.equal((await store.get('public')).archived, true);
  assert.deepEqual((await store.get('public')).historyAliasIds, ['child']);
  await store.register([{ id: 'child', at: 2 }, { id: 'public', title: 'Public' }]);
  const rows = (await store.list({ archived: true })).items;
  assert.deepEqual(rows.map(row => row.id), ['public']);
  await store.lifecycle('child', 'delete');
  assert.equal((await store.get('public')).deleted, true);
});

test('validated runtime aliases preserve deletion and publish retirement of old directory rows', async t => {
  const store = fixture(t);
  await store.register([{ id: 'first', adapterId: 'pi', at: 1 }, { id: 'second', adapterId: 'codex-harness', at: 2 }]);
  await store.lifecycle('second', 'delete');
  await store.join('first', ['second']);
  const row = await store.get('first');
  assert.equal(row.deleted, true);
  assert.equal((await store.get('second')).id, 'first');
  const directory = await store.directory(0, 100);
  assert.equal(directory.items.find(item => item.id === 'second').deleted, true);
  assert.equal((await store.list()).items.length, 0);
});

test('transcript pages remain byte bounded without dropping large messages', async t => {
  const store = fixture(t);
  const [row] = await store.register([{ id: 'large', at: 1 }]);
  await store.cache('large', Array.from({ length: 8 }, (_, i) => ({ role: 'assistant', text: String(i).repeat(600000) })),
    { expectedRevision: row.replicaRevision });
  let after = -1, seen = 0;
  do {
    const page = await store.messages('large', { after, limit: 200 });
    assert.ok(Buffer.byteLength(JSON.stringify(page.items)) < 2 * 1024 * 1024);
    seen += page.items.length; after = page.next;
  } while (after != null);
  assert.equal(seen, 8);
});

test('deleting a native source fences both early and late legacy migration copies', async t => {
  const store = fixture(t);
  await store.register([{ id: 'native', adapterId: 'pi' }]);
  const body = Buffer.from(JSON.stringify([{ role: 'assistant', text: 'legacy sole copy' }]));
  const pointer = { sha256: crypto.createHash('sha256').update(body).digest('hex'), size: body.length };
  await store.importChunk('early', pointer, 0, body.toString('base64'));
  await store.sealImport('early', pointer, { sourceLocalId: 'native' });
  assert.equal((await store.messages('early')).items.length, 1);
  await store.register([{ id: 'public', adapterId: 'codex-harness' }]);
  await store.join('public', ['native']);
  await store.importChunk('late', pointer, 0, body.toString('base64'));
  await store.lifecycle('public', 'delete');
  assert.equal((await store.messages('early')).unavailable, true);
  assert.equal((await store.sealImport('late', pointer, { sourceLocalId: 'native' })).durable, true);
  assert.equal((await store.messages('late')).unavailable, true);
  assert.equal((await store.list()).items.length, 0);
  assert.equal((await store.sealImport('early', pointer, {})).deleted, true);
});
