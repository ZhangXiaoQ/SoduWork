'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), http = require('node:http');
const store = require('../main/app-settings-store.cjs');
const contract = require('../main/soduwork-app-bridge-contract.cjs');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-settings-')), key = crypto.randomBytes(32);
  let owner = 'hub/account-a';
  const app = { getPath: () => root }, safeStorage = { isEncryptionAvailable: () => true,
    encryptString(value) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv); const text = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), text]); },
    decryptString(value) { const cipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0,12)); cipher.setAuthTag(value.subarray(12,28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString(); } };
  store.configure({ app, safeStorage, ownerOf: () => owner });
  return { root, app, safeStorage, setOwner: value => { owner = value; }, binding: { pluginId: 'local:fixture', origin: 'https://cloud.example' }, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
test('settings are encrypted, bounded JSON, isolated by account/app/origin; own explicit credential reads and CAS updates', () => {
  const f = fixture();
  try {
    const saved = store.update(f.binding, { values: { ukey: 'fixture-A-secret', theme: 'dark', nested: { password: 'fixture-nested' } } });
    assert.deepEqual(saved.values, { theme: 'dark' }); assert.deepEqual(saved.secretKeys, ['ukey','nested']);
    assert.ok(!fs.readFileSync(path.join(f.root, 'app-settings.secure.json'), 'utf8').includes('fixture-A-secret'));
    assert.equal(store.get(f.binding, { keys: ['ukey'], includeSecrets: true }).values.ukey, 'fixture-A-secret');
    assert.equal(store.get({ ...f.binding, pluginId: 'local:other' }).revision, 0);
    assert.equal(store.get({ ...f.binding, origin: 'https://other.example' }).revision, 0);
    f.setOwner('hub/account-b'); assert.equal(store.get(f.binding).revision, 0);
    f.setOwner('hub/account-a'); assert.equal(store.get(f.binding).revision, 1);
    assert.throws(() => store.update(f.binding, { values: { ukey: 'stale' }, expectedRevision: 0 }), /已变化/);
    const next = store.update(f.binding, { values: { theme: 'light' }, expectedRevision: 1 });
    assert.equal(next.revision, 2); assert.equal(store.read(f.binding).values.ukey, 'fixture-A-secret');
    assert.equal(store.update(f.binding, { values: { theme: 'light' } }).revision, 2);
    for (const values of [JSON.parse('{"__proto__":{}}'), { a: undefined }, { a: 'x'.repeat(16385) }, { a: { constructor: {} } }]) assert.throws(() => store.update(f.binding, { values }));
    assert.throws(() => contract.normalizeRequest({ id: 'x', method: 'settings.get', params: { includeSecrets: true } }), /明确指定/);
    assert.equal(contract.METHOD_CAPABILITY['settings.update'], 'settings.write');
    f.setOwner(''); assert.throws(() => store.get(f.binding), /登录/);
  } finally { f.cleanup(); }
});
test('application conversations restore configured ukey without an app window and recheck account, install and declarations', async () => {
  const f = fixture(), personal = require('../main/personal-plugins');
  const appConnections = require('../main/app-conversation-connection.cjs');
  try {
    const body = { key: 'conversation-app', name: 'Conversation app', version: '0.1.0', template: 'app',
      description: 'Fixture', instructions: 'Fixture', mcpServers: ['cloud'],
      ui: { contributions: [{ id: 'main', title: 'App', slot: 'workspace.navigation', source: {
        type: 'external', url: f.binding.origin, bridge: { version: 1, capabilities: ['mcp.connect'] },
      } }] } };
    const plugin = personal.create(f.app, body).plugin, binding = { ...f.binding, pluginId: plugin.pluginId };
    assert.throws(() => appConnections.context(f.app, plugin.pluginId), /尚未配置连接.*打开即用/);
    store.update(binding, { values: { ukey: 'fixture-conversation-key', theme: 'dark' } });
    const current = appConnections.context(f.app, plugin.pluginId);
    assert.equal(current.connection.token, 'fixture-conversation-key');
    assert.equal(current.connection.url, f.binding.origin + '/mcp');
    assert.equal(store.read(binding).connections.main.credentialKey, 'ukey');
    assert.equal(store.get(binding).connections, undefined, 'host metadata is not exposed to app settings reads');
    store.update(binding, { values: { theme: 'light', connections: { main: { url: 'https://attacker.invalid/mcp' } } } });
    assert.equal(appConnections.context(f.app, plugin.pluginId).connection.url, current.connection.url);
    const revision = store.read(binding).revision;
    store.saveConnection(binding, 'main', store.read(binding).connections.main);
    assert.equal(store.read(binding).revision, revision, 'repeated page connection does not invalidate active credentials');
    f.setOwner('hub/other-account');
    assert.throws(() => current.connection.readCurrent(), /账号已变化/);
    assert.throws(() => appConnections.context(f.app, plugin.pluginId), /尚未配置连接/);
    f.setOwner('hub/account-a');
    const fresh = appConnections.context(f.app, plugin.pluginId);
    personal.create(f.app, { ...body, version: '0.2.0', mcpServers: ['changed'] });
    assert.throws(() => fresh.connection.readCurrent(), /连接器或安装来源已变化/);
    assert.equal(fs.readFileSync(path.join(f.root, 'app-settings.secure.json'), 'utf8').includes('fixture-conversation-key'), false);
  } finally { f.cleanup(); }
});
test('stored MCP credentials survive page closure, preference changes, elapsed days and concurrent consumers', async t => {
  const f = fixture(), personal = require('../main/personal-plugins');
  const guard = require('../main/pi-session/app-mcp-grant.cjs'), preview = require('../main/work-preview');
  const original = preview.appContextFor, received = [], leases = [];
  const server = http.createServer((req, res) => { received.push(req.headers.authorization); res.end('{"ok":true}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { preview.appContextFor = original; leases.forEach(l => l.cleanup()); server.closeAllConnections(); server.close(); f.cleanup(); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const plugin = personal.create(f.app, { key: 'persistent-mcp', name: 'Persistent MCP', version: '0.1.0', template: 'app',
    description: 'Fixture', instructions: 'Fixture', mcpServers: ['cloud'],
    ui: { contributions: [{ id: 'main', slot: 'workspace.navigation', title: 'App', source: {
      type: 'external', url: origin, bridge: { version: 1, capabilities: ['mcp.connect'] },
    } }] } }).plugin;
  const bound = {pluginId:plugin.pluginId,origin};
  store.update(bound, {values:{serviceKey:'fixture-shared-key', accountId:'account-a'}});
  store.saveConnection(bound, 'main', {server:'cloud',url:origin+'/mcp',credentialKey:'serviceKey'});
  let closed = false;
  preview.appContextFor = () => {
    if (closed) throw Error('page destroyed');
    return {pluginId:plugin.pluginId,requiresMcp:true,connection:{credentialKey:'serviceKey',readCurrent(){throw Error('page-only connection');}}};
  };
  const handle = {snapshot:()=>({activePlugins:[plugin.pluginId]})};
  guard.bind(handle, {}, plugin.pluginId, f.app);
  const turn = {}; await guard.guardSend(handle, turn);
  closed = true;
  store.update(bound, {values:{theme:'light',accountName:'New display name'}});
  await turn.beforeTurn();
  const connection = (await guard.forSession(handle)).connection;
  const proxy = require('../main/pi-session/app-mcp-proxy.cjs');
  leases.push(await proxy.create(connection), await proxy.create(connection));
  const call = lease => fetch(lease.url,{method:'POST',headers:{Authorization:'Bearer '+lease.token},body:'{}'});
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 7*86400000;
    assert.deepEqual((await Promise.all(leases.map(call))).map(r=>r.status), [200,200]);
  } finally { Date.now = realNow; }
  assert.deepEqual(received, ['Bearer fixture-shared-key','Bearer fixture-shared-key']);
  const accepted = {}; await guard.guardSend(handle, accepted);
  store.update(bound, {values:{serviceKey:'fixture-replacement-key'}});
  store.update(bound, {values:{serviceKey:'fixture-shared-key'}});
  await assert.rejects(accepted.beforeTurn(), /账号或设置已变化/);
  assert.deepEqual((await Promise.all(leases.map(call))).map(r=>r.status), [401,401]);
  assert.equal(received.length,2,'Changed credentials are blocked before upstream execution');
  const fresh = await guard.context(null,plugin.pluginId,undefined,f.app);
  leases.push(await proxy.create(fresh.connection));
  assert.equal((await call(leases[2])).status,200);
  store.update(bound,{remove:['serviceKey']});
  assert.equal((await call(leases[2])).status,401);
});

test('any main-window conversation may select an application and queued turns keep independent application credentials', async () => {
  const f = fixture(), personal = require('../main/personal-plugins');
  const guard = require('../main/pi-session/app-mcp-grant.cjs');
  try {
    const make = key => personal.create(f.app, { key, name: key, version: '0.1.0', template: 'app',
      description: 'Fixture', instructions: 'Fixture', mcpServers: ['cloud'],
      ui: { contributions: [{ id: 'main', title: 'App', slot: 'workspace.navigation', source: {
        type: 'external', url: f.binding.origin, bridge: { version: 1, capabilities: ['mcp.connect'] },
      } }] } }).plugin;
    const first = make('first-app'), second = make('second-app');
    for (const app of [first, second]) store.update({ ...f.binding, pluginId: app.pluginId }, { values: { ukey: app.key + '-fixture-key' } });
    const handle = { snapshot: () => ({ activePlugins: [] }) }, sender = { isDestroyed: () => false };
    guard.bind(handle, sender, '', f.app);
    const ordinary = {}; guard.guardSend(handle, ordinary);
    const a = { pluginIds: [first.pluginId] }; guard.guardSend(handle, a);
    const b = { pluginIds: [second.pluginId] }; guard.guardSend(handle, b);
    await ordinary.beforeTurn(); assert.equal(guard.forSession(handle), null);
    await a.beforeTurn(); assert.equal(guard.forSession(handle).connection.token, first.key + '-fixture-key');
    await b.beforeTurn(); assert.equal(guard.forSession(handle).connection.token, second.key + '-fixture-key');
    guard.bind(handle, sender, first.pluginId, f.app);
    const inAnotherApp = { pluginIds: [second.pluginId] }; guard.guardSend(handle, inAnotherApp); await inAnotherApp.beforeTurn();
    assert.equal(guard.forSession(handle).pluginId, second.pluginId, 'an explicit application selection also works from another application conversation');
    guard.bind(handle, sender, '', f.app);
    const pending = { pluginIds: [first.pluginId] }; guard.guardSend(handle, pending);
    store.update({ ...f.binding, pluginId: first.pluginId }, { values: { ukey: 'rotated-fixture-key' } });
    await assert.rejects(pending.beforeTurn(), /账号或设置已变化/);
    const own = { pluginIds: [first.pluginId] }; guard.guardSend(handle, own); await own.beforeTurn();
    const lease = guard.forSession(handle).connection;
    const inventory = personal._read(f.app);
    inventory.plugins.find(row => row.id === first.pluginId).enabled = false;
    fs.writeFileSync(path.join(f.root, 'personal-plugins.json'), JSON.stringify(inventory));
    assert.throws(() => lease.readCurrent(), /停用或卸载/);
    inventory.plugins = inventory.plugins.filter(row => row.id !== first.pluginId);
    fs.writeFileSync(path.join(f.root, 'personal-plugins.json'), JSON.stringify(inventory));
    assert.throws(() => lease.readCurrent(), /不存在/);
  } finally { f.cleanup(); }
});
test('market history turns restore owned MCP without a window and retain installation, queue and account boundaries', async () => {
  const f = fixture(), guard = require('../main/pi-session/app-mcp-grant.cjs');
  const origin = f.binding.origin, pluginId = 'market-history';
  const entry = { id: 'main', slot: 'workspace.navigation', source: { type: 'external', url: origin + '/app',
    bridge: { capabilities: ['mcp.connect'] } } };
  const plugin = { pluginId, installed: true, permissions: { canUse: true }, versionId: 'catalog-v2',
    conversationVersionId: 'installed-v1', conversationCapabilities: { mcpServers: ['cloud'] },
    conversationUi: { contributions: [entry] } };
  let afterFetch = () => {};
  const deps = { identityOf: async () => ({ hub: 'https://hub.example', session: 'fixture-session' }),
    fetchImpl: async () => { afterFetch(); return { ok: true, json: async () => ({ items: [structuredClone(plugin)] }) }; } };
  const handle = { snapshot: () => ({ activePlugins: [pluginId] }) };
  const binding = { pluginId, origin };
  try {
    store.update(binding, { values: { ukey: 'fixture-market-history-key' } });
    guard.bind(handle, null, '', f.app, deps);
    const turn = {}; await guard.guardSend(handle, turn); await turn.beforeTurn();
    const current = await guard.forSession(handle);
    assert.equal(current.connection.token, 'fixture-market-history-key');
    assert.equal(current.connection.versionId, 'installed-v1', 'accepted installation overrides newer catalog version');
    assert.equal(current.connection.server, 'cloud');
    assert.equal(current.connection.url, origin + '/mcp');
    await current.connection.authorize();
    const queued = {}; await guard.guardSend(handle, queued);
    plugin.conversationVersionId = 'installed-v2';
    await assert.rejects(queued.beforeTurn(), /账号或设置已变化/);
    await assert.rejects(current.connection.authorize(), /安装版本或连接授权已变化/);
    plugin.conversationVersionId = 'installed-v1';
    plugin.permissions.canUse = false;
    await assert.rejects(current.connection.authorize(), /安装并启用/);
    await assert.rejects(guard.guardSend(handle, {}), /安装并启用/);
    plugin.permissions.canUse = true;
    entry.source.url = 'https://other.example/app';
    await assert.rejects(current.connection.authorize(), /安装版本或连接授权已变化/);
    entry.source.url = origin + '/app';
    store.update(binding, { values: { ukey: 'rotated-market-key' } });
    await assert.rejects(guard.forSession(handle), /账号或设置已变化/);
    f.setOwner('hub/other-account');
    assert.throws(() => current.connection.readCurrent(), /账号已变化/);
    await assert.rejects(guard.guardSend(handle, {}), /尚未配置连接/);
    f.setOwner('hub/account-a');
    afterFetch = () => f.setOwner('hub/other-account');
    await assert.rejects(guard.guardSend(handle, {}), /账号已变化/);
  } finally { f.cleanup(); }
});

test('per-turn MCP proxy uses stored ukey; account switch invalidates old grant and new grant uses new account, cleanup closes proxy', async () => {
  const f = fixture(), received = [];
  const server = http.createServer((req,res) => { received.push(req.headers.authorization); res.setHeader('Content-Type','application/json'); res.end('{"ok":true}'); });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let first, second;
  try {
    store.update(f.binding, { values: { ukey: 'fixture-account-A' } });
    const connection = () => { const row = store.read(f.binding); return { server: 'cloud', url: 'http://127.0.0.1:' + server.address().port + '/mcp', token: row.values.ukey, revision: row.revision,
      readCurrent: () => { const current = store.read(f.binding); return { token: current.values.ukey, revision: current.revision }; } }; };
    const proxy = require('../main/pi-session/app-mcp-proxy.cjs');
    first = await proxy.create(connection());
    const call = lease => fetch(lease.url, { method: 'POST', headers: { Authorization: 'Bearer ' + lease.token }, body: '{}' });
    assert.equal((await call(first)).status, 200);
    store.update(f.binding, { values: { ukey: 'fixture-account-B' } });
    assert.equal((await call(first)).status, 401);
    second = await proxy.create(connection()); assert.equal((await call(second)).status, 200);
    assert.deepEqual(received, ['Bearer fixture-account-A','Bearer fixture-account-B']);
    assert.equal((await fetch(second.url, { headers: { Origin: 'https://attacker.example', Authorization: 'Bearer ' + second.token } })).status, 403);
  } finally { first?.cleanup(); second?.cleanup(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.cleanup(); }
});
test('shell settings management authorizes the main desk frame and returns only masked metadata', () => {
  const f = fixture(), handlers = new Map();
  try {
    const plugin = require('../main/personal-plugins').create(f.app, { key: 'settings-ui', template: 'app', name: 'Settings UI', version: '0.1.0', description: 'Fixture settings', instructions: 'Fixture only',
      ui: { contributions: [{ id: 'main', title: 'App', slot: 'workspace.navigation', source: { type: 'external', url: f.binding.origin } }] } }).plugin;
    require('../main/app-settings-ipc.cjs').install({ app: f.app, safeStorage: f.safeStorage, ownerOf: () => 'fixture-owner', ipcMain: { handle: (key,value) => handlers.set(key,value) } });
    const frame = { url: require('node:url').pathToFileURL(path.resolve(__dirname,'../desk.html')).href + '?panel=workspace' };
    const event = { senderFrame: frame, sender: { mainFrame: frame } };
    const save = handlers.get('app-settings-update'), get = handlers.get('app-settings-get');
    assert.equal(save(event, plugin.pluginId, { values: { ukey: 'ui-private-key', theme: 'light' } }).ok,true);
    assert.deepEqual(get(event, plugin.pluginId, { keys: ['ukey'], includeSecrets: true }).values,{});
    assert.equal(get(event, plugin.pluginId,{}).secretMasks.ukey,'ui-pr****');
    assert.ok(!JSON.stringify(get(event, plugin.pluginId,{})).includes('ui-private-key'));
    assert.equal(save(event, plugin.pluginId, { values: { ukey: 'ak-26-new-fixture' }, expectedRevision: 1 }).ok,true);
    assert.equal(get(event, plugin.pluginId,{}).secretMasks.ukey,'ak-26****');
    assert.equal(get(event, plugin.pluginId,{}).values.theme,'light');
    assert.equal(save({ senderFrame: { url: frame.url }, sender: event.sender }, plugin.pluginId, { values: { ukey: 'forged' } }).ok,false);
    const web = { url: 'https://cloud.example/' };
    assert.equal(get({ senderFrame: web, sender: { mainFrame: web } }, plugin.pluginId,{}).ok,false);
  } finally { f.cleanup(); }
});
test('standalone app turns retain native ownership without requiring a business connection', async () => {
  const preview = require('../main/work-preview'), original = preview.appContextFor;
  const guard = require('../main/pi-session/app-mcp-grant.cjs');
  const app = {}, sender = {}, session = {}, pluginId = 'standalone-app';
  const native = { pluginId, pageUrl: 'http://127.0.0.1:8098/', requiresMcp: false, connection: null };
  preview.appContextFor = source => source === sender ? native : null;
  try {
    guard.bind(session, sender, pluginId, app);
    const turn = {}; guard.guardSend(session, turn); await turn.beforeTurn();
    assert.equal(guard.forSession(session), native);
    assert.equal(session.appMcpExpected, '');
    assert.equal(guard.forSession(session).connection, null, 'no fake credential or MCP grant is created');
    preview.appContextFor = () => null;
    assert.throws(() => guard.context(sender, pluginId, undefined, app), /连接不可用/, 'lost native ownership still fails closed');
  } finally { preview.appContextFor = original; }
});

test('queued app messages bind settings at acceptance and cannot acquire the new account after switching', async () => {
  const preview = require('../main/work-preview'), original = preview.appContextFor;
  let revision = 1;
  preview.appContextFor = () => ({ pluginId: 'local:queued', connection: { credentialKey: 'ukey', scope: 'owner-app-origin', revision } });
  try {
    const session = { appPluginId: 'local:queued' }, guard = require('../main/pi-session/app-mcp-grant.cjs');
    guard.bind(session, {}, session.appPluginId);
    const queued = {}; guard.guardSend(session, queued); revision++;
    await assert.rejects(queued.beforeTurn(), /账号或设置已变化/);
    const fresh = {}; guard.guardSend(session, fresh); await fresh.beforeTurn();
    assert.equal(session.appMcpExpected,'owner-app-origin:2');
    revision++;
    assert.throws(() => guard.context({},session.appPluginId,session.appMcpExpected), /账号或设置已变化/);
  } finally { preview.appContextFor = original; }
});
test('reattaching a conversation preserves each queued turn application independently of its displayed window', async () => {
  const preview = require('../main/work-preview'), original = preview.appContextFor;
  const guard = require('../main/pi-session/app-mcp-grant.cjs');
  const first = {}, second = {}, session = {};
  preview.appContextFor = () => ({ pluginId: 'local:queued', connection: { credentialKey: 'ukey', scope: 'owner-app-origin', revision: 1 } });
  try {
    guard.bind(session, first, '');
    const mainQueued = {}; guard.guardSend(session, mainQueued);
    guard.bind(session, first, 'local:queued');
    await mainQueued.beforeTurn();
    assert.equal(guard.forSession(session), null, 'previously unbound text cannot acquire a later application identity');
    const accepted = {}; guard.guardSend(session, accepted); await accepted.beforeTurn();
    const queued = {}; guard.guardSend(session, queued);
    guard.bind(session, second, 'local:queued');
    assert.equal(guard.forSession(session).pluginId, 'local:queued');
    await queued.beforeTurn();
    const fresh = {}; guard.guardSend(session, fresh); await fresh.beforeTurn();
    assert.equal(guard.forSession(session).pluginId, 'local:queued');
    guard.bind(session, second, 'local:other');
    assert.equal(guard.forSession(session).pluginId, 'local:queued', 'an existing turn retains its own application');
    assert.throws(() => guard.guardSend(session, {}), /连接不可用/, 'new requests must use the newly selected application');
  } finally { preview.appContextFor = original; }
});
test('remote application settings require a current authorized installation and reject an account change during lookup', async () => {
  const f=fixture(),handlers=new Map();let owner='account-a',allowed=true,installed=true,switchOnFetch=false;
  try {
    require('../main/app-settings-ipc.cjs').install({app:f.app,safeStorage:f.safeStorage,ownerOf:()=>owner,
      identityOf:()=>({hub:'https://hub.example',clientId:'fixture-device',session:'fixture-session'}),
      fetchImpl:async()=>{if(switchOnFetch)owner='account-b';return {ok:true,json:async()=>({items:[{pluginId:'remote-app',installed,permissions:{canUse:allowed},ui:{contributions:[{slot:'workspace.navigation',source:{type:'external',url:'https://cloud.example/app'}}]}}]})}},
      ipcMain:{handle:(key,value)=>handlers.set(key,value)}});
    const frame={url:require('node:url').pathToFileURL(path.resolve(__dirname,'../desk.html')).href};
    const event={senderFrame:frame,sender:{mainFrame:frame}};
    const get=()=>handlers.get('app-settings-get')(event,'remote-app',{});
    assert.equal((await get()).ok,true);
    allowed=false;assert.equal((await get()).ok,false);allowed=true;
    installed=false;assert.equal((await get()).ok,false);installed=true;
    switchOnFetch=true;assert.equal((await get()).ok,false);
  }finally{f.cleanup()}
});

test('H5 market apps read and write their own settings without a personal plugin; current installation, scope and manifest are checked', async () => {
  const f = fixture(), connection = require('../main/work-preview-app-connection.cjs');
  const pluginId = 'market-fixture', origin = f.binding.origin;
  const source = { type: 'external', url: origin + '/login.html', bridge: { capabilities: ['settings.read', 'settings.write'] } };
  const plugin = { pluginId, installed: true, permissions: { canUse: true }, ui: { contributions: [{ id: 'main', slot: 'workspace.navigation', source }] } };
  let beforeReply = () => {}, pageOrigin = origin;
  const deps = { app: f.app, identityOf: () => ({ hub: 'https://hub.example', session: 'fixture-session' }),
    fetchImpl: async () => { beforeReply(); return { ok: true, json: async () => ({ items: [plugin] }) }; } };
  const item = { appBridge: { appId: 'plugin:' + pluginId, contributionId: 'main', origin },
    view: { webContents: { isDestroyed: () => false, getURL: () => pageOrigin + '/login.html' } } };
  require('../main/work-preview-app-owner.cjs').capture(item, deps);
  const call = (method, params = {}) => connection.settings({ item }, { method: 'settings.' + method, params }, deps);
  try {
    assert.equal((await call('update', { values: { ukey: 'fixture-market-key', theme: 'light' } })).ok, true);
    assert.equal((await call('get', { keys: ['ukey'], includeSecrets: true })).values.ukey, 'fixture-market-key');
    assert.equal((await call('get')).values.ukey, undefined);
    assert.equal(store.get({ pluginId: 'different-app', origin }).revision, 0);
    for (const field of ['installed', 'installedVersionAvailable', 'enabled']) {
      plugin[field] = false; await assert.rejects(call('get'), /安装并启用/); delete plugin[field]; plugin.installed = true;
    }
    plugin.permissions.canUse = false; await assert.rejects(call('get'), /安装并启用/); plugin.permissions.canUse = true;
    source.bridge.capabilities = ['settings.read']; await assert.rejects(call('update', { values: { theme: 'dark' } }), /未声明/);
    source.bridge.capabilities.push('settings.write');
    source.url = 'https://other.example'; await assert.rejects(call('get'), /未声明/); source.url = origin;
    beforeReply = () => { pageOrigin = 'https://navigated.example'; }; await assert.rejects(call('get'), /来源已变化/); pageOrigin = origin;
    beforeReply = () => f.setOwner('hub/account-b'); await assert.rejects(call('update', { values: { ukey: 'stale' } }), { code: 'APP_ACCOUNT_CHANGED' });
    assert.equal(store.get({ pluginId, origin }).revision, 0);
    f.setOwner('hub/account-a'); assert.equal(store.get({ pluginId, origin }).revision, 1);
  } finally { f.cleanup(); }
});

test('authorized market app connects to its own local MCP; every proxy call rechecks installation and account', async () => {
  const f = fixture(), connection = require('../main/work-preview-app-connection.cjs');
  const received = [], server = http.createServer((req, res) => {
    received.push(req.headers.authorization); res.end('{"ok":true}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port, pluginId = 'market-mcp';
  const source = { type: 'external', url: origin, bridge: { capabilities: ['mcp.connect'] } };
  const plugin = { pluginId, versionId: 'market-installed-version', installed: true, permissions: { canUse: true },
    capabilities: { mcpServers: ['cloud'] }, ui: { contributions: [{ id: 'main', slot: 'workspace.navigation', source }] } };
  const deps = { app: f.app, identityOf: () => ({ hub: 'https://hub.example', clientId: 'device', session: 'session' }),
    fetchImpl: async (url, options) => {
      if (url.endsWith('/conversation-grant')) {
        assert.deepEqual(JSON.parse(options.body).applicationConnection, { pluginId,
          versionId: plugin.versionId, contributionId: 'main', origin, server: 'cloud' });
        return { ok: true, json: async () => ({ ok: true,
          items: [{ ...plugin, name: 'Market MCP', version: '1.0.0', context: 'Use current application' }],
          mcpGrant: null }) };
      }
      return { ok: true, json: async () => ({ items: [plugin] }) };
    } };
  const item = { appBridge: { appId: 'plugin:' + pluginId, contributionId: 'main', origin },
    view: { webContents: { isDestroyed: () => false, getURL: () => origin + '/home.html' } } };
  require('../main/work-preview-app-owner.cjs').capture(item, deps);
  const params = { server: 'cloud', url: origin + '/mcp', credentialKey: 'ukey', context: { spaceId: 'team' } };
  let resolved;
  try {
    store.update({ pluginId, origin }, { values: { ukey: 'market-local-secret' } });
    await assert.rejects(connection.connect({ item }, { ...params, url: 'http://elsewhere/mcp' }, deps), /来源/);
    await assert.rejects(connection.connect({ item }, { ...params, server: 'other' }, deps), /未声明/);
    assert.equal((await connection.connect({ item }, params, deps)).connected, true);
    const current = connection.resolve(item, deps);
    resolved = await require('../main/pi-session/plugin-grant').resolve({ ...deps, ref: 'market-local',
      pluginIds: [pluginId], appContext: { pluginId, pageUrl: origin + '/home.html', requiresMcp: true, connection: current } });
    assert.match(resolved.applicationGuide, /"transport":"application"/);
    assert.match(resolved.applicationGuide, /"spaceId":"team"/);
    assert.ok(resolved.applicationGuide.includes(origin + '/mcp'));
    assert.doesNotMatch(resolved.applicationGuide, /market-local-secret|fixture-hub-ticket/);
    const spec = JSON.parse(fs.readFileSync(resolved.grant.configFile)).servers.cloud;
    const call = () => fetch(spec.url, { method: 'POST', headers: spec.headers, body: '{}' });
    assert.equal((await call()).status, 200);
    plugin.permissions.canUse = false; assert.equal((await call()).status, 401);
    plugin.permissions.canUse = true;
    plugin.capabilities.mcpServers = []; assert.equal((await call()).status, 401);
    plugin.capabilities.mcpServers = ['cloud'];
    f.setOwner('hub/account-b'); assert.equal((await call()).status, 401);
    assert.deepEqual(received, ['Bearer market-local-secret']);
  } finally { resolved?.grant.cleanup(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.cleanup(); }
});
