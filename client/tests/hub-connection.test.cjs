'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../api.js'), 'utf8');
function fixture(seed = {}, bridge = {}, storage, internal = true, clock = { setTimeout, clearTimeout }) {
  const values = new Map(Object.entries(seed)), requests = [];
  storage ||= { getItem: key => values.get(key) || '', setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const window = { soduWorkAPI: bridge, dispatchEvent() {}, __SODUWORK_TEST_HUB_CONFIG__: { allowSwitch: internal } };
  vm.runInNewContext(source, { window, localStorage: storage, URL, URLSearchParams, AbortController,
    ...clock, console, User: { id: 'legacy-user' },
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, text: async () => '{}' }; } });
  return { api: window.SoduWorkAPI, values, requests, bridge };
}
const legacy = 'http://192.0.2.10:8989';
const unassigned = 'https://unassigned-legacy-hub.invalid';
for (const id of ['self-hosted']) test(`${id} renderer uses bundled Hub from its first request and rejects another fixed Hub`, async () => {
  const profile = require('../main/distribution.cjs').getProfile(id);
  const enrollments = [];
  const bridge = { distributionInfo: () => profile,
    getHubConnection: async () => ({ hub: profile.hubOrigin, editable: false }),
    deviceAuthBootstrap: async payload => { enrollments.push(payload); return { ok: true, stored: true,
      clientId: id + '-device', session: id + '-session', user: { id: id + '-user' }, expiresIn: 1800 }; } };
  const f = fixture({ soduwork_work_hub_url: 'https://other.invalid' }, bridge, undefined, false);
  assert.equal(f.api.hubBase(), profile.hubOrigin);
  assert.equal(f.api.hubConfig().editable, false);
  assert.throws(() => f.api.setHubEnvironment('production', 'https://other.invalid'), /固定/);
  await f.api.registerClient();
  await f.api.myModels();
  assert.equal(enrollments[0].hub, profile.hubOrigin);
  assert.ok(f.requests.length > 0);
  assert.ok(f.requests.every(row => row.url.startsWith(profile.hubOrigin + '/')));
  bridge.getHubConnection = async () => ({ hub: 'https://other.invalid', editable: false });
  const invalid = fixture({}, bridge, undefined, false);
  await assert.rejects(invalid.api.clientAuthPolicy(), /配置无效/);
  assert.equal(invalid.requests.length, 0);
});
for (const [name, seed, expected, bridge] of [
  ['fresh', {}, 'http://127.0.0.1:18989'],
  ['local-code fresh', {}, 'http://127.0.0.1:18989', { runtimeForm: () => 'local-code' }],
  ['production without saved URL', { soduwork_work_hub_environment_v1: 'production' }, unassigned],
  ['production with saved URL', { soduwork_work_hub_environment_v1: 'production', soduwork_work_hub_url: legacy }, legacy],
  ['legacy default', { soduwork_work_hub_url: legacy }, legacy],
  ['old credential without URL', { soduwork_work_device_secret: 'old-key' }, unassigned],
  ['old dev default', { soduwork_work_hub_environment_v1: 'development' }, 'http://127.0.0.1:9080'],
  ['custom connection', { soduwork_work_hub_url: 'https://old.example.com' }, 'https://old.example.com'],
]) test(`internal fixture migration preserves ${name}`, () => assert.equal(fixture(seed, bridge).api.hubBase(), expected));

test('connection records survive actual storage reload without changing unrelated user data', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-hub-config-')), file = path.join(dir, 'local-storage.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(file, JSON.stringify({ soduwork_work_hub_url: legacy, history: 'keep', preferences: 'keep' }));
  function diskStorage() {
    const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
    return { getItem: key => read()[key] || '', setItem(key, value) { const data = read(); data[key] = value; fs.writeFileSync(file, JSON.stringify(data)); } };
  }
  fixture({}, {}, diskStorage()).api.setHubEnvironment('production', 'https://my-team.example.com');
  const restarted = fixture({}, {}, diskStorage()).api;
  assert.equal(restarted.hubBase(), 'https://my-team.example.com');
  restarted.setHubEnvironment('development', 'http://localhost:18990');
  const again = fixture({}, {}, diskStorage()).api;
  assert.equal(again.hubBase(), 'http://localhost:18990');
  assert.equal(again.hubConfig().productionHub, 'https://my-team.example.com');
  assert.equal(again.setHubEnvironment('production').hub, 'https://my-team.example.com');
  assert.equal(JSON.parse(fs.readFileSync(file)).history, 'keep');
  assert.equal(JSON.parse(fs.readFileSync(file)).preferences, 'keep');
});

