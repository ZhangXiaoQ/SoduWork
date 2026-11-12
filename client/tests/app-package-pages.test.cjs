'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const personal = require('../main/personal-plugins');
const resources = require('../main/plugin-resources');
const pages = require('../main/app-package-pages.cjs');
const store = require('../main/app-settings-store.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-package-pages-'));
  const app = { getPath: () => root }, out = path.join(root, 'source');
  require('../../skills/app-developer/scripts/scaffold.cjs').scaffold({ out, key: 'offline-page', name: '离线应用' });
  const file = path.join(out, 'soduwork-plugin-draft.json');
  const body = resources.collect(JSON.parse(fs.readFileSync(file, 'utf8')), file, out);
  const pluginId = personal.create(app, body).plugin.pluginId;
  let owner = null, handler;
  store.configure({ app, ownerOf: () => owner });
  const session = { setPermissionRequestHandler(fn) { this.askPermission = fn; },
    setPermissionCheckHandler(fn) { this.checkPermission = fn; }, protocol: {
      handle(scheme, fn) { assert.equal(scheme, 'https'); handler = fn; } } };
  const deps = { app, session: { fromPartition(name) { assert.match(name, /^persist:sw-app-[a-f0-9]{32}$/); return session; } } };
  t.after(() => { store.configure(undefined); fs.rmSync(root, { recursive: true, force: true }); });
  return { app, body, pluginId, deps, session, setOwner: value => { owner = value; },
    open: () => pages.prepare(deps, { pluginId, contributionId: 'main' }),
    request: (url, method = 'GET') => handler({ url, method }) };
}
test('offline installed pages serve only declared UI/assets and reject other apps, scripts and writes', async t => {
  const f = fixture(t), opened = await f.open(), origin = new URL(opened.url).origin;
  const html = await f.request(opened.url);
  assert.equal(html.status, 200); assert.match(html.headers.get('content-type'), /^text\/html/);
  assert.match(await html.text(), /离线应用/);
  assert.match(html.headers.get('content-security-policy'), /object-src 'none'/);
  assert.equal((await f.request(origin + '/app.js')).status, 200);
  assert.equal((await f.request(origin + '/ui/app.js', 'HEAD')).status, 200);
  assert.equal(await (await f.request(opened.url, 'HEAD')).text(), '');
  for (const file of ['/references/private.txt', '/scripts/private.js', '/ui/missing.css'])
    assert.equal((await f.request(origin + file)).status, 404);
  assert.equal((await f.request(opened.url, 'POST')).status, 403);
  assert.equal((await f.request('https://other.soduwork-app.invalid/ui/index.html')).status, 403);
  assert.equal(f.session.checkPermission(), false);
  f.session.askPermission(null, 'camera', allowed => assert.equal(allowed, false));
  const handlers = new Map();
  personal.install({ app: f.app, ipcMain: { handle: (name, fn) => handlers.set(name, fn) } });
  await handlers.get('personal-plugin-enable')(null, f.pluginId, false);
  assert.equal((await f.request(opened.url)).status, 403, 'disabling an app revokes subsequent resource reads');
  await assert.rejects(f.open(), /安装并启用/);
});
test('account changes separate persistent storage and stop resources from the previous account', async t => {
  const f = fixture(t); f.setOwner('hub/account-a');
  const first = await f.open();
  f.setOwner('hub/account-b');
  assert.equal((await f.request(first.url)).status, 403);
  const second = await f.open(); assert.notEqual(first.partition, second.partition);
  f.setOwner('hub/account-a');
  const reopened = await f.open(); assert.equal(reopened.partition, first.partition);
});
test('Hub packages use authorized immutable bytes and fail closed on revoked or corrupted responses', async t => {
  const f = fixture(t); f.setOwner('hub/account-a');
  let allowed = true, corrupt = false;
  f.deps.identityOf = async () => ({ hub: 'https://fixture.invalid', clientId: 'fixture', session: 'isolated-session' });
  f.deps.fetchImpl = async (url, options) => {
    assert.equal(url, 'https://fixture.invalid/api/v1/plugins/market-app/ui-package');
    assert.equal(options.redirect, 'error'); assert.match(options.headers.Authorization, /^Device /);
    const files = structuredClone(f.body.resources); if (corrupt) files[0].sha256 = '0'.repeat(64);
    return allowed ? Response.json({ ui: f.body.ui, resources: files }) : new Response('', { status: 403 });
  };
  const raw = { pluginId: 'market-app', contributionId: 'main' };
  const opened = await pages.prepare(f.deps, raw);
  assert.equal((await f.request(opened.url)).status, 200);
  allowed = false;
  assert.equal((await f.request(opened.url)).status, 403);
  await assert.rejects(pages.prepare(f.deps, raw), /安装与使用权限/);
  allowed = true; corrupt = true;
  await assert.rejects(pages.prepare(f.deps, raw), /校验不一致/);
});

