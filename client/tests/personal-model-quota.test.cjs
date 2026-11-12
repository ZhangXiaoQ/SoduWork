'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const http = require('node:http');
const { create, beforeTurn } = require('../main/conversation/quota-admission.cjs');
const { createTurnQueue } = require('../main/pi-session/turn-queue');
const quota = require('../core/token-quota');

function identity(hub = 'http://127.0.0.1:1') {
  const now = Math.floor(Date.now() / 1000);
  return { hub, clientId: 'personal-device', session: Buffer.from(JSON.stringify({
    typ: 'device', uid: 'personal-owner', cid: 'personal-device', iat: now, exp: now + 3600,
  })).toString('base64url') + '.' + 'a'.repeat(64) };
}
const budget = () => ({ enabled: true, exceeded: true, reason: 'total_exhausted',
  limit: 10, used: 10, remaining: 0, quotaVersion: 2, personalModelsAllowed: true });
const admitted = (model = 'personal-model') => ({ ok: true, quotaVersion: 2, quotaScope: 'personal', personalQuotaSupported: true,
  resolvedModel: model, providerId: 'personal-provider',
  quota: { ...budget(), exceeded: false }, platformQuota: budget() });

test('captured Pi turns use the real HTTP model/agent contract and preserve task lifecycle arguments', async t => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    requests.push({ url, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(admitted(url.searchParams.get('model') || 'default-model')));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const owner = identity('http://127.0.0.1:' + server.address().port);
  const authorize = create({ identityOf: async () => owner });
  let lifecycle = 0;
  const queue = createTurnQueue(), runtime = { agent: 'pi', modelMode: 'managed' };
  for (const modelName of ['old & queued/model', 'new personal/model', '']) {
    queue.add({ text: 'continue', options: { modelName,
      beforeTurn: beforeTurn(authorize, owner, function (...args) {
        assert.deepEqual(args, [], 'existing task hooks still receive no synthetic argument');
        assert.equal(this.modelName, modelName); lifecycle++;
      }, runtime) } });
  }
  for (let n = 0; n < 3; n++) assert.equal((await queue.run(queue.take(), async () => ({ ok: true }))).ok, true);
  assert.equal(lifecycle, 3);
  assert.deepEqual(requests.map(row => [...row.url.searchParams]), [
    [['model', 'old & queued/model'], ['agent', 'pi']],
    [['model', 'new personal/model'], ['agent', 'pi']], [['model', ''], ['agent', 'pi']],
  ]);
  assert.ok(requests.every(row => row.auth === 'Device ' + owner.session));
});

test('native and managed Runner admission remains strict even with a queued personal model', async () => {
  const owner = identity(), calls = [];
  for (const runtime of [undefined, { agent: 'codex', modelMode: 'account' },
    { agent: 'codex-harness', modelMode: 'managed' },
    { agent: 'pi', modelMode: 'managed', controlled: true }]) {
    await beforeTurn(async (...args) => calls.push(args), owner, undefined, runtime)({ modelName: 'personal-model' });
  }
  assert.ok(calls.every(args => args[2] === undefined));
});

test('personal admission fails closed on old, mismatched or malformed funding grants', async () => {
  const owner = identity(), selection = { model: 'personal-model', agent: 'pi' };
  const bad = [
    { ...admitted(), quotaVersion: undefined },
    { ...admitted(), personalQuotaSupported: false },
    { ...admitted(), resolvedModel: 'other-model' },
    { ...admitted(), providerId: '' },
    { ...admitted(), quotaScope: 'renderer-exempt' },
    { ...admitted(), quota: { enabled: true } },
  ];
  for (const response of bad) {
    const authorize = create({ identityOf: async () => owner, fetchImpl: async () => new Response(JSON.stringify(response)) });
    await assert.rejects(authorize(owner, undefined, selection));
  }
  const personal = create({ identityOf: async () => owner,
    fetchImpl: async () => new Response(JSON.stringify(admitted())) });
  await assert.rejects(personal(owner), 'a no-model native call cannot inherit a personal grant');
  const strict = create({ identityOf: async () => owner,
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, quota: { enabled: true, exceeded: false } })) });
  await strict(owner, undefined, selection); // Old servers can still admit under their strict account policy.
  const exhausted = create({ identityOf: async () => owner, fetchImpl: async () => new Response(JSON.stringify({
    detail: { code: 'TOKEN_QUOTA_EXCEEDED', message: 'strict old server', quota: budget() },
  }), { status: 403 }) });
  await assert.rejects(exhausted(owner, undefined, selection), error => error.code === quota.CODE && error.quota.exceeded);
});

