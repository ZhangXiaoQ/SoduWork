'use strict';
// Real Electron fixed-Hub login/settings, storage and IPC. Only explicit loopback fixtures can make HTTP calls.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  env.SODUWORK_HUB_E2E_RUN_ID = require('node:crypto').randomUUID();
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename], { env, stdio: 'inherit', windowsHide: true, timeout: 90000 });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  const receipt = JSON.parse(require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../../outputs/hub-connection/report.json'), 'utf8'));
  process.exit(result.status === 0 && receipt.ok && receipt.runId === env.SODUWORK_HUB_E2E_RUN_ID ? 0 : 1);
}
const { app, BrowserWindow, ipcMain, safeStorage, session } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-hub-ui-'));
app.setName('SoduWorkFixedHubFixture');
app.setPath('userData', path.join(root, 'profile'));
app.on('window-all-closed', () => {});
const client = path.resolve(__dirname, '..'), out = path.resolve(client, '../outputs/hub-connection');
fs.mkdirSync(out, { recursive: true });
const report = { ok: false, runId: process.env.SODUWORK_HUB_E2E_RUN_ID, cases: [], profile: root,
  inputBoundary: 'Offscreen Chromium focus emulation with native pointer/keyboard events; this does not verify OS window focus.' }, servers = [], requests = [];
