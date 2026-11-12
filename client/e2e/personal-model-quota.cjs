'use strict';
// Real Electron IPC/Session/SDK -> TCP Hub -> deterministic OpenAI provider.
// The provider's semantic outputs are fixtures; no paid model or user profile is used.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const electron = require('electron');
const client = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await delay(50); }
  throw Error('Timed out: ' + label);
}
async function json(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  const body = await response.json();
  return { status: response.status, body };
}
function stop(process) {
  if (!process || process.exitCode !== null || process.signalCode !== null) return;
  if (global.process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(process.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else process.kill('SIGKILL');
}
async function portClosed(url) {
  const net = require('node:net'), target = new URL(url);
  return new Promise(resolve => {
    const socket = net.connect({ host: target.hostname, port: Number(target.port) });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => { socket.destroy(); resolve(true); });
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
}

if (typeof electron === 'string') {
  (async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-personal-quota-'));
    const log = fs.openSync(path.join(root, 'hub.log'), 'w');
    const python = process.env.SODUWORK_TEST_PYTHON || 'python';
    const hub = spawn(python, ['-B', path.join(client, '../hub-backend/tests/personal_model_quota_hub.py'), '--root', root],
      { cwd: root, windowsHide: true, stdio: ['pipe', log, log], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let native, nativeLog, ready, report = { ok: false, root, cases: [] };
    try {
      await until(() => {
        if (hub.exitCode !== null) throw Error('Hub fixture exited: ' + hub.exitCode);
        return fs.existsSync(path.join(root, 'ready.json'));
      }, 'isolated Hub readiness', 45000);
      ready = JSON.parse(fs.readFileSync(path.join(root, 'ready.json'), 'utf8'));
      const env = { ...process.env };
      for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
        'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
      nativeLog = fs.openSync(path.join(root, 'electron.log'), 'w');
      native = spawn(electron, [__filename, root], { cwd: client, windowsHide: true, env, stdio: ['ignore', nativeLog, nativeLog] });
      await until(() => native.exitCode !== null || native.signalCode !== null, 'Electron E2E completion', 300000);
      report = JSON.parse(fs.readFileSync(path.join(root, 'electron-report.json'), 'utf8'));
      assert.equal(native.exitCode, 0, report.error || 'Electron failed');
      assert.equal(report.ok, true, report.error);
    } catch (error) { report.ok = false; report.error = String(error.stack || error); }
    finally {
      try { stop(native); } catch (error) { report.ok = false; report.cleanupError = String(error); }
      if (nativeLog !== undefined) fs.closeSync(nativeLog);
      if (ready && hub.exitCode === null) {
        try { await json(ready.hub + '/__fixture__/shutdown', { method: 'POST', headers: { 'x-fixture-key': ready.controlKey } }); } catch {}
      }
      hub.stdin.end();
      try { await until(() => hub.exitCode !== null || hub.signalCode !== null, 'Hub shutdown', 10000); }
      catch (error) { stop(hub); report.ok = false; report.cleanupError = String(error); }
      fs.closeSync(log);
      report.cleanup = { hubExit: hub.exitCode, electronExit: native?.exitCode,
        hubPortClosed: ready ? await portClosed(ready.hub) : true,
        providerPortClosed: ready ? await portClosed(ready.provider) : true };
      const aliveOwned = () => (report.ownedElectronPids || []).filter(pid => {
        try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
      });
      try { await until(() => aliveOwned().length === 0, 'owned Electron processes exit', 10000); }
      catch (error) { report.ok = false; report.cleanupError = String(error); }
      report.cleanup.remainingOwnedElectronPids = aliveOwned();
      if (hub.exitCode !== 0 || !report.cleanup.hubPortClosed || !report.cleanup.providerPortClosed) report.ok = false;
      const hubLog = fs.readFileSync(path.join(root, 'hub.log'), 'utf8');
      if (/Traceback \(most recent call last\)|ERROR:.*Exception in ASGI/.test(hubLog)) {
        report.ok = false; report.hubError = 'Uncaught Hub error; inspect hub.log';
      }
      fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ ok: report.ok, cases: report.cases?.length || 0, root, error: report.error, cleanup: report.cleanup }));
      process.exitCode = report.ok ? 0 : 1;
    }
  })().catch(error => { console.error(error.stack); process.exitCode = 1; });
} else {
  const { app, BrowserWindow, ipcMain, net } = electron;
  const root = path.resolve(process.argv[2]);
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('soduwork-personal-quota-'));
  const ready = JSON.parse(fs.readFileSync(path.join(root, 'ready.json'), 'utf8'));
  assert.equal(new URL(ready.hub).hostname, '127.0.0.1');
  app.disableHardwareAcceleration(); app.setAppPath(client);
  app.setPath('userData', path.join(root, 'profile'));
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const report = { ok: false, cases: [], boundary: 'Actual production Electron IPC, Pi SDK, Hub HTTP/auth/proxy and SQLite ledger; deterministic provider output, no external paid credentials.' };
  let win, bridge, identity;
  const mark = name => { report.cases.push(name); console.log('PASS ' + name); };
  const deviceHeaders = () => ({ Authorization: 'Device ' + identity.session, 'content-type': 'application/json' });
  const api = (route, method = 'GET', body, headers = deviceHeaders()) => json(ready.hub + route,
    { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const control = (route = '/state', body) => api('/__fixture__' + route, body === undefined ? 'GET' : 'POST', body,
    { 'x-fixture-key': ready.controlKey, 'content-type': 'application/json' });
  const admin = (route, body) => api(route, 'PATCH', body, { Authorization: 'Bearer ' + ready.adminToken, 'content-type': 'application/json' });
  const js = code => win.webContents.executeJavaScript(code, true);
  async function click(selector) {
    await win.webContents.capturePage();
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing target');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);if(!e.contains(document.elementFromPoint(x,y)))throw Error('Occluded target');return{x,y}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(60);
  }
  async function choose(name, allowed = true) {
    await click('.nmodel-button');
    await until(() => js('!!document.querySelector(' + JSON.stringify('[data-model-name="' + name + '"]') + ')'), 'model option');
    const before = await js('selected.length');
    await click('[data-model-name="' + name + '"]');
    await until(() => js('selected.length>' + before), 'model selection IPC');
    const result = await js('selected.at(-1).result');
    assert.equal(result.ok, allowed, JSON.stringify(result));
    if (!allowed) await js('document.querySelector("[data-model-close]")?.click()');
    return result;
  }
  async function send(text) {
    await js('(()=>{const input=document.querySelector("#nchatInput");input.value=' + JSON.stringify(text) + ';input.dispatchEvent(new Event("input",{bubbles:true}));})()');
    const before = await js('sent.length'); await click('#nchatSend');
    await until(() => js('sent.length>' + before), 'send IPC');
    return js('sent.at(-1)');
  }
  async function idle() {
    return until(async () => {
      const state = await js('quotaFixture.invoke("pi-session-snapshot",state.ref)');
      const handle = require('../main/agent-runtime/pi-session-bridge').get(await js('state.ref'));
      return handle && !handle.inFlight() ? state.snapshot : false;
    }, 'real Pi turn completion', 60000);
  }
  app.whenReady().then(async () => {
    const auth = require('../main/device-auth');
    require('../main/hub-endpoint.cjs').initialize(app, { SODUWORK_TEST_HUB_URL: ready.hub,
      SODUWORK_USER_DATA: app.getPath('userData') });
    auth.install({ app, ipcMain, safeStorage: electron.safeStorage });
    const login = await auth.login(app, { hub: ready.hub, account: ready.account, password: ready.password,
      workRoot: workspace, name: 'Isolated quota E2E', platform: process.platform });
    assert.equal(login.ok, true, JSON.stringify(login));
    const enrolled = auth.identity(app, ready.hub);
    const identityOf = async () => auth.authenticatedIdentity(app, ready.hub, enrolled.clientId);
    identity = await identityOf();
    assert.equal((await admin('/api/v1/admin/users/' + ready.userId, { tokenQuota: { mode: 'limited', limit: 56 } })).status, 200);
    let catalog = (await api('/api/v1/my-models')).body;
    const saved = await api('/api/v1/my-models', 'PUT', { expectedRevision: catalog.revision,
      providers: [{ id: 'custom-quota-personal', name: 'Personal fixture', kind: 'openai-compat', personal: true, baseUrl: ready.provider + '/v1' },
        { id: 'custom-quota-keyless', name: 'Keyless fixture', kind: 'openai-compat', personal: true, authMode: 'none', baseUrl: ready.provider + '/v1' }],
      keys: { 'custom-quota-personal': ready.personalKey },
      models: [{ providerId: 'custom-quota-personal', name: 'personal-model', label: 'Personal fixture model' },
        { providerId: 'custom-quota-keyless', name: 'keyless-model', label: 'Keyless fixture model' }] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const admission = require('../main/conversation/quota-admission.cjs');
    const onQuotaExceeded = detail => {
      (report.quotaEvents ||= []).push(detail.quota);
      if (win && !win.isDestroyed()) win.webContents.send('device-auth-quota-exceeded', detail);
    };
    bridge = require('../main/pi-session/ipc').install({ app, ipcMain, BrowserWindow, identityOf,
      sendIdentityOf: identityOf, capabilityGrantsOf: async () => [], onQuotaExceeded,
      authorizeAI: admission.create({ app, identityOf, onQuotaExceeded }) });
    const catalogChanges = require('../main/agent-runtime/catalog-changes.cjs').create({
      session: require('../main/agent-runtime/pi-session-bridge'), contents: () => electron.webContents.getAllWebContents(),
      invalidateModels() {
        require('../main/pi-session/model-config').invalidate();
        require('../main/agent-runtime/process-session').invalidateModels();
      },
    });
    report.catalogChanges = 0;
    ipcMain.on('soduwork-work-broadcast', (event, kind) => {
      if (catalogChanges.receive(event, kind)) report.catalogChanges++;
    });
    ipcMain.handle('quota-fixture-catalog', async () => (await api('/api/v1/my-models')).body);
    ipcMain.handle('quota-fixture-me', async () => (await api('/api/v1/client-auth/me')).body);
    const preload = path.join(root, 'preload.cjs');
    fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('quotaFixture',{invoke:(...args)=>ipcRenderer.invoke(...args),close:ref=>ipcRenderer.send('pi-session-close',ref),catalogChanged:()=>ipcRenderer.send('soduwork-work-broadcast','models'),event:fn=>ipcRenderer.on('pi-session-event',(_event,value)=>fn(value)),quota:fn=>ipcRenderer.on('device-auth-quota-exceeded',(_event,value)=>fn(value))});`);
    let html = fs.readFileSync(path.join(__dirname, 'fixtures/compact-chat-model.html'), 'utf8');
    const base = pathToFileURL(path.join(__dirname, 'fixtures/')).href;
    html = html.replace('<head>', '<head><base href="' + base + '">').replace('<head><meta', '<head><base href="' + base + '"><meta');
    html = html.replace('</head>', '<link rel="stylesheet" href="../../components/client-auth/quota-notice.css"><script src="../../core/token-quota.js"></script><script src="../../components/client-auth/quota-notice.js"></script></head>');
    html = html.replace(/<script>\s*window.errors=[\s\S]*?<\/script><\/body>/, `<script>
      window.errors=[];addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
      window.selected=[];window.sent=[];window.notices=[];window.published=[];window.state={ref:'',adapterId:'pi'};quotaFixture.event(value=>published.push(value));
      window.SoduWorkAPI={myModels:()=>quotaFixture.invoke('quota-fixture-catalog'),clientAuthMe:()=>quotaFixture.invoke('quota-fixture-me'),hubConfig:()=>({hub:${JSON.stringify(ready.hub)}}),clientAuthSnapshot:()=>({user:{id:${JSON.stringify(ready.userId)}}})};
      window.soduWorkAPI={conversationSession:{runtimes:async()=>({ok:true,runtimes:[{id:'pi',modelMode:'managed'}]}),selectModel:async(ref,name)=>{const result=await quotaFixture.invoke('pi-session-select-model',ref,name);selected.push({name,result});return result;}}};
      WorkComposer.upgradeChat(document.querySelector('#old'));
      document.querySelector('.nbox').classList.add('work-composer');
      SoduWorkQuotaNotice.mount(document.querySelector('.nbox'));quotaFixture.quota(value=>SoduWorkQuotaNotice.update(value));
      window.controls=ChatComposerControls.create(document.querySelector('main'),{state:()=>state,say:s=>notices.push(s),modelSelected:s=>{state.selection=s},thinkingChanged:s=>{state.thinking=s},runtimeSelected:s=>Object.assign(state,s.snapshot),renderQueue(){},updateQueue(){}});
      document.querySelector('#nchatSend').addEventListener('click',async()=>{const text=document.querySelector('#nchatInput').value;const result=await quotaFixture.invoke('pi-session-send',state.ref,text,[],{});sent.push(result);});
      window.openFixture=async()=>{const opened=await quotaFixture.invoke('pi-session-open',{cwd:${JSON.stringify(workspace)},adapterId:'pi',modelName:'platform-model'});if(!opened.ok)throw Error(JSON.stringify(opened));window.opened=opened;state.ref=opened.ref;state.selection=opened.snapshot.modelSelection;state.model=opened.snapshot.model;controls.render();return opened;};
      window.fixtureReady=true;
    </script></body>`);
    win = new BrowserWindow({ show: false, width: 1100, height: 760, webPreferences: {
      offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, preload,
      partition: 'personal-quota-' + require('node:crypto').randomUUID(), backgroundThrottling: false } });
    const desk = pathToFileURL(path.join(client, 'desk.html')).href;
    win.webContents.session.protocol.handle('file', request => request.url === desk
      ? new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      : net.fetch(request.url, { bypassCustomProtocolHandlers: true }));
    await win.loadURL(desk); await until(() => js('window.fixtureReady'), 'production composer fixture');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await js('SoduWorkAPI.clientAuthMe().then(value=>SoduWorkQuotaNotice.update(value))');
    await js('openFixture()');
    const platformTicket = (await api('/api/v1/ai-proxy/config?model=platform-model&agent=pi')).body.key;
    assert.ok(platformTicket);
    assert.equal((await send('quota fixture draft: create the first plugin draft')).ok, true);
    await idle();
    await until(async () => (await control()).body.quota.used >= 56, 'actual usage ledger exhaustion');
    assert.match(fs.readFileSync(path.join(workspace, 'plugin-draft.txt'), 'utf8'), /QUOTA_DRAFT_MARKER/);
    const before = (await control()).body;
    assert.equal(before.quota.exceeded, true);
    assert.equal(before.providerRequests.length, 2);
    mark('Production IPC/SDK writes a draft and actual platform usage exhausts the account allowance');
    await send('quota fixture continue: finish the plugin'); await idle();
    assert.equal((await control()).body.providerRequests.length, 2, 'exhausted platform must not reach provider');
    assert.equal(await js('document.querySelector("#nchatInput").value'), 'quota fixture continue: finish the plugin');
    await until(() => js('!!document.querySelector(".soduwork-quota-card:not([hidden])")'), 'quota notice');
    assert.match(await js('document.querySelector("[data-quota-guidance]").textContent'), /个人模型/);
    await js('document.querySelector(".fixture-copy").textContent="已通过真实工具保存 plugin-draft.txt；平台下一轮已停止，当前草稿和会话历史仍保留。"');
    await delay(100);
    fs.writeFileSync(path.join(root, 'platform-exhausted.png'), (await win.webContents.capturePage()).toPNG());
    mark('Exhausted platform next turn is rejected with quota guidance and retained draft');
    await choose('personal-model');
    assert.match(await js('document.querySelector(".nmodel-button").textContent'), /Personal fixture model|personal-model/);
    assert.equal(await js('document.querySelector("#nchatInput").value'), 'quota fixture continue: finish the plugin');
    assert.equal(await js('document.querySelector(".soduwork-quota-card").hidden'), true,
      JSON.stringify({ selection: await js('state.selection'), quota: report.quotaEvents?.at(-1) }));
    await send('quota fixture continue: finish the plugin'); const snapshot = await idle();
    await until(async () => (await control()).body.daily.some(row => row.scope === 'personal' && row.tokens > 0), 'personal ledger receipt');
    const after = (await control()).body;
    assert.equal(after.quota.used, before.quota.used);
    assert.equal(after.providerRequests.length, 5);
    assert.equal(after.providerRequests.filter(row => row.args?.path === 'plugin-draft.txt').length, 1);
    assert.equal(after.providerRequests.filter(row => row.args?.path === 'plugin.json').length, 1);
    assert.equal(after.providerRequests.filter(row => row.args?.path === 'index.html').length, 1);
    assert.ok(after.providerRequests.slice(2).every(row => row.keyKind === 'personal'));
    assert.match(JSON.stringify(snapshot), /QUOTA_DRAFT_MARKER|plugin-draft.txt/);
    assert.match(fs.readFileSync(path.join(workspace, 'index.html'), 'utf8'), /PERSONAL_CONTINUATION_MARKER/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(workspace, 'plugin.json'), 'utf8')).id, 'quota-continuation-fixture');
    await js('document.querySelector(".fixture-copy").textContent="PERSONAL_CONTINUATION_COMPLETE：同一会话已保留 plugin-draft.txt，并通过真实工具生成 plugin.json 和 index.html。"');
    await delay(100);
    fs.writeFileSync(path.join(root, 'personal-continuation.png'), (await win.webContents.capturePage()).toPNG());
    mark('Real model picker switches to personal model; same session continues tools/files without duplicate execution or platform charges');
    await choose('platform-other', false);
    assert.equal(await js('state.selection.name'), 'personal-model');
    const cached = await api('/api/v1/ai-proxy/v1/chat/completions', 'POST', { model: 'platform-model', messages: [{ role: 'user', content: 'cached ticket probe' }] },
      { Authorization: 'Bearer ' + platformTicket, 'content-type': 'application/json' });
    assert.equal(cached.status, 403);
    assert.equal((await control()).body.providerRequests.length, 5);
    mark('Platform picker failure and an existing proxy ticket cannot bypass exhausted quota');

    const resumedFiles = Object.fromEntries(['plugin-draft.txt', 'plugin.json', 'index.html'].map(name =>
      [name, require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(workspace, name))).digest('hex')]));
    const oldRef = await js('state.ref'), archivedId = await js('opened.sessionId');
    report.ownedElectronPids = app.getAppMetrics().map(row => row.pid);
    const personalTotal = data => data.daily.filter(row => row.model === 'personal-model' && row.scope === 'personal')
      .reduce((total, row) => total + row.tokens, 0);
    await until(async () => personalTotal((await control()).body) === 84, 'complete pre-resume personal ledger');
    await js('quotaFixture.close(state.ref)');
    await until(() => !require('../main/agent-runtime/pi-session-bridge').get(oldRef), 'owned runtime closes before archive resume');
    const reopened = await js(`(async()=>{
      const result=await quotaFixture.invoke('pi-session-open',{chatId:${JSON.stringify(archivedId)},adapterId:'pi'});
      window.reopened=result;if(!result.ok)throw Error(JSON.stringify(result));
      state.ref=result.ref;state.adapterId=result.adapterId;state.selection=result.snapshot.modelSelection;
      state.model=result.snapshot.model;controls.render();return result;
    })()`);
    assert.equal(reopened.resumed, true);
    assert.equal(reopened.sessionId, archivedId);
    assert.notEqual(reopened.ref, oldRef, 'must reopen the archive, not reattach a live runtime');
    assert.equal(path.resolve(reopened.cwd), path.resolve(workspace));
    assert.equal(await js('state.selection.name'), 'personal-model');
    assert.match(JSON.stringify(reopened.snapshot), /QUOTA_DRAFT_MARKER|plugin-draft.txt/);
    assert.match(JSON.stringify(reopened.snapshot), /PERSONAL_CONTINUATION_COMPLETE/);
    assert.equal((await send('quota fixture resume: verify retained context without rerunning tools')).ok, true);
    await idle();
    await until(async () => personalTotal((await control()).body) === 112, 'resumed personal turn adds exactly 28 tokens');
    const resumedState = (await control()).body;
    assert.equal(resumedState.quota.used, before.quota.used);
    assert.equal(resumedState.providerRequests.length, 6);
    assert.equal(resumedState.providerRequests.at(-1).keyKind, 'personal');
    assert.equal(resumedState.providerRequests.filter(row => row.tool).length, 3, 'resume must not execute prior tools again');
    for (const [name, digest] of Object.entries(resumedFiles)) {
      assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(workspace, name))).digest('hex'), digest);
    }
    report.resume = { sameSession: true, newRuntime: true, sameWorkspace: true,
      personalTokensBefore: 84, personalTokensAfter: 112, platformTokens: resumedState.quota.used, toolExecutions: 3 };
    mark('Real close/reopen restores the same archive, personal model, history and files; next turn adds exactly its own usage without tool replay');

    await choose('keyless-model');
    await send('keyless personal provider inference probe'); await idle();
    await until(async () => (await control()).body.daily.some(row => row.model === 'keyless-model' && row.scope === 'personal'), 'keyless personal accounting');
    let current = (await control()).body;
    assert.equal(current.providerRequests.at(-1).keyKind, 'none');
    assert.equal(current.quota.used, before.quota.used);
    mark('A no-key local personal model performs real SDK inference without consuming platform allowance');

    const headersAdmin = { Authorization: 'Bearer ' + ready.adminToken, 'content-type': 'application/json' };
    async function saveKeys(keys) {
      const config = (await api('/api/v1/my-models')).body;
      const result = await api('/api/v1/my-models', 'PUT', { expectedRevision: config.revision, keys });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      const previous = report.catalogChanges;
      await js('quotaFixture.catalogChanged()');
      await until(() => report.catalogChanges > previous, 'production catalog invalidation IPC');
    }
    const configFor = name => api('/api/v1/ai-proxy/config?agent=pi&model=' + encodeURIComponent(name));
    const proxy = (ticket, name) => api('/api/v1/ai-proxy/v1/chat/completions', 'POST',
      { model: name, messages: [{ role: 'user', content: 'guard probe' }] },
      { Authorization: 'Bearer ' + ticket, 'content-type': 'application/json' });
    assert.equal((await admin('/api/v1/admin/users/' + ready.userId, { tokenQuota: { mode: 'limited', limit: 10000 } })).status, 200);
    await saveKeys({ 'fixture-platform': ready.personalKey });
    const countBeforeStale = (await control()).body.providerRequests.length;
    assert.equal((await proxy(platformTicket, 'platform-model')).status, 409, 'old platform ticket must not silently switch to personal funding');
    assert.equal((await control()).body.providerRequests.length, countBeforeStale);
    await choose('platform-model');
    assert.equal(await js('state.selection.model.quotaScope'), 'personal');
    const samePersonal = (await configFor('platform-model')).body;
    assert.equal(samePersonal.quotaScope, 'personal');
    await send('same model name personal-key inference'); await idle();
    await until(async () => (await control()).body.daily.some(row => row.model === 'platform-model' && row.scope === 'personal'), 'same-name personal receipt');
    current = (await control()).body;
    assert.equal(current.providerRequests.at(-1).keyKind, 'personal');
    assert.equal(current.quota.used, before.quota.used);
    await saveKeys({ 'fixture-platform': null });
    const requestCount = (await control()).body.providerRequests.length;
    assert.equal((await proxy(samePersonal.key, 'platform-model')).status, 409,
      'cached personal ticket must be rejected even while organization budget remains');
    assert.equal((await control()).body.providerRequests.length, requestCount);
    const fallback = await configFor('platform-model');
    assert.equal(fallback.status, 200); assert.equal(fallback.body.quotaScope, 'platform');
    await choose('platform-model');
    await send('same model name organization fallback after key removal'); await idle();
    await until(async () => (await control()).body.quota.used > before.quota.used, 'fresh organization inference billed to platform');
    current = (await control()).body;
    assert.equal(current.providerRequests.at(-1).keyKind, 'platform');
    assert.equal(current.quota.used, before.quota.used + 28);
    mark('Same provider/model changes funding safely: old tickets reject, production catalog event refreshes SDK, removed key falls back and bills platform');

    const personalConfig = (await configFor('personal-model')).body;
    assert.ok(personalConfig.quotaUsageToken);
    const platformUsed = current.quota.used;
    const tampered = personalConfig.quotaUsageToken.slice(0, -1) + (personalConfig.quotaUsageToken.endsWith('a') ? 'b' : 'a');
    const forged = await api('/api/v1/usage/events', 'POST', { sourceId: 'fixture-forged-personal-token',
      agent: 'pi', model: 'personal-model', provider: 'custom-quota-personal', quotaUsageToken: tampered,
      credentialScope: 'personal', billingMode: 'personal', usage: { input: 7 } });
    assert.equal(forged.status, 200);
    assert.equal((await control()).body.quota.used, platformUsed + 7);
    mark('Client-declared personal funding and a tampered receipt cannot exempt platform accounting');

    const callsBeforeGuards = (await control()).body.providerRequests.length;
    const assertPersonalDenied = async () => {
      assert.ok([401, 403].includes((await configFor('personal-model')).status));
      const admitted = await api('/api/v1/client-auth/authorize-ai?agent=pi&model=personal-model');
      assert.ok([401, 403].includes(admitted.status));
      assert.ok([401, 403].includes((await proxy(personalConfig.key, 'personal-model')).status));
      assert.equal((await control()).body.providerRequests.length, callsBeforeGuards);
    };
    await admin('/api/v1/admin/users/' + ready.userId, { tokenQuota: { mode: 'limited', limit: 0 } });
    await assertPersonalDenied();
    await admin('/api/v1/admin/users/' + ready.userId, { tokenQuota: { mode: 'limited', limit: 10000 } });
    await control('/account', { active: false }); await assertPersonalDenied();
    await control('/account', { active: true });
    mark('Explicit administrator zero pause and disabled accounts block personal config, admission and cached proxy inference');

    const member = (await api('/api/v1/admin/quotas/members/' + ready.userId, 'GET', undefined, headersAdmin)).body;
    const restricted = await api('/api/v1/admin/quotas/members/' + ready.userId, 'PUT', {
      revision: member.assignment.revision, mode: 'custom', custom: { totalLimit: 10000,
        restrictModels: true, models: [{ provider: 'fixture-platform', model: 'platform-model', limit: 10000 }] },
    }, headersAdmin);
    assert.equal(restricted.status, 200, JSON.stringify(restricted.body));
    await assertPersonalDenied();
    assert.equal((await configFor('personal-model')).body.detail.quota.reason, 'model_not_allowed');
    const restored = await api('/api/v1/admin/quotas/members/' + ready.userId, 'PUT', {
      revision: restricted.body.revision, mode: 'inherit' }, headersAdmin);
    assert.equal(restored.status, 200);
    const foreign = await api('/api/v1/ai-proxy/config?agent=pi&model=personal-model', 'GET', undefined,
      { Authorization: 'Device ' + ready.foreignToken });
    assert.ok(foreign.status !== 200 || foreign.body.ok !== true);
    assert.equal((await control()).body.providerRequests.length, callsBeforeGuards);
    mark('Model allowlists and a different signed-in identity cannot obtain the personal model or reach its provider');

    const final = (await control()).body;
    report.ledger = final.daily; report.providerRequests = final.providerRequests.map(({ model, keyKind, tool, args }) => ({ model, keyKind, tool, path: args?.path }));
    report.http = final.http;
    const publicState = await js('(async()=>JSON.stringify({opened,reopened,selected,sent,published,snapshot:await quotaFixture.invoke("pi-session-snapshot",state.ref)}))()');
    assert.doesNotMatch(publicState, /quotaUsageToken/);
    assert.equal(publicState.includes(personalConfig.quotaUsageToken), false);
    assert.equal(publicState.includes(samePersonal.quotaUsageToken), false);
    mark('Real open/select/send/snapshot IPC and published session events never expose signed funding receipts');
    assert.deepEqual(await js('errors'), []);
    report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); console.error(report.error); }).finally(async () => {
    report.ownedElectronPids = [...new Set([...(report.ownedElectronPids || []), ...app.getAppMetrics().map(row => row.pid)])];
    try { require('../main/agent-runtime/pi-session-bridge').closeAll(); await bridge?.dispose(); }
    catch (error) { report.ok = false; report.cleanupError = String(error.stack || error); }
    if (win && !win.isDestroyed()) win.destroy();
    fs.writeFileSync(path.join(root, 'electron-report.json'), JSON.stringify(report, null, 2));
    app.exit(report.ok ? 0 : 1);
  });
}
