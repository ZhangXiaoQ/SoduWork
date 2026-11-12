'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { create } = require('../main/conversation/content-migration.cjs');
const { identity } = require('./helpers/platform-session-fixture.cjs');
const reply = (value, status = 200) => ({ ok: status === 200, status, json: async () => value });
test('migration fences old writers first and never clears content on an old Hub', async () => {
  const calls = [], actor = identity();
  const service = create({ identityOf: async () => actor, fetch: async (_, route) => {
    calls.push(route); return reply({ metadataOnly: false, pending: { account: 1 } });
  } });
  await service.run(); assert.equal(calls.length, 1);
  assert.equal(service.snapshot(actor).phase, 'waiting-upgrade'); await service.close();
});
test('offline sources do not starve later pages or cloud categories', async () => {
  const requests = [], actor = identity(); let migrated = 0;
  const service = create({ budget: 10, identityOf: async () => actor, fetch: async (_, route, options) => {
    const url = new URL(route); requests.push({ url, options });
    if (url.pathname.endsWith('/status')) return reply({ metadataOnly: true, complete: false, pending: { account: 3, handoff: 1 } });
    if (options.method === 'GET') {
      if (url.searchParams.get('kind') === 'handoff') return reply({ items: [{ id: 'cloud' }], hasMore: false });
      return reply(url.searchParams.get('after') ? { items: [{ id: 'available' }], hasMore: false } :
        { items: [{ id: 'offline-a' }, { id: 'offline-b' }], hasMore: true, cursor: 'offline-b' });
    }
    if (url.pathname.includes('offline-')) return reply({ detail: 'Endpoint offline' }, 409);
    migrated++; return reply({ ok: true });
  } });
  await service.run(); assert.equal(migrated, 1);
  await service.run(); assert.equal(migrated, 3);
  assert.ok(requests.some(row => row.url.searchParams.get('after') === 'offline-b'));
  assert.equal(service.snapshot(actor).phase, 'pending'); await service.close();
});
test('execution migration obeys its request budget and never reports pending content as complete', async () => {
  let writes = 0; const actor = identity();
  const service = create({ budget: 3, identityOf: async () => actor, fetch: async (_, route, options) => {
    if (route.endsWith('/status')) return reply({ metadataOnly: true, complete: false, pending: { execution: 1 } });
    if (options.method === 'GET') return reply({ items: [{ id: 'long' }], hasMore: false });
    writes++; return reply({ ok: true, complete: false });
  } });
  await service.run(); assert.equal(writes, 3); assert.equal(service.snapshot(actor).phase, 'pending'); await service.close();
});
test('account switch drops a late migration directory without starting transfers', async () => {
  let actor = identity(), writes = 0;
  const initial = actor;
  const service = create({ identityOf: async () => actor, fetch: async (_, route, options) => {
    if (route.endsWith('/status')) return reply({ metadataOnly: true, pending: { account: 1 } });
    if (options.method === 'POST') writes++;
    actor = identity('two'); return reply({ items: [{ id: 'old-account' }], hasMore: false });
  } });
  await service.run(); assert.equal(writes, 0);
  assert.equal(service.snapshot(actor).phase, 'idle'); assert.equal(service.snapshot(initial).phase, 'pending'); await service.close();
});
