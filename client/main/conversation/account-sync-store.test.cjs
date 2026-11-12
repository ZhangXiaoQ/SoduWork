'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('the durable outbox keeps only the newest complete checkpoint per source session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-account-sync-'));
  const file = path.join(root, 'outbox.json');
  const store = require('./account-sync-store').create(file);
  const job = revision => ({
    id: 'job-' + revision, ownerKey: 'account', clientId: 'desktop',
    body: { sourceSessionId: 'session', sourceRevision: revision, snapshotComplete: true },
  });
  store.enqueue(job(1));
  store.enqueue(job(2));
  assert.deepEqual(store.jobs().map(item => item.body.sourceRevision), [2]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('lifecycle tombstones survive reopen without advancing the directory cursor or accepting older rows', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-account-lifecycle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'outbox.json');
  const store = require('./account-sync-store').create(file);
  store.saveDirectory('account-a', [{ id: 'acct-1', revision: 3, archived: false }], 3);
  store.saveDirectory('account-a', [{ id: 'acct-1', sourceSessionId: 'native-1', revision: 8,
    lifecycleRevision: 8, deleted: true }]);
  store.saveDirectory('account-a', [{ id: 'acct-1', revision: 4, deleted: false }], 4);
  store.saveDirectory('account-a', [], 2);
  const reopened = require('./account-sync-store').create(file);
  assert.equal(reopened.directory('account-a').cursor, 4);
  assert.deepEqual(reopened.directory('account-a').items, [{ id: 'acct-1', sourceSessionId: 'native-1',
    revision: 8, lifecycleRevision: 8, deleted: true }]);
  assert.deepEqual(reopened.directory('account-b').items, []);
});

test('upgrading discarded tombstones resets only directory cursors once and preserves pending work', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-account-cursor-upgrade-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'outbox.json'), factory = require('./account-sync-store').create;
  const old = factory(file);
  old.saveDirectory('account-a', [{ id: 'active', revision: 8 }], 10);
  old.setSession('checkpoint', { sourceSessionId: 'native', conversationId: 'deleted-account-row' });
  old.enqueue({ id: 'pending', ownerKey: 'owner', clientId: 'device', body: { sourceSessionId: 'native', sourceRevision: 1 } });
  const db = new (require('node:sqlite').DatabaseSync)(file + '.sqlite');
  db.exec("DELETE FROM metadata WHERE key='lifecycle-tombstones'"); db.close();
  const upgraded = factory(file);
  assert.equal(upgraded.directory('account-a').cursor, 0);
  assert.equal(upgraded.directory('account-a').items[0].id, 'active');
  assert.equal(upgraded.session('checkpoint').conversationId, 'deleted-account-row');
  assert.equal(upgraded.jobs()[0].id, 'pending');
  upgraded.saveDirectory('account-a', [{ id: 'deleted-account-row', revision: 9, deleted: true }], 10);
  const restarted = factory(file);
  assert.equal(restarted.directory('account-a').cursor, 10, 'the migration does not trigger a full scan on every startup');
  assert.equal(restarted.directory('account-a').items.find(item => item.id === 'deleted-account-row').deleted, true);
  assert.equal(restarted.jobs().length, 1);
});