test('a secure main-process profile is restored before any enrollment or policy request', async () => {
  const calls = [];
  const f = fixture({}, { deviceAuthStatus: async () => ({ ready: true, hub: legacy }),
    deviceAuthBootstrap: async payload => { calls.push(payload); return { ok: false, stored: true, activationRequired: true }; } });
  await Promise.all([f.api.registerClient(), f.api.clientAuthPolicy()]);
  assert.equal(f.api.hubBase(), legacy);
  assert.equal(calls[0].hub, legacy);
  assert.ok(f.requests.every(row => row.url.startsWith(legacy)));
});

test('switching Hub never carries an old session, account or legacy key into its new enrollment', async () => {
  const payloads = [];
  const f = fixture({ soduwork_work_hub_url: legacy, soduwork_work_device_secret: 'legacy-key' }, {
    selectHubEnvironment: async () => ({ ok: true }),
    deviceAuthBootstrap: async payload => { payloads.push(payload); return { ok: true, stored: true,
      clientId: payload.hub === legacy ? 'device-old' : 'device-new', session: payload.hub === legacy ? 'old-token' : 'new-token',
      user: { id: payload.hub === legacy ? 'old-user' : 'new-user' }, expiresIn: 1800 }; }
  });
  await f.api.registerClient();
  const oldKey = f.api.taskStorageKey('tasks');
  await f.api.connectHub('production', 'https://own.example.com');
  assert.equal(f.api.clientAuthSnapshot().user, null);
  assert.notEqual(f.api.taskStorageKey('tasks'), oldKey);
  await f.api.myModels();
  assert.equal(payloads[1].legacySecret, '');
  assert.equal(f.requests.at(-1).options.headers.Authorization, 'Device new-token');
  assert.ok(f.requests.at(-1).url.startsWith('https://own.example.com/'));
});

test('late login and logout results cannot overwrite a newly selected Hub identity', async () => {
  for (const method of ['clientLogin', 'clientLogout']) {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const f = fixture({ soduwork_work_hub_url: legacy }, { deviceAuthLogin: () => pending, deviceAuthLogout: () => pending });
    const operation = f.api[method]({ account: 'alice', password: 'fixture-only' });
    await Promise.resolve(); await Promise.resolve();
    f.api.setHubEnvironment('production', 'https://new.example.com');
    finish({ ok: true, session: 'obsolete', user: { id: 'old-user' }, expiresIn: 300 });
    await assert.rejects(operation, { code: 'STALE_TASK_SCOPE' });
    assert.equal(f.api.clientAuthSnapshot().user, null);
  }
});

test('storage failure rolls back main-process selection and never claims a saved configuration', async () => {
  const selected = [];
  const f = fixture({}, { selectHubEnvironment: async hub => { selected.push(hub); return { ok: true }; } },
    { getItem: () => '', setItem() { throw Error('disk full'); } });
  await assert.rejects(f.api.connectHub('production', 'https://team.example.com'), /无法保存/);
  assert.deepEqual(selected, ['https://team.example.com', 'http://127.0.0.1:18989']);
  assert.equal(f.api.hubBase(), 'http://127.0.0.1:18989');
});

test('invalid service URL and failed main-process selection leave the saved connection untouched', async () => {
  const f = fixture({}, { selectHubEnvironment: async () => ({ ok: false, error: 'selection rejected' }) });
  for (const value of ['https://user:secret@example.com', 'https://example.com/api', 'https://example.com?q=x', 'file:///C:/']) {
    await assert.rejects(f.api.connectHub('production', value));
    assert.equal(f.api.hubBase(), 'http://127.0.0.1:18989');
  }
  await assert.rejects(f.api.connectHub('production', 'https://team.example.com'), /selection rejected/);
  assert.equal(f.values.has('soduwork_work_hub_connections_v2'), false);
});


