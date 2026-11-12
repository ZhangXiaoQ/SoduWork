'use strict';

// Isolated endpoint storage pressure. No account config, live Hub or transcript
// is loaded. Report measured latency separately from data-integrity assertions.
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { createWorker } = require('../main/conversation/replica-store.cjs');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-history-pressure-'));
  let store = createWorker(path.join(root, 'history.sqlite'));
  const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
  const started = performance.now();
  try {
    for (let first = 0; first < 10000; first += 500) {
      await store.register(Array.from({ length: 500 }, (_, n) => ({ id: 'session-' + (first + n), at: 1000, title: 'Isolated history ' + (first + n) })));
    }
    const messages = Array.from({ length: 100 }, (_, n) => ({ id: 'message-' + n, role: n % 2 ? 'assistant' : 'user', text: 'isolated text '.repeat(100) }));
    for (let first = 0; first < 1000; first += 20) {
      await Promise.all(Array.from({ length: 20 }, (_, n) => store.cache('session-' + (first + n), messages, { expectedRevision: 0, complete: true })));
    }
    const writeMs = performance.now() - started;
    const latencies = [], seen = new Set(); let after;
    do {
      const tick = performance.now();
      const page = await store.list({ after, limit: 200 });
      latencies.push(performance.now() - tick);
      for (const row of page.items) { assert.equal(seen.has(row.id), false); seen.add(row.id); }
      after = page.next;
    } while (after);
    assert.equal(seen.size, 10000);
    for (let n = 0; n < 100; n++) await store.lifecycle('session-' + n, 'delete', { account: 'another-account' });
    await store.close(); store = createWorker(path.join(root, 'history.sqlite'));
    for (let n = 0; n < 100; n++) {
      const [row] = await store.register([{ id: 'session-' + n, at: 99999 }]);
      assert.equal(row.deleted, true);
      assert.equal((await store.cache(row.id, messages, { expectedRevision: 0 })).stale, true);
    }
    assert.equal((await store.messages('session-999')).items.length, 100);
    latencies.sort((a, b) => a - b);
    delay.disable();
    console.log(JSON.stringify({ conversations: 10000, messages: 100000, deletesAfterRestart: 100,
      writeMs: Math.round(writeMs), elapsedMs: Math.round(performance.now() - started),
      pageP95Ms: Number(latencies[Math.floor(latencies.length * .95)].toFixed(2)),
      mainLoopP99Ms: Number((delay.percentile(99) / 1e6).toFixed(2)),
      mainLoopMaxMs: Number((delay.max / 1e6).toFixed(2)), rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024), integrity: 'passed' }));
  } finally {
    delay.disable(); await store.close(); fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
