'use strict';
// Production window/tab/preload code, real Chromium history and popup creation.
// Isolated loopback apps, profile and composer; no accounts, models or business writes.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ELECTRON_NO_ATTACH_CONSOLE','CHROME_CRASHPAD_PIPE_NAME','CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)], { env, windowsHide:true, stdio:'inherit', timeout:90000 });
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, WebContentsView, ipcMain, safeStorage } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const assert = require('node:assert/strict');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-app-tabs-'));
const out = path.resolve(__dirname, '../../outputs/app-window-tabs-20261021'); fs.mkdirSync(out, { recursive:true });
app.setPath('userData', path.join(temp, 'profile')); app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const report = { ok:false, cases:[], boundary:'Real Electron WebContentsView, production title bar, native IPC, Chromium history/popups and optional original canvas source on an isolated fixture server. Synthetic DOM actions verify handlers; no claim of real mouse input or live model/business flow.' };
const windows = [], views = [], servers = [], handlers = {};
let host, origin, foreign, posted = '';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, label) => { for (let i = 0; i < 320; i++) { if (await check()) return; await delay(25); } throw Error('Timed out: ' + label); };
const js = (wc, source) => wc.executeJavaScript(source, true).catch(error => { throw Error(source.slice(0, 160) + ': ' + error.message); });
const sdk = fs.readFileSync(path.resolve(__dirname, '../sdk/soduwork-app.js'));
const canvasPath = process.argv.find(value => value.startsWith('--canvas-source='))?.slice('--canvas-source='.length);
const canvas = canvasPath ? fs.readFileSync(path.resolve(canvasPath)) : Buffer.from('<!doctype html><title>无限画布</title><div id="world">画布</div>');
async function serve(handler) {
  const server = http.createServer(handler); servers.push(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + server.address().port;
}
app.whenReady().then(async () => {
  foreign = await serve((_req, res) => { res.writeHead(200, { 'Content-Type':'text/html' }); res.end('<title>Foreign page</title>Other origin'); });
  origin = await serve((req, res) => {
    if (req.url === '/never-finishes') { res.writeHead(200, { 'Content-Type':'image/png' }); res.flushHeaders(); return; }
    if (req.url === '/pending-assets') { res.writeHead(200, { 'Content-Type':'text/html' }); res.end('<title>Pending assets</title><a id="next" href="/one">Next</a><img width="1" height="1" src="/never-finishes">'); return; }
    if (req.url === '/sdk.js') { res.writeHead(200, { 'Content-Type':'application/javascript' }); return res.end(sdk); }
    if (req.url === '/canvas') { res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8' }); return res.end(canvas); }
    if (req.url === '/api/events') {
      res.writeHead(200, { 'Content-Type':'text/event-stream' });
      return res.write('event: hello\ndata: {"kind":"snapshot","nodes":[{"id":"one","label":"测试节点","phase":"沟通","detail":"隔离数据","status":"active"}]}\n\n');
    }
    if (req.method === 'POST') { let body = ''; req.on('data', bytes => { body += bytes; }); req.on('end', () => { posted = body; res.end('<title>Posted page</title>Form accepted'); }); return; }
    res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8' });
    res.end('<!doctype html><title>H5 ' + req.url + '</title><script src="/sdk.js"></script><textarea id="draft"></textarea><a id="blank" target="_blank" href="/linked">Link</a><form id="form" method="post" target="_blank" action="/posted"><input name="payload" value="kept"></form>');
  });
  fs.writeFileSync(path.join(temp,'host.html'), '<!doctype html><title>Owner</title><script>window.settingsRequests=[];soduWorkAPI.workPreview.onAppsManage(p=>settingsRequests.push(p));soduWorkAPI.workPreviewAppHost.onRequest(p=>soduWorkAPI.workPreviewAppHost.respond(p.id,{ok:true,tabId:p.tabId}));</script>');
  fs.writeFileSync(path.join(temp,'composer.html'), '<!doctype html><textarea id="draft">对话草稿</textarea><script>window.received=[];soduWorkAPI.workPreview.onComposerSubmit(p=>{received.push(p.text);soduWorkAPI.workPreview.composerSubmitResult({id:p.id,ok:true});});</script>');
  const caps = ['context.read','composer.control','conversation.send','settings.read','settings.write'];
  const plugin = require('../main/personal-plugins').create(app, { key:'tabs-fixture', name:'Tabs fixture', version:'0.1.0', template:'app', description:'Isolated app', instructions:'Fixture only', ui:{ contributions:[{ id:'app', title:'App', slot:'workspace.navigation', source:{ type:'external', url:origin, bridge:{ version:1, capabilities:caps } } }] } }).plugin;
  require('../main/app-settings-store.cjs').configure({ app, safeStorage, ownerOf:() => 'tabs-fixture' });
  require('../main/work-preview').install({ app,
    ipcMain:{ handle(name, fn) { handlers[name] = fn; ipcMain.handle(name,fn); }, on:(...args) => ipcMain.on(...args) },
    BrowserWindow:Object.assign(function(options) { const win = new BrowserWindow(options); windows.push(win); return win; }, { fromWebContents:wc => BrowserWindow.fromWebContents(wc) }),
    WebContentsView:function(options) {
      const view = new WebContentsView(options); views.push(view);
      const load = view.webContents.loadFile.bind(view.webContents);
      view.webContents.loadFile = (file, options) => load(path.basename(file) === 'desk.html' ? path.join(temp,'composer.html') : file, options);
      return view;
    }, shell:{ openExternal:async () => {} },
  });
  host = new BrowserWindow({ show:false, webPreferences:{ preload:path.resolve(__dirname,'../preload.js'), contextIsolation:true, sandbox:true } });
  await host.loadFile(path.join(temp,'host.html'));
  const payload = { tabId:'browser-app', label:'Static application name', appVersion:'0.1.0', url:origin + '/', appBridge:{ appId:'plugin:' + plugin.pluginId, contributionId:'app', origin, version:1, capabilities:caps } };
  assert.equal((await js(host.webContents,'soduWorkAPI.workPreview.showDetached(' + JSON.stringify(payload) + ')')).ok,true);
  const win = windows[0], [chrome, first, composer] = win.contentView.children;
  const action = (name, id) => js(chrome.webContents,'soduWorkWindowChrome.action(' + JSON.stringify(name) + ',' + JSON.stringify(id || '') + ')');
  const state = async () => (await action('state')).state;
  const current = async () => { const s = await state(); return views.find(view => view.webContents && !view.webContents.isDestroyed() && view.webContents.getTitle() === s.tabs.find(tab => tab.id === s.activeId).title); };
  await until(async () => (await state()).tabs[0].title === 'H5 /', 'initial page title');
  await until(() => !composer.webContents.isLoading(), 'composer ready');
  await until(async () => (await state()).startup === 'ready', 'initial first frame');
  assert.equal(await js(chrome.webContents,'!!document.querySelector("#back svg") && !document.querySelector("#title")'),true);
  assert.equal(await js(chrome.webContents,'soduWorkWindowChrome.platform'),process.platform);
  assert.equal(await js(chrome.webContents,'document.documentElement.dataset.platform'),process.platform);
  assert.equal((await state()).canBack,false);
  assert.equal((await state()).appVersion,'0.1.0');
  assert.equal(await js(chrome.webContents,'!!document.getElementById("version")'),false,'version no longer occupies title bar space');
  assert.equal(await js(chrome.webContents,'!!document.getElementById("settings")'),false,'application settings entry is absent from chrome');
  report.cases.push('Application chrome has neither a settings icon/menu nor version text; refresh, navigation and native controls remain.');
  await js(first.webContents,'document.title="动态标题"');
  await until(() => js(chrome.webContents,'document.querySelector(".tab-label").textContent === "动态标题"'), 'live title');
  await js(first.webContents,'history.pushState({},"","/spa-one");history.pushState({},"","/spa-two");document.title="SPA 页面"');
  await action('back'); await until(() => first.webContents.getURL() === origin + '/spa-one', 'SPA back one');
  await action('back'); await until(() => first.webContents.getURL() === origin + '/', 'SPA back two');
  assert.equal((await state()).startup, 'ready', 'SPA history navigation must not return to the startup shell');
  assert.equal(first.getVisible(), true, 'SPA page remains visible');
  await first.webContents.loadURL(origin + '/one'); await first.webContents.loadURL(origin + '/two');
  await action('back'); await until(() => first.webContents.getURL() === origin + '/one', 'document back one');
  await action('back'); await until(() => first.webContents.getURL() === origin + '/', 'document back two');
  report.cases.push('Icon-only chrome, SVG back, dynamic document title, two SPA history entries and two full-document back steps.');
  await js(first.webContents, 'const slowLink=document.createElement("a");slowLink.href="/pending-assets";document.body.append(slowLink);slowLink.click()');
  await until(() => first.webContents.getTitle() === 'Pending assets', 'new document with pending asset');
  assert.equal((await state()).startup, 'ready', 'internal navigation must not reopen launch splash while a resource is pending');
  assert.equal(first.getVisible(), true, 'new page stays interactive before all resources finish');
  // executeJavaScript waits for window.onload, so use Chromium input to prove
  // the still-loading document is actually usable before that event fires.
  win.show(); win.focus(); first.webContents.focus(); await delay(100);
  first.webContents.sendInputEvent({type:'mouseDown',x:20,y:15,button:'left',clickCount:1});
  first.webContents.sendInputEvent({type:'mouseUp',x:20,y:15,button:'left',clickCount:1});
  await until(() => first.webContents.getURL() === origin + '/one', 'navigate again while previous resources remain pending');
  await until(() => first.webContents.getTitle() === 'H5 /one' && !first.webContents.isLoading(), 'new document ready after pending resources');
  await first.webContents.loadURL(origin + '/');
  report.cases.push('Internal navigation stays visible while an image request never finishes, and another page can still be opened.');
  await js(first.webContents,'draft.value="保留 H5 草稿";void window.open("/popup","named")');
  await until(async () => (await state()).tabs.length === 2 && (await state()).tabs[1].title === 'H5 /popup', 'window.open tab');
  let popup = await current();
  await until(async () => (await state()).startup === 'ready', 'popup first frame ready');
  assert.equal(first.getVisible(),false); assert.equal(popup.getVisible(),true);
  const popupId = (await state()).activeId;
  assert.equal((await js(popup.webContents,'soduWorkApp.settings.update({values:{ukey:"fixture-key"}})')).ok,true);
  assert.equal((await js(popup.webContents,'soduWorkApp.chat.send({text:"新标签发消息",requestId:"popup-chat"})')).ok,true);
  assert.deepEqual(await js(composer.webContents,'received'),['新标签发消息']);
  assert.equal((await js(popup.webContents,'soduWorkAppBridge.context.get()')).tabId,payload.tabId);
  await action('select',payload.tabId);
  assert.equal(await js(first.webContents,'draft.value'),'保留 H5 草稿');
  assert.equal((await js(first.webContents,'soduWorkApp.settings.get({keys:["ukey"],includeSecrets:true})')).values.ukey,'fixture-key');
  await js(first.webContents,'document.getElementById("blank").click()');
  await until(async () => (await state()).tabs.length === 3 && (await state()).tabs[2].title === 'H5 /linked','target blank tab');
  assert.equal(windows.length,1);
  await action('select',payload.tabId); await js(first.webContents,'document.getElementById("form").submit()');
  await until(() => posted === 'payload=kept','popup POST data');
  await until(async () => (await state()).tabs.at(-1).title === 'Posted page','POST title');
  report.cases.push('window.open, target=_blank and form POST create real tabs in one native window; per-tab draft, same-app settings, composer and stable bridge identity are preserved.');
  await action('select',popupId); await popup.webContents.loadURL(foreign);
  assert.equal((await js(popup.webContents,'soduWorkAppBridge.settings.get({keys:["ukey"],includeSecrets:true})')).code,'APP_ORIGIN_DENIED');
  await js(popup.webContents,'void window.open("file:///C:/Windows/win.ini")'); await delay(150);
  assert.equal((await state()).tabs.length,4);
  await until(() => js(chrome.webContents,'!document.getElementById("back").disabled'),'popup back enabled');
  await js(chrome.webContents,'document.getElementById("back").click()');
  await until(() => popup.webContents.getURL() === origin + '/popup','back acts on selected popup');
  assert.equal(await js(first.webContents,'draft.value'),'保留 H5 草稿');
  report.cases.push('Foreign-origin navigation cannot read app credentials; file popup is denied.');
  await action('select',payload.tabId);
  await js(first.webContents,'void window.open("/canvas")');
  await until(async () => (await state()).tabs.length === 5 && (await state()).tabs.at(-1).title.includes('画布'),'canvas tab');
  const canvasId = (await state()).activeId, canvasView = await current();
  await until(() => js(canvasView.webContents,'!!document.getElementById("world")'),'canvas ready');
  if (canvasPath) await until(() => js(canvasView.webContents,'document.querySelectorAll(".node").length === 1'),'original canvas node rendered');
  await js(canvasView.webContents,'document.getElementById("world").style.transform="translate(123px, 77px) scale(1.5)";window.fixtureCanvasMarker="kept"');
  await action('select',payload.tabId); await action('select',canvasId);
  assert.equal(await js(canvasView.webContents,'fixtureCanvasMarker'), 'kept');
  assert.equal(await js(canvasView.webContents,'document.getElementById("world").style.transform'),'translate(123px, 77px) scale(1.5)');
  assert.equal((await js(canvasView.webContents,'soduWorkAppBridge.composer.expand()')).ok,true);
  assert.ok(canvasView.getBounds().x + canvasView.getBounds().width <= composer.getBounds().x);
  await js(host.webContents,'soduWorkAPI.workPreview.resetEmbedded()'); assert.equal(win.isDestroyed(),false);
  assert.equal((await state()).tabs.length,5);
  if (win.isMaximized()) { win.unmaximize(); await until(() => !win.isMaximized(),'restore before title bar sizing'); }
  await js(chrome.webContents,'document.querySelector("#back").focus()');
  await delay(150);
  for (const width of [650,1280]) {
    win.setContentSize(width,800);
    await until(() => chrome.getBounds().width === width,'title bar resize');
    assert.equal(await js(chrome.webContents,'(() => {const b=document.getElementById("back").getBoundingClientRect(),t=document.getElementById("tabs").getBoundingClientRect(),r=document.getElementById("settings").getBoundingClientRect();return b.right<=t.left&&t.right<=r.left&&r.right<=innerWidth-(soduWorkWindowChrome.platform==="darwin"?10:150)})()'),true);
    assert.equal(await js(chrome.webContents,'(() => {const region=e=>getComputedStyle(e).webkitAppRegion;return region(document.getElementById("tabs"))==="drag"&&region(document.getElementById("drag-space"))==="drag"&&document.getElementById("drag-space").getBoundingClientRect().width>=48&&[...document.querySelectorAll("button,.tab")].every(e=>region(e)==="no-drag")})()'),true);
  }
  // Render both platform layouts in real Chromium; this does not simulate macOS native controls.
  for (const platform of ['darwin','win32']) {
    await js(chrome.webContents,'document.documentElement.dataset.platform='+JSON.stringify(platform));
    for (const width of [480,650,1280]) {
      win.setContentSize(width,800);
      await until(() => chrome.getBounds().width === width,'platform title bar resize');
      const geometry = await js(chrome.webContents,'(()=>{const rect=id=>document.getElementById(id).getBoundingClientRect(),l=rect("logo"),b=rect("back"),t=rect("tabs"),r=rect("refresh"),s=rect("settings");return {logoLeft:l.left,logoRight:l.right,backLeft:b.left,backRight:b.right,tabsLeft:t.left,tabsRight:t.right,refreshLeft:r.left,settingsRight:s.right,width:innerWidth}})()');
      assert.equal(geometry.logoLeft,platform==='darwin'?88:10);
      assert.ok(geometry.logoRight<=geometry.backLeft && geometry.backRight<=geometry.tabsLeft && geometry.tabsRight<=geometry.refreshLeft);
      assert.ok(geometry.settingsRight<=geometry.width-(platform==='darwin'?10:150));
    }
    if (platform==='darwin') fs.writeFileSync(path.join(out,'mac-titlebar-layout.png'),(await chrome.webContents.capturePage()).toPNG());
  }
  await js(chrome.webContents,'document.documentElement.dataset.platform=soduWorkWindowChrome.platform');
  report.cases.push('Production preload supplies the native platform; macOS CSS reserves 88px at the left for native traffic lights and shifts logo/back/tabs, while Windows retains its right controls gap. Chromium verifies 480/650/1280px layouts; native macOS buttons require a Mac check.');
  win.show(); win.focus();
  await until(() => js(canvasView.webContents,'innerWidth').then(width => Math.abs(width-canvasView.getBounds().width)<=1),'canvas viewport resized');
  await delay(200);
  for (const [name, wc] of [['tabs',chrome.webContents],['canvas',canvasView.webContents]]) {
    let image;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { image = await wc.capturePage(); break; }
      catch (error) {
        (report.captureRetries ||= []).push({ name, error:String(error) });
        if (attempt === 2) throw error;
        wc.invalidate(); await delay(150);
      }
    }
    assert.equal(image.isEmpty(),false);
    fs.writeFileSync(path.join(out,name + '.png'),image.toPNG());
  }
  report.cases.push((canvasPath ? 'Original 流程画布 source' : 'Canvas fixture') + ' renders in its own tab, retains document/viewport state across switches, controls the shared composer, and survives main-page reset.');
  const firstContents = first.webContents;
  await action('close',payload.tabId); assert.equal(firstContents.isDestroyed(),true);
  assert.equal((await state()).tabs.length,4);
  await action('select',popupId); await action('refresh');
  await until(() => !popup.webContents.isLoading(),'refresh selected tab');
  assert.equal(await js(composer.webContents,'draft.value'),'对话草稿');
  assert.equal(await js(canvasView.webContents,'fixtureCanvasMarker'),'kept');
  const before = (await state()).tabs.length;
  await js(popup.webContents,'window.open("about:blank").location.href=' + JSON.stringify(origin + '/from-blank'));
  await until(async () => (await state()).tabs.length === before + 1 && (await state()).tabs.at(-1).title === 'H5 /from-blank','about blank popup');
  const blank = await current(); await js(blank.webContents,'window.close()');
  await until(async () => (await state()).tabs.length === before,'script close tab');
  const firstWindowViews = [...views];
  assert.equal((await js(host.webContents,'soduWorkAPI.workPreview.showDetached(' + JSON.stringify({ ...payload,appVersion:'',tabId:'second-app' }) + ')')).ok,true);
  const secondWindow = windows[1], secondChrome = secondWindow.contentView.children[0];
  await until(() => !secondChrome.webContents.isLoading(),'second chrome');
  assert.equal(await js(secondChrome.webContents,'!!document.querySelector("#settings,#version")'),false);
  assert.equal((await action('select','second-app')).ok,false);
  while (!win.isDestroyed()) { const s = await state(); await action('close',s.activeId).catch(() => {}); await delay(20); }
  assert.equal(secondWindow.isDestroyed(),false);
  assert.ok(firstWindowViews.every(view => !view.webContents || view.webContents.isDestroyed()));
  await js(secondChrome.webContents,'soduWorkWindowChrome.action("close","second-app")').catch(() => {});
  await until(() => secondWindow.isDestroyed(),'second app closes');
  await until(() => views.every(view => !view.webContents || view.webContents.isDestroyed()),'all app surfaces reclaimed');
  assert.ok(views.every(view => !view.webContents || view.webContents.isDestroyed()));
  report.cases.push('First tab can close; refresh affects only selected page and keeps composer/other tabs; about:blank then location works; window.close closes its tab; last-tab close reclaims all native surfaces.');
  report.cases.push('650/1280px title bars keep back/tabs/actions separate; tabs cannot select another app window and closing one app leaves the second open.');
  report.ok = true;
}).catch(error => { report.error = String(error.stack || error); }).finally(async () => {
  host?.destroy(); for (const win of windows) if (!win.isDestroyed()) win.destroy();
  for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
});
