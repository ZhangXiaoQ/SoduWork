'use strict';

// Exercise the actual paged importer with more than the old 128 MiB object
// ceiling. The transport generates one bounded source page at a time.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { createWorker } = require('../main/conversation/replica-store.cjs');
const { run } = require('../main/conversation/import-content.cjs');
const CHUNK = 256 * 1024, PAGE_COUNT = 36, MESSAGES = 64;
const pageBody = index => Buffer.from(JSON.stringify(Array.from({ length: MESSAGES }, (_, number) => ({
  id: index + ':' + number, role: number % 2 ? 'assistant' : 'user', text: index + ':' + number + ':' + 'x'.repeat(60000) }))));
const pointerFor = bytes => ({ schema: 1, scope: 'a'.repeat(64), runnerId: 'isolated',
  sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length });

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-history-migration-pressure-'));
  let store = createWorker(path.join(root, 'replicas.sqlite'));
  const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
  const started = performance.now();
  let rss = 0;
  const sampler = setInterval(() => { rss = Math.max(rss, process.memoryUsage().rss); }, 25);
  try {
    const pages = Array.from({ length: PAGE_COUNT }, (_, index) => ({ ...pointerFor(pageBody(index)), count: MESSAGES }));
    const bytes = pages.reduce((sum, page) => sum + page.size, 0);
    assert.ok(bytes > 128 * 1024 * 1024);
    const manifest = Buffer.from(JSON.stringify({ format: 'soduwork.account-history.pages.v1', pages, count: PAGE_COUNT * MESSAGES }));
    const pointer = pointerFor(manifest), byHash = new Map(pages.map((page, index) => [page.sha256, index]));
    let cached, cachedDigest, interrupted = false, interrupt = true;
    const reads = new Map();
    const history = { get store() { return store; }, resolve: id => store.get(id) };
    const options = { history, identity: { hub: 'https://fixture.invalid', clientId: 'pc', user: { id: 'owner' } },
      pointer, metadata: { id: 'acct-pressure', title: 'Isolated migration' }, guard: async () => {},
      rpc: async (op, args) => {
        assert.equal(op, 'runtime.content.read'); assert.equal(args.scope, pointer.scope);
        const index = byHash.get(args.sha256);
        if (interrupt && index === 4) { interrupted = true; throw Error('Isolated disconnect'); }
        reads.set(args.sha256, (reads.get(args.sha256) || 0) + 1);
        if (cachedDigest !== args.sha256) {
          cached = args.sha256 === pointer.sha256 ? manifest : pageBody(index); cachedDigest = args.sha256;
        }
        return { ok: true, data: { ...pointerFor(cached), offset: args.offset,
          b64: cached.subarray(args.offset, args.offset + CHUNK).toString('base64') } };
      } };
    await assert.rejects(run(options), /Isolated disconnect/);
    assert.equal(interrupted, true); assert.equal((await store.list()).items.length, 0);
    await store.close(); store = createWorker(path.join(root, 'replicas.sqlite')); interrupt = false;
    const receipt = await run(options);
    assert.equal(receipt.durable, true);
    assert.equal(receipt.count, PAGE_COUNT * MESSAGES);
    assert.equal(reads.get(pages[0].sha256), Math.ceil(pages[0].size / CHUNK));
    await store.close(); store = createWorker(path.join(root, 'replicas.sqlite'));
    let after = -1, total = 0;
    do {
      const page = await store.messages(receipt.id, { after, limit: 100 });
      for (const message of page.items) {
        assert.equal(message.id, Math.floor(total / MESSAGES) + ':' + (total % MESSAGES));
        assert.ok(message.text.startsWith(message.id + ':')); total++;
      }
      after = page.next;
    } while (after != null);
    assert.equal(total, PAGE_COUNT * MESSAGES);
    await store.lifecycle(receipt.id, 'delete');
    assert.equal((await run(options)).deleted, true);
    assert.equal((await store.list()).items.length, 0);
    delay.disable();
    console.log(JSON.stringify({ bytes, pages: PAGE_COUNT, messages: total,
      interruptionAndRestart: 'passed', deletionRetry: 'passed', integrity: 'passed',
      elapsedMs: Math.round(performance.now() - started),
      mainLoopP99Ms: Number((delay.percentile(99) / 1e6).toFixed(2)),
      mainLoopMaxMs: Number((delay.max / 1e6).toFixed(2)), peakRssMiB: Math.round(rss / 1024 / 1024) }));
  } finally {
    clearInterval(sampler); delay.disable(); await store.close(); fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
