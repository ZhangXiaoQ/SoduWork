'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const personal = require('../main/personal-plugins'), resources = require('../main/plugin-resources');
const cache = require('../main/app-resource-cache.cjs');
function fixture(t) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-resource-cache-'));
  const app = { getPath: () => profile }, source = path.join(profile, 'source');
  require('../../skills/app-developer/scripts/scaffold.cjs').scaffold({ out: source, key: 'cache-app', name: 'Cache fixture' });
  const file = path.join(source, 'soduwork-plugin-draft.json');
  const body = resources.collect(JSON.parse(fs.readFileSync(file, 'utf8')), file, source);
  const pluginId = personal.create(app, body).plugin.pluginId;
  const input = { profile, pluginId, scope: 'account-a', contributionId: 'main' };
  t.after(async () => { await cache.close(); fs.rmSync(profile, { recursive: true, force: true }); });
  return { profile, app, body, input,
    read: patch => cache.request({ ...input, action: 'metadata', ...patch }),
    stats: () => cache.request({ ...input, action: 'stats' }) };
}
test('warm concurrent resource requests reuse validated bytes without main-thread registry I/O', async t => {
  const f = fixture(t); await f.read(); const before = await f.stats();
  const read = fs.readFileSync;
  fs.readFileSync = (filename, ...args) => {
    assert.notEqual(filename, path.join(f.profile, 'personal-plugins.json'), 'main thread must not parse the registry');
    return read(filename, ...args);
  };
  try {
    const results = await Promise.all(Array.from({ length: 20 }, () => f.read({ action: 'resource', pathname: 'app.js' })));
    assert.ok(results.every(result => result.path === 'ui/app.js' && result.bytes.length));
  } finally { fs.readFileSync = read; }
  const after = await f.stats();
  assert.equal(after.registryReads, before.registryReads); assert.equal(after.normalizations, before.normalizations);
  assert.equal(after.hits - before.hits, 20); assert.ok(after.bytes > 0 && after.totalBytes <= after.maxBytes);
});
test('registry changes immediately invalidate disable, uninstall and corrupted resources', async t => {
  const f = fixture(t); await f.read();
  const target = path.join(f.profile, 'personal-plugins.json');
  const original = fs.readFileSync(target, 'utf8'), doc = JSON.parse(original);
  doc.plugins[0].enabled = false; fs.writeFileSync(target, JSON.stringify(doc));
  await assert.rejects(f.read(), /安装并启用/); assert.equal((await f.stats()).bytes, 0);
  fs.writeFileSync(target, original); await f.read();
  doc.plugins[0].enabled = true; doc.plugins[0].versions[0].body.resources[0].sha256 = '0'.repeat(64);
  fs.writeFileSync(target, JSON.stringify(doc)); await assert.rejects(f.read(), /校验/);
  fs.writeFileSync(target, JSON.stringify({ schemaVersion: 1, plugins: [] }));
  await assert.rejects(f.read(), /不存在/);
});
test('version upgrade, account change, bounded eviction and clearing never delete persistent files', async t => {
  const f = fixture(t); const first = await f.read();
  const business = path.join(f.profile, 'business.sqlite'); fs.writeFileSync(business, 'persistent fixture');
  const revised = structuredClone(f.body); revised.version = '0.2.0';
  personal.create(f.app, revised); const next = await f.read();
  assert.notEqual(next.revision, first.revision);
  await f.read({ scope: 'account-b' }); assert.equal((await f.stats()).entries, 1, 'old account cache evicted');
  for (let i = 0; i < 9; i++) {
    const plugin = personal.create(f.app, { ...f.body, key: 'cache-' + i }).plugin;
    await f.read({ pluginId: plugin.pluginId });
  }
  assert.ok((await f.stats()).entries <= 8, 'bounded app cache, not unbounded historical versions');
  await f.read(); const registry = fs.readFileSync(path.join(f.profile, 'personal-plugins.json'));
  await cache.request({ ...f.input, action: 'clear' }); assert.equal((await f.stats()).bytes, 0);
  assert.deepEqual(fs.readFileSync(path.join(f.profile, 'personal-plugins.json')), registry);
  assert.equal(fs.readFileSync(business, 'utf8'), 'persistent fixture');
  assert.ok((await f.read()).row.source.entry, 'cache clear can reload the installed application');
});
