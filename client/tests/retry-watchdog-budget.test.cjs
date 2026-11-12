'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const control = require('../main/pi-session/run-control');
const { create } = require('../e2e/fixtures/resumed-pi.cjs');

test('successful tool replies cannot replenish the turn-wide model retry budget', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-retry-segments-'));
  const fixture = await create(root);
  t.after(async () => { await fixture.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 6 }); });
  fs.writeFileSync(path.join(fixture.agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 6, delayScheduleMs: [1, 1, 1, 1, 1, 1] } }));
  fixture.reply((_body, count) => count % 2 === 0
    ? { tool: 'write', args: { path: 'receipt-' + count + '.txt', content: 'completed once' } }
    : { respond(response) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Isolated transient failure HTTP 503' } }));
    } });
  await fixture.open();
  await fixture.handle.submit('Write the isolated receipts and summarize.').completion;
  const final = fixture.handle.snapshot();
  assert.equal(fixture.requests.length, 13, 'six retries across successful SDK segments must remain six retries');
  assert.equal(final.tools.filter(row => row.name === 'write').length, 6);
  assert.equal(final.completion.reason, 'error');
  assert.equal(final.execution.turnQueue.paused, true);
});

for (const recovers of [true, false]) test('real SDK sixth backoff keeps a single turn budget; recovers=' + recovers,
  { timeout: 30000 }, async t => {
    assert.equal(require('../scripts/patch-pi-retry-schedule.cjs').patchPiRetrySchedule().ok, true);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-watchdog-budget-'));
    const fixture = await create(root), originalMonitor = control.startMonitor, originalTimeout = global.setTimeout;
    let state, tick, checked = false;
    control.startMonitor = (run, ctx) => {
      state = run;
      const interval = global.setInterval;
      global.setInterval = (callback, delay, ...args) => {
        if (delay === 10000) tick = callback;
        return interval(callback, delay, ...args);
      };
      try { originalMonitor(run, ctx); } finally { global.setInterval = interval; }
    };
    // Accelerate only the wall-clock sleep; the actual announced retry deadline
    // and watchdog judgment remain untouched.
    global.setTimeout = (callback, delay, ...args) => originalTimeout(callback, delay === 240000 ? 100 : delay, ...args);
    t.after(async () => {
      control.startMonitor = originalMonitor; global.setTimeout = originalTimeout;
      await fixture.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 6 });
    });
    fs.writeFileSync(path.join(fixture.agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 6, maxAgentDelayMs: 240000, delayScheduleMs: [1, 1, 1, 1, 1, 240000] } }));
    fixture.reply((_body, count) => {
      if (count === 1) return { tool: 'write', args: { path: 'saved.txt', content: 'saved once' } };
      if (count <= 7 || !recovers) return { respond(response) {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Isolated transient failure HTTP 503' } }));
      } };
      return { text: 'Recovered within the original retry budget.' };
    });
    await fixture.open();
    fixture.handle.on(() => {
      const retry = fixture.handle.snapshot().modelRetry;
      if (retry?.active && retry.attempt === 6 && !checked) {
        checked = true;
        setImmediate(() => {
          assert.equal(retry.delayMs, 240000);
          state.lastActivityAt = Date.now() - 181000;
          tick();
          assert.equal(Boolean(state.stalledIncident), false);
        });
      }
    });
    const result = await fixture.handle.submit('Save the file and summarize.').completion;
    assert.equal(checked, true);
    // Prompt settlement and model completion are separate contracts. The queue
    // must remain paused on a model error even though the prompt promise settled.
    const final = fixture.handle.snapshot();
    assert.equal(final.completion.reason, recovers ? 'stop' : 'error');
    assert.equal(final.status, recovers ? 'idle' : 'unreachable');
    if (!recovers) {
      assert.equal(final.completion.retryable, true);
      assert.equal(final.execution.turnQueue.paused, true);
    } else assert.equal(result.ok, true);
    assert.equal(fixture.requests.length, 8);
    assert.equal(fixture.handle.snapshot().tools.filter(row => row.name === 'write').length, 1);
    assert.equal(fixture.requests.some(row => JSON.stringify(row.messages).includes('<soduwork-internal-runtime-recovery>')), false);
  });