const production = 'http://127.0.0.1:18989';
test('runtime badge cannot override the fixed production connection', async () => {
  const f = fixture({}, { runtimeForm: () => 'local-code' }, undefined, false);
  await f.api.clientAuthPolicy();
  assert.equal(f.api.runtimeForm(), 'local-code');
  assert.equal(f.api.hubBase(), production);
  assert.equal(f.api.hubConfig().editable, false);
  assert.ok(f.requests.every(row => row.url.startsWith(production + '/')));
});
test('local-code editable connections follow the main-process policy and isolate the old identity', async () => {
  const payloads = [];
  const f = fixture({}, {
    getHubConnection: async () => ({ hub: production, internalTest: false, editable: true }),
    selectHubEnvironment: async hub => ({ ok: true, hub }),
    deviceAuthBootstrap: async payload => { payloads.push(payload); return { ok: true, stored: true,
      session: 'session-' + payload.hub, clientId: 'device-' + payload.hub,
      user: { id: 'user-' + payload.hub }, expiresIn: 1800 }; },
  }, undefined, false);
  await f.api.registerClient();
  assert.equal(f.api.hubBase(), production);
  assert.equal(f.api.hubConfig().editable, true);
  const oldKey = f.api.taskStorageKey('tasks');
  const config = await f.api.connectHub('production', 'https://dev.example.com');
  assert.equal(config.hub, 'https://dev.example.com');
  assert.equal(f.api.clientAuthSnapshot().user, null);
  assert.notEqual(f.api.taskStorageKey('tasks'), oldKey);
  await f.api.clientAuthPolicy();
  assert.ok(f.requests.at(-1).url.startsWith('https://dev.example.com/'));
});

test('rejected main-process selection keeps the editable connection unchanged', async () => {
  const f = fixture({}, {
    getHubConnection: async () => ({ hub: production, internalTest: false, editable: true }),
    selectHubEnvironment: async () => ({ ok: false, error: 'selection rejected' }),
  }, undefined, false);
  await f.api.clientAuthPolicy();
  await assert.rejects(f.api.connectHub('production', 'https://other.example.com'), /selection rejected/);
  assert.equal(f.api.hubBase(), production);
  assert.equal(f.api.hubConfig().editable, true);
});

test('editable local-code runs validate the address before touching the main process', async () => {
  let selected = 0;
  const f = fixture({}, {
    getHubConnection: async () => ({ hub: production, internalTest: false, editable: true }),
    selectHubEnvironment: async () => { selected++; return { ok: true }; },
  }, undefined, false);
  await f.api.clientAuthPolicy();
  for (const value of ['https://user:secret@example.com', 'https://example.com/api', 'file:///C:/']) {
    await assert.rejects(f.api.connectHub('production', value));
  }
  assert.equal(selected, 0);
  assert.equal(f.api.hubBase(), production);
});
for (const seed of [
  {}, { soduwork_work_hub_url: legacy }, { soduwork_work_hub_environment_v1: 'development' },
  { soduwork_work_hub_connections_v2: JSON.stringify({ environment: 'development', productionHub: legacy, developmentHub: 'http://localhost:18989' }) },
]) test('product ignores saved environment selection: ' + JSON.stringify(seed), async () => {
  let selected = 0, restored = 0;
  const f = fixture(seed, { selectHubEnvironment() { selected++; }, deviceAuthStatus() { restored++; } }, undefined, false);
  await f.api.clientAuthPolicy();
  assert.equal(f.api.hubBase(), production);
  assert.equal(f.api.hubConfig().editable, false);
  assert.throws(() => f.api.setHubEnvironment('development', 'http://localhost:18989'));
  await assert.rejects(f.api.connectHub('production', 'https://other.example.com'));
  assert.equal(selected, 0); assert.equal(restored, 0);
  assert.ok(f.requests.every(row => row.url.startsWith(production + '/')));
});

