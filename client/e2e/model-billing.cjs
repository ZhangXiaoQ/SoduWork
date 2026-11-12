'use strict';
// Invoked by test_model_gateway_diagnostics.py: real production Session/SDK ->
// loopback Hub -> simulated provider. No user profile, external service or tool execution.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { create } = require('./fixtures/resumed-pi.cjs');
const guard = require('../main/pi-session/tool-guard');
const errors = require('../main/pi-session/model-errors');

(async () => {
  const hub = new URL(process.env.SODUWORK_FIXTURE_HUB);
  assert.equal(hub.hostname, '127.0.0.1');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-billing-sdk-'));
  const original = guard.prepareGuardedBash;
  let fixture;
  try {
    guard.prepareGuardedBash = async (sdk, cwd, settings) => guard.createGuardedBash(sdk, cwd, settings,
      { resolvedShell: { shellPath: process.execPath, source: 'isolated-billing-check' } });
    fixture = await create(root);
    fs.writeFileSync(path.join(fixture.agentDir, 'settings.json'), JSON.stringify({
      compaction: { enabled: false }, retry: { enabled: true, maxRetries: 3,
        baseDelayMs: 20, delayScheduleMs: [20, 40, 60] },
    }));
    fixture.reply(() => ({ respond: async (response, body) => {
      const upstream = await fetch(new URL('/api/v1/ai-proxy/v1/chat/completions', hub), {
        method: 'POST', headers: { 'content-type': 'application/json',
          authorization: 'Bearer ' + process.env.SODUWORK_FIXTURE_TICKET }, body: JSON.stringify(body),
      });
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') });
      response.end(await upstream.text());
    } }));
    await fixture.open();
    let retryAttempts = 0;
    fixture.handle.on(() => { if (fixture.handle.snapshot().modelRetry?.active) retryAttempts++; });
    await fixture.handle.submit('Check the isolated billing response.').completion;
    const snapshot = fixture.handle.snapshot();
    assert.equal(fixture.requests.length, 1, 'billing must not trigger SDK retries');
    assert.equal(retryAttempts, 0);
    assert.match(JSON.stringify(snapshot), /余额|billing_required/);
    const classified = errors.describe(JSON.stringify(snapshot));
    assert.equal(classified.retryable, false);
    assert.doesNotMatch(classified.publicText, /private\.invalid/);
    process.stdout.write(JSON.stringify({ ok: true, retryAttempts, requests: fixture.requests.length }) + '\n');
  } finally {
    guard.prepareGuardedBash = original;
    await fixture?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
