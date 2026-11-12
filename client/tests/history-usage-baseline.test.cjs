'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const stream = require('../main/pi-session/event-stream');
const { seed } = require('../main/pi-session/history-seed');
const { createUsageReporter } = require('../main/agent-runtime/usage-reporter');

const start = Date.parse('2026-11-11T00:00:00Z');
function entry(index, total = 1, token = '', provider = 'platform-provider') {
  return { id: 'archive-' + index, type: 'message', timestamp: new Date(start + index * 1000).toISOString(),
    message: { role: 'assistant', model: 'shared-name', provider: 'soduwork',
      usageProvider: provider, content: [{ type: 'text', text: 'archive text ' + index }],
      usage: { input: total, output: 0, totalTokens: total, cost: { total: 0 } }, stopReason: 'stop',
      ...(token ? { quotaUsageToken: token } : {}) } };
}
function restore(acc, entries) {
  return seed(acc, { state: { messages: [] }, sessionManager: { getEntries: () => entries } },
    { maxMessages: 240, nativeAgentId: 'pi' });
}

test('restoring over 240 messages keeps every accounting fact without expanding the UI replay', () => {
  const entries = Array.from({ length: 260 }, (_, n) => entry(n, 1,
    n >= 10 && n < 20 ? 'historical-personal-ticket' : '', n >= 10 && n < 20 ? 'personal-provider' : 'platform-provider'));
  const acc = stream.create();
  assert.equal(restore(acc, entries), 240);
  assert.equal(acc.state.messages.length, 240);
  const receipts = acc.snapshot().usageReceipts;
  assert.equal(receipts.length, 260);
  assert.equal(receipts.reduce((sum, receipt) => sum + receipt.usage.total, 0), 260);
  assert.equal(receipts[0].at, start);
  assert.equal(receipts[10].at, start + 10000);
  assert.equal(receipts[10].provider, 'personal-provider');
  assert.equal(receipts[10].quotaUsageToken, 'historical-personal-ticket');
  assert.equal(receipts[10].agent, 'pi');
  assert.equal(receipts[10].usage.costKnown, false, 'SDK zero pricing remains unknown');
  assert.equal(receipts[20].quotaUsageToken, undefined);
  assert.ok(receipts.every(receipt => !('content' in receipt) && !('blocks' in receipt) && !('text' in receipt)));
  assert.doesNotMatch(JSON.stringify(acc.uiSnapshot()), /quotaUsageToken|historical-personal-ticket|accountingHistory|archive text 0/);
  assert.ok(acc.uiSnapshot().messages.length <= 80);
  assert.equal(restore(acc, entries), 240);
  assert.equal(acc.snapshot().usageReceipts.length, 260, 'reseed replaces its baseline instead of double-counting tail replay');
  const next = entry(260, 5);
  acc.push({ type: 'message_start', message: next.message });
  acc.push({ type: 'message_end', message: { ...next.message, completedAt: start + 260000 } });
  assert.equal(acc.snapshot().usageReceipts.length, 261);
  assert.equal(acc.snapshot().usageReceipts.at(-1).usage.input, 5);
  entries.push(next);
  restore(acc, entries);
  assert.equal(acc.snapshot().usageReceipts.length, 261, 'a live call now in the archive is counted only once after reseed');
});

test('restored outbox crosses persisted server highwater with separate personal and platform increments', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-history-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entries = Array.from({ length: 250 }, (_, n) => entry(n));
  const acc = stream.create(); restore(acc, entries);
  const received = [], deltas = [];
  let highwater = 250, platform = 250, personal = 0, failOnce = true;
  // Exercise the actual reporter HTTP/outbox contract against the server's
  // monotonic cumulative rule, starting with already-settled historical usage.
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', part => body += part);
    req.on('end', () => {
      const payload = JSON.parse(body); received.push(payload);
      const delta = Math.max(0, payload.usage.total - highwater);
      highwater = Math.max(highwater, payload.usage.total);
      const selfFunded = payload.quotaUsageToken === 'personal-call-ticket';
      if (selfFunded) personal += delta; else platform += delta;
      if (delta) deltas.push([delta, selfFunded ? 'personal' : 'platform']);
      if (selfFunded && failOnce) { failOnce = false; res.writeHead(503); res.end('{}'); }
      else { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const identity = { hub: 'http://127.0.0.1:' + server.address().port, clientId: 'fixture-device', session: 'fixture-session' };
  const handle = { sessionId: 'same-restored-session', adapterId: 'pi', model: 'shared-name', usageIdentity: identity };
  const reporter = createUsageReporter({ app: { getPath: () => root }, identityOf: async () => identity });
  reporter.observe(handle, acc.snapshot()); await reporter.flush();
  assert.equal(received.at(-1).usage.total, 250);
  for (const [n, total, token] of [[250, 5, 'personal-call-ticket'], [251, 3, '']]) {
    const message = { ...entry(n, total, token).message, completedAt: start + n * 1000 };
    acc.push({ type: 'message_start', message }); acc.push({ type: 'message_end', message });
    reporter.observe(handle, acc.snapshot());
  }
  await reporter.persist(); await reporter.flush(); await reporter.flush();
  assert.deepEqual(received.map(row => row.usage.total), [250, 255, 255, 258]);
  assert.deepEqual(deltas, [[5, 'personal'], [3, 'platform']]);
  assert.equal(platform, 253); assert.equal(personal, 5);
  assert.equal(new Set(received.map(row => row.idempotencyKey)).size, 1);
  assert.equal(received.at(-1).quotaUsageToken, undefined);
  assert.equal(received[1].provider, 'platform-provider', 'same provider/model can have different actual funding');
  reporter.observe(handle, acc.snapshot()); await reporter.flush();
  assert.equal(received.length, 4, 'observing unchanged restored state never repeats a settled checkpoint');
});

test('reseed changes old accounting without changing the visible tail or reusing stale cached receipts', () => {
  const original = Array.from({ length: 260 }, (_, n) => entry(n));
  const acc = stream.create(); restore(acc, original);
  const old = acc.snapshot().usageReceipts;
  const tail = JSON.stringify(acc.uiSnapshot().messages);
  const changed = original.slice();
  changed[0] = entry(0, 7, 'older-personal-ticket', 'changed-provider');
  // A display reload may reuse its message array and the same 240-message tail.
  // The accounting archive identity is independently part of the cache key.
  const messages = acc.state.messages;
  messages.length = 0;
  restore(acc, changed);
  assert.equal(acc.state.messages, messages);
  assert.equal(acc.state.messages.length, 240);
  assert.equal(JSON.stringify(acc.uiSnapshot().messages), tail);
  const fresh = acc.snapshot().usageReceipts;
  assert.notEqual(fresh, old);
  assert.equal(fresh.length, 260);
  assert.equal(fresh[0].usage.total, 7);
  assert.equal(fresh[0].provider, 'changed-provider');
  assert.equal(fresh[0].quotaUsageToken, 'older-personal-ticket');
  assert.equal(old[0].usage.total, 1);
});
