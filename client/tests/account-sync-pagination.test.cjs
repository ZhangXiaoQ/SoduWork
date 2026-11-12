'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { create } = require('../main/conversation/account-sync');
const { identity } = require('./helpers/platform-session-fixture.cjs');

function fixture(t, fetch) {
  let current = identity();
  const sync = create({ app: {}, identityOf: () => current, localIdentityOf: () => current,
    store: { jobs: () => [] }, fetch });
  t.after(() => sync.close());
  return { sync, actor: value => { current = value; } };
}
test('account history drains more than 100 conversations before returning a complete directory', async t => {
  const calls = [];
  const f = fixture(t, async (_actor, route) => {
    const after = Number(new URL(route).searchParams.get('after')); calls.push(after);
    const items = Array.from({ length: after ? 5 : 100 }, (_, i) => ({ id: 'conversation-' + (after + i + 1) }));
    return new Response(JSON.stringify({ items, cursor: after + items.length, hasMore: !after }));
  });
  const result = await f.sync.history();
  assert.equal(result.ok, true); assert.equal(result.chats.length, 105); assert.deepEqual(calls, [0, 100]);
});
test('account history rejects a late page after an account or Hub change', async t => {
  for (const changed of [identity('two'), { ...identity(), hub: 'https://other.invalid' }]) {
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const f = fixture(t, async () => { entered(); await gate; return new Response(JSON.stringify({ items: [{ id: 'private' }] })); });
    const request = f.sync.history(); await ready; f.actor(changed); release();
    const result = await request;
    assert.equal(result.ok, false); assert.deepEqual(result.chats, []);
  }
});

test('account history opens a stale sidebar alias through its canonical Hub id', async t => {
  const item = { id: 'hub-conversation', title: 'Archived chat', historyAliasIds: ['stale-sidebar-id'] };
  const f = fixture(t, async (_actor, route) => {
    const url = new URL(route);
    if (url.pathname.endsWith('/messages')) {
      assert.equal(url.pathname.endsWith('/account-conversations/hub-conversation/messages'), true);
      return new Response(JSON.stringify({ conversation: item,
        items: [{ id: 'message-1', role: 'assistant', text: 'ready' }], cursor: 1, hasMore: false }));
    }
    return new Response(JSON.stringify({ items: [item], cursor: 1, hasMore: false }));
  });
  const history = await f.sync.history();
  assert.equal(history.chats[0].id, 'hub-conversation');
  assert.equal(f.sync.isAccountConversation('stale-sidebar-id'), true);
  assert.equal((await f.sync.row('stale-sidebar-id')).id, 'hub-conversation');
  const projection = await f.sync.openProjection('stale-sidebar-id');
  assert.equal(projection.snapshot().messages[0].text, 'ready');
  assert.equal(projection.historyRow().id, 'hub-conversation');
});

test('account projection refreshes an unloaded sidebar alias before reading messages', async t => {
  const item = { id: 'hub-conversation', title: 'Archived chat', historyAliasIds: ['stale-sidebar-id'] };
  const calls = [];
  const f = fixture(t, async (_actor, route) => {
    const url = new URL(route);
    calls.push(url.pathname);
    if (url.pathname.endsWith('/source')) return new Response('{}', { status: 404 });
    if (url.pathname.endsWith('/messages')) return new Response(JSON.stringify({ conversation: item,
      items: [{ id: 'message-1', role: 'assistant', text: 'ready' }], cursor: 1, hasMore: false }));
    return new Response(JSON.stringify({ items: [item], cursor: 1, hasMore: false }));
  });
  const projection = await f.sync.openProjection('stale-sidebar-id');
  assert.equal(projection.snapshot().messages[0].text, 'ready');
  assert.deepEqual(calls, [
    '/api/v1/account-conversations/stale-sidebar-id/source',
    '/api/v1/account-conversations',
    '/api/v1/account-conversations/hub-conversation/messages',
  ]);
});

test('account projection retries once after a stale canonical id is rejected', async t => {
  const stale = { id: 'old-conversation', title: 'Archived chat', revision: 1, sourceSessionId: 'source-1' };
  const fresh = { id: 'new-conversation', title: 'Archived chat', revision: 2,
    sourceSessionId: 'source-1', historyAliasIds: ['old-conversation'] };
  let directoryReads = 0, messageReads = 0;
  const f = fixture(t, async (_actor, route) => {
    const url = new URL(route);
    if (url.pathname.endsWith('/messages')) {
      messageReads++;
      if (messageReads === 1) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({ conversation: fresh,
        items: [{ id: 'message-1', role: 'assistant', text: 'recovered' }], cursor: 1, hasMore: false }));
    }
    directoryReads++;
    return new Response(JSON.stringify({ items: [directoryReads === 1 ? stale : fresh], cursor: 1, hasMore: false }));
  });
  await f.sync.history();
  const projection = await f.sync.openProjection('old-conversation');
  assert.equal(projection.snapshot().messages[0].text, 'recovered');
  assert.equal(directoryReads, 2);
  assert.equal(messageReads, 2);
  assert.equal(projection.historyRow().id, 'new-conversation');
});

test('a repeating directory cursor fails without returning a silently truncated history', async t => {
  const f = fixture(t, async () => new Response(JSON.stringify({ items: [{ id: 'one' }], cursor: 0, hasMore: true })));
  const result = await f.sync.history();
  assert.equal(result.ok, false); assert.deepEqual(result.chats, []);
});