test('personal continuation guidance requires explicit server support and excludes account blocks', () => {
  assert.equal(quota.allowsPersonal(budget()), true);
  assert.notEqual(quota.copy(budget()).title, quota.copy({ ...budget(), quotaVersion: 1 }).title);
  for (const patch of [{ quotaVersion: 1 }, { personalModelsAllowed: false }, { limit: 0 },
    { reason: 'trial_expired' }, { reason: 'model_not_allowed' }, { restrictModels: true }]) {
    assert.equal(quota.allowsPersonal({ ...budget(), ...patch }), false);
    assert.doesNotMatch(quota.copy({ ...budget(), ...patch }).guidance, /\u4e2a\u4eba\u6a21\u578b/);
  }
});

test('Pi call tokens survive archival receipts but never appear in public models or renderer snapshots', () => {
  const stream = require('../main/pi-session/event-stream');
  const attribution = require('../main/pi-session/usage-attribution');
  const token = 'signed-private-receipt', acc = stream.create();
  let prepared = { provider: 'runtime', model: { id: 'personal-model', quotaProvider: 'provider',
    quotaVersion: 2, quotaScope: 'personal', quotaUsageToken: token } };
  const stamp = attribution.create(() => prepared);
  const message = { role: 'assistant', model: 'personal-model', provider: 'runtime',
    content: [{ type: 'text', text: 'kept answer' }], usage: { input: 3, output: 2 }, stopReason: 'stop' };
  const start = { type: 'message_start', message }; stamp(start); acc.push(start);
  prepared = { provider: 'runtime', model: { id: 'later-model', quotaProvider: 'provider',
    quotaVersion: 2, quotaScope: 'platform', quotaUsageToken: 'later-token' } };
  const end = { type: 'message_end', message }; stamp(end); acc.push(end);
  assert.equal(message.quotaUsageToken, token, 'call retains its original funding even after a future selection');
  const archived = JSON.parse(JSON.stringify(message)), restored = stream.create();
  require('../main/pi-session/history-seed').seed(restored, { state: { messages: [archived] } }, { nativeAgentId: 'pi' });
  assert.equal(restored.snapshot().usageReceipts[0].quotaUsageToken, token);
  const model = require('../main/conversation/model-selection').publicModel(prepared.model);
  assert.equal(model.quotaScope, 'platform');
  const source = fs.readFileSync(path.join(__dirname, '../main/pi-session/ipc.js'), 'utf8');
  const startAt = source.indexOf('function _contextSnapshot('), endAt = source.indexOf('\nfunction _send(', startAt);
  const contextSnapshot = vm.runInNewContext('(' + source.slice(startAt, endAt) + ')');
  for (const view of [model, acc.uiSnapshot(), acc.uiSnapshot({ messageLimit: 2000 }),
    require('../main/pi-session/snapshot-window').limitSnapshot(restored.snapshot()),
    contextSnapshot({}, restored.snapshot()), restored.snapshot().messages]) {
    assert.doesNotMatch(JSON.stringify(view), /signed-private-receipt|later-token|quotaUsageToken/);
  }
  assert.match(JSON.stringify(contextSnapshot({}, restored.snapshot())), /kept answer/);
});

test('mismatched or legacy calls cannot borrow a newly selected token', () => {
  const { create } = require('../main/pi-session/usage-attribution');
  for (const patch of [{ id: 'other-model' }, { quotaVersion: 1 }]) {
    const model = { id: 'personal-model', quotaProvider: 'provider', quotaVersion: 2,
      quotaUsageToken: 'must-not-borrow', ...patch };
    const stamp = create(() => ({ provider: 'runtime', model }));
    const message = { role: 'assistant', model: 'personal-model', provider: 'runtime' };
    stamp({ type: 'message_start', message }); stamp({ type: 'message_end', message });
    assert.equal(message.quotaUsageToken, undefined);
  }
});

