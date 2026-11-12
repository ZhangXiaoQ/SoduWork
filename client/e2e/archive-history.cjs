'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..'), out = path.resolve(process.argv[2] || path.join(client, '../outputs/branch-merge-20260930/archive-browser'));
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-archive-e2e-')));
  fs.mkdirSync(out, { recursive: true }); app.setPath('userData', root); app.on('window-all-closed', () => {});
  const report = { ok: false, cases: [], errors: [] };
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  const sessions = require('../main/pi-session/session');
  const { createPiSessionBridge } = require('../main/agent-runtime/pi-session-bridge');
  const { createRunnerRuntimeAdapter } = require('../main/agent-runtime/runner-adapter');
  const catalog = require('../main/agent-runtime/runtime-catalog');
  let win, bridge, hub;
  const js = code => win.webContents.executeJavaScript(code, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code) { for (let i = 0; i < 150; i++) { if (await js(code)) return; await delay(30); } throw Error('Timed out: ' + code); }
  async function click(selector) {
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||!e.checkVisibility())throw Error('Unavailable: '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(50);
  }
  app.whenReady().then(async () => {
    // Real ownership checks use a disposable identity and an empty loopback Hub.
    // No business account, server, runner process or native user archive is used.
    hub = require('node:http').createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, items: [], chats: [], cursor: 0, hasMore: false }));
    });
    hub.on('upgrade', (_request, socket) => socket.destroy());
    await new Promise(resolve => hub.listen(0, '127.0.0.1', resolve));
    const synthetic = require('../tests/helpers/platform-session-fixture.cjs');
    const identity = { ...synthetic.identity(), session: synthetic.backendSessions().one,
      hub: 'http://127.0.0.1:' + hub.address().port };
    const auth = require('../main/device-auth');
    auth.identity = () => identity; auth.session = () => identity.session; auth.profiles = () => [];
    auth.localOwner = () => require('../main/platform-connections/runtime.cjs').scope(identity);
    const realFetch = global.fetch;
    global.fetch = (url, options) => {
      const target = new URL(typeof url === 'string' || url instanceof URL ? url : url.url);
      if (target.origin !== identity.hub) throw Error('Non-fixture network request blocked');
      return realFetch(url, options);
    };
    const directory = path.join(sessions.archiveRoot(app), 'sessions', 'fixture'); fs.mkdirSync(directory, { recursive: true });
    const transcript = path.join(directory, 'pi-fixture.jsonl');
    const bytes = [{ type: 'session', version: 3, id: 'pi-fixture', timestamp: '2026-09-29T00:00:00Z', cwd: root },
      { type: 'message', timestamp: '2026-09-29T00:01:00Z', message: { role: 'user', content: [{ type: 'text', text: '设置' }], timestamp: 1790640060000 } }]
      .map(x => JSON.stringify(x)).join('\n') + '\n';
    fs.writeFileSync(transcript, bytes);
    const rows = catalog.runnerRuntimes().map(spec => ({ ref: spec.id + '-fixture', cli: spec.id, workOwner: auth.localOwner(),
      taskId: 'chat-' + spec.id, title: 'Fixture ' + spec.displayName, state: 'done', started: Date.now() / 1000, ended: Date.now() / 1000 }));
    for (const id of ['pi-fixture', ...rows.map(row => row.ref)]) {
      require('../main/conversation/session-memory').bind(app, id, identity, [], true);
    }
    const runtime = { async rpc(op, input) {
      if (op === 'runtime.sessions') return { ok: true, data: { runs: rows } };
      if (op === 'runtime.session.forget') { const index = rows.findIndex(row => row.ref === input.ref); if (index >= 0) rows.splice(index, 1); }
      return { ok: true, data: {} };
    } };
    bridge = createPiSessionBridge({ app, sessionModule: sessions, runnerAdapters: catalog.runnerRuntimes()
      .map(runtimeSpec => createRunnerRuntimeAdapter({ app, runtimeSpec, runnerRuntime: runtime })) });
    Object.assign(require('../main/agent-runtime/pi-session-bridge'), bridge);
    require('../main/pi-session/ipc').install({ app, ipcMain, BrowserWindow, identityOf: () => identity, capabilityGrantsOf: () => [] });
    const panel = read('desk.html').match(/<section class="archive-history-panel"[\s\S]*?<\/section>\s*<div class="skin-manager"/)[0].replace(/<div class="skin-manager"$/, '');
    const styles = ['theme/variables.css', 'components/archive/archive-history-panel.css', 'theme/workspace-page-heads.css'].map(file => '<style>' + read(file) + '</style>').join('');
    const file = path.join(out, 'fixture.html');
    fs.writeFileSync(file, '<!doctype html><html data-desk-panel="workspace"><meta charset="utf-8">' + styles + '<style>body{margin:0;font:14px var(--font-ui);background:var(--bg-1)}</style>' + panel + '</html>');
    win = new BrowserWindow({ show: false, width: 1120, height: 760, webPreferences: { preload: path.join(client, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_r, cb) => cb({ cancel: true }));
    await win.loadFile(file);
    await js(`window.refreshes=0;window.SoduWorkAPI={hubBase:()=> ${JSON.stringify(identity.hub)},clientAuthSnapshot:()=>({clientId:'device',user:{id:'one'}})};window.WorkspaceShell={refreshConversationHistory:()=>refreshes++};void 0;`);
    for (const file of JSON.parse(read('core/locales/manifest.json'))) await js(read('core/locales/' + file));
    for (const file of ['core/i18n-dom.js', 'core/i18n.js', 'components/workspace/workspace-sidebar-state.js', 'components/archive/archive-history-panel.js']) await js(read(file) + '\nvoid 0;');
    const api = 'soduWorkAPI.conversationSession';
    const archiveIds = ['pi-fixture', ...rows.map(row => row.ref)];
    for (const id of archiveIds) assert.equal((await js(api + '.archiveHistory(' + JSON.stringify(id) + ')')).ok, true);
    assert.equal((await js(api + '.history()')).chats.length, 0);
    // A different account can browse the same local archive while Hub history is pending.
    await js(`window.legacyArchiveStore=WorkspaceSidebarState.create(WorkspaceSidebarState.accountOptions({storage:localStorage,api:SoduWorkAPI}));
      window.legacyArchiveProject=legacyArchiveStore.saveProject({name:'Shared archive fixture',folders:[]});
      legacyArchiveStore.move({id:${JSON.stringify(archiveIds[1])},title:'Saved local archive'},legacyArchiveProject);
      legacyArchiveStore.archiveProject(legacyArchiveProject);
      SoduWorkAPI.clientAuthSnapshot=()=>({clientId:'device',user:{id:'two'}});void 0;`);
    let releaseAccountHistory;
    bridge.setExternalHistory({ history: () => new Promise(resolve => { releaseAccountHistory = resolve; }) });
    await js('openArchiveHistory();void 0;');
    await until('document.querySelectorAll("#archiveHistoryList .archive-history-item").length===' + archiveIds.length);
    await until('document.querySelectorAll("#archiveProjectsList .archive-history-item").length===1');
    assert.equal(await js('document.querySelector("#archiveProjectsList .archive-history-item-title").textContent'), 'Shared archive fixture');
    assert.equal(typeof releaseAccountHistory, 'function');
    bridge.setExternalHistory(null);
    releaseAccountHistory({ ok: true, chats: [] });
    await js(`WorkspaceSidebarState.create(WorkspaceSidebarState.accountOptions({storage:localStorage,api:SoduWorkAPI})).permanentlyDeleteProject(legacyArchiveProject);
      SoduWorkAPI.clientAuthSnapshot=()=>({clientId:'device',user:{id:'one'}});
      window.dispatchEvent(new Event('soduwork-data-scope-changed'));void 0;`);
    await until('document.querySelectorAll("#archiveProjectsList .archive-history-item").length===0');
    report.cases.push('a cold archive view shares validated local groups across accounts without waiting for account history');
    assert.deepEqual((await js(api + '.archivedHistory()')).chats.map(row => row.id).sort(), archiveIds.slice().sort());
    report.cases.push('Pi and every production Runner adapter archive through real preload/IPC and durable archive-state');
    for (const locale of ['en-US', 'zh-CN', 'en-US']) {
      await js('SoduWorkI18n.setLocale(' + JSON.stringify(locale) + ');void 0;');
      await until('document.querySelector("#archiveHistoryTitle").textContent===' + JSON.stringify(locale === 'en-US' ? 'Archived conversations' : '归档会话'));
      assert.equal(await js('Array.from(document.querySelectorAll(".archive-history-item-title")).some(e=>e.textContent==="设置")'), true, 'user chat title must not be translated');
    }
    await click('#archiveHistorySortTrigger'); await click('[data-archive-sort="alpha"]');
    await js('SoduWorkI18n.setLocale("zh-CN");void 0;');
    await until('document.querySelector("#archiveHistorySortLabel").textContent==="按字母顺序"');
    await js('SoduWorkI18n.setLocale("en-US");void 0;');
    await until('document.querySelector("#archiveHistorySortLabel").textContent==="Alphabetical"');
    report.cases.push('locale round trip, dynamic count/date/sort and original user titles retained');
    await js('document.querySelector("#archiveHistorySearch").value="设置";document.querySelector("#archiveHistorySearch").dispatchEvent(new Event("input"));void 0;');
    await until('document.querySelectorAll("#archiveHistoryList .archive-history-item").length===1');
    await click('#archiveHistoryList .archive-history-restore');
    await until('document.querySelectorAll("#archiveHistoryList .archive-history-item").length===0');
    assert.equal(fs.readFileSync(transcript, 'utf8'), bytes);
    assert.equal((await js(api + '.history()')).chats[0].id, 'pi-fixture');
    await js(api + '.archiveHistory("pi-fixture")'); await js('openArchiveHistory();void 0;');
    await until('document.querySelectorAll("#archiveHistoryList .archive-history-item").length===1');
    await click('#archiveHistoryList .archive-history-delete');
    await until('!!document.querySelector("dialog[open]")');
    assert.equal(await js('document.querySelector("dialog h2").textContent'), 'Permanently delete this conversation?');
    for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Escape' });
    await until('!document.querySelector("dialog")'); assert.equal(fs.existsSync(transcript), true);
    await click('#archiveHistoryList .archive-history-delete'); await click('.archive-delete-confirm');
    await until('!document.querySelector("dialog") && document.querySelectorAll("#archiveHistoryList .archive-history-item").length===0');
    assert.equal(fs.existsSync(transcript), false);
    report.cases.push('real Pi archive/restore preserves transcript bytes; Escape cancels; confirmed deletion removes only selected fixture');
    await js(`window.projects=WorkspaceSidebarState.create(WorkspaceSidebarState.accountOptions({storage:localStorage,api:SoduWorkAPI}));
      window.pid=projects.saveProject({name:'Project fixture',folders:[]});
      projects.move({id:'qwen-fixture',title:'Fixture Qwen Code'},pid);projects.move({id:'codex-fixture',title:'Fixture Codex'},pid);projects.archiveProject(pid);
      document.querySelector('#archiveHistorySearch').value='';document.querySelector('#archiveHistorySearch').dispatchEvent(new Event('input'));openArchiveHistory();void 0;`);
    await until('document.querySelectorAll("#archiveProjectsList .archive-history-item").length===1');
    await click('#archiveProjectsTab'); await click('#archiveProjectsList .archive-history-restore');
    await until('document.querySelectorAll("#archiveProjectsList .archive-history-item").length===0');
    const grouped = await js('WorkspaceSidebarState.create(WorkspaceSidebarState.accountOptions({storage:localStorage,api:SoduWorkAPI})).get()');
    assert.equal(grouped.projects[0].name, 'Project fixture');
    assert.deepEqual(grouped.projects[0].chatIds.sort(), ['codex-fixture', 'qwen-fixture']);
    assert.equal((await js(api + '.history()')).chats.length, 2);
    assert.ok(await js('refreshes>=2'));
    report.cases.push('restoring archived project restores its chats, grouping and immediate sidebar refresh');
    await click('#archiveChatsTab');
    for (const width of [390, 760, 1280]) {
      win.setSize(width, 760);
      await until(`innerWidth >= ${width - 32} && innerWidth <= ${width}`);
      await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const layout = await js('(()=>{const p=document.querySelector("#archivePanel"),h=document.querySelector(".archive-history-head");return{width:p.clientWidth,scroll:p.scrollWidth,title:h.getBoundingClientRect().height,kicker:!!document.querySelector(".archive-history-kicker")}})()');
      assert.ok(layout.scroll <= layout.width + 1, JSON.stringify(layout)); assert.equal(layout.kicker, false);
      if (width >= 760) assert.ok(layout.title <= 65, JSON.stringify(layout));
    }
    fs.writeFileSync(path.join(out, 'archive-en.png'), (await win.webContents.capturePage()).toPNG());
    assert.deepEqual(await js('SoduWorkI18n.getMissing()'), []);
    assert.deepEqual(report.errors, []); report.cases.push('390/760/1280px, compact shared header, no horizontal overflow or missing translations');
    report.ok = true;
  }).catch(async error => { report.error = error.stack || String(error);
    if (win && !win.isDestroyed()) report.diagnostics = await js('({dialog:!!document.querySelector("dialog"),rows:document.querySelectorAll("#archiveHistoryList .archive-history-item").length,status:document.querySelector("#archiveHistoryStatus")?.textContent})').catch(() => null); })
    .finally(async () => { await bridge?.dispose(); win?.destroy(); hub?.closeAllConnections(); hub?.close(); fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} app.exit(report.ok ? 0 : 1); });
}