test('market package reads use the authenticated account session when device identity has no session', async t => {
  const f = fixture(t); f.setOwner('hub/account-a');
  let sessions = 0, allowed = true;
  f.deps.identityOf = () => ({ hub: 'https://strict.invalid', clientId: 'fixture', secret: 'fixture-device-only' });
  f.deps.authenticatedIdentityOf = async () => {
    sessions++; return { hub: 'https://strict.invalid', clientId: 'fixture', session: 'fixture-account-session' };
  };
  f.deps.fetchImpl = async (_url, options) => {
    if (options.headers.Authorization !== 'Device fixture-account-session') return new Response('', { status: 401 });
    assert.equal(options.headers['X-SoduWork-Device-Secret'], undefined);
    return allowed ? Response.json({ ui: f.body.ui, resources: f.body.resources }) : new Response('', { status: 403 });
  };
  const opened = await pages.prepare(f.deps, { pluginId: 'market-session-app', contributionId: 'main' });
  assert.equal((await f.request(opened.url)).status, 200);
  assert.equal(sessions, 2, 'opening and resource reads obtain the current authenticated identity');
  allowed = false; assert.equal((await f.request(opened.url)).status, 403);
  f.deps.authenticatedIdentityOf = async () => { throw Error('Account renewal unavailable'); };
  f.deps.fetchImpl = async () => assert.fail('failed renewal cannot fall back to device-secret authentication');
  await assert.rejects(pages.prepare(f.deps, { pluginId: 'market-session-app', contributionId: 'main' }), /Account renewal unavailable/);
});

test('conditional Hub reads recheck authorization without retransmitting packages and recover after cache clear', async t => {
  const f = fixture(t); f.setOwner('hub/account-a');
  f.deps.identityOf = async () => ({ hub: 'https://conditional.invalid', clientId: 'fixture', session: 'isolated-session' });
  const cache = require('../main/app-resource-cache.cjs');
  let requests = 0, bodies = 0, allowed = true, etag = '"version-one"';
  f.deps.fetchImpl = async (_url, options) => {
    requests++;
    if (!allowed) return new Response('', { status: 403 });
    if (options.headers['If-None-Match'] === etag) return new Response(null, { status: 304, headers: { etag } });
    bodies++; return Response.json({ ui: f.body.ui, resources: f.body.resources }, { headers: { etag } });
  };
  const raw = { pluginId: 'conditional-app', contributionId: 'main' };
  const opened = await pages.prepare(f.deps, raw);
  for (let i = 0; i < 10; i++) assert.equal((await f.request(opened.url)).status, 200);
  assert.equal(requests, 11, 'every resource rechecks Hub authorization'); assert.equal(bodies, 1);
  etag = '"version-two"'; const updated = await pages.prepare(f.deps, raw);
  assert.notEqual(updated.revision, opened.revision); assert.equal(bodies, 2);
  await cache.request({ profile: f.app.getPath('userData'), pluginId: raw.pluginId, action: 'clear' });
  assert.equal((await f.request(updated.url)).status, 200); assert.equal(bodies, 3, 'eviction triggers a fresh verified package response');
  allowed = false;
  assert.equal((await f.request(updated.url)).status, 403, 'revocation beats a matching cache tag');
  assert.equal((await cache.request({ profile: f.app.getPath('userData'), pluginId: raw.pluginId, action: 'stats' })).bytes, 0);
});
test('remote pages reject missing account ownership before using a legacy device identity', async t => {
  const f = fixture(t); let identityReads = 0, requests = 0, partitions = 0;
  f.deps.identityOf = async () => {
    identityReads++; return { hub: 'https://fixture.invalid', clientId: 'fixture', secret: 'isolated-device-secret' };
  };
  f.deps.fetchImpl = async () => { requests++; return Response.json({ ui: f.body.ui, resources: f.body.resources }); };
  f.deps.session.fromPartition = () => { partitions++; return f.session; };
  await assert.rejects(pages.prepare(f.deps, { pluginId: 'market-app', contributionId: 'main' }), /登录/);
  assert.deepEqual({ identityReads, requests, partitions }, { identityReads: 0, requests: 0, partitions: 0 });
  const local = await f.open();
  assert.match(local.url, /\.soduwork-app\.invalid\/ui\/index\.html$/);
  assert.equal((await f.request(local.url)).status, 200, 'offline local pages remain available');
});
test('remote package responses cannot open or keep serving across logout, account or Hub changes', async t => {
  const f = fixture(t), raw = { pluginId: 'market-app', contributionId: 'main' };
  let hub = 'https://fixture-a.invalid', afterRequest = () => {}, partitions = 0;
  f.deps.identityOf = async () => ({ hub, clientId: 'fixture', session: 'isolated-session' });
  f.deps.fetchImpl = async url => {
    assert.equal(url, hub + '/api/v1/plugins/market-app/ui-package');
    afterRequest(); return Response.json({ ui: f.body.ui, resources: f.body.resources });
  };
  f.deps.session.fromPartition = () => { partitions++; return f.session; };
  for (const next of [null, 'https://fixture-a.invalid/account-b', 'https://fixture-b.invalid/account-a']) {
    hub = 'https://fixture-a.invalid'; f.setOwner(hub + '/account-a');
    afterRequest = () => { f.setOwner(next); if (next?.includes('fixture-b')) hub = 'https://fixture-b.invalid'; };
    await assert.rejects(pages.prepare(f.deps, raw), /登录|账号已变化/);
    assert.equal(partitions, 0, 'a stale response must not create a persistent partition');
  }
  hub = 'https://fixture-a.invalid'; f.setOwner(hub + '/account-a'); afterRequest = () => {};
  const opened = await pages.prepare(f.deps, raw);
  f.setOwner(null);
  assert.equal((await f.request(opened.url)).status, 403, 'logout revokes the already-open resource handler');
});
