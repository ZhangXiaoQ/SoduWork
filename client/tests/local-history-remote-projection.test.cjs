'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../main/pi-session/local-history-remote.cjs');
const { identity } = require('./helpers/platform-session-fixture.cjs');
const { accountId } = require('../main/device-auth-request');

test('phone history preserves task identity only for copies from the current Hub and account', async () => {
  const actor = identity(), account = accountId(actor);
  const copied = {id: 'copy-cloud', cached: true, taskId: 'task-cloud', title: 'Same title',
    source: {hub: actor.hub, account, id: 'cloud-sync-original'}, revision: 1};
  const rows = [copied,
    {...copied, id: 'copy-pc', taskId: 'task-pc', revision: 2},
    {...copied, id: 'native', cached: false, revision: 3},
    {...copied, id: 'other-account', source: {...copied.source, account: 'another'}, revision: 4},
    {...copied, id: 'other-hub', source: {...copied.source, hub: 'https://different.invalid'}, revision: 5},
    {...copied, id: 'unknown-source', source: null, revision: 6},
  ];
  let reads = 0;
  const remote = create({app: {}, session: {}, identityOf: async () => actor,
    history: {directory: async () => ({items: rows, cursor: 6, hasMore: false, workspace: 'pc'}),
      resolve: async id => rows.find(row => row.id === id),
      read: async () => { reads++; return {items: [], cursor: 0, hasMore: false}; }},
  });
  const page = await remote({action: 'list'}, async () => {});
  assert.deepEqual(page.items.map(row => row.taskProjectionId), ['task-cloud', 'task-pc', '', '', '', '']);
  assert.deepEqual(page.items.map(row => row.id), rows.map(row => row.id));
  for (const item of page.items) {
    assert.equal(item.localReplica, true);
    assert.equal(item.canContinue, false, 'a projection link is not execution authority');
    assert.equal(item.source, undefined, 'private source metadata stays on the PC');
  }
  const read = await remote({action: 'read', id: copied.id}, async () => {});
  assert.equal(read.conversation.id, copied.id);
  assert.equal(read.conversation.taskProjectionId, copied.taskId);
  assert.equal(reads, 1);
});


test('phone receives explicit zero counts for old unsent review placeholders, never unknown-as-zero', async () => {
  const rows = [
    { id: 'empty-review', count: 0, status: 'idle', state: 'completed' },
    { id: 'real-review', count: 4, status: 'idle', state: 'completed' },
    { id: 'older-unknown', state: 'completed' },
    { id: 'working', count: 0, status: 'streaming', state: 'running' },
  ];
  const remote = create({ app: {}, session: {}, identityOf: async () => identity(),
    history: { directory: async () => ({ items: rows, cursor: 4, hasMore: false }) } });
  const page = await remote({ action: 'list' }, async () => {});
  assert.deepEqual(page.items.map(row => row.messageCount), [0, 4, undefined, 0]);
  assert.deepEqual(page.items.map(row => row.state), ['idle', 'idle', 'completed', 'running']);
  assert.equal(page.items[0].canContinue, false);
  assert.equal(page.items[0].deleted, false, 'draft metadata is preserved, not tombstoned');
});