for (const oldHub of ['http://localhost:18989', '']) test('fixed product isolates legacy key with saved URL: ' + oldHub, async () => {
  const payloads = [];
  const f = fixture({ soduwork_work_hub_url: oldHub, soduwork_work_device_secret: 'old-local-key',
    soduwork_work_task_ops_v1: '[{"id":"legacy-only"}]' }, {
    getHubConnection: async () => ({ hub: production, internalTest: false }),
    deviceAuthBootstrap: async payload => { payloads.push(payload); return { ok: true, stored: true,
      session: 'production-session', clientId: 'production-device', user: { id: 'production-user' }, expiresIn: 1800 }; },
  }, undefined, false);
  await f.api.registerClient(); await f.api.myModels();
  assert.equal(payloads[0].hub, production); assert.equal(payloads[0].legacySecret, '');
  assert.equal(f.values.get('soduwork_work_legacy_auth_hub_v1'), oldHub || unassigned);
  assert.equal(f.values.get('soduwork_work_device_secret'), 'old-local-key');
  assert.equal(f.values.get('soduwork_work_task_ops_v1'), '[{"id":"legacy-only"}]');
  assert.ok(!JSON.stringify(f.requests).includes('old-local-key'));
  assert.ok(f.requests.every(row => row.url.startsWith(production + '/')));
  assert.match(f.api.taskStorageKey('ops'), /http%3A%2F%2F127\.0\.0\.1%3A18989/);
});

test('only an explicit main-process internal loopback connection overrides the product endpoint', async () => {
  for (const connection of [ { hub: 'http://127.0.0.1:54321', internalTest: false },
    { hub: 'https://other.example.com', internalTest: true } ]) {
    const f = fixture({}, { getHubConnection: async () => connection }, undefined, false);
    await assert.rejects(f.api.clientAuthPolicy()); assert.equal(f.requests.length, 0);
  }
  let release;
  const f = fixture({}, { getHubConnection: () => new Promise(resolve => { release = resolve; }) }, undefined, false);
  const policy = f.api.clientAuthPolicy(); await Promise.resolve();
  assert.equal(f.requests.length, 0);
  release({ hub: 'http://127.0.0.1:54321', internalTest: true }); await policy;
  assert.equal(f.requests[0].url, 'http://127.0.0.1:54321/api/v1/client-auth/policy');
  assert.equal(f.api.hubConfig().editable, false);
});

test('native fixed policy wins over an injected renderer fixture flag', async () => {
  const f = fixture({ soduwork_work_hub_url: 'http://localhost:9080' }, {
    getHubConnection: async () => ({ hub: production, internalTest: false }),
  });
  await f.api.clientAuthPolicy();
  assert.equal(f.api.hubBase(), production);
  assert.throws(() => f.api.setHubEnvironment('development', 'http://localhost:9080'));
});

/* The real main-process handler must serve the live connection (prepare() swaps it),
   never the boot-time snapshot that silently rolls a saved address back. */
test('hub-connection-info serves the live connection, not a boot snapshot', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.match(mainSource, /hub-connection-info', \(\) => _hubEndpoint\.current\(app\)/);
  assert.doesNotMatch(mainSource, /hub-connection-info', \(\) => _hubConnection\)/);
});

test('fixed-policy lookup times out, retries, and ignores a late old result', async () => {
  let expire, finish;
  const clock = { setTimeout(fn) { expire = fn; return 1; }, clearTimeout() {} };
  const f = fixture({}, { getHubConnection: () => new Promise(resolve => { finish = resolve; }) }, undefined, false, clock);
  const lookup = f.api.clientAuthPolicy();
  await Promise.resolve(); expire();
  await assert.rejects(lookup, { code: 'DEVICE_AUTH_INIT_TIMEOUT' });
  assert.equal(f.requests.length, 0);
  f.bridge.getHubConnection = async () => ({ hub: production, internalTest: false });
  await f.api.clientAuthPolicy();
  finish({ hub: 'http://localhost:9080', internalTest: true });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.api.hubBase(), production);
  assert.equal(f.requests.length, 1);
});