let win;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => win.webContents.executeJavaScript(code);
async function until(code) {
  for (let n = 0; n < 400; n++) {
    try { if (await run(code)) return; } catch (_) {}
    await sleep(20);
  }
  throw Error('UI timeout: ' + code + '\n' + await run('document.body.innerText'));
}
async function click(selector) {
  const point = await run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
  await sleep(60);
}
async function fill(selector, value) {
  // ClientAuth schedules initial account autofocus 50 ms after it reveals the
  // gate. Let that finish before sending pointer/keyboard input to another field.
  await sleep(100);
  await click(selector);
  // Hidden/offscreen windows still need a focused WebContents before Chromium
  // applies native editing shortcuts; otherwise insertText appends at the caret.
  win.webContents.focus();
  await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await until('document.hasFocus() && document.activeElement === document.querySelector(' + JSON.stringify(selector) + ')');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Control' });
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Control' });
  await until('(() => { const el = document.querySelector(' + JSON.stringify(selector) + '); return el.selectionStart === 0 && el.selectionEnd === el.value.length; })()');
  await win.webContents.insertText(value);
  assert.equal(await run(`document.querySelector(${JSON.stringify(selector)}).value`), value, 'typing reaches ' + selector);
}
async function assertConnectionLabel(hub) {
  const label = await run(`(() => {
    const el = document.querySelector('.soduwork-auth-hub');
    return { tag: el.tagName, text: el.textContent.trim(), tabIndex: el.tabIndex,
      role: el.getAttribute('role'), entries: document.querySelectorAll('.soduwork-auth-service-entry').length };
  })()`);
  assert.deepEqual(label, { tag: 'SPAN', text: '连接 ' + new URL(hub).host, tabIndex: -1, role: null, entries: 0 },
    'the footer shows the current host as plain text without a connection button');
}
async function assertNarrowLayout() {
  const layout = await run(`(() => {
    const gate = document.querySelector('.soduwork-auth-gate'), card = document.querySelector('.soduwork-auth-card');
    const bounds = card.getBoundingClientRect(), footer = card.querySelector('.soduwork-auth-hub').getBoundingClientRect();
    return { scrollWidth: gate.scrollWidth, clientWidth: gate.clientWidth,
      footerInCard: footer.left >= bounds.left && footer.right <= bounds.right };
  })()`);
  assert.ok(layout.scrollWidth <= layout.clientWidth, 'login gate has no horizontal overflow: ' + JSON.stringify(layout));
  assert.equal(layout.footerInCard, true, 'the host footer stays within the login card');
}
async function service(label) {
  const users = new Map(), secrets = new Map();
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : {}, device = body.device;
    requests.push({ label, path: req.url, body, device, key: req.headers['x-device-key'], authorization: req.headers.authorization });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') return res.end('{}');
    if (req.url.startsWith('/api/v1/client-updates/check?')) return res.end(JSON.stringify({ hasUpdate: false }));
    if (req.url === '/api/v1/usage/events') return res.end(JSON.stringify({ ok: true }));
    if (req.url.endsWith('/policy')) return res.end(JSON.stringify({ allowSelfRegistration: true, mailReady: true, passwordMinLength: 8 }));
    if (req.url.endsWith('/enroll') || req.url.endsWith('/login')) {
      if (secrets.has(device)) assert.equal(req.headers['x-device-key'], secrets.get(device));
      else secrets.set(device, req.headers['x-device-key']);
      if (req.url.endsWith('/login')) {
        assert.equal(body.account, label); assert.equal(body.password, 'fixture-password');
        users.set(device, { id: label, username: label, displayName: label });
      }
      const user = users.get(device);
      return res.end(JSON.stringify(user ? { authState: 'active', session: 'session-' + label,
        expiresIn: 1800, user } : { authState: 'pending', activationRequired: true }));
    }
    res.end(JSON.stringify({ providers: [], usable: [], myModels: [] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
  return { url: 'http://127.0.0.1:' + server.address().port, users, secrets };
}
async function open(surface = 'legacy') {
  assert.ok(['legacy', 'email'].includes(surface), 'known authentication fixture');
  win = new BrowserWindow({ show: false, width: 920, height: 860, webPreferences: {
    preload: path.join(client, 'preload.js'), contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  win.webContents.on('preload-error', (_event, _path, error) => { report.preloadError = String(error); });
  win.webContents.on('console-message', event => { if (event.level === 'error') process.stderr.write('Renderer: ' + event.message + '\n'); });
  await win.loadFile(path.join(root, surface + '-connection.html'));
  // Offscreen fixtures have no OS focus. Emulate Chromium focus so native
  // keyboard events exercise the focused input without stealing a user window.
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  await until('typeof SoduWorkAPI === "object"');
  process.stdout.write('READY ' + surface + '\n');
}
app.whenReady().then(async () => {
  assert.ok(safeStorage.isEncryptionAvailable(), 'OS credential encryption must be available');
  const a = await service('alice'), b = await service('bob');
  const endpoint = require('../main/hub-endpoint.cjs');
  endpoint.initialize(app, {});
  ipcMain.handle('hub-connection-info', () => endpoint.current(app));
  ipcMain.on('runtime-form', event => { event.returnValue = 'local-code'; });
  const allowed = new Set([a.url, b.url]);
  const originalFetch = global.fetch;
  global.fetch = (url, options) => {
    if (!allowed.has(new URL(url).origin)) return Promise.reject(Error('fetch failed (isolated fixture: unreachable service)'));
    return originalFetch(url, options);
  };
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: /^(https?|wss?):/.test(details.url) && !allowed.has(new URL(details.url).origin) });
  });
  const auth = require('../main/device-auth');
  auth.install({ app, ipcMain, safeStorage });
  ipcMain.handle('hub-environment-select', (_event, hub) => auth.selectHub(app, hub));
  ipcMain.handle('app-version', () => 'fixture');
  ipcMain.handle('sys-info', () => ({ platform: 'fixture', hostname: 'isolated' }));
  ipcMain.handle('runner-configure', () => ({ ok: true }));
  require('../main/client-updater').install({ app, ipcMain, BrowserWindow,
    identityOf: auth.authenticatedIdentity, getWindow: () => win,
    dialog: { showMessageBox: async () => { throw Error('No installer should be offered in this fixture'); } } });
  ipcMain.handle('work-root-default', () => path.join(root, 'work'));
  const url = file => pathToFileURL(path.join(client, file)).href;
  const desk = fs.readFileSync(path.join(client, 'desk.html'), 'utf8');
  const panelStart = desk.indexOf('<div class="panel" id="settingsPanel"');
  const card = desk.slice(panelStart, desk.indexOf('<section class="archive-history-panel"', panelStart));
  assert.ok(panelStart >= 0 && card.includes('settingsPanel'), 'load the real settings panel markup');
  fs.copyFileSync(path.join(client, 'icon.png'), path.join(root, 'icon.png'));
  for (const surface of ['legacy', 'email']) fs.writeFileSync(path.join(root, surface + '-connection.html'), `<!doctype html><html><meta charset="utf-8">
    <link rel="stylesheet" href="${url('theme/variables.css')}">
    <link rel="stylesheet" href="${url('components/panels/panels-detail.css')}">
    <link rel="stylesheet" href="${url('components/settings/settings.css')}">
    <link rel="stylesheet" href="${url('components/client-auth/client-auth.css')}">
    ${surface === 'email' ? '<link rel="stylesheet" href="' + url('components/client-auth/account-center.css') + '">' : ''}
    <style>body{font:15px system-ui;margin:20px;background:white}#settingsPanel{position:relative;margin:20px auto}</style>
    <body>${card}
    <script>var cfg={};var User={id:'fixture-renderer'};
      window.fixtureErrors=[];addEventListener('error',event=>fixtureErrors.push(event.message));
      addEventListener('unhandledrejection',event=>fixtureErrors.push(String(event.reason)));
      if (!localStorage.getItem('fixture-history')) {
        localStorage.setItem('soduwork_work_hub_environment_v1', 'development');
        localStorage.setItem('soduwork_work_hub_url', 'http://127.0.0.1:18989');
        localStorage.setItem('soduwork_work_device_secret', 'fixture-old-local-key');
        localStorage.setItem('fixture-history', 'preserved');
      }
    </script>
    <script src="${url('core/api-work-plugins.js')}"></script><script src="${url('api.js')}"></script>
    <script src="${url('components/settings/settings.js')}"></script>
    ${surface === 'email' ? ['account-ui.js', 'email-auth.js'].map(file => '<script src="' + url('components/client-auth/' + file) + '"></script>').join('') : ''}
    <script src="${url('components/client-auth/client-auth.js')}"></script></body></html>`);
  await open();
  await until('document.querySelector(".soduwork-auth-retry") && !document.querySelector(".soduwork-auth-retry").hidden');
  assert.equal(await run('SoduWorkAPI.hubBase()'), endpoint.PRODUCTION_HUB);
  assert.equal(await run('SoduWorkAPI.hubConfig().editable'), true);
  assert.equal(await run('document.querySelector(".soduwork-auth-form-badge").hidden'), false);
  assert.equal(await run('document.querySelector(".soduwork-auth-form-badge").textContent'), '本地代码启动');
  const switchers = '.soduwork-auth-connection,.soduwork-auth-production,.soduwork-auth-local,#soduWorkAuthHub,.soduwork-auth-connect,#hubEnvironmentPicker,#hubUrlInput,#hubUrlSave,[data-hub-env]';
  assert.equal(await run('document.querySelectorAll(' + JSON.stringify(switchers) + ').length'), 3,
    'exactly one address panel (details, input, button) is offered to local-code runs');
  assert.equal(await run('document.querySelector(".soduwork-auth-connection").open'), true,
    'a connectivity failure auto-expands the address panel for repointing');
  await click('.soduwork-auth-connection summary');
  assert.equal(await run('document.querySelector(".soduwork-auth-connection").open'), false);
  await assertConnectionLabel(endpoint.PRODUCTION_HUB);
  await click('.soduwork-auth-connection summary');
  assert.equal(await run('document.querySelector(".soduwork-auth-connection").open'), true,
    'local-code legacy login opens the address editor through its own summary');
  assert.equal(requests.length, 0, 'offline product verification never reaches a backend');
  assert.equal(await run('localStorage.getItem("soduwork_work_device_secret")'), null,
    'retired plaintext device keys are removed from renderer storage even while offline');
  await click('.soduwork-auth-retry');
  await until('!document.querySelector(".soduwork-auth-retry").disabled');
  assert.equal(await run('SoduWorkAPI.hubBase()'), endpoint.PRODUCTION_HUB);
  fs.writeFileSync(path.join(out, 'fixed-production-login.png'), (await win.webContents.capturePage()).toPNG());
  win.setSize(420, 760); await sleep(180);
  assert.equal(await run('document.querySelector(".soduwork-auth-submit").getBoundingClientRect().right <= innerWidth'), true);
  fs.writeFileSync(path.join(out, 'fixed-production-login-narrow.png'), (await win.webContents.capturePage()).toPNG());
  report.cases.push('local-code defaults resolve to production and auto-expand the address panel on failure; retry retains production offline');

  /* Test login-gate address changes: reject invalid URLs inline and reload after saving valid ones. */
  win.destroy(); await open();
  await until('document.querySelector(".soduwork-auth-connection") && !document.querySelector("#soduWorkAuthHub").disabled');
  await run('document.querySelector(".soduwork-auth-connection").open = true');
  await fill('#soduWorkAuthHub', 'https://example.com/api');
  await click('.soduwork-auth-connect');
  await until('document.querySelector(".soduwork-auth-status").textContent.includes("后台地址")');
  assert.equal(await run('SoduWorkAPI.hubBase()'), endpoint.PRODUCTION_HUB);
  await fill('#soduWorkAuthHub', a.url);
  await click('.soduwork-auth-connect');
  await until('SoduWorkAPI.hubBase() === ' + JSON.stringify(a.url));
  await sleep(1500);
  /* the saved address must survive the reload; a stale connection snapshot rolls it back */
  assert.equal(await run('SoduWorkAPI.hubBase()'), a.url, 'saved address survives the reload');
  await until('document.querySelector("#soduWorkAuthHub") && document.querySelector("#soduWorkAuthHub").value === ' + JSON.stringify(a.url));
  assert.equal(await run('SoduWorkAPI.hubConfig().editable'), true);
  assert.ok(requests.every(row => row.label !== 'bob'), 'foreign fixture stays untouched while repointing');
  fs.writeFileSync(path.join(out, 'local-code-repointed.png'), (await win.webContents.capturePage()).toPNG());
  report.cases.push('local-code login gate repoints the service in place; invalid addresses are rejected without reload');

  win.destroy(); await open('email');
  await until('ClientAuth.snapshot().policy?.mailReady && !document.querySelector("#soduWorkAuthAccount").disabled');
  assert.equal(await run('document.querySelector(".ac-account-label").textContent'), '账号');
  assert.equal(await run('document.querySelector("[data-auth-code]").hidden'), true);
  assert.equal(await run('document.querySelector(".soduwork-auth-connection").open'), false);
  await assertConnectionLabel(a.url);
  await click('.soduwork-auth-connection summary');
  assert.equal(await run('document.querySelector(".soduwork-auth-connection").open'), true);
  await fill('#soduWorkAuthHub', 'https://example.com/api'); await click('.soduwork-auth-connect');
  await until('document.querySelector(".soduwork-auth-status").textContent.includes("后台地址")');
  assert.equal(await run('SoduWorkAPI.hubBase()'), a.url);
  await fill('#soduWorkAuthHub', a.url); await click('.soduwork-auth-connect');
  await until('document.querySelector("#soduWorkAuthAccount") && !document.querySelector("#soduWorkAuthAccount").disabled');
  await sleep(1200);
  assert.equal(await run('SoduWorkAPI.hubBase()'), a.url);
  await until('ClientAuth.snapshot().policy?.mailReady');
  await click('[data-auth-mode="register"]');
  assert.equal(await run('document.querySelector("[data-auth-code]").hidden'), false);
  assert.equal(await run('document.querySelector(".ac-account-label").textContent'), '邮箱');
  assert.equal(await run('document.querySelector("[data-send-code]").disabled'), false);
  await assertConnectionLabel(a.url);
  await click('.soduwork-auth-connection summary');
  assert.equal(await run('document.querySelector(".soduwork-auth-connection").open'), true,
    'local-code email registration retains the editable service panel');
  fs.writeFileSync(path.join(out, 'local-email-registration-connection.png'), (await win.webContents.capturePage()).toPNG());
  report.cases.push('EmailAuth defaults to account/password; local address saves work through real clicks and registration retains its editable panel with a plain host footer');

  win.destroy();
  endpoint.initialize(app, { SODUWORK_TEST_HUB_URL: a.url, SODUWORK_USER_DATA: app.getPath('userData') });
  await open();
  await until('!document.querySelector(".soduwork-auth-submit").disabled');
  assert.equal(await run('SoduWorkAPI.hubBase()'), a.url);
  assert.equal(await run('document.querySelectorAll(' + JSON.stringify(switchers) + ').length'), 0);
  await assertConnectionLabel(a.url);
  assert.equal(await run('document.querySelectorAll(' + JSON.stringify(switchers) + ').length'), 0);
  await fill('#soduWorkAuthAccount', 'alice'); await fill('#soduWorkAuthPassword', 'fixture-password');
  await click('.soduwork-auth-pw-eye');
  assert.equal(await run('document.querySelector("#soduWorkAuthPassword").type'), 'text');
  await click('.soduwork-auth-submit');
  await until('document.querySelector("#soduWorkClientAuthGate").hidden');
  assert.equal(await run('document.querySelector("#soduWorkAuthPassword").value'), '');
  assert.equal(await run('document.querySelector("#soduWorkAuthPassword").type'), 'password');
  await until('SoduWorkAPI.clientAuthSnapshot().user?.id === "alice"');
  const identityA = auth.identity(app);
  assert.equal(identityA.hub, a.url);
  assert.notEqual(identityA.secret, 'fixture-old-local-key');
  assert.equal((await run('window.soduWorkAPI.selectHubEnvironment(' + JSON.stringify(b.url) + ')')).ok, false);
  assert.equal(auth.identity(app).hub, a.url);
  assert.equal(requests.filter(row => row.label === 'bob').length, 0);
  assert.ok(requests.filter(row => row.key).every(row => row.key !== 'fixture-old-local-key'));
  report.cases.push('explicit internal loopback profile supports normal secure login; foreign IPC is rejected without request or identity change');

  const beforeUpdates = requests.filter(row => row.path.startsWith('/api/v1/client-updates/')).length;
  assert.equal((await run('soduWorkAPI.checkClientUpdate()')).state, 'development');
  assert.equal(requests.filter(row => row.path.startsWith('/api/v1/client-updates/')).length, beforeUpdates,
    'unpackaged source runs do not perform installer update checks');
  assert.equal((await run('soduWorkAPI.checkClientUpdate({ testMode: true })')).state, 'current');
  const update = requests.find(row => row.path.startsWith('/api/v1/client-updates/check?'));
  assert.equal(update.label, 'alice');
  assert.equal(update.authorization, 'Device session-alice');
  const updateQuery = new URL(update.path, a.url).searchParams;
  assert.equal(updateQuery.get('current'), app.getVersion());
  assert.equal(updateQuery.get('platform'), process.platform);
  assert.equal(updateQuery.get('arch'), process.arch);
  assert.equal(updateQuery.get('channel'), 'stable');
  const usage = require('../main/agent-runtime/usage-reporter').createUsageReporter({
    app, identityOf: auth.authenticatedIdentity });
  usage.observe({ usageIdentity: identityA, sessionId: 'privacy-fixture-chat', adapterId: 'pi', model: 'fixture-model' },
    { messages: [{ role: 'assistant', done: true, content: 'fixture-private-answer',
      usage: { input: 4, output: 6, totalTokens: 10 } }] });
  await usage.flush();
  const accounting = requests.find(row => row.path === '/api/v1/usage/events');
  assert.ok(accounting, 'usage accounting reaches the selected Hub through real HTTP');
  assert.equal(accounting.label, 'alice');
  assert.equal(accounting.authorization, 'Device session-alice');
  assert.equal(accounting.body.model, 'fixture-model');
  assert.equal(accounting.body.usage.total, 10);
  assert.ok(!JSON.stringify(accounting.body).includes('fixture-private-answer'));
  assert.equal(requests.filter(row => row.label === 'bob').length, 0);
  report.cases.push('source update checks stay local; explicit update IPC and usage accounting use the authenticated selected Hub over HTTP');

  win.destroy(); await open();
  await until('SoduWorkAPI.clientAuthSnapshot().user?.id === "alice"');
  await until('document.querySelector("#soduWorkClientAuthGate").hidden && !document.documentElement.classList.contains("soduwork-auth-pending")');
  assert.equal(await run('localStorage.getItem("fixture-history")'), 'preserved');
  assert.equal(auth.identity(app).clientId, identityA.clientId);
  const persisted = fs.readFileSync(path.join(root, 'profile/device-auth.json'), 'utf8');
  assert.ok(!persisted.includes(identityA.secret));
  await run('document.querySelector("#settingsPanel").classList.add("show")');
  await sleep(100);
  assert.equal(await run('document.querySelectorAll(' + JSON.stringify(switchers) + ').length'), 0);
  fs.writeFileSync(path.join(out, 'fixed-settings.png'), (await win.webContents.capturePage()).toPNG());
  report.cases.push('window reopen preserves identity/history and OS-encrypted key; real settings markup retains no environment switch');

  win.destroy();
  endpoint.initialize(app, { SODUWORK_TEST_HUB_URL: b.url, SODUWORK_USER_DATA: app.getPath('userData') });
  await open('email');
  await until('ClientAuth.snapshot().policy?.mailReady && !document.querySelector(".soduwork-auth-submit").disabled');
  assert.equal(await run('SoduWorkAPI.hubBase()'), b.url);
  assert.equal(await run('SoduWorkAPI.hubConfig().editable'), false);
  assert.equal(await run('document.querySelectorAll(' + JSON.stringify(switchers) + ').length'), 0);
  await assertConnectionLabel(b.url);
  assert.equal(await run('document.querySelectorAll(' + JSON.stringify(switchers) + ').length'), 0);
  report.appearance = await run(`(() => {
    const gate = document.querySelector('.soduwork-auth-gate'), card = document.querySelector('.soduwork-auth-card');
    return { fontToken: getComputedStyle(gate).getPropertyValue('--font-ui').trim(),
      fontFamily: getComputedStyle(card).fontFamily, headingFont: getComputedStyle(card.querySelector('h1')).fontFamily,
      accent: getComputedStyle(gate).getPropertyValue('--accent').trim(),
      logoLoaded: card.querySelector('img').complete && card.querySelector('img').naturalWidth > 0 };
  })()`);
  assert.match(report.appearance.fontToken, /sans-serif/);
  assert.match(report.appearance.fontFamily, /sans-serif/);
  assert.match(report.appearance.headingFont, /sans-serif/);
  assert.equal(report.appearance.accent, '#3d8bff');
  assert.equal(report.appearance.logoLoaded, true);
  fs.writeFileSync(path.join(out, 'fixed-email-login.png'), (await win.webContents.capturePage()).toPNG());
  win.setSize(420, 760); await sleep(180);
  await assertNarrowLayout();
  fs.writeFileSync(path.join(out, 'fixed-email-login-narrow.png'), (await win.webContents.capturePage()).toPNG());
  win.setSize(920, 860); await sleep(180);
  await click('[data-auth-mode="register"]');
  assert.equal(await run('document.querySelector(".ac-account-label").textContent'), '邮箱');
  assert.equal(await run('document.querySelector("[data-auth-code]").hidden'), false);
  assert.equal(await run('document.querySelector("[data-send-code]").disabled'), false);
  await assertConnectionLabel(b.url);
  assert.equal(await run('document.querySelectorAll(' + JSON.stringify(switchers) + ').length'), 0);
  fs.writeFileSync(path.join(out, 'fixed-email-registration.png'), (await win.webContents.capturePage()).toPNG());
  win.setSize(420, 760); await sleep(180);
  await assertNarrowLayout();
  await run('document.querySelector(".ac-auth-footer").scrollIntoView({block:"end"})');
  await sleep(100);
  fs.writeFileSync(path.join(out, 'fixed-email-registration-narrow.png'), (await win.webContents.capturePage()).toPNG());
  win.setSize(920, 860); await sleep(180);
  await click('.ac-auth-back');
  const aRequests = requests.filter(row => row.label === 'alice').length;
  assert.equal((await run('window.soduWorkAPI.selectHubEnvironment(' + JSON.stringify(a.url) + ')')).ok, false);
  assert.equal(requests.filter(row => row.label === 'alice').length, aRequests);
  await fill('#soduWorkAuthAccount', 'bob'); await fill('#soduWorkAuthPassword', 'fixture-password');
  await click('[data-password-toggle]');
  assert.equal(await run('document.querySelector("#soduWorkAuthPassword").type'), 'text');
  await click('.soduwork-auth-submit');
  await until('document.querySelector("#soduWorkClientAuthGate").hidden && SoduWorkAPI.clientAuthSnapshot().user?.id === "bob"');
  assert.equal(await run('document.querySelector("#soduWorkAuthPassword").value'), '');
  assert.equal(auth.identity(app).hub, b.url);
  assert.deepEqual(await run('fixtureErrors'), []);
  report.cases.push('fixed EmailAuth login and registration show only a plain host footer with no editor at normal and narrow widths; secure account/password login and foreign IPC rejection still work');
  report.requests = { fixture: requests.length, aliceFixture: requests.filter(row => row.label === 'alice').length,
    bobFixture: requests.filter(row => row.label === 'bob').length, fixedEndpointSelectionsRejected: 2 };
  report.ok = true;
}).catch(error => { report.error = error.stack; process.exitCode = 1; }).finally(async () => {
  if (win && !win.isDestroyed()) win.destroy();
  for (const server of servers) await new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  });
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
});