test('offline platform-personal-platform checkpoints retain 10/15/18 boundaries, retries and runtime attribution', async t => {
  const { createUsageReporter } = require('../main/agent-runtime/usage-reporter');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-personal-receipts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = identity(), app = { getPath: () => root }, sent = [];
  let fail = true;
  const reporter = createUsageReporter({ app, identityOf: async () => owner,
    fetchImpl: async (_url, options) => {
      sent.push(JSON.parse(options.body));
      if (fail) throw Error('offline');
      return new Response('{"ok":true}');
    } });
  const receipt = (total, token, agent = 'pi') => ({ model: 'same-model', provider: 'same-provider', agent,
    usage: { input: total, total, requests: 1 }, at: Date.now(), ...(token ? { quotaUsageToken: token } : {}) });
  const handle = { sessionId: 'one-session', usageIdentity: owner, adapterId: 'pi',
    model: { id: 'same-model', quotaVersion: 2, quotaUsageToken: 'do-not-borrow-current-token' } };
  const receipts = [receipt(10), receipt(5, 'signed-personal'), receipt(3)];
  reporter.observe(handle, { usageReceipts: receipts });
  await reporter.persist();
  let rows = Object.values(JSON.parse(fs.readFileSync(path.join(root, 'usage-outbox.json'), 'utf8')).rows);
  assert.deepEqual(rows.map(r => [r.payload.usage.total, r.payload.quotaUsageToken || '']), [[10, ''], [15, 'signed-personal'], [18, '']]);
  await reporter.flush();
  assert.equal(sent.length, 1, 'failed head preserves ordered remaining checkpoints');
  fail = false; await reporter.flush();
  assert.deepEqual(sent.map(r => [r.usage.total, r.quotaUsageToken || '']), [[10, ''], [10, ''], [15, 'signed-personal'], [18, '']]);
  assert.equal(new Set(sent.map(r => r.idempotencyKey)).size, 1);
  reporter.observe(handle, { usageReceipts: receipts.slice() }); await reporter.flush();
  assert.equal(sent.length, 4, 'replayed receipts do not re-submit settled cumulative usage');
  handle.adapterId = 'codex-harness';
  reporter.observe(handle, { usageReceipts: [...receipts, receipt(2, '', 'codex-harness')] }); await reporter.flush();
  assert.equal(sent.at(-1).usage.total, 20);
  assert.equal(sent.at(-1).agent, 'codex-harness');
  assert.equal(sent.at(-1).quotaUsageToken, undefined, 'Runner handoff never inherits the preceding Pi exemption');
  reporter.observe({ ...handle, sessionId: 'legacy-no-receipts' }, { usage: { input: 7, total: 7 } });
  await reporter.flush();
  assert.equal(sent.at(-1).quotaUsageToken, undefined, 'aggregate legacy usage cannot borrow model credentials');
});

test('model configuration requires receipt-capable Pi funding and keeps its ticket out of the public model', async () => {
  const { fetchModel } = require('../main/pi-session/model-config');
  const owner = identity(), valid = { ok: true, model: 'personal-model', provider: 'provider',
    key: 'proxy-key', quotaVersion: 2, quotaScope: 'personal', personalQuotaSupported: true,
    quotaUsageToken: 'signed-personal-receipt' };
  const fetchImpl = body => async () => Response.json(body);
  const good = await fetchModel(owner, 'personal-model', 1000, fetchImpl(valid));
  assert.equal(good.ok, true);
  assert.equal(good.model.quotaUsageToken, valid.quotaUsageToken);
  assert.doesNotMatch(JSON.stringify(require('../main/conversation/model-selection').publicModel(good.model)), /receipt|proxy-key/);
  for (const patch of [{ personalQuotaSupported: false }, { quotaVersion: 1 }, { quotaUsageToken: '' }, { provider: '' }]) {
    assert.equal((await fetchModel(owner, 'personal-model', 1000, fetchImpl({ ...valid, ...patch }))).ok, false);
  }
  assert.equal((await fetchModel(owner, 'personal-model', 1000, fetchImpl(valid), false, 'codex-harness')).ok, false);
});

test('inline app inference never asks for Pi funding without Pi per-call accounting', async () => {
  const { create } = require('../main/app-ai-generate.cjs');
  const owner = identity(), calls = [];
  const generate = create({ app: {}, authenticatedIdentityOf: async () => owner, configuredModel: () => 'personal-model',
    resolveModel: async () => ({ ok: true, model: { id: 'personal-model', key: 'proxy-key',
      baseUrl: 'http://fixture.invalid', quotaVersion: 2, quotaScope: 'personal', quotaUsageToken: 'not-used' } }),
    authorizeAI: async (...args) => { calls.push(args); throw Object.assign(Error('strict'), { code: quota.CODE }); },
    fetchImpl: async () => { throw Error('must not reach provider'); } });
  const result = await generate({}, { input: 'input', instructions: 'instructions', requestId: 'inline-strict' });
  assert.equal(result.code, quota.CODE);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 2);
});

test('direct Pi image turns retain strict admission because media has no chat usage receipt', async () => {
  const calls = [];
  const hook = beforeTurn(async (...args) => calls.push(args), identity(), undefined, { agent: 'pi', modelMode: 'managed' });
  await hook({ modelName: require('../core/model-choice').imageKey({ providerId: 'images', name: 'image-model' }) });
  assert.equal(calls[0][2], undefined);
});

test('versioned legacy monthly quota uses server-derived personal allowance without inventing a reason', () => {
  const legacy = { enabled: true, exceeded: true, mode: 'limited', period: 'month',
    limit: 10, used: 10, remaining: 0, quotaVersion: 2, personalModelsAllowed: true };
  assert.equal(quota.allowsPersonal(legacy), true);
  assert.match(quota.copy(legacy).guidance, /\u4e2a\u4eba\u6a21\u578b/);
  for (const patch of [{ quotaVersion: undefined }, { personalModelsAllowed: undefined }, { limit: 0 },
    { reason: 'trial_expired' }, { reason: 'model_not_allowed' }, { reason: 'unknown-block' }, { restrictModels: true }])
    assert.equal(quota.allowsPersonal({ ...legacy, ...patch }), false);
});
