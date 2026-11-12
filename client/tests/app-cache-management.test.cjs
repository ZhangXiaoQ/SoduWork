'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const personal = require('../main/personal-plugins'), resources = require('../main/plugin-resources');
const store = require('../main/app-settings-store.cjs'), cache = require('../main/app-resource-cache.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-cache-manage-')), app = { getPath: () => root };
  const source = path.join(root, 'source');
  require('../../skills/app-developer/scripts/scaffold.cjs').scaffold({ out: source, key: 'cache-manager', name: 'Cache manager' });
  const file = path.join(source, 'soduwork-plugin-draft.json');
  const pluginId = personal.create(app, resources.collect(JSON.parse(fs.readFileSync(file, 'utf8')), file, source)).plugin.pluginId;
  let account = 'account-a', networkBytes = 4096, gate;
  const session = { clearCache: async () => { networkBytes = 0; }, getCacheSize: async () => { await gate; return networkBytes; },
    clearData: () => assert.fail('persistent data must never be cleared'), clearStorageData: () => assert.fail('storage must remain'), clearAuthCache: () => assert.fail('authentication must remain') };
  store.configure({ app, ownerOf: () => account });
  const sender = {}, owner = { host: { webContents: sender }, views: new Map() };
  const deps = { app, session: { fromPartition: () => session } };
  const { manage } = require('../main/app-cache-management.cjs').create({ getDeps: () => deps, ownerFor: () => owner });
  t.after(async () => { store.configure(undefined); await cache.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { app, pluginId, owner, sender, manage, event: { sender }, setAccount: value => { account = value; }, setGate: value => { gate = value; } };
}
test('clearing only app resource and HTTP cache retains installation and rejects untrusted callers', async t => {
  const f = fixture(t), body = { pluginId: f.pluginId, action: 'clear' };
  const original = fs.readFileSync(path.join(f.app.getPath(), 'personal-plugins.json'));
  await assert.rejects(f.manage({ sender: {} }, body), /主工作区/);
  const result = await f.manage(f.event, body); assert.equal(result.ok, true); assert.equal(result.bytes, 0);
  assert.deepEqual(fs.readFileSync(path.join(f.app.getPath(), 'personal-plugins.json')), original);
  await assert.rejects(f.manage(f.event, { ...body, action: 'delete' }), /请求无效/);
});
test('late cache statistics cannot cross an account boundary and revoked apps cannot clear caches', async t => {
  const f = fixture(t); let release;
  f.setGate(new Promise(resolve => { release = resolve; }));
  const response = f.manage(f.event, { pluginId: f.pluginId, action: 'stats' });
  f.setAccount('account-b'); release(); await assert.rejects(response, /账号已变化/);
  const handlers = new Map(); personal.install({ app: f.app, ipcMain: { handle: (key, fn) => handlers.set(key, fn) } });
  await handlers.get('personal-plugin-enable')(null, f.pluginId, false);
  await assert.rejects(f.manage(f.event, { pluginId: f.pluginId, action: 'clear' }), /安装并启用/);
});

test('external H5 cache uses the workspace Session even when its page has no bridge or has closed', async t => {
  const f = fixture(t); let cleared = false;
  const profile = path.join(f.app.getPath(), 'personal-plugins.json'), document = JSON.parse(fs.readFileSync(profile, 'utf8'));
  document.plugins[0].versions[0].manifest.ui.contributions[0].source = { type: 'external', url: 'https://fixture.invalid/', openMode: 'workspace' };
  fs.writeFileSync(profile, JSON.stringify(document));
  f.owner.lease = { session: { getCacheSize: async () => cleared ? 0 : 100, clearCache: async () => { cleared = true; },
    clearStorageData: () => assert.fail('H5 login state must remain') } };
  const before = await f.manage(f.event, { pluginId: f.pluginId, action: 'stats' });
  assert.equal(before.shared, true); assert.equal(before.networkBytes, 100);
  const after = await f.manage(f.event, { pluginId: f.pluginId, action: 'clear' });
  assert.equal(after.networkBytes, 0); assert.equal(cleared, true);
});
